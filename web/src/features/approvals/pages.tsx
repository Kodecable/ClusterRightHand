import type {
	ApprovalRequest,
	ExternalCallView,
	QuotaApproval,
	RefMap,
	RequestSource as RequestSourceValue,
	TaskGroupView,
	TaskView,
} from "@crh/api";
import type { I18n, MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Link, useParams } from "@tanstack/react-router";
import { ArrowLeftIcon } from "lucide-react";
import { useMemo } from "react";
import { DataTable, type DataTableColumn, type DataTableRowLink } from "@/components/data-table";
import { ApprovalPanel, RequestDetails } from "@/components/decision";
import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { InternalLink } from "@/components/internal-link";
import { NodeNameList, NodeTargetList, nodeTargetsText } from "@/components/node-targets";
import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";
import { RelativeTime } from "@/components/relative-time";
import { RequestSource } from "@/components/request-source";
import { PageSkeleton } from "@/components/skeletons";
import { ExternalCallStatusBadge, TaskGroupStatusBadge, TaskStatusBadge } from "@/components/status-badge";
import { SignatureWait } from "@/features/authorizations/signature-wait";
import { actionText } from "@/lib/action-text";
import { isNotFound } from "@/lib/api/client";
import { displaySessionTitle } from "@/lib/session-title";
import { taskTitle } from "@/lib/task-title";
import { cn, MONO_CELL } from "@/lib/utils";
import {
	useApprovalLookups,
	useApprovals,
	useApprovalTask,
	useApprovalTaskGroup,
	useDecideApproval,
	useDecideExternalCall,
	useExternalCall,
} from "./api";

/** What kind of decision a row holds; the table's first column. */
type DecisionType = "approval" | "signature" | "local_window" | "quota";

const TYPE_LABELS: Record<DecisionType, MessageDescriptor> = {
	approval: msg`Approval`,
	signature: msg`Signature`,
	local_window: msg`Local window`,
	quota: msg`Quota`,
};

/** A signature wait is labelled by its plan's option kinds; no plan yet reads as a signature. */
function signatureType(view: TaskView | TaskGroupView): DecisionType {
	const records = "tasks" in view ? view.tasks.map((task) => task.authorization) : [view.authorization];
	const options = records.flatMap((record) => record?.options ?? []);
	if (options.some((option) => option.kind === "sign")) return "signature";
	if (options.some((option) => option.kind === "local_window")) return "local_window";
	return "signature";
}

/** Whether a task group waits for a signature, even while other members already run. */
function groupAwaitsSignature(group: TaskGroupView): boolean {
	return (
		group.state === "awaiting_authorization" || group.tasks.some((task) => task.state === "awaiting_authorization")
	);
}

/** One row of the approvals table: a task, task group or session whose decision waits for the user. */
interface DecisionRow {
	key: string;
	type: DecisionType;
	operation: string;
	/** Node names from the compact request; absent when only the kind-specific view is available. */
	requestNodes?: string[];
	nodeIds?: string[];
	moreNodes?: number;
	refs?: RefMap;
	/** Who asked; every endpoint returns it, either on the request or on the view. */
	source?: RequestSourceValue;
	requestedAt: string;
	link: DataTableRowLink;
	label: string;
}

const requestKey = (kind: string, id: string) => `${kind}:${id}`;

/** The compact request of one waiting item, keyed by its kind and id. */
function requestsByKey(requests: readonly ApprovalRequest[] | undefined): Map<string, ApprovalRequest> {
	return new Map((requests ?? []).map((request) => [requestKey(request.kind, request.id), request]));
}

function taskRow(
	type: "approval" | "signature",
	task: TaskView,
	request: ApprovalRequest | undefined,
	i18n: I18n,
): DecisionRow {
	const operation = request !== undefined ? actionText(i18n, request.action) : taskTitle(i18n, task);
	return {
		key: `${type}:task:${task.id}`,
		type: type === "signature" ? signatureType(task) : type,
		operation,
		...(request !== undefined
			? { requestNodes: request.nodes ?? [], moreNodes: request.moreNodes }
			: { nodeIds: [task.nodeId] }),
		source: request?.source ?? task.source,
		requestedAt: task.createdAt,
		link: { to: "/approvals/tasks/$taskId", params: { taskId: task.id } },
		label: operation,
	};
}

function taskGroupRow(
	type: "approval" | "signature",
	taskGroup: TaskGroupView,
	request: ApprovalRequest | undefined,
	i18n: I18n,
): DecisionRow {
	const operation = request !== undefined ? actionText(i18n, request.action) : taskTitle(i18n, taskGroup);
	return {
		key: `${type}:task-group:${taskGroup.id}`,
		type: type === "signature" ? signatureType(taskGroup) : type,
		operation,
		...(request !== undefined
			? { requestNodes: request.nodes ?? [], moreNodes: request.moreNodes }
			: { nodeIds: taskGroup.targets, refs: taskGroup.refs }),
		source: request?.source ?? taskGroup.source,
		requestedAt: taskGroup.createdAt,
		link: { to: "/approvals/task-groups/$taskGroupId", params: { taskGroupId: taskGroup.id } },
		label: operation,
	};
}

function externalCallRow(call: ExternalCallView, request: ApprovalRequest | undefined, i18n: I18n): DecisionRow {
	// An api_request is shown by the request it makes (method and path), not by the built-in tool's name.
	const args =
		typeof call.arguments === "object" && call.arguments !== null && !Array.isArray(call.arguments)
			? (call.arguments as Record<string, unknown>)
			: {};
	const legacy =
		call.extension === "crhs-api" && call.tool === "api_request"
			? [args.method, args.path].filter((value): value is string => typeof value === "string" && value !== "").join(" ")
			: "";
	const operation =
		request !== undefined
			? actionText(i18n, request.action)
			: legacy === ""
				? `${call.extension}/${call.tool}`
				: legacy;
	return {
		key: `approval:external-call:${call.id}`,
		type: "approval",
		operation,
		...(request !== undefined ? { requestNodes: request.nodes ?? [], moreNodes: request.moreNodes } : {}),
		source: request?.source ?? call.source,
		requestedAt: call.createdAt,
		link: { to: "/approvals/external-calls/$externalCallId", params: { externalCallId: call.id } },
		label: operation,
	};
}

function quotaRow(wait: QuotaApproval, i18n: I18n): DecisionRow {
	const title = displaySessionTitle(wait.title, i18n);
	return {
		key: `quota:${wait.sessionId}`,
		type: "quota",
		operation: title,
		requestedAt: wait.since,
		link: { to: "/sessions/$sessionId", params: { sessionId: wait.sessionId } },
		label: title,
	};
}

/** The source cell every row reads from the same model. */
function SourceCell({ row }: { row: DecisionRow }) {
	if (row.source === undefined) return <span className="text-muted-foreground">–</span>;
	return <RequestSource source={row.source} className="block truncate leading-5" />;
}

/**
 * The Approvals page (doc/design/webui.md "Approvals page"): one table of everything waiting for this
 * user — task approvals, task-group approvals, tasks waiting for the user's
 * signature and roots whose token quota is used up. Rows read the server's compact approval request when
 * one is present; a row opens the matching detail page, where the decision itself is made. The sidebar
 * badge counts the same rows (`pending.ts`).
 */
export function ApprovalsPage() {
	const { t, i18n } = useLingui();
	const approvals = useApprovals();
	const lookups = useApprovalLookups();
	const data = approvals.data;

	const rows = useMemo(() => {
		if (data === undefined) return [];
		const requests = requestsByKey(data.requests);
		return [
			...data.tasks.map((task) => taskRow("approval", task, requests.get(requestKey("task", task.id)), i18n)),
			...data.externalCalls.map((call) =>
				externalCallRow(call, requests.get(requestKey("external_call", call.id)), i18n),
			),
			...data.taskGroups.map((taskGroup) =>
				taskGroupRow("approval", taskGroup, requests.get(requestKey("task_group", taskGroup.id)), i18n),
			),
			...data.authorizations.tasks.map((task) =>
				taskRow("signature", task, requests.get(requestKey("task", task.id)), i18n),
			),
			...data.authorizations.taskGroups.map((taskGroup) =>
				taskGroupRow("signature", taskGroup, requests.get(requestKey("task_group", taskGroup.id)), i18n),
			),
			...data.quotas.map((wait) => quotaRow(wait, i18n)),
		];
	}, [data, i18n]);

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
				cell: ({ row }) =>
					row.original.requestNodes !== undefined ? (
						<NodeNameList names={row.original.requestNodes} more={row.original.moreNodes} compact />
					) : (
						<NodeTargetList
							ids={row.original.nodeIds ?? []}
							refs={row.original.refs}
							nodeNames={lookups.nodeNames}
							compact
						/>
					),
				meta: {
					title: (row: DecisionRow) =>
						nodeTargetsText(
							i18n,
							row.requestNodes !== undefined
								? row.requestNodes
								: (row.nodeIds ?? []).map((id) => lookups.nodeNames.get(id) ?? id),
							row.requestNodes !== undefined ? row.moreNodes : undefined,
						) || undefined,
				},
			},
			{
				id: "source",
				header: t`Source`,
				size: 160,
				cell: ({ row }) => <SourceCell row={row.original} />,
			},
			{
				id: "requested",
				header: t`Requested`,
				size: 120,
				cell: ({ row }) => <RelativeTime value={row.original.requestedAt} />,
			},
		],
		[t, i18n, lookups.nodeNames],
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

function DetailBackLink() {
	return (
		<div>
			<Link
				to="/approvals"
				className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
			>
				<ArrowLeftIcon className="size-3.5" />
				<Trans>All approvals</Trans>
			</Link>
		</div>
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
			<p className="text-sm">
				<Trans>This request is no longer waiting for approval; it is {status}</Trans>
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
	const request = view.request ?? undefined;
	const awaitingApproval = view.state === "awaiting_approval";
	const awaitingSignature = view.state === "awaiting_authorization";
	return (
		<Page width="detail" data-testid="approval-detail">
			<DetailBackLink />
			{awaitingApproval && request !== undefined ? (
				<ApprovalPanel
					request={request}
					variant="page"
					busy={decide.isPending}
					error={decide.error}
					onDecide={(body) => decide.mutate({ kind: "task", id: view.id, body })}
				/>
			) : awaitingSignature && request !== undefined ? (
				<SignatureWait request={request} variant="page" onChanged={() => void task.refetch()} />
			) : !awaitingApproval && !awaitingSignature ? (
				<Settled status={<TaskStatusBadge state={view.state} />} title={<Trans>Already settled</Trans>}>
					<InternalLink to="/tasks/$taskId" params={{ taskId: view.id }}>
						<Trans>Open the task</Trans>
					</InternalLink>
				</Settled>
			) : null}
			<RequestDetails
				source={{ kind: "task", task: view }}
				nodeNames={lookups.nodeNames}
				refNames={lookups.refNames}
				tokenNames={lookups.tokenNames}
			/>
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
	const request = view.request ?? undefined;
	const awaitingApproval = view.state === "awaiting_approval";
	// A group with running members keeps `running`; it still waits while one member needs a signature.
	const awaitingSignature = groupAwaitsSignature(view);
	return (
		<Page width="detail" data-testid="approval-detail">
			<DetailBackLink />
			{awaitingApproval && request !== undefined ? (
				<ApprovalPanel
					request={request}
					variant="page"
					busy={decide.isPending}
					error={decide.error}
					onDecide={(body) => decide.mutate({ kind: "task_group", id: view.id, body })}
				/>
			) : awaitingSignature && request !== undefined ? (
				<SignatureWait request={request} variant="page" onChanged={() => void taskGroup.refetch()} />
			) : !awaitingApproval && !awaitingSignature ? (
				<Settled status={<TaskGroupStatusBadge state={view.state} />} title={<Trans>Already settled</Trans>}>
					<InternalLink to="/task-groups/$taskGroupId" params={{ taskGroupId: view.id }}>
						<Trans>Open the task group</Trans>
					</InternalLink>
				</Settled>
			) : null}
			<RequestDetails
				source={{ kind: "task_group", taskGroup: view }}
				nodeNames={lookups.nodeNames}
				refNames={lookups.refNames}
				tokenNames={lookups.tokenNames}
			/>
		</Page>
	);
}

/** The deep link the decision dock and the approvals table use for one external call. */
export function ExternalCallApprovalPage() {
	const { t } = useLingui();
	const params = useParams({ strict: false }) as { externalCallId?: string };
	const call = useExternalCall(params.externalCallId);
	const lookups = useApprovalLookups();
	const decide = useDecideExternalCall();
	if (call.isPending) return <DetailPending />;
	if (call.error !== null && call.error !== undefined) {
		// A missing row is an ordinary not-found page: retention is not a user-facing detail here.
		if (isNotFound(call.error)) {
			return (
				<Page width="detail">
					<ErrorState error={t`This external call doesn't exist or you don't have access.`} />
				</Page>
			);
		}
		return (
			<Page width="detail">
				<ErrorState error={call.error} retry={() => void call.refetch()} />
			</Page>
		);
	}
	if (!call.data) return null;
	const view = call.data;
	const request = view.request ?? undefined;
	const awaitingApproval = view.state === "awaiting_approval";
	return (
		<Page width="detail" data-testid="approval-detail">
			<DetailBackLink />
			{awaitingApproval && request !== undefined ? (
				<ApprovalPanel
					request={request}
					variant="page"
					busy={decide.isPending}
					error={decide.error}
					onDecide={(body) => decide.mutate({ id: view.id, body })}
				/>
			) : !awaitingApproval ? (
				<Settled status={<ExternalCallStatusBadge state={view.state} />} title={<Trans>Already settled</Trans>}>
					{view.rootSessionId !== null && (
						<InternalLink to="/sessions/$sessionId" params={{ sessionId: view.rootSessionId }}>
							<Trans>Open the session</Trans>
						</InternalLink>
					)}
				</Settled>
			) : null}
			<RequestDetails
				source={{ kind: "external_call", call: view }}
				nodeNames={lookups.nodeNames}
				refNames={lookups.refNames}
				tokenNames={lookups.tokenNames}
			/>
		</Page>
	);
}
