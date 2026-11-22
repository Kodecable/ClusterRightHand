import type { JobView } from "@crh/api";
import { Trans, useLingui } from "@lingui/react/macro";
import { CodeText } from "@/components/code-text";
import { InternalLink } from "@/components/internal-link";
import { Dialog, DialogContent, DialogHeader, DialogScrollArea, DialogTitle } from "@/components/ui/dialog";
import { jobResourceLink } from "@/features/jobs/job";
import { safeInternalPath } from "@/lib/url";
import { detailId, resultId, type ToolItem } from "./tool-call";
import { approvalWait, prettyJson, reviewingDetails } from "./tool-details";

/**
 * The dialog a tool card opens: the call's arguments, the returned result, and plain links to the task, task
 * group or subagent session the call names. A call that has not returned shows no result section; the
 * composer dock already shows approval and signature waits, and the card follows a live task.
 */
export function ToolDialog({
	item,
	job,
	open,
	onOpenChange,
}: {
	item: ToolItem;
	/** The job a job-backed call follows; its resource page is the one link the dialog offers for it. */
	job?: JobView;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const { t } = useLingui();
	const result = item.result;
	const returned = result !== undefined;
	const jobLink = job === undefined ? undefined : jobResourceLink(job.resource);
	const subagent =
		item.details !== null && typeof item.details === "object" && !Array.isArray(item.details)
			? item.details.sessionId
			: undefined;
	const subagentId = jobLink === undefined && typeof subagent === "string" && subagent !== "" ? subagent : undefined;
	const hasArgs = Object.keys(item.args).length > 0;
	// With a job, its resource page is the one link for the task, group or session; the details' ids would
	// duplicate it. Without one, the call's own details carry the links, as before.
	const taskId = jobLink === undefined ? (resultId(item, "task_id") ?? detailId(item.details, "task_id")) : undefined;
	const taskGroupId =
		jobLink === undefined ? (resultId(item, "task_group_id") ?? detailId(item.details, "task_group_id")) : undefined;
	// An extension call waiting for approval links to its approval page; task approvals live in the decision
	// dock and on their pages, and Auto Review's pending request is not the user's yet.
	const externalCallId = detailId(item.details, "external_call_id");
	const approvalUrl =
		externalCallId === undefined || reviewingDetails(item.details)
			? undefined
			: safeInternalPath(approvalWait(item.details)?.url);
	const hasLinks =
		jobLink !== undefined ||
		taskId !== undefined ||
		taskGroupId !== undefined ||
		subagentId !== undefined ||
		approvalUrl !== undefined;

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-2xl" data-testid="tool-dialog">
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
					{returned && (
						<div className="grid gap-1">
							<span className="text-[11px] font-medium text-muted-foreground">
								<Trans>Result</Trans>
							</span>
							<ToolResultContent result={result} />
						</div>
					)}
					{hasLinks && (
						<div className="flex flex-wrap items-center gap-3 text-xs" data-testid="tool-dialog-links">
							{jobLink !== undefined && job !== undefined && (
								<InternalLink to={jobLink.to} params={jobLink.params} className="text-xs">
									{job.resource.type === "task_group" ? (
										<Trans>Task group details</Trans>
									) : job.resource.type === "session" ? (
										<Trans>Subagent session</Trans>
									) : (
										<Trans>Task details</Trans>
									)}
								</InternalLink>
							)}
							{approvalUrl !== undefined && (
								<InternalLink href={approvalUrl} className="text-xs">
									<Trans>Review and approve</Trans>
								</InternalLink>
							)}
							{taskId !== undefined && (
								<InternalLink to="/tasks/$taskId" params={{ taskId }} className="text-xs">
									<Trans>Task details</Trans>
								</InternalLink>
							)}
							{taskGroupId !== undefined && (
								<InternalLink to="/task-groups/$taskGroupId" params={{ taskGroupId }} className="text-xs">
									<Trans>Task group details</Trans>
								</InternalLink>
							)}
							{subagentId !== undefined && (
								<InternalLink to="/sessions/$sessionId" params={{ sessionId: subagentId }} className="text-xs">
									<Trans>Subagent session</Trans>
								</InternalLink>
							)}
						</div>
					)}
				</DialogScrollArea>
			</DialogContent>
		</Dialog>
	);
}

/**
 * A returned tool result (doc/design/agent-runtime.md "Tool output"): one JSON block keeps the pretty JSON
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
