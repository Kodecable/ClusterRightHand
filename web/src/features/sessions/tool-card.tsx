import { useLingui } from "@lingui/react/macro";
import { LoaderCircleIcon, WrenchIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { taskGroupEnded, useTask, useTaskGroup } from "@/features/tasks/api";
import { isTerminal } from "@/features/tasks/output";
import { isNotFound } from "@/lib/api/client";
import { cn } from "@/lib/utils";
import { callStillOpen, detailId, type ToolItem, toolLine } from "./tool-call";
import { ToolDialog } from "./tool-dialog";
import { type ToolFailure, taskGroupViewFailure, taskViewFailure, toolResultFailure } from "./tool-failure";
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
	const { t } = useLingui();
	const [open, setOpen] = useState(false);

	const result = item.result;
	const returned = result !== undefined;
	const failure = result === undefined ? undefined : toolResultFailure(result);
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
	const spinning =
		!returned &&
		!taskGone &&
		!taskGroupGone &&
		callStillOpen({ sessionActive, taskState: followedTask?.state, taskGroupState: followedTaskGroup?.state });
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
	const line = toolLine(item.name, item.args);
	const rest = line.slice(item.name.length);
	const liveOutput = result === undefined ? streams.tool(item.callId) : undefined;

	return (
		<div className="text-xs" data-testid="tool-card" data-tool-status={status}>
			<button
				type="button"
				data-testid="tool-toggle"
				aria-haspopup="dialog"
				onClick={() => setOpen(true)}
				className="group flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
			>
				<ToolStatusIcon spinning={spinning} failed={failed} label={statusLabel} />
				<span className="min-w-0 flex-1 truncate font-mono text-xs" title={line}>
					<span className="font-medium">{item.name}</span>
					{rest}
				</span>
			</button>
			<ToolDialog item={item} open={open} onOpenChange={setOpen} liveOutput={liveOutput} />
		</div>
	);
}
