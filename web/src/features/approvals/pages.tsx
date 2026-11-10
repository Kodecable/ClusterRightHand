import type { ApprovalBody, QuotaApproval, TaskGroupView, TaskView } from "@crh/api";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { Link, useParams } from "@tanstack/react-router";
import { ArrowLeftIcon } from "lucide-react";
import { ApprovalCard } from "@/components/approval-card";
import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { NodeTargetList } from "@/components/node-targets";
import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";
import { QuotaCard } from "@/components/quota-card";
import { CardSkeleton, PageSkeleton } from "@/components/skeletons";
import { TaskStatusBadge } from "@/components/status-badge";
import { useDecideQuota } from "@/features/sessions/api";
import { TaskGroupStatus } from "@/features/tasks/task-group-result";
import { taskTitle } from "@/features/tasks/title";
import { cn, linkClass } from "@/lib/utils";
import { useApprovalLookups, useApprovals, useApprovalTask, useApprovalTaskGroup, useDecideApproval } from "./api";
import { pendingCount } from "./pending";

/** A section that disappears entirely when it has nothing to show. */
function ApprovalSection({
	label,
	title,
	description,
	children,
	count,
}: {
	label: string;
	title: React.ReactNode;
	description?: React.ReactNode;
	children: React.ReactNode;
	count: number;
}) {
	if (count === 0) return null;
	return (
		<section className="grid gap-2" aria-label={label} data-testid={`approvals-section-${label}`}>
			<div className="flex items-baseline gap-2">
				<h2 className="text-sm font-medium">{title}</h2>
				<span className="text-xs text-muted-foreground">
					<Plural value={count} one="# waiting" other="# waiting" />
				</span>
			</div>
			{description !== undefined && <p className="text-sm text-muted-foreground">{description}</p>}
			<div className="grid gap-2">{children}</div>
		</section>
	);
}

function TaskCards({
	tasks,
	nodeNames,
	refNames,
	tokenNames,
	userNames,
}: {
	tasks: TaskView[];
	nodeNames: Map<string, string>;
	refNames: Map<string, string>;
	tokenNames: Map<string, string>;
	userNames: Map<string, string>;
}) {
	const decide = useDecideApproval();
	const onDecide = (id: string, body: ApprovalBody) => {
		decide.mutate({ kind: "task", id, body });
	};
	return (
		<>
			{tasks.map((task) => (
				<ApprovalCard
					key={task.id}
					item={{ kind: "task", task }}
					nodeNames={nodeNames}
					refNames={refNames}
					tokenNames={tokenNames}
					userNames={userNames}
					busy={decide.isPending && decide.variables?.id === task.id}
					error={decide.variables?.id === task.id ? decide.error : undefined}
					onDecide={(body) => onDecide(task.id, body)}
				/>
			))}
		</>
	);
}

function TaskGroupCards({
	taskGroups,
	nodeNames,
	refNames,
	tokenNames,
	userNames,
}: {
	taskGroups: TaskGroupView[];
	nodeNames: Map<string, string>;
	refNames: Map<string, string>;
	tokenNames: Map<string, string>;
	userNames: Map<string, string>;
}) {
	const decide = useDecideApproval();
	const onDecide = (id: string, body: ApprovalBody) => {
		decide.mutate({ kind: "task_group", id, body });
	};
	return (
		<>
			{taskGroups.map((taskGroup) => (
				<ApprovalCard
					key={taskGroup.id}
					item={{ kind: "task_group", taskGroup }}
					nodeNames={nodeNames}
					refNames={refNames}
					tokenNames={tokenNames}
					userNames={userNames}
					busy={decide.isPending && decide.variables?.id === taskGroup.id}
					error={decide.variables?.id === taskGroup.id ? decide.error : undefined}
					onDecide={(body) => onDecide(taskGroup.id, body)}
				/>
			))}
		</>
	);
}

function SignatureSection({
	tasks,
	taskGroups,
	nodeNames,
}: {
	tasks: TaskView[];
	taskGroups: TaskGroupView[];
	nodeNames: Map<string, string>;
}) {
	const { t } = useLingui();
	if (tasks.length + taskGroups.length === 0) return null;
	return (
		<section className="grid gap-2" aria-label={t`Waiting for your signature`} data-testid="signature-section">
			<h2 className="text-sm font-medium">
				<Trans>Waiting for your signature</Trans>
			</h2>
			<p className="text-sm text-muted-foreground">
				<Trans>These passed their rules; they run once you sign them.</Trans>
			</p>
			<ul className="grid gap-1">
				{tasks.map((task) => (
					<li key={task.id} className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-sm">
						<Link to="/tasks/$taskId" params={{ taskId: task.id }} className={cn("min-w-0 flex-1 truncate", linkClass)}>
							{taskTitle(task)} · {nodeNames.get(task.nodeId) ?? task.nodeId}
						</Link>
						<span>
							<Trans>Task</Trans>
						</span>
					</li>
				))}
				{taskGroups.map((taskGroup) => (
					<li key={taskGroup.id} className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-sm">
						<span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1">
							<Link
								to="/task-groups/$taskGroupId"
								params={{ taskGroupId: taskGroup.id }}
								className={cn("min-w-0 truncate", linkClass)}
							>
								{taskTitle(taskGroup) || t`task group`}
							</Link>
							<span className="text-muted-foreground">·</span>
							<NodeTargetList ids={taskGroup.targets} refs={taskGroup.refs} nodeNames={nodeNames} />
						</span>
						<span>
							<Trans>Task group</Trans>
						</span>
					</li>
				))}
			</ul>
		</section>
	);
}

function QuotaRow({ wait }: { wait: QuotaApproval }) {
	const decide = useDecideQuota(wait.sessionId);
	return (
		<QuotaCard
			wait={wait}
			busy={decide.isPending}
			error={decide.error}
			onDecide={(decision) => decide.mutate(decision)}
		/>
	);
}

/**
 * The Approvals page (doc/design/webui.md "Shared components"): everything that waits for this
 * user — task approvals, task-group approvals, privileged tasks waiting for a
 * signature and roots whose token quota is used up. Decisions go through the
 * shared cards and invalidate the queries, so the header badge updates too.
 */
export function ApprovalsPage() {
	const approvals = useApprovals();
	const lookups = useApprovalLookups();
	const data = approvals.data;
	const count = pendingCount(data);

	if (approvals.isPending) {
		return (
			<Page>
				<CardSkeleton />
				<CardSkeleton />
			</Page>
		);
	}
	if (approvals.error !== null && approvals.error !== undefined) {
		return (
			<Page>
				<ErrorState error={approvals.error} retry={() => void approvals.refetch()} />
			</Page>
		);
	}

	return (
		<Page data-testid="approvals-page">
			<PageHeader title={<Trans>Approvals</Trans>} />

			{data && count === 0 && (
				<EmptyState
					title={<Trans>Nothing is waiting for you</Trans>}
					description={<Trans>New requests appear here and in the sidebar badge.</Trans>}
				/>
			)}

			{data && data.tasks.length > 0 && (
				<ApprovalSection
					label="Task approvals"
					title={<Trans>Task approvals</Trans>}
					description={<Trans>These tasks were held back by a rule and run once you approve them.</Trans>}
					count={data.tasks.length}
				>
					<TaskCards
						tasks={data.tasks}
						nodeNames={lookups.nodeNames}
						refNames={lookups.refNames}
						tokenNames={lookups.tokenNames}
						userNames={lookups.userNames}
					/>
				</ApprovalSection>
			)}

			{data && data.taskGroups.length > 0 && (
				<ApprovalSection
					label="Task-group approvals"
					title={<Trans>Task-group approvals</Trans>}
					description={<Trans>One decision applies to every node in the task group.</Trans>}
					count={data.taskGroups.length}
				>
					<TaskGroupCards
						taskGroups={data.taskGroups}
						nodeNames={lookups.nodeNames}
						refNames={lookups.refNames}
						tokenNames={lookups.tokenNames}
						userNames={lookups.userNames}
					/>
				</ApprovalSection>
			)}

			{data && (
				<SignatureSection
					tasks={data.authorizations.tasks}
					taskGroups={data.authorizations.taskGroups}
					nodeNames={lookups.nodeNames}
				/>
			)}

			{data && data.quotas.length > 0 && (
				<ApprovalSection
					label="Token quotas used up"
					title={<Trans>Token quota used up</Trans>}
					description={<Trans>Add tokens to the paused run or stop it.</Trans>}
					count={data.quotas.length}
				>
					{data.quotas.map((wait) => (
						<QuotaRow key={wait.sessionId} wait={wait} />
					))}
				</ApprovalSection>
			)}
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

/** A deep link to one approval (MCP returns these paths). */
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
	const pending = task.data.state === "awaiting_approval";
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
			{pending ? (
				<ApprovalCard
					item={{ kind: "task", task: task.data }}
					nodeNames={lookups.nodeNames}
					refNames={lookups.refNames}
					tokenNames={lookups.tokenNames}
					userNames={lookups.userNames}
					busy={decide.isPending}
					error={decide.error}
					onDecide={(body) => decide.mutate({ kind: "task", id: task.data?.id ?? "", body })}
				/>
			) : (
				<Settled status={<TaskStatusBadge state={task.data.state} />} title={<Trans>Already settled</Trans>}>
					<Link to="/tasks/$taskId" params={{ taskId: task.data.id }} className={linkClass}>
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
	const pending = taskGroup.data.state === "awaiting_approval";
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
			{pending ? (
				<ApprovalCard
					item={{ kind: "task_group", taskGroup: taskGroup.data }}
					nodeNames={lookups.nodeNames}
					refNames={lookups.refNames}
					tokenNames={lookups.tokenNames}
					userNames={lookups.userNames}
					busy={decide.isPending}
					error={decide.error}
					onDecide={(body) => decide.mutate({ kind: "task_group", id: taskGroup.data?.id ?? "", body })}
				/>
			) : (
				<Settled status={<TaskGroupStatus state={taskGroup.data.state} />} title={<Trans>Already settled</Trans>}>
					<Link to="/task-groups/$taskGroupId" params={{ taskGroupId: taskGroup.data.id }} className={linkClass}>
						<Trans>Open the task group</Trans>
					</Link>
				</Settled>
			)}
		</Page>
	);
}
