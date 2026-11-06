import { Trans, useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { CodeText } from "@/components/code-text";
import { InternalLink } from "@/components/internal-link";
import { TaskGone } from "@/components/task-gone";
import { TaskResult } from "@/components/task-result";
import { Dialog, DialogContent, DialogHeader, DialogScrollArea, DialogTitle } from "@/components/ui/dialog";
import { useTask } from "@/features/tasks/api";
import { isNotFound } from "@/lib/api/client";
import { safeInternalPath } from "@/lib/url";
import { useStreamingText } from "@/markdown/stream-store";
import { resultId, type ToolItem } from "./tool-call";
import { approvalWait, authorizationWait, prettyJson } from "./tool-details";
import type { TranscriptStreams } from "./transcript-streams";

/** A cluster task result shows the same `TaskResult` as the task page (doc/webui.md "共享部件"). */
function ToolTask({ taskId }: { taskId: string }) {
	const task = useTask(taskId);
	const { t } = useLingui();
	if (task.isPending) return <p className="text-xs text-muted-foreground">{t`Loading task…`}</p>;
	if (task.error !== null && task.error !== undefined) {
		if (isNotFound(task.error)) return <TaskGone className="text-xs" />;
		return <p className="text-xs text-danger">{task.error.message}</p>;
	}
	if (!task.data) return null;
	return (
		<div className="rounded-md border bg-card/40 p-2">
			<TaskResult task={task.data} />
		</div>
	);
}

/**
 * The dialog a tool card opens: the call's arguments, an approval or signature wait, the live output while it
 * runs, and the returned result with the task, task group or subagent session it links.
 */
export function ToolDialog({
	item,
	open,
	onOpenChange,
	liveOutput,
}: {
	item: ToolItem;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** The live output store of an unreturned call; undefined once the call returned. */
	liveOutput: ReturnType<TranscriptStreams["tool"]> | undefined;
}) {
	const { t } = useLingui();
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
	const hasArgs = Object.keys(item.args).length > 0;
	const taskResultId = returned ? resultId(item, "task_id") : undefined;
	const taskGroupResultId = returned ? resultId(item, "task_group_id") : undefined;

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-3xl" data-testid="tool-dialog">
				<DialogHeader>
					<DialogTitle className="pr-6 font-mono text-sm">{item.name}</DialogTitle>
				</DialogHeader>
				<DialogScrollArea className="grid max-h-[70vh] gap-3" data-testid="tool-output">
					{hasArgs && (
						<div className="grid gap-1">
							<span className="text-[11px] font-medium text-muted-foreground">
								<Trans>Arguments</Trans>
							</span>
							<CodeText
								text={JSON.stringify(item.args, null, 2)}
								maxLines={0}
								preClassName="max-h-none"
								label={t`Tool arguments`}
							/>
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
							<ToolResultContent result={result} />
							{taskResultId !== undefined && <ToolTask taskId={taskResultId} />}
							{taskGroupResultId !== undefined && (
								<Link
									to="/task-groups/$taskGroupId"
									params={{ taskGroupId: taskGroupResultId }}
									className="text-xs text-primary underline underline-offset-2"
								>
									<Trans>Open the task group page</Trans>
								</Link>
							)}
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
				</DialogScrollArea>
			</DialogContent>
		</Dialog>
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

/**
 * A returned tool result (doc/agent-runtime.md#交给模型的输出d112): one JSON block keeps the pretty JSON
 * view, while a text result shows each raw or note block in its own monospace block.
 */
function ToolResultContent({ result }: { result: NonNullable<ToolItem["result"]> }) {
	const { t } = useLingui();
	const blocks = result.blocks !== undefined && result.blocks.length > 0 ? result.blocks : [result.text];
	const only = blocks.length === 1 ? blocks[0] : undefined;
	const json = only === undefined ? undefined : prettyJson(only);
	if (json !== undefined) {
		return (
			<CodeText
				text={json.pretty}
				maxLines={0}
				preClassName="max-h-none"
				label={t`Tool result`}
				className={result.isError ? "border-danger/40" : undefined}
			/>
		);
	}
	return (
		<div className="grid gap-1.5" data-testid="tool-result-text">
			{blocks.map((block, index) => {
				const key = `${index}:${block.slice(0, 16)}`;
				return (
					<CodeText
						key={key}
						text={block}
						maxLines={0}
						preClassName="max-h-none"
						label={t`Tool result`}
						className={result.isError ? "border-danger/40" : undefined}
					/>
				);
			})}
		</div>
	);
}
