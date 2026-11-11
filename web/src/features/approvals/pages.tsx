import type { QuotaApproval, RefMap, TaskGroupView, TaskView } from "@crh/api";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Link, useParams } from "@tanstack/react-router";
import { ArrowLeftIcon } from "lucide-react";
import { useMemo } from "react";
import { DataTable, type DataTableColumn, type DataTableRowLink } from "@/components/data-table";
import { ApprovalDecision } from "@/components/decision";
import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { NodeTargetList } from "@/components/node-targets";
import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";
import { RelativeTime } from "@/components/relative-time";
import { PageSkeleton } from "@/components/skeletons";
import { TaskStatusBadge } from "@/components/status-badge";
import { UserLink } from "@/components/user-link";
import { SignatureWait } from "@/features/authorizations/signature-wait";
import { sessionTitle } from "@/features/sessions/session-item";
import { TaskGroupStatus } from "@/features/tasks/task-group-result";
import { taskTitle } from "@/features/tasks/title";
import { cn, linkClass, MONO_CELL } from "@/lib/utils";
import { useApprovalLookups, useApprovals, useApprovalTask, useApprovalTaskGroup, useDecideApproval } from "./api";
import { actorLabel } from "./rules";

/** What kind of decision a row holds; the table's first column. */
type DecisionType = "approval" | "signature" | "quota";

const TYPE_LABELS: Record<DecisionType, MessageDescriptor> = {
	approval: msg`Approval`,
	signature: msg`Signature`,
	quota: msg`Quota`,
};

/** One row of the approvals table: a task, task group or session whose decision waits for the user. */
interface DecisionRow {
	key: string;
	type: DecisionType;
	operation: string;
	nodes: string[];
	refs?: RefMap;
	actor?: { type: string; id: string };
	requestedAt: string;
	link: DataTableRowLink;
	label: string;
}

function taskRow(type: "approval" | "signature", task: TaskView): DecisionRow {
	return {
		key: `${type}:task:${task.id}`,
		type,
		operation: taskTitle(task),
		nodes: [task.nodeId],
		actor: { type: task.actorType, id: task.actorId },
		requestedAt: task.createdAt,
		link: { to: "/approvals/tasks/$taskId", params: { taskId: task.id } },
		label: taskTitle(task),
	};
}

function taskGroupRow(type: "approval" | "signature", taskGroup: TaskGroupView): DecisionRow {
	return {
		key: `${type}:task-group:${taskGroup.id}`,
		type,
		operation: taskTitle(taskGroup),
		nodes: taskGroup.targets,
		refs: taskGroup.refs,
		actor: { type: taskGroup.actorType, id: taskGroup.actorId },
		requestedAt: taskGroup.createdAt,
		link: { to: "/approvals/task-groups/$taskGroupId", params: { taskGroupId: taskGroup.id } },
		label: taskTitle(taskGroup),
	};
}

function quotaRow(wait: QuotaApproval, defaultTitle: string): DecisionRow {
	const title = sessionTitle(wait, defaultTitle);
	return {
		key: `quota:${wait.sessionId}`,
		type: "quota",
		operation: title,
		nodes: [],
		requestedAt: wait.since,
		link: { to: "/sessions/$sessionId", params: { sessionId: wait.sessionId } },
		label: title,
	};
}

/** The readable full text of a node list for a cell's tooltip. */
function nodeNamesText(ids: readonly string[], names: Map<string, string>): string | undefined {
	const text = ids.map((id) => names.get(id) ?? id).join(", ");
	return text === "" ? undefined : text;
}

/** The actor that asked for a task, or a dash when the row has none (a quota wait). */
function AskedBy({
	row,
	userNames,
	tokenNames,
}: {
	row: DecisionRow;
	userNames: Map<string, string>;
	tokenNames: Map<string, string>;
}) {
	if (row.actor === undefined) return <>–</>;
	if (row.actor.type === "user") return <UserLink id={row.actor.id} name={userNames.get(row.actor.id)} />;
	return <span className="truncate">{actorLabel(row.actor.type, row.actor.id, tokenNames)}</span>;
}

/**
 * The Approvals page (doc/design/webui.md "Approvals page"): one table of everything waiting for this
 * user — task approvals, task-group approvals, tasks waiting for the user's
 * signature and roots whose token quota is used up. A row opens the matching
 * detail page, where the decision itself is made. The sidebar badge counts the
 * same rows (`pending.ts`).
 */
export function ApprovalsPage() {
	const { t, i18n } = useLingui();
	const approvals = useApprovals();
	const lookups = useApprovalLookups();
	const data = approvals.data;

	const rows = useMemo(() => {
		if (data === undefined) return [];
		const quotaDefault = t`New Session`;
		return [
			...data.tasks.map((task) => taskRow("approval", task)),
			...data.taskGroups.map((taskGroup) => taskGroupRow("approval", taskGroup)),
			...data.authorizations.tasks.map((task) => taskRow("signature", task)),
			...data.authorizations.taskGroups.map((taskGroup) => taskGroupRow("signature", taskGroup)),
			...data.quotas.map((wait) => quotaRow(wait, quotaDefault)),
		];
	}, [data, t]);

	const columns = useMemo<DataTableColumn<DecisionRow>[]>(
		() => [
			{
				id: "type",
				header: t`Type`,
				size: 100,
				cell: ({ row }) => i18n._(TYPE_LABELS[row.original.type]),
			},
			{
				id: "operation",
				header: t`Operation`,
				minSize: 160,
				cell: ({ row }) => <span className={cn("truncate", MONO_CELL)}>{row.original.operation}</span>,
				meta: { title: (row: DecisionRow) => row.operation },
			},
			{
				id: "nodes",
				header: t`Nodes`,
				minSize: 120,
				cell: ({ row }) => {
					if (row.original.nodes.length === 0) return <span className="text-muted-foreground">–</span>;
					if (row.original.refs !== undefined) {
						return (
							<NodeTargetList
								ids={row.original.nodes}
								refs={row.original.refs}
								nodeNames={lookups.nodeNames}
								className="flex-nowrap"
							/>
						);
					}
					const id = row.original.nodes[0] ?? "";
					return <span className="truncate">{lookups.nodeNames.get(id) ?? id}</span>;
				},
				meta: {
					title: (row: DecisionRow) => nodeNamesText(row.nodes, lookups.nodeNames),
				},
			},
			{
				id: "asked-by",
				header: t`Asked by`,
				size: 140,
				cell: ({ row }) => <AskedBy row={row.original} userNames={lookups.userNames} tokenNames={lookups.tokenNames} />,
			},
			{
				id: "requested",
				header: t`Requested`,
				size: 120,
				cell: ({ row }) => <RelativeTime value={row.original.requestedAt} />,
			},
		],
		[t, i18n, lookups.nodeNames, lookups.userNames, lookups.tokenNames],
	);

	return (
		<Page data-testid="approvals-page">
			<PageHeader title={<Trans>Approvals</Trans>} />
			<DataTable
				label={t`Waiting for you`}
				columns={columns}
				data={rows}
				getRowId={(row) => row.key}
				loading={approvals.isLoading}
				error={approvals.isError ? approvals.error : undefined}
				onRetry={() => void approvals.refetch()}
				rowLink={(row) => row.link}
				rowLabel={(row) => row.label}
				rowLinkColumn="operation"
				empty={
					<EmptyState
						bare
						title={<Trans>Nothing is waiting for you</Trans>}
						description={<Trans>New requests appear here and in the sidebar badge.</Trans>}
					/>
				}
			/>
		</Page>
	);
}

function Settled({
	status,
	title,
	children,
}: {
	status: React.ReactNode;
	title: React.ReactNode;
	children?: React.ReactNode;
}) {
	return (
		<div className="grid gap-2 rounded-lg border p-4">
			<h1 className="text-lg font-semibold break-words [overflow-wrap:anywhere]">{title}</h1>
			<p className="flex flex-wrap items-center gap-2 text-sm">
				<Trans>This request is no longer waiting for approval; it is</Trans> {status}
			</p>
			{children}
		</div>
	);
}

function DetailPending() {
	return (
		<Page width="detail">
			<PageSkeleton />
		</Page>
	);
}

/** A deep link to one task's approval or signature wait (MCP returns these paths). */
export function ApprovalTaskPage() {
	const params = useParams({ strict: false }) as { taskId?: string };
	const task = useApprovalTask(params.taskId);
	const lookups = useApprovalLookups();
	const decide = useDecideApproval();
	if (task.isPending) return <DetailPending />;
	if (task.error !== null && task.error !== undefined) {
		return (
			<Page width="detail">
				<ErrorState error={task.error} retry={() => void task.refetch()} />
			</Page>
		);
	}
	if (!task.data) return null;
	const view = task.data;
	return (
		<Page width="detail" data-testid="approval-detail">
			<div>
				<Link
					to="/approvals"
					className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
				>
					<ArrowLeftIcon className="size-3.5" />
					<Trans>All approvals</Trans>
				</Link>
			</div>
			{view.state === "awaiting_approval" ? (
				<ApprovalDecision
					item={{ kind: "task", task: view }}
					nodeNames={lookups.nodeNames}
					refNames={lookups.refNames}
					tokenNames={lookups.tokenNames}
					busy={decide.isPending}
					error={decide.error}
					onDecide={(body) => decide.mutate({ kind: "task", id: view.id, body })}
				/>
			) : view.state === "awaiting_authorization" ? (
				<SignatureWait
					kind="task"
					id={view.id}
					item={{ kind: "task", task: view }}
					nodeNames={lookups.nodeNames}
					onChanged={() => void task.refetch()}
				/>
			) : (
				<Settled status={<TaskStatusBadge state={view.state} />} title={<Trans>Already settled</Trans>}>
					<Link to="/tasks/$taskId" params={{ taskId: view.id }} className={linkClass}>
						<Trans>Open the task</Trans>
					</Link>
				</Settled>
			)}
		</Page>
	);
}

export function ApprovalTaskGroupPage() {
	const params = useParams({ strict: false }) as { taskGroupId?: string };
	const taskGroup = useApprovalTaskGroup(params.taskGroupId);
	const lookups = useApprovalLookups();
	const decide = useDecideApproval();
	if (taskGroup.isPending) return <DetailPending />;
	if (taskGroup.error !== null && taskGroup.error !== undefined) {
		return (
			<Page width="detail">
				<ErrorState error={taskGroup.error} retry={() => void taskGroup.refetch()} />
			</Page>
		);
	}
	if (!taskGroup.data) return null;
	const view = taskGroup.data;
	return (
		<Page width="detail" data-testid="approval-detail">
			<div>
				<Link
					to="/approvals"
					className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
				>
					<ArrowLeftIcon className="size-3.5" />
					<Trans>All approvals</Trans>
				</Link>
			</div>
			{view.state === "awaiting_approval" ? (
				<ApprovalDecision
					item={{ kind: "task_group", taskGroup: view }}
					nodeNames={lookups.nodeNames}
					refNames={lookups.refNames}
					tokenNames={lookups.tokenNames}
					busy={decide.isPending}
					error={decide.error}
					onDecide={(body) => decide.mutate({ kind: "task_group", id: view.id, body })}
				/>
			) : view.state === "awaiting_authorization" ? (
				<SignatureWait
					kind="task_group"
					id={view.id}
					item={{ kind: "task_group", taskGroup: view }}
					nodeNames={lookups.nodeNames}
					onChanged={() => void taskGroup.refetch()}
				/>
			) : (
				<Settled status={<TaskGroupStatus state={view.state} />} title={<Trans>Already settled</Trans>}>
					<Link to="/task-groups/$taskGroupId" params={{ taskGroupId: view.id }} className={linkClass}>
						<Trans>Open the task group</Trans>
					</Link>
				</Settled>
			)}
		</Page>
	);
}
