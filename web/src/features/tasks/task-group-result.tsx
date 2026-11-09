import type { TaskGroupView } from "@crh/api";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { ApprovalCard, DecisionView } from "@/components/approval-card";
import { DataTable, type DataTableColumn } from "@/components/data-table";
import { StatusText, TaskStatusBadge } from "@/components/status-badge";
import { TaskOutcomeText } from "@/components/task-result";
import { useApprovalLookups, useDecideApproval } from "@/features/approvals/api";
import { useAuth } from "@/features/auth/session";
import { AuthorizationWait } from "@/features/authorizations/authorization-wait";
import { taskGroupStatusTone } from "@/lib/status";

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
 * The targets that never ran, under the page title: the group's own state line
 * only says interrupted/cancelled, so this is where the skipped nodes are named.
 * Rendered as one short line; the member table already shows every task.
 */
export function TaskGroupSkippedNotice({ taskGroup, names }: { taskGroup: TaskGroupView; names: Map<string, string> }) {
	if (taskGroup.skipped.length === 0) return null;
	const skipped = taskGroup.skipped.map((id) => names.get(id) ?? id).join(", ");
	return (
		<p className="text-sm text-muted-foreground break-words [overflow-wrap:anywhere]" data-testid="task-group-skipped">
			<Trans>Skipped: {skipped}</Trans>
			{taskGroup.state === "interrupted" && <Trans> (the batch was interrupted)</Trans>}
			{taskGroup.state === "cancelled" && <Trans> (the batch was cancelled)</Trans>}
		</p>
	);
}

/**
 * The result of one task group (doc/webui.md "Task group"): its approval,
 * signature or decision, then one row per node with the task's status and
 * outcome. The page title and status live above; the summary, target list and
 * counts would repeat what the title and rows already say.
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
		</section>
	);
}
