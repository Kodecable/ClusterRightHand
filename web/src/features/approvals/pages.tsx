import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { Link, useParams } from "@tanstack/react-router";
import { toast } from "sonner";
import { ApprovalCard } from "@/components/approval-card";
import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";
import { QuotaCard } from "@/components/quota-card";
import { CardSkeleton } from "@/components/skeletons";
import { TaskStatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useDecideQuota } from "@/features/sessions/api";
import type { ApprovalBody, QuotaApproval, TaskGroupView, TaskView } from "@/lib/api/types";
import { useApprovalGroup, useApprovalLookups, useApprovals, useApprovalTask, useDecideApproval } from "./api";
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
				<h2 className="text-sm font-semibold">{title}</h2>
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
	tokenNames,
}: {
	tasks: TaskView[];
	nodeNames: Map<string, string>;
	tokenNames: Map<string, string>;
}) {
	const { t } = useLingui();
	const decide = useDecideApproval();
	const onDecide = (id: string, body: ApprovalBody) => {
		decide.mutate(
			{ kind: "task", id, body },
			{
				onSuccess: () => toast.success(t`Decision recorded.`),
				onError: (error) => toast.error(error.message),
			},
		);
	};
	return (
		<>
			{tasks.map((task) => (
				<ApprovalCard
					key={task.id}
					item={{ kind: "task", task }}
					nodeNames={nodeNames}
					tokenNames={tokenNames}
					busy={decide.isPending && decide.variables?.id === task.id}
					error={decide.variables?.id === task.id ? decide.error : undefined}
					onDecide={(body) => onDecide(task.id, body)}
				/>
			))}
		</>
	);
}

function GroupCards({
	groups,
	nodeNames,
	tokenNames,
}: {
	groups: TaskGroupView[];
	nodeNames: Map<string, string>;
	tokenNames: Map<string, string>;
}) {
	const { t } = useLingui();
	const decide = useDecideApproval();
	const onDecide = (id: string, body: ApprovalBody) => {
		decide.mutate(
			{ kind: "group", id, body },
			{
				onSuccess: () => toast.success(t`Decision recorded.`),
				onError: (error) => toast.error(error.message),
			},
		);
	};
	return (
		<>
			{groups.map((group) => (
				<ApprovalCard
					key={group.id}
					item={{ kind: "group", group }}
					nodeNames={nodeNames}
					tokenNames={tokenNames}
					busy={decide.isPending && decide.variables?.id === group.id}
					error={decide.variables?.id === group.id ? decide.error : undefined}
					onDecide={(body) => onDecide(group.id, body)}
				/>
			))}
		</>
	);
}

function SignatureSection({
	tasks,
	groups,
	nodeNames,
}: {
	tasks: TaskView[];
	groups: TaskGroupView[];
	nodeNames: Map<string, string>;
}) {
	const { t } = useLingui();
	if (tasks.length + groups.length === 0) return null;
	return (
		<section className="grid gap-2" aria-label={t`Waiting for your signature`} data-testid="signature-section">
			<h2 className="text-sm font-semibold">
				<Trans>Waiting for your signature</Trans>
			</h2>
			<p className="text-sm text-muted-foreground">
				<Trans>These passed their rules; they run once you sign them.</Trans>
			</p>
			<ul className="grid gap-1">
				{tasks.map((task) => (
					<li key={task.id} className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-sm">
						<Link
							to="/tasks/$taskId"
							params={{ taskId: task.id }}
							className="min-w-0 flex-1 truncate text-primary underline underline-offset-2"
						>
							{task.summary || task.kind} · {nodeNames.get(task.nodeId) ?? task.nodeId}
						</Link>
						<Badge variant="outline">
							<Trans>Task</Trans>
						</Badge>
					</li>
				))}
				{groups.map((group) => (
					<li key={group.id} className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-sm">
						<Link
							to="/task-groups/$taskGroupId"
							params={{ taskGroupId: group.id }}
							className="min-w-0 flex-1 truncate text-primary underline underline-offset-2"
						>
							{group.summary || group.kind || t`task group`} ·{" "}
							{group.nodeIds.map((id) => nodeNames.get(id) ?? id).join(", ")}
						</Link>
						<Badge variant="outline">
							<Trans>Task group</Trans>
						</Badge>
					</li>
				))}
			</ul>
		</section>
	);
}

function QuotaRow({ wait }: { wait: QuotaApproval }) {
	const { t } = useLingui();
	const decide = useDecideQuota(wait.sessionId);
	return (
		<QuotaCard
			wait={wait}
			busy={decide.isPending}
			error={decide.error}
			onDecide={(decision) =>
				decide.mutate(decision, {
					onSuccess: () => toast.success(t`Quota decision recorded.`),
					onError: (error) => toast.error(error.message),
				})
			}
		/>
	);
}

/**
 * The Approvals page (doc/webui.md "共享部件"): everything that waits for this
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
			<PageHeader
				title={<Trans>Approvals</Trans>}
				description={<Trans>Everything that waits for your approval, signature or quota decision.</Trans>}
			/>

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
					<TaskCards tasks={data.tasks} nodeNames={lookups.nodeNames} tokenNames={lookups.tokenNames} />
				</ApprovalSection>
			)}

			{data && data.taskGroups.length > 0 && (
				<ApprovalSection
					label="Task-group approvals"
					title={<Trans>Task-group approvals</Trans>}
					description={<Trans>One decision applies to every node in the group.</Trans>}
					count={data.taskGroups.length}
				>
					<GroupCards groups={data.taskGroups} nodeNames={lookups.nodeNames} tokenNames={lookups.tokenNames} />
				</ApprovalSection>
			)}

			{data && (
				<SignatureSection
					tasks={data.authorizations.tasks}
					groups={data.authorizations.taskGroups}
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

function Settled({ state, title, children }: { state: string; title: React.ReactNode; children?: React.ReactNode }) {
	return (
		<div className="grid gap-2 rounded-lg border p-4">
			<h1 className="text-lg font-semibold">{title}</h1>
			<p className="flex flex-wrap items-center gap-2 text-sm">
				<Trans>This request is no longer waiting for approval; it is</Trans> <TaskStatusBadge state={state} />
			</p>
			{children}
		</div>
	);
}

function DetailPending() {
	return (
		<p className="p-4 text-sm text-muted-foreground" role="status">
			<Trans>Loading…</Trans>
		</p>
	);
}

/** A deep link to one approval (MCP returns these paths). */
export function ApprovalTaskPage() {
	const params = useParams({ strict: false }) as { taskId?: string };
	const task = useApprovalTask(params.taskId);
	const lookups = useApprovalLookups();
	const decide = useDecideApproval();
	const { t } = useLingui();
	if (task.isPending) return <DetailPending />;
	if (task.error !== null && task.error !== undefined) {
		return (
			<div className="p-4">
				<ErrorState error={task.error} retry={() => void task.refetch()} />
			</div>
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
					<Trans>← Approvals</Trans>
				</Link>
			</div>
			{pending ? (
				<ApprovalCard
					item={{ kind: "task", task: task.data }}
					nodeNames={lookups.nodeNames}
					tokenNames={lookups.tokenNames}
					busy={decide.isPending}
					error={decide.error}
					onDecide={(body) =>
						decide.mutate(
							{ kind: "task", id: task.data?.id ?? "", body },
							{
								onSuccess: () => toast.success(t`Decision recorded.`),
								onError: (error) => toast.error(error.message),
							},
						)
					}
				/>
			) : (
				<Settled state={task.data.state} title={<Trans>Already settled</Trans>}>
					<Button
						render={<Link to="/tasks/$taskId" params={{ taskId: task.data.id }} />}
						variant="outline"
						size="sm"
						nativeButton={false}
					>
						<Trans>Open the task</Trans>
					</Button>
				</Settled>
			)}
		</Page>
	);
}

export function ApprovalTaskGroupPage() {
	const params = useParams({ strict: false }) as { taskGroupId?: string };
	const group = useApprovalGroup(params.taskGroupId);
	const lookups = useApprovalLookups();
	const decide = useDecideApproval();
	const { t } = useLingui();
	if (group.isPending) return <DetailPending />;
	if (group.error !== null && group.error !== undefined) {
		return (
			<div className="p-4">
				<ErrorState error={group.error} retry={() => void group.refetch()} />
			</div>
		);
	}
	if (!group.data) return null;
	const pending = group.data.state === "awaiting_approval";
	return (
		<Page width="detail" data-testid="approval-detail">
			<div>
				<Link
					to="/approvals"
					className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
				>
					<Trans>← Approvals</Trans>
				</Link>
			</div>
			{pending ? (
				<ApprovalCard
					item={{ kind: "group", group: group.data }}
					nodeNames={lookups.nodeNames}
					tokenNames={lookups.tokenNames}
					busy={decide.isPending}
					error={decide.error}
					onDecide={(body) =>
						decide.mutate(
							{ kind: "group", id: group.data?.id ?? "", body },
							{
								onSuccess: () => toast.success(t`Decision recorded.`),
								onError: (error) => toast.error(error.message),
							},
						)
					}
				/>
			) : (
				<Settled state={group.data.state} title={<Trans>Already settled</Trans>}>
					<Button
						render={<Link to="/task-groups/$taskGroupId" params={{ taskGroupId: group.data.id }} />}
						variant="outline"
						size="sm"
						nativeButton={false}
					>
						<Trans>Open the task group</Trans>
					</Button>
				</Settled>
			)}
		</Page>
	);
}
