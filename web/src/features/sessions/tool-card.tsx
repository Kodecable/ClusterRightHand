import { Trans, useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { DownloadIcon, LoaderCircleIcon, WrenchIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { useLibraries } from "@/features/library/api";
import { taskGroupEnded, useTask, useTaskGroup } from "@/features/tasks/api";
import { enc, isNotFound, queryString } from "@/lib/api/client";
import { formatBytes } from "@/lib/format";
import { isTerminal } from "@/lib/task-output";
import { cn } from "@/lib/utils";
import { callStillOpen, detailId, type ToolItem, toolLine } from "./tool-call";
import { type DeliveryDetails, deliveryDetails, viewImageDetails } from "./tool-details";
import { ToolDialog } from "./tool-dialog";
import { type ToolFailure, taskGroupViewFailure, taskViewFailure, toolResultFailure } from "./tool-failure";
import type { TranscriptStreams } from "./transcript-streams";

/**
 * Where a `copy_file to_user` delivery is downloaded from. A library is resolved by id when possible, so a
 * renamed group keeps the link; the server checks access when the link is clicked.
 */
function deliveryHref(source: DeliveryDetails["source"], ref: string | undefined): string {
	return "library" in source
		? `/api/libraries/${enc(ref ?? source.library)}/file${queryString({ path: source.path })}`
		: `/api/nodes/${enc(source.nodeId)}/file${queryString({ path: source.path })}`;
}

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
	const image = item.name === "view_image" ? viewImageDetails(result?.details ?? item.details) : undefined;
	const delivery = item.name === "copy_file" ? deliveryDetails(result?.details ?? item.details) : undefined;
	const deliveryLibraryId =
		delivery !== undefined && "library" in delivery.source ? delivery.source.libraryId : undefined;
	const deliveryLibraries = useLibraries(deliveryLibraryId !== undefined);
	const deliveryRef = deliveryLibraries.data?.find((library) => library.id === deliveryLibraryId)?.ref;
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
						{delivery !== undefined ? (
							<span className="ml-1.5 inline-flex min-w-0 items-center gap-1.5 font-sans" data-testid="copy-delivery">
								<span className="truncate font-medium text-foreground">{delivery.name}</span>
								<span className="truncate text-muted-foreground" title={delivery.source.path}>
									{"library" in delivery.source ? delivery.source.library : delivery.source.node} ·{" "}
									{delivery.source.path}
								</span>
								{delivery.bytes !== undefined && <span>{formatBytes(delivery.bytes, i18n.locale)}</span>}
							</span>
						) : image === undefined ? (
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
				</button>
				{delivery !== undefined && (
					<a
						href={deliveryHref(delivery.source, deliveryRef)}
						className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-xs text-muted-foreground hover:text-foreground"
						data-testid="copy-delivery-download"
						title={t`Download ${delivery.name}`}
					>
						<DownloadIcon className="size-3.5" aria-hidden="true" />
						<Trans>Download</Trans>
					</a>
				)}
			</div>
			<ToolDialog item={item} open={open} onOpenChange={setOpen} liveOutput={liveOutput} />
		</div>
	);
}
