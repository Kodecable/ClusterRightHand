import { Trans, useLingui } from "@lingui/react/macro";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { ArrowLeftIcon, ShieldCheckIcon, SquareIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { ApprovalCard, DecisionView } from "@/components/approval-card";
import { AuthorizationCard } from "@/components/authorization-card";
import { DataTable, type DataTableColumn } from "@/components/data-table";
import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import type { KeyValueItem } from "@/components/key-value";
import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";
import { RelativeTime } from "@/components/relative-time";
import { TaskStatusBadge, taskStateLabel } from "@/components/status-badge";
import { TaskEvaluation, TaskFacts, TaskOutcomeText, TaskOutput } from "@/components/task-result";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useApprovalLookups, useApprovals, useDecideApproval } from "@/features/approvals/api";
import { pendingCount } from "@/features/approvals/pending";
import { usePendingAuthorization, useSubmitAuthorization } from "@/features/authorizations/api";
import { useNodes } from "@/features/nodes/api";
import { useDirectory } from "@/features/users/api";
import type { TaskView } from "@/lib/api/types";
import { taskActor } from "./actor";
import { useCancelTask, useTask, useTaskGroup, useTasks } from "./api";
import { isTerminal } from "./output";
import { TaskGroupResult } from "./task-group-result";

const STATES = [
	"awaiting_approval",
	"awaiting_authorization",
	"dispatched",
	"running",
	"exited",
	"failed",
	"rejected",
	"denied",
	"unknown",
];

function FilterSelect({
	id,
	label,
	value,
	onChange,
	options,
}: {
	id: string;
	label: string;
	value: string;
	onChange: (value: string) => void;
	options: { value: string; label: string }[];
}) {
	return (
		<div className="grid gap-1.5">
			<Label htmlFor={id}>{label}</Label>
			<Select value={value} onValueChange={(next) => onChange(String(next ?? "any"))}>
				<SelectTrigger id={id} size="sm" className="w-44">
					<SelectValue>
						{(current: string | null) => options.find((option) => option.value === current)?.label ?? ""}
					</SelectValue>
				</SelectTrigger>
				<SelectContent>
					{options.map((option) => (
						<SelectItem key={option.value} value={option.value}>
							{option.label}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</div>
	);
}

/**
 * All tasks the user can see (doc/webui.md "Tasks"): a cursor-paged table with
 * state / actor-type / node filters and a shortcut to the Approvals page, where
 * everything waiting for this user is handled.
 */
export function TasksPage() {
	const { t, i18n } = useLingui();
	const navigate = useNavigate();
	const nodes = useNodes();
	const directory = useDirectory();
	const approvals = useApprovals();
	const [state, setState] = useState("any");
	const [actorType, setActorType] = useState("any");
	const [nodeId, setNodeId] = useState("any");

	const tasks = useTasks({
		state: state === "any" ? undefined : state,
		actorType: actorType === "any" ? undefined : actorType,
		nodeId: nodeId === "any" ? undefined : nodeId,
	});
	const rows = useMemo(() => tasks.data?.pages.flatMap((page) => page.items) ?? [], [tasks.data]);
	const users = useMemo(
		() => new Map((directory.data?.users ?? []).map((user) => [user.id, user.displayName || user.username])),
		[directory.data],
	);
	const names = useMemo(() => new Map((nodes.data ?? []).map((node) => [node.id, node.name])), [nodes.data]);

	const columns = useMemo<DataTableColumn<TaskView>[]>(
		() => [
			{
				id: "created",
				header: t`Created`,
				size: 110,
				cell: ({ row }) => <RelativeTime value={row.original.createdAt} className="text-xs" />,
			},
			{
				id: "task",
				header: t`Task`,
				cell: ({ row }) => (
					<span className="flex min-w-0 items-center gap-1.5">
						<span className="truncate font-mono text-xs leading-5">{row.original.summary || row.original.kind}</span>
						{row.original.privileged && (
							<Badge variant="secondary">
								<Trans>Privileged</Trans>
							</Badge>
						)}
					</span>
				),
			},
			{
				id: "node",
				header: t`Node`,
				size: 140,
				cell: ({ row }) => (
					<span className="truncate text-xs leading-5">{names.get(row.original.nodeId) ?? row.original.nodeId}</span>
				),
			},
			{
				id: "actor",
				header: t`By`,
				size: 130,
				cell: ({ row }) => {
					const actor = taskActor(row.original, (id) => users.get(id));
					return (
						<span className="block truncate text-xs leading-5" title={actor.id ?? undefined}>
							{actor.name}
						</span>
					);
				},
			},
			{
				id: "state",
				header: t`State`,
				size: 160,
				cell: ({ row }) => (
					<TaskStatusBadge state={row.original.state} exitCode={row.original.exitCode} signal={row.original.signal} />
				),
			},
			{
				id: "outcome",
				header: t`Outcome`,
				size: 130,
				cell: ({ row }) => (
					<span className="truncate text-xs leading-5">
						<TaskOutcomeText task={row.original} />
					</span>
				),
			},
		],
		[names, t, users],
	);

	const actorTypes = [
		{ value: "any", label: t`Any actor` },
		{ value: "user", label: t`User` },
		{ value: "api_token", label: t`API token` },
		{ value: "agent", label: t`Agent` },
		{ value: "subagent", label: t`Subagent` },
		{ value: "schedule", label: t`Schedule` },
	];

	const waiting = pendingCount(approvals.data);

	return (
		<Page data-testid="tasks-page">
			<PageHeader
				title={<Trans>Tasks</Trans>}
				description={
					<Trans>
						Every task on the nodes you can see, newest first. Requests waiting for you are handled on the Approvals
						page.
					</Trans>
				}
			/>

			<div className="flex flex-wrap items-end gap-3">
				<FilterSelect
					id="task-filter-state"
					label={t`State`}
					value={state}
					onChange={setState}
					options={[
						{ value: "any", label: t`Any state` },
						...STATES.map((value) => ({ value, label: taskStateLabel(i18n, value) })),
					]}
				/>
				<FilterSelect
					id="task-filter-actor"
					label={t`Actor type`}
					value={actorType}
					onChange={setActorType}
					options={actorTypes}
				/>
				<FilterSelect
					id="task-filter-node"
					label={t`Node`}
					value={nodeId}
					onChange={setNodeId}
					options={[
						{ value: "any", label: t`Any node` },
						...(nodes.data ?? []).map((node) => ({ value: node.id, label: node.name })),
					]}
				/>
				<Button
					type="button"
					variant="outline"
					size="sm"
					data-testid="waiting-for-me"
					render={<Link to="/approvals" />}
				>
					<ShieldCheckIcon />
					<Trans>Waiting for me</Trans>
					{waiting > 0 && <Badge variant="secondary">{waiting}</Badge>}
				</Button>
			</div>

			<DataTable
				label={t`Tasks`}
				columns={columns}
				data={rows}
				getRowId={(task) => task.id}
				loading={tasks.isPending}
				error={tasks.error ?? undefined}
				onRetry={() => void tasks.refetch()}
				hasMore={tasks.hasNextPage ?? false}
				loadingMore={tasks.isFetchingNextPage}
				onLoadMore={() => void tasks.fetchNextPage()}
				onRowClick={(task) => void navigate({ to: "/tasks/$taskId", params: { taskId: task.id } })}
				empty={
					<EmptyState
						className="border-0 py-10"
						title={<Trans>No tasks yet</Trans>}
						description={<Trans>Run something on a node, or use the batch page.</Trans>}
					/>
				}
			/>
		</Page>
	);
}

/** A node link that shows the node's name, falling back to its id while the list loads. */
function NodeLink({ nodeId, names }: { nodeId: string; names: Map<string, string> }) {
	return (
		<Link to="/nodes/$nodeId" params={{ nodeId }} className="text-primary underline underline-offset-2">
			{names.get(nodeId) ?? nodeId}
		</Link>
	);
}

/** One task: header, one facts block, the approval or signature card, then the result (doc/webui.md "Task page"). */
export function TaskPage() {
	const { t } = useLingui();
	const params = useParams({ strict: false }) as { taskId?: string };
	const id = params.taskId ?? "";
	const task = useTask(id, true);
	const directory = useDirectory();
	const nodes = useNodes();
	const looks = useApprovalLookups();
	const decide = useDecideApproval();
	const pending = usePendingAuthorization("task", task.data?.state === "awaiting_authorization" ? id : undefined);
	const submit = useSubmitAuthorization();
	const cancel = useCancelTask(id);
	const names = useMemo(() => new Map((nodes.data ?? []).map((node) => [node.id, node.name])), [nodes.data]);

	if (task.isPending) {
		return (
			<p className="p-4 text-sm text-muted-foreground" role="status">
				<Trans>Loading…</Trans>
			</p>
		);
	}
	if (task.error !== null && task.error !== undefined) {
		return (
			<div className="p-4">
				<ErrorState error={task.error} retry={() => void task.refetch()} />
			</div>
		);
	}
	if (!task.data) return null;
	const view = task.data;
	const actor = taskActor(view, (uid) => (directory.data?.users ?? []).find((user) => user.id === uid)?.displayName);
	const running = !isTerminal(view.state);

	const links: KeyValueItem[] = [
		...(view.rootSessionId !== null && view.rootSessionId !== undefined
			? [
					{
						label: <Trans>Session</Trans>,
						value: (
							<Link
								to="/sessions/$sessionId"
								params={{ sessionId: view.rootSessionId }}
								className="font-mono text-xs text-primary underline underline-offset-2"
							>
								{view.rootSessionId}
							</Link>
						),
					},
				]
			: []),
		...(view.taskGroupId !== null && view.taskGroupId !== undefined
			? [
					{
						label: <Trans>Task group</Trans>,
						value: (
							<Link
								to="/task-groups/$taskGroupId"
								params={{ taskGroupId: view.taskGroupId }}
								className="font-mono text-xs text-primary underline underline-offset-2"
							>
								{view.taskGroupId}
							</Link>
						),
					},
				]
			: []),
	];

	return (
		<Page width="detail" data-testid="task-page">
			<div>
				<Link
					to="/tasks"
					className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
				>
					<ArrowLeftIcon className="size-3.5" />
					<Trans>All tasks</Trans>
				</Link>
			</div>
			<PageHeader
				title={
					<span className="font-mono" title={view.summary || view.kind}>
						{view.summary || view.kind}
					</span>
				}
				description={
					<span className="flex flex-wrap items-center gap-2">
						<TaskStatusBadge state={view.state} exitCode={view.exitCode} signal={view.signal} />
					</span>
				}
				actions={
					running ? (
						<Button
							type="button"
							variant="destructive"
							data-testid="cancel-task"
							disabled={cancel.isPending}
							onClick={() =>
								cancel.mutate(undefined, {
									onSuccess: () => toast.success(t`Task cancelled.`),
									onError: (error) => toast.error(error.message),
								})
							}
						>
							<SquareIcon />
							<Trans>Stop task</Trans>
						</Button>
					) : undefined
				}
			/>

			<section className="rounded-lg border p-3" aria-label={t`Task details`}>
				<TaskFacts
					task={view}
					showSummary={false}
					showState={false}
					showWaiting={false}
					showDecision={false}
					node={<NodeLink nodeId={view.nodeId} names={names} />}
					askedBy={
						<span className="flex flex-wrap items-center gap-1.5">
							<span>{actor.name}</span>
							<span className="font-mono text-xs text-muted-foreground">{actor.id}</span>
						</span>
					}
					extra={links}
				/>
			</section>

			{view.state === "awaiting_approval" && (
				<ApprovalCard
					item={{ kind: "task", task: view }}
					nodeNames={looks.nodeNames}
					tokenNames={looks.tokenNames}
					busy={decide.isPending}
					error={decide.error}
					showFacts={false}
					showHeading={false}
					onDecide={(body) =>
						decide.mutate(
							{ kind: "task", id: view.id, body },
							{
								onSuccess: () => {
									toast.success(t`Decision recorded.`);
									void task.refetch();
								},
								onError: (error) => toast.error(error.message),
							},
						)
					}
				/>
			)}

			{view.state === "awaiting_authorization" &&
				(pending.data?.pending ? (
					<AuthorizationCard
						pending={pending.data.pending}
						kind="task"
						onSubmit={(input) => submit.mutateAsync(input)}
						onChanged={() => {
							void pending.refetch();
							void task.refetch();
						}}
						busy={submit.isPending}
						error={submit.error}
					/>
				) : (
					<p className="text-sm text-muted-foreground">
						<Trans>Waiting for the payload to sign; the card appears when it is ready.</Trans>
					</p>
				))}

			{view.approval?.decision && (
				<section className="rounded-lg border p-3" aria-label={t`Approval`}>
					<DecisionView decision={view.approval.decision} />
				</section>
			)}

			{view.state !== "awaiting_approval" && (
				<TaskEvaluation task={view} tokenNames={looks.tokenNames} className="rounded-lg border p-3" />
			)}

			<section className="rounded-lg border p-3" aria-label={t`Result`}>
				<TaskOutput task={view} />
			</section>
		</Page>
	);
}

/** One task group from a link, e.g. a group that waits for the owner's signature. */
export function TaskGroupPage() {
	const params = useParams({ strict: false }) as { taskGroupId?: string };
	const id = params.taskGroupId ?? "";
	const group = useTaskGroup(id, true);
	const nodes = useNodes();
	const names = useMemo(() => new Map((nodes.data ?? []).map((node) => [node.id, node.name])), [nodes.data]);

	if (group.isPending) {
		return (
			<p className="p-4 text-sm text-muted-foreground" role="status">
				<Trans>Loading…</Trans>
			</p>
		);
	}
	if (group.error !== null && group.error !== undefined) {
		return (
			<div className="p-4">
				<ErrorState error={group.error} retry={() => void group.refetch()} />
			</div>
		);
	}
	if (!group.data) return null;

	return (
		<Page width="detail" data-testid="task-group-page">
			<div>
				<Link
					to="/tasks"
					className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
				>
					<ArrowLeftIcon className="size-3.5" />
					<Trans>All tasks</Trans>
				</Link>
			</div>
			<PageHeader title={<Trans>Task group</Trans>} />
			<TaskGroupResult group={group.data} names={names} onChanged={() => void group.refetch()} />
		</Page>
	);
}
