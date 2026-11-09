import type { TaskGroupView } from "@crh/api";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { ApprovalCard, DecisionView } from "@/components/approval-card";
import { DataTable, type DataTableColumn } from "@/components/data-table";
import { NodeTargetList } from "@/components/node-targets";
import { StatusText, TaskStatusBadge } from "@/components/status-badge";
import { TaskOutcomeText } from "@/components/task-result";
import { Badge } from "@/components/ui/badge";
import { useApprovalLookups, useDecideApproval } from "@/features/approvals/api";
import { useAuth } from "@/features/auth/session";
import { AuthorizationWait } from "@/features/authorizations/authorization-wait";
import { taskGroupStatusTone } from "@/lib/status";
import { cn, MONO_CELL } from "@/lib/utils";

const GROUP_STATES: Record<string, MessageDescriptor> = {
	awaiting_approval: msg`Awaiting approval`,
	awaiting_authorization: msg`Awaiting authorization`,
	running: msg`Running`,
	finished: msg`Finished`,
	interrupted: msg`Interrupted`,
	rejected: msg`Rejected`,
	cancelled: msg`Cancelled`,
};

/** The status of a task group; an unknown state keeps its raw name visible. */
export function TaskGroupStatus({ state }: { state: string }) {
	const { i18n } = useLingui();
	const label = GROUP_STATES[state];
	return <StatusText tone={taskGroupStatusTone(state)}>{label === undefined ? state : i18n._(label)}</StatusText>;
}

/**
 * The result of one task group (doc/webui.md "Task group"): its state, the
 * group approval or signature when it waits, and one row per node with the
 * task's outcome and its full result. Shared by the task-group page and the
 * batch run.
 */
export function TaskGroupResult({
	taskGroup,
	names,
	onChanged,
}: {
	taskGroup: TaskGroupView;
	names: Map<string, string>;
	onChanged?: () => void;
}) {
	const currentUser = useAuth().user;
	const lookups = useApprovalLookups();
	const decide = useDecideApproval();
	const { t } = useLingui();
	const nodeName = (id: string) => names.get(id) ?? id;
	const skipped = taskGroup.skipped.map(nodeName).join(", ");
	// A shared session's viewers see the task group but may not decide it or sign for its owner.
	const canAct = currentUser?.kind === "admin" || taskGroup.onBehalfOfUserId === currentUser?.id;
	const canSign = taskGroup.onBehalfOfUserId === currentUser?.id;
	const columns: DataTableColumn<TaskGroupView["tasks"][number]>[] = [
		{
			id: "node",
			header: t`Node`,
			minSize: 140,
			cell: ({ row }) => nodeName(row.original.nodeId),
			meta: { title: (task: TaskGroupView["tasks"][number]) => nodeName(task.nodeId) },
		},
		{
			id: "state",
			header: t`Status`,
			size: 90,
			cell: ({ row }) => <TaskStatusBadge state={row.original.state} />,
		},
		{
			id: "outcome",
			header: t`Outcome`,
			minSize: 140,
			cell: ({ row }) => <TaskOutcomeText task={row.original} />,
		},
	];

	return (
		<section className="grid gap-3" data-testid="task-group-result" data-group-id={taskGroup.id}>
			<div className="flex flex-wrap items-center gap-2">
				<h2 className="text-sm font-medium">
					<Trans>Result</Trans>
				</h2>
				<TaskGroupStatus state={taskGroup.state} />
				{taskGroup.privileged && (
					<Badge variant="secondary">
						<Trans>Privileged</Trans>
					</Badge>
				)}
				<span className="text-xs text-muted-foreground">
					<Plural value={taskGroup.nodeIds.length} one="# node" other="# nodes" />
				</span>
			</div>

			{(taskGroup.summary !== undefined || taskGroup.kind !== undefined) && (
				<p className={cn(MONO_CELL, "text-muted-foreground break-words [overflow-wrap:anywhere]")}>
					{taskGroup.summary ?? taskGroup.kind}
				</p>
			)}

			<p className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground" data-testid="task-group-targets">
				<Trans>Targets:</Trans>
				<NodeTargetList ids={taskGroup.targets} refs={taskGroup.refs} nodeNames={names} />
			</p>

			{taskGroup.state === "awaiting_approval" && canAct && (
				<ApprovalCard
					item={{ kind: "task_group", taskGroup }}
					nodeNames={lookups.nodeNames}
					refNames={lookups.refNames}
					tokenNames={lookups.tokenNames}
					userNames={lookups.userNames}
					busy={decide.isPending}
					error={decide.error}
					onDecide={(body) => decide.mutate({ kind: "task_group", id: taskGroup.id, body })}
				/>
			)}

			{taskGroup.state === "awaiting_authorization" && canSign && (
				<AuthorizationWait
					kind="task_group"
					id={taskGroup.id}
					onChanged={onChanged}
					waiting={
						<p className="text-sm text-muted-foreground">
							<Trans>Waiting for the owner's authorization; the payload is being prepared.</Trans>
						</p>
					}
				/>
			)}

			{taskGroup.state === "rejected" && taskGroup.approval?.decision && (
				<DecisionView
					decision={taskGroup.approval.decision}
					tokenNames={lookups.tokenNames}
					userNames={lookups.userNames}
				/>
			)}

			<DataTable
				label={t`Tasks in this task group`}
				columns={columns}
				data={taskGroup.tasks}
				getRowId={(task) => task.id}
				rowLink={(task) => ({ to: "/tasks/$taskId", params: { taskId: task.id } })}
				rowLabel={(task) => nodeName(task.nodeId)}
				rowData={(task) => ({ "data-testid": "task-group-member", "data-task-id": task.id })}
			/>

			{taskGroup.skipped.length > 0 && (
				<p className="text-xs text-muted-foreground break-words [overflow-wrap:anywhere]">
					<Trans>Skipped: {skipped}</Trans>
					{taskGroup.state === "interrupted" && <Trans> (the batch was interrupted)</Trans>}
					{taskGroup.state === "cancelled" && <Trans> (the batch was cancelled)</Trans>}
				</p>
			)}
		</section>
	);
}
