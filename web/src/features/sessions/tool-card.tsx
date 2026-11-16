import { Trans, useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { LoaderCircleIcon, WrenchIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { taskOutcomeText } from "@/components/task-outcome";
import { taskGroupEnded, useTask, useTaskGroup } from "@/features/tasks/api";
import { isNotFound } from "@/lib/api/client";
import { formatBytes } from "@/lib/format";
import { isTerminal } from "@/lib/task-output";
import { cn } from "@/lib/utils";
import { callStillOpen, detailId, type ToolItem, toolLine } from "./tool-call";
import { reviewingDetails, viewImageDetails } from "./tool-details";
import { ToolDialog } from "./tool-dialog";
import {
	type ToolFailure,
	taskGroupViewFailure,
	taskViewFailure,
	toolResultFailure,
	toolResultOutcome,
} from "./tool-failure";
import type { TranscriptStreams } from "./transcript-streams";

/** How often an open call re-reads the task or task group it follows. */
const FOLLOW_INTERVAL_MS = 5000;

/**
 * The card's status, as its leading icon only (doc/design/webui.md "Message rendering"): a spinner while the call may still
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
			className={cn(
				"inline-flex shrink-0",
				failed ? "text-danger" : "text-muted-foreground group-hover:text-foreground",
			)}
		>
			{spinning ? (
				<LoaderCircleIcon className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
			) : (
				<WrenchIcon className="size-3.5" aria-hidden="true" />
			)}
		</span>
	);
}

export function ToolCard({
	item,
	streams,
	sessionActive,
}: {
	item: ToolItem;
	streams: TranscriptStreams;
	sessionActive: boolean;
}) {
	const { t, i18n } = useLingui();
	const [open, setOpen] = useState(false);

	const result = item.result;
	const returned = result !== undefined;
	const failure = result === undefined ? undefined : toolResultFailure(result);
	// A task result's outcome decides the colour even when the call reports `isError`: a cancelled task is
	// muted, and `isError` only names the model-facing error of a call with no task outcome.
	const resultOutcome = result === undefined ? undefined : toolResultOutcome(result);
	// Only a call without a result follows a task or task group: a returned call must not fetch.
	const taskId = returned ? undefined : detailId(item.details, "task_id");
	const taskGroupId = returned ? undefined : detailId(item.details, "task_group_id");
	// Plain reads, not the long-polling waits: a session may have many open calls, and each wait would hold one
	// of the browser's few connections per origin for as long as the call runs.
	const task = useTask(taskId);
	const taskGroup = useTaskGroup(taskGroupId);
	const followedTask = taskId === undefined ? undefined : task.data;
	const followedTaskGroup = taskGroupId === undefined ? undefined : taskGroup.data;
	// A task the retention sweep removed is not still running, and there is nothing to refresh.
	const taskGone = taskId !== undefined && isNotFound(task.error);
	const taskGroupGone = taskGroupId !== undefined && isNotFound(taskGroup.error);
	// Auto Review judging this call keeps the card in progress: it is not a user-facing approval yet.
	const reviewing =
		!returned &&
		(followedTask?.phase === "reviewing" ||
			followedTaskGroup?.phase === "reviewing" ||
			(sessionActive && reviewingDetails(item.details)));
	const spinning =
		reviewing ||
		(!returned &&
			!taskGone &&
			!taskGroupGone &&
			callStillOpen({ sessionActive, taskState: followedTask?.state, taskGroupState: followedTaskGroup?.state }));
	const followed = taskId !== undefined || taskGroupId !== undefined;
	const followedGone = taskGone || taskGroupGone;
	const { refetch: refetchTask } = task;
	const { refetch: refetchTaskGroup } = taskGroup;
	// Re-read the followed task or group every few seconds while the card spins, and once more when it stops
	// (the session went idle), so a stopped card shows how the task ended.
	useEffect(() => {
		if (!followed) return;
		const refresh = () => {
			if (taskId !== undefined) void refetchTask();
			if (taskGroupId !== undefined) void refetchTaskGroup();
		};
		if (!spinning) {
			if (!followedGone) refresh();
			return;
		}
		const timer = setInterval(refresh, FOLLOW_INTERVAL_MS);
		return () => clearInterval(timer);
	}, [followed, spinning, followedGone, taskId, taskGroupId, refetchTask, refetchTaskGroup]);
	// What a stopped call's task or group ended with: its failure, `done`, or undefined when nothing is known.
	let outcome: ToolFailure | "done" | undefined;
	if (!returned && !spinning) {
		if (followedTask !== undefined && isTerminal(followedTask.state)) {
			outcome = taskViewFailure(followedTask) ?? "done";
		} else if (followedTaskGroup !== undefined && taskGroupEnded(followedTaskGroup.state)) {
			outcome = taskGroupViewFailure(followedTaskGroup) ?? "done";
		}
	}
	// A task failure is a failed card even though the call itself returned normally.
	const failed = returned
		? resultOutcome === undefined
			? result.isError || failure !== undefined
			: resultOutcome.failed
		: outcome !== undefined && outcome !== "done";
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
	// The server's outcome names the result; a group whose members disagree says so.
	const failureLabel = (value: ToolFailure): string =>
		value.kind === "partly-failed" ? t`Partly failed` : taskOutcomeText(i18n, value.outcome);
	const followedOutcome =
		followedTask?.outcome ?? (followedTaskGroup === undefined ? undefined : followedTaskGroup.outcome);
	let statusLabel: string;
	if (returned) {
		if (failure !== undefined) statusLabel = failureLabel(failure);
		else if (resultOutcome !== undefined) statusLabel = taskOutcomeText(i18n, resultOutcome);
		else statusLabel = failed ? t`Failed` : t`Done`;
	} else if (spinning) statusLabel = t`Running`;
	else if (outcome === undefined) statusLabel = t`No result`;
	else if (outcome === "done")
		statusLabel =
			followedOutcome === null || followedOutcome === undefined ? t`Done` : taskOutcomeText(i18n, followedOutcome);
	else statusLabel = failureLabel(outcome);
	const line = toolLine(item.name, item.args);
	const rest = line.slice(item.name.length);
	const image = item.name === "view_image" ? viewImageDetails(result?.details ?? item.details) : undefined;
	const liveOutput = result === undefined ? streams.tool(item.callId) : undefined;

	return (
		<div className="text-xs" data-testid="tool-card" data-tool-status={status}>
			<div className="flex items-center gap-1">
				<button
					type="button"
					data-testid="tool-toggle"
					aria-haspopup="dialog"
					onClick={() => setOpen(true)}
					className="group flex min-w-0 flex-1 items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
				>
					<ToolStatusIcon spinning={spinning} failed={failed} label={statusLabel} />
					<span className="min-w-0 flex-1 truncate font-mono text-xs" title={line}>
						<span className="font-medium">{item.name}</span>
						{image === undefined ? (
							rest
						) : (
							<span className="ml-1.5 inline-flex items-center gap-1.5 font-sans" data-testid="view-image-summary">
								{"library" in image.source ? (
									<Link
										to="/library/$library"
										params={{ library: image.source.library }}
										search={{
											path: image.source.path.includes("/")
												? image.source.path.slice(0, image.source.path.lastIndexOf("/"))
												: "",
										}}
										className="underline underline-offset-2"
										title={image.source.path}
									>
										{image.source.library}
									</Link>
								) : (
									<span title={image.source.path}>{image.source.node}</span>
								)}
								<span className="text-muted-foreground">{image.source.path}</span>
								<span>
									{image.width}×{image.height}
								</span>
								<span>{formatBytes(image.bytes, i18n.locale)}</span>
								<span className="font-mono text-muted-foreground" title={image.sha256}>
									{image.sha256.slice(0, 12)}
								</span>
							</span>
						)}
					</span>
					{reviewing && (
						<span data-testid="tool-reviewing" className="shrink-0 text-xs text-muted-foreground">
							<Trans>Auto Review is reviewing…</Trans>
						</span>
					)}
				</button>
			</div>
			<ToolDialog item={item} open={open} onOpenChange={setOpen} liveOutput={liveOutput} reviewing={reviewing} />
		</div>
	);
}
