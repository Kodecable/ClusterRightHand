import { Trans, useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { ChevronDownIcon, ChevronRightIcon, WrenchIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { CodeText } from "@/components/code-text";
import { InternalLink } from "@/components/internal-link";
import { StatusBadge, TaskStatusBadge } from "@/components/status-badge";
import { TaskResult } from "@/components/task-result";
import { useTask } from "@/features/tasks/api";
import { safeInternalPath } from "@/lib/url";
import { SafeMarkdown, StreamingMarkdown } from "@/markdown/SafeMarkdown";
import { useStreamingText } from "@/markdown/stream-store";
import type { Json, JsonObject } from "./sessionState";
import { approvalWait, authorizationWait, prettyJson, type TranscriptItem } from "./sessionState";
import type { TranscriptStreams } from "./transcript-streams";

type ToolItem = Extract<TranscriptItem, { kind: "tool" }>;

/** The parts of a tool result the UI lifts out of the JSON before showing the rest. */
function resultSummary(details: Json | undefined, text: string): { state?: string; exitCode?: number } {
	const parsed = prettyJson(text);
	const value = parsed && !Array.isArray(parsed.value) ? parsed.value : undefined;
	const state = typeof value?.state === "string" ? value.state : undefined;
	const exit = typeof value?.exit_code === "number" ? value.exit_code : undefined;
	if (state !== undefined || exit !== undefined) return { state, exitCode: exit };
	const detailState =
		details !== null && typeof details === "object" && !Array.isArray(details) && typeof details.state === "string"
			? details.state
			: undefined;
	return detailState === undefined ? {} : { state: detailState };
}

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

function ToolCard({
	item,
	streams,
	onBeforeResize,
	onAfterResize,
}: {
	item: ToolItem;
	streams: TranscriptStreams;
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

	const wait = item.result ? undefined : approvalWait(item.details);
	const approvalHref = wait ? safeInternalPath(wait.url) : undefined;
	const signature = item.result ? undefined : authorizationWait(item.details);
	const signatureHref = signature ? safeInternalPath(signature.url) : undefined;
	const subagent =
		item.details !== null && typeof item.details === "object" && !Array.isArray(item.details)
			? item.details.sessionId
			: undefined;
	const subagentId = typeof subagent === "string" && subagent !== "" ? subagent : undefined;
	const summary = resultSummary(item.details, item.result?.text ?? "");
	const status = item.result
		? item.result.isError
			? "failed"
			: "done"
		: item.status === "pending"
			? "preparing"
			: item.status === "running"
				? "running"
				: "empty";

	const statusLabel = {
		failed: t`Failed`,
		done: t`Done`,
		preparing: t`Preparing`,
		running: t`Running`,
		empty: t`No result yet`,
	}[status];
	const tone = status === "done" ? "ok" : status === "failed" ? "danger" : status === "empty" ? "muted" : "info";
	const hasArgs = Object.keys(item.args).length > 0;
	const summaryLine = toolSummary(item.args);
	const liveOutput = item.result === undefined ? streams.tool(item.callId) : undefined;
	const taskId = toolTaskId(item);

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
				<WrenchIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
				<span className="shrink-0 font-mono text-xs font-medium">{item.name}</span>
				<span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground" title={summaryLine}>
					{summaryLine}
				</span>
				{(summary.state !== undefined || summary.exitCode !== undefined) && (
					<span className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
						{summary.state !== undefined && <TaskStatusBadge state={summary.state} exitCode={summary.exitCode} />}
						{summary.exitCode !== undefined && summary.exitCode !== 0 && (
							<span className="font-mono">exit {summary.exitCode}</span>
						)}
					</span>
				)}
				<StatusBadge tone={tone} dot={false}>
					{statusLabel}
				</StatusBadge>
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
					{item.result !== undefined && (
						<div className="grid gap-1">
							<span className="text-[11px] font-medium text-muted-foreground">
								<Trans>Result</Trans>
							</span>
							<CodeText
								text={prettyJson(item.result.text)?.pretty ?? item.result.text}
								maxLines={40}
								label={t`Tool result`}
								className={item.result.isError ? "border-danger/40" : undefined}
							/>
							{taskId !== undefined && <ToolTask taskId={taskId} />}
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
	onBeforeResize,
	onAfterResize,
}: {
	item: TranscriptItem;
	streams: TranscriptStreams;
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
					<ToolCard item={item} streams={streams} onBeforeResize={onBeforeResize} onAfterResize={onAfterResize} />
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
