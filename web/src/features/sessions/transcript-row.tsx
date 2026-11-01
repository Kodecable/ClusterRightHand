import { Trans, useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { ChevronDownIcon, ChevronRightIcon, LoaderCircleIcon, WrenchIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { CodeText } from "@/components/code-text";
import { InternalLink } from "@/components/internal-link";
import { TaskResult } from "@/components/task-result";
import { groupEnded, useTask, useTaskGroup } from "@/features/tasks/api";
import { isTerminal } from "@/features/tasks/output";
import { safeInternalPath } from "@/lib/url";
import { cn } from "@/lib/utils";
import { SafeMarkdown, StreamingMarkdown } from "@/markdown/SafeMarkdown";
import { useStreamingText } from "@/markdown/stream-store";
import type { Json, JsonObject } from "./sessionState";
import { approvalWait, authorizationWait, prettyJson, type TranscriptItem } from "./sessionState";
import { groupViewFailure, type ToolFailure, taskViewFailure, toolFailure } from "./tool-failure";
import type { TranscriptStreams } from "./transcript-streams";

type ToolItem = Extract<TranscriptItem, { kind: "tool" }>;

/** A cluster task result shows the same `TaskResult` as the task page (doc/webui.md "共享部件"). */
function ToolTask({ taskId }: { taskId: string }) {
	const task = useTask(taskId);
	const { t } = useLingui();
	if (task.isPending) return <p className="text-xs text-muted-foreground">{t`Loading task…`}</p>;
	if (task.error !== null && task.error !== undefined)
		return <p className="text-xs text-danger">{task.error.message}</p>;
	if (!task.data) return null;
	return (
		<div className="rounded-md border bg-card/40 p-2">
			<TaskResult task={task.data} />
		</div>
	);
}

/** The first string argument among `keys`, in order; a joined argv array counts as one too. */
function firstString(args: JsonObject, keys: readonly string[]): string | undefined {
	for (const key of keys) {
		const value = args[key];
		if (typeof value === "string" && value.trim() !== "") return value;
	}
	return undefined;
}

function argvLine(args: JsonObject): string | undefined {
	const argv = args.argv;
	if (!Array.isArray(argv) || argv.length === 0) return undefined;
	const parts = argv.filter((part): part is string => typeof part === "string");
	return parts.length > 0 ? parts.join(" ") : undefined;
}

/**
 * What a tool call is doing, as one line: the command, the file, the node or
 * target, or (for the other tools) their first telling argument. The card's
 * collapsed row shows it so two `exec` cards do not look identical.
 */
export function toolSummary(args: JsonObject): string {
	const detail =
		firstString(args, ["cmd", "shell", "command"]) ??
		argvLine(args) ??
		firstString(args, ["path", "file", "task", "request", "request_id", "session_id", "query", "url", "name"]) ??
		"";
	const targets = Array.isArray(args.targets)
		? args.targets.filter((target): target is string => typeof target === "string")
		: [];
	const node = firstString(args, ["node", "nodeId", "node_id"]);
	const where = targets.length > 0 ? targets.join(", ") : node;
	if (detail === "" && where === undefined) {
		const keys = Object.keys(args);
		return keys.length === 0 ? "" : keys.join(", ");
	}
	if (detail === "") return where ?? "";
	if (where === undefined || detail.includes(where)) return detail;
	return `${detail} · ${where}`;
}

function toolTaskId(item: ToolItem): string | undefined {
	const parsed = prettyJson(item.result?.text ?? "");
	const value = parsed && !Array.isArray(parsed.value) ? parsed.value : undefined;
	const id = value?.task_id;
	return typeof id === "string" && id !== "" ? id : undefined;
}

/** How often an open call re-reads the task or task group it follows. */
const FOLLOW_INTERVAL_MS = 5000;

/** A string field of the call's live status details, e.g. the `task_id` the first status published. */
function detailId(details: Json | undefined, key: "task_id" | "task_group_id"): string | undefined {
	if (details === null || details === undefined || typeof details !== "object" || Array.isArray(details))
		return undefined;
	const value = details[key];
	return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * Whether an unreturned call may still produce a result (doc/webui.md "工具卡片"): the session is running or
 * awaiting, and the call's task or task group, when the card knows one, has not ended.
 */
export function callStillOpen({
	sessionActive,
	taskState,
	groupState,
}: {
	sessionActive: boolean;
	taskState: string | undefined;
	groupState: string | undefined;
}): boolean {
	if (!sessionActive) return false;
	if (taskState !== undefined && isTerminal(taskState)) return false;
	if (groupState !== undefined && groupEnded(groupState)) return false;
	return true;
}

/**
 * The card's status, as its leading icon only (doc/webui.md "消息渲染"): a spinner while the call may still
 * return, then the wrench — in the danger colour when the call or the task it ran failed. The accessible name
 * and the tooltip carry the state a badge used to show.
 */
function ToolStatusIcon({ spinning, failed, label }: { spinning: boolean; failed: boolean; label: string }) {
	return (
		<span
			role="img"
			aria-label={label}
			title={label}
			data-testid="tool-status-icon"
			className={cn("inline-flex shrink-0", failed ? "text-danger" : "text-muted-foreground")}
		>
			{spinning ? (
				<LoaderCircleIcon className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
			) : (
				<WrenchIcon className="size-3.5" aria-hidden="true" />
			)}
		</span>
	);
}

function ToolCard({
	item,
	streams,
	sessionActive,
	onBeforeResize,
	onAfterResize,
}: {
	item: ToolItem;
	streams: TranscriptStreams;
	sessionActive: boolean;
	onBeforeResize?: () => void;
	onAfterResize?: () => void;
}) {
	const { t } = useLingui();
	const [expanded, setExpanded] = useState(false);
	const mounted = useRef(false);
	// The correction runs after the expanded content has been committed.
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs on the expanded toggle
	useEffect(() => {
		if (!mounted.current) {
			mounted.current = true;
			return;
		}
		onAfterResize?.();
	}, [expanded, onAfterResize]);

	const result = item.result;
	const returned = result !== undefined;
	const wait = result ? undefined : approvalWait(item.details);
	const approvalHref = wait ? safeInternalPath(wait.url) : undefined;
	const signature = result ? undefined : authorizationWait(item.details);
	const signatureHref = signature ? safeInternalPath(signature.url) : undefined;
	const subagent =
		item.details !== null && typeof item.details === "object" && !Array.isArray(item.details)
			? item.details.sessionId
			: undefined;
	const subagentId = typeof subagent === "string" && subagent !== "" ? subagent : undefined;
	const failure = result === undefined ? undefined : toolFailure(result.text);
	// Only a call without a result follows a task or task group: a returned call must not fetch.
	const taskId = returned ? undefined : detailId(item.details, "task_id");
	const groupId = returned ? undefined : detailId(item.details, "task_group_id");
	// Plain reads, not the long-polling waits: a session may have many open calls, and each wait would hold one
	// of the browser's few connections per origin for as long as the call runs.
	const task = useTask(taskId);
	const group = useTaskGroup(groupId);
	const followedTask = taskId === undefined ? undefined : task.data;
	const followedGroup = groupId === undefined ? undefined : group.data;
	const spinning =
		!returned && callStillOpen({ sessionActive, taskState: followedTask?.state, groupState: followedGroup?.state });
	const followed = taskId !== undefined || groupId !== undefined;
	const { refetch: refetchTask } = task;
	const { refetch: refetchGroup } = group;
	// Re-read the followed task or group every few seconds while the card spins, and once more when it stops
	// (the session went idle), so a stopped card shows how the task ended.
	useEffect(() => {
		if (!followed) return;
		const refresh = () => {
			if (taskId !== undefined) void refetchTask();
			if (groupId !== undefined) void refetchGroup();
		};
		if (!spinning) {
			refresh();
			return;
		}
		const timer = setInterval(refresh, FOLLOW_INTERVAL_MS);
		return () => clearInterval(timer);
	}, [followed, spinning, taskId, groupId, refetchTask, refetchGroup]);
	// What a stopped call's task or group ended with: its failure, `done`, or undefined when nothing is known.
	let outcome: ToolFailure | "done" | undefined;
	if (!returned && !spinning) {
		if (followedTask !== undefined && isTerminal(followedTask.state)) {
			outcome = taskViewFailure(followedTask) ?? "done";
		} else if (followedGroup !== undefined && groupEnded(followedGroup.state)) {
			outcome = groupViewFailure(followedGroup) ?? "done";
		}
	}
	// A task failure is a failed card even though the call itself returned normally.
	const failed = returned ? result.isError || failure !== undefined : outcome !== undefined && outcome !== "done";
	const status = returned
		? failed
			? "failed"
			: "done"
		: spinning
			? item.status === "pending"
				? "preparing"
				: item.status === "running"
					? "running"
					: "empty"
			: failed
				? "failed"
				: "empty";
	// The icon is the only status signal: its accessible name and tooltip say what a badge used to show.
	const failureLabel = (value: ToolFailure): string =>
		value.kind === "partly-failed"
			? t`Partly failed`
			: value.reason === "cancelled"
				? t`Cancelled`
				: value.reason === "timed-out"
					? t`Timed out`
					: value.reason === "exit"
						? t`Exit ${value.exitCode ?? ""}`
						: t`Failed`;
	let statusLabel: string;
	if (returned) statusLabel = failure === undefined ? (failed ? t`Failed` : t`Done`) : failureLabel(failure);
	else if (spinning) statusLabel = t`Running`;
	else if (outcome === undefined) statusLabel = t`No result`;
	else statusLabel = outcome === "done" ? t`Done` : failureLabel(outcome);
	const hasArgs = Object.keys(item.args).length > 0;
	const summaryLine = toolSummary(item.args);
	const liveOutput = result === undefined ? streams.tool(item.callId) : undefined;
	const taskResultId = toolTaskId(item);

	return (
		<div className="overflow-hidden rounded-lg border bg-card/50" data-testid="tool-card" data-tool-status={status}>
			<button
				type="button"
				data-testid="tool-toggle"
				aria-expanded={expanded}
				onClick={() => {
					onBeforeResize?.();
					setExpanded((value) => !value);
				}}
				className="flex w-full items-center gap-2 px-2.5 py-2 text-left text-xs hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
			>
				<ToolStatusIcon spinning={spinning} failed={failed} label={statusLabel} />
				<span className="shrink-0 font-mono text-xs font-medium">{item.name}</span>
				<span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground" title={summaryLine}>
					{summaryLine}
				</span>
				{expanded ? (
					<ChevronDownIcon className="size-3.5 shrink-0" aria-hidden="true" />
				) : (
					<ChevronRightIcon className="size-3.5 shrink-0" aria-hidden="true" />
				)}
			</button>
			{expanded && (
				<div className="grid gap-2 border-t p-2.5" data-testid="tool-output">
					{hasArgs && (
						<div className="grid gap-1">
							<span className="text-[11px] font-medium text-muted-foreground">
								<Trans>Arguments</Trans>
							</span>
							<CodeText text={JSON.stringify(item.args, null, 2)} maxLines={24} label={t`Tool arguments`} />
						</div>
					)}
					{wait && (
						<p className="text-xs text-warn" role="status">
							<Trans>Waiting for your approval.</Trans>{" "}
							<InternalLink href={approvalHref}>
								<Trans>Review and approve</Trans>
							</InternalLink>
						</p>
					)}
					{signature && (
						<p className="text-xs text-warn" role="status">
							<Trans>Waiting for your signature.</Trans>{" "}
							<InternalLink href={signatureHref}>
								<Trans>Open the signing page</Trans>
							</InternalLink>
						</p>
					)}
					{liveOutput !== undefined && (
						<div className="grid gap-1">
							<span className="text-[11px] font-medium text-muted-foreground">
								<Trans>Output so far</Trans>
							</span>
							<ToolLiveOutput store={liveOutput} />
						</div>
					)}
					{result !== undefined && (
						<div className="grid gap-1">
							<span className="text-[11px] font-medium text-muted-foreground">
								<Trans>Result</Trans>
							</span>
							<CodeText
								text={prettyJson(result.text)?.pretty ?? result.text}
								maxLines={40}
								label={t`Tool result`}
								className={result.isError ? "border-danger/40" : undefined}
							/>
							{taskResultId !== undefined && <ToolTask taskId={taskResultId} />}
						</div>
					)}
					{subagentId !== undefined && (
						<Link
							to="/sessions/$sessionId"
							params={{ sessionId: subagentId }}
							className="text-xs text-primary underline underline-offset-2"
						>
							<Trans>Open the subagent's session</Trans>
						</Link>
					)}
				</div>
			)}
		</div>
	);
}

function ToolLiveOutput({ store }: { store: ReturnType<TranscriptStreams["tool"]> }) {
	const { text } = useStreamingText(store);
	if (text === "") {
		return (
			<p className="text-xs text-muted-foreground">
				<Trans>No output yet.</Trans>
			</p>
		);
	}
	return (
		<pre className="max-h-72 overflow-auto rounded-md border bg-[var(--code)] p-2 font-mono text-xs whitespace-pre-wrap break-words">
			{text}
		</pre>
	);
}

function CompactionDivider({ text }: { text: string }) {
	return (
		<details className="rounded-md border border-dashed px-2.5 py-2 text-xs text-muted-foreground">
			<summary className="cursor-pointer select-none">
				<Trans>Context compacted</Trans>
			</summary>
			<p className="mt-1 whitespace-pre-wrap">{text}</p>
		</details>
	);
}

/**
 * One transcript row (doc/webui.md "消息渲染"): a plain user message, assistant
 * text and thinking through SafeMarkdown, tool cards with their live output,
 * errors and the compaction divider. A message that arrived through the live
 * stream keeps its row and store after `message_end` (only the committed text
 * replaces the live text), so the incremental Markdown tree is not discarded;
 * messages loaded from a snapshot render their text in one shot.
 */
export function TranscriptRow({
	item,
	streams,
	sessionActive,
	onBeforeResize,
	onAfterResize,
}: {
	item: TranscriptItem;
	streams: TranscriptStreams;
	/** Whether the session is running or awaiting: an unreturned call stops waiting once it is idle. */
	sessionActive: boolean;
	onBeforeResize?: () => void;
	onAfterResize?: () => void;
}) {
	const { t } = useLingui();
	return (
		<article data-testid="message" data-message-id={item.key} data-kind={item.kind} className="px-3 pb-2.5">
			{item.kind === "user" && (
				<div className="flex justify-end">
					<div className="max-w-[85%] rounded-2xl bg-primary px-3 py-2 text-sm whitespace-pre-wrap break-words text-primary-foreground">
						{item.text}
					</div>
				</div>
			)}
			{item.kind === "text" && (
				<div className="max-w-[92%] text-sm" data-testid={item.streaming ? "streaming-text" : undefined}>
					{item.live ? (
						// A streamed message keeps the same renderer after it is committed:
						// the final text replaces the store's live text in place.
						<StreamingMarkdown store={streams.text(item.key)} text={item.streaming ? undefined : item.text} />
					) : (
						<SafeMarkdown text={item.text} />
					)}
				</div>
			)}
			{item.kind === "thinking" && (
				<details className="max-w-[92%] rounded-md border border-dashed px-2.5 py-1.5 text-sm text-muted-foreground">
					<summary className="cursor-pointer select-none text-xs font-medium" data-testid="thinking-toggle">
						<Trans>Thinking</Trans>
					</summary>
					<div className="mt-1">
						{item.live ? (
							<StreamingMarkdown
								store={streams.text(item.key)}
								text={item.streaming ? undefined : item.text}
								className="text-muted-foreground"
							/>
						) : (
							<SafeMarkdown text={item.text} className="text-muted-foreground" />
						)}
					</div>
				</details>
			)}
			{item.kind === "tool" && (
				<div className="max-w-[92%]">
					<ToolCard
						item={item}
						streams={streams}
						sessionActive={sessionActive}
						onBeforeResize={onBeforeResize}
						onAfterResize={onAfterResize}
					/>
				</div>
			)}
			{item.kind === "compaction" && <CompactionDivider text={item.text} />}
			{item.kind === "error" && (
				<p role="alert" className="text-sm text-danger">
					{item.reason === "aborted" ? <Trans>The run was stopped.</Trans> : <Trans>The run failed.</Trans>}
					{item.message !== null && <span className="ml-1 text-muted-foreground">{item.message}</span>}
				</p>
			)}
			{item.kind === "text" && item.text === "" && item.streaming && <span className="sr-only">{t`Generating…`}</span>}
		</article>
	);
}
