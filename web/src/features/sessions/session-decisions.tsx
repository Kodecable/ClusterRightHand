import type {
	ApprovalBody,
	ApprovalList,
	ApprovalRequest,
	ExternalCallView,
	PtyApprovalItem,
	QuotaApproval,
	SessionView,
	TaskGroupView,
	TaskView,
} from "@crh/api";
import { Trans, useLingui } from "@lingui/react/macro";
import { useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { ApprovalPanel } from "@/components/decision/approval-panel";
import { InternalLink } from "@/components/internal-link";
import { useApprovals, useDecideApproval, useDecideExternalCall } from "@/features/approvals/api";
import { PtySignatureWait, SignatureWait } from "@/features/authorizations/signature-wait";
import { useDecideTerminalApproval } from "@/features/terminals/api";
import { sessionKeys, useDecideQuota } from "./api";
import { Composer } from "./composer";
import { QuotaPanel } from "./quota-panel";

export type SessionDecision =
	| { kind: "quota"; wait: QuotaApproval }
	| { kind: "approval_task"; task: TaskView; request?: ApprovalRequest }
	| { kind: "approval_external_call"; call: ExternalCallView; request?: ApprovalRequest }
	| { kind: "approval_task_group"; taskGroup: TaskGroupView; request?: ApprovalRequest }
	| { kind: "approval_pty"; item: PtyApprovalItem; request?: ApprovalRequest }
	| { kind: "signature_task"; task: TaskView; request?: ApprovalRequest }
	| { kind: "signature_task_group"; taskGroup: TaskGroupView; request?: ApprovalRequest }
	| { kind: "signature_pty"; item: PtyApprovalItem; request?: ApprovalRequest };

function oldest<T extends { createdAt: string }>(items: T[]): T[] {
	return [...items].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

/**
 * The pending decisions of one session tree, in the order the dock offers them
 * (doc/design/webui.md "Session header"): the used-up quota, rule approvals
 * (tasks, external calls, task groups, terminals), then signature waits (tasks,
 * task groups, terminals), oldest first in each group. The approvals list
 * already holds only what this viewer may answer.
 */
export function sessionDecisions(data: ApprovalList | undefined, rootSessionId: string): SessionDecision[] {
	if (data === undefined) return [];
	const inTree = (id: string | null | undefined) => id === rootSessionId;
	// The badge query returns one compact request beside every waiting view; the dock renders only that model.
	const requests = new Map(data.requests.map((request) => [`${request.kind}:${request.id}`, request] as const));
	const requestFor = (kind: ApprovalRequest["kind"], id: string) => requests.get(`${kind}:${id}`);
	const quotas = [...data.quotas]
		.filter((wait) => wait.sessionId === rootSessionId)
		.sort((left, right) => left.since.localeCompare(right.since))
		.map((wait): SessionDecision => ({ kind: "quota", wait }));
	return [
		...quotas,
		// Auto Review's reviewing state is not a user-facing approval: the dock waits for the verdict.
		...oldest(data.tasks.filter((task) => inTree(task.rootSessionId) && task.phase !== "reviewing")).map(
			(task): SessionDecision => ({ kind: "approval_task", task, request: requestFor("task", task.id) }),
		),
		...oldest(data.externalCalls.filter((call) => inTree(call.rootSessionId) && call.phase !== "reviewing")).map(
			(call): SessionDecision => ({
				kind: "approval_external_call",
				call,
				request: requestFor("external_call", call.id),
			}),
		),
		...oldest(
			data.taskGroups.filter((taskGroup) => inTree(taskGroup.rootSessionId) && taskGroup.phase !== "reviewing"),
		).map(
			(taskGroup): SessionDecision => ({
				kind: "approval_task_group",
				taskGroup,
				request: requestFor("task_group", taskGroup.id),
			}),
		),
		...oldest(data.ptys.filter((item) => inTree(item.rootSessionId))).map(
			(item): SessionDecision => ({ kind: "approval_pty", item, request: requestFor("pty", item.terminalId) }),
		),
		...oldest(data.authorizations.tasks.filter((task) => inTree(task.rootSessionId))).map(
			(task): SessionDecision => ({
				kind: "signature_task",
				task,
				request: requestFor("task", task.id),
			}),
		),
		...oldest(data.authorizations.taskGroups.filter((taskGroup) => inTree(taskGroup.rootSessionId))).map(
			(taskGroup): SessionDecision => ({
				kind: "signature_task_group",
				taskGroup,
				request: requestFor("task_group", taskGroup.id),
			}),
		),
		...oldest((data.authorizations.ptys ?? []).filter((item) => inTree(item.rootSessionId))).map(
			(item): SessionDecision => ({ kind: "signature_pty", item, request: requestFor("pty", item.terminalId) }),
		),
	];
}

function decisionId(decision: SessionDecision): string {
	switch (decision.kind) {
		case "quota":
			return decision.wait.sessionId;
		case "approval_task":
		case "signature_task":
			return decision.task.id;
		case "approval_external_call":
			return decision.call.id;
		case "approval_task_group":
		case "signature_task_group":
			return decision.taskGroup.id;
		case "approval_pty":
		case "signature_pty":
			return decision.item.terminalId;
	}
}

/** A link to the task, task group or terminal a decision is about. */
function TaskDetails({ decision }: { decision: SessionDecision }) {
	const { t } = useLingui();
	switch (decision.kind) {
		case "approval_task":
		case "signature_task":
			return (
				<InternalLink to="/tasks/$taskId" params={{ taskId: decision.task.id }} className="text-xs whitespace-nowrap">
					{t`Task details`}
				</InternalLink>
			);
		case "approval_task_group":
		case "signature_task_group":
			return (
				<InternalLink
					to="/task-groups/$taskGroupId"
					params={{ taskGroupId: decision.taskGroup.id }}
					className="text-xs whitespace-nowrap"
				>
					{t`Task details`}
				</InternalLink>
			);
		case "approval_pty":
		case "signature_pty":
			return (
				<InternalLink
					to="/terminals/$id"
					params={{ id: decision.item.terminalId }}
					className="text-xs whitespace-nowrap"
				>
					{t`Terminal details`}
				</InternalLink>
			);
		case "quota":
		case "approval_external_call":
			return null;
	}
}

/** The session's own refresh after a wait ends: its state and the list row behind Stop. */
function useSessionRefresh(sessionId: string): () => void {
	const queryClient = useQueryClient();
	return () => {
		void queryClient.invalidateQueries({ queryKey: sessionKeys.detail(sessionId) });
		void queryClient.invalidateQueries({ queryKey: sessionKeys.list() });
	};
}

function ApprovalDock({
	task,
	taskGroup,
	request,
	count,
}: {
	task?: TaskView;
	taskGroup?: TaskGroupView;
	/** The server-built compact request from the approvals list; without it there is no panel to render. */
	request: ApprovalRequest | undefined;
	count?: React.ReactNode;
}) {
	const sessionId = task?.rootSessionId ?? taskGroup?.rootSessionId ?? "";
	const refresh = useSessionRefresh(sessionId);
	const decide = useDecideApproval();
	if (request === undefined) return null;
	const kind = request.kind === "task_group" ? "task_group" : "task";
	const onDecide = (body: ApprovalBody) => {
		decide.mutate(
			{ kind, id: request.id, body },
			{
				onSuccess: () => {
					refresh();
				},
			},
		);
	};
	return (
		<ApprovalPanel
			request={request}
			variant="inline"
			count={count}
			details={
				<TaskDetails
					decision={
						task !== undefined
							? { kind: "approval_task", task }
							: { kind: "approval_task_group", taskGroup: taskGroup as TaskGroupView }
					}
				/>
			}
			busy={decide.isPending}
			error={decide.error}
			onDecide={onDecide}
		/>
	);
}

function SignatureDock({
	task,
	taskGroup,
	request,
	count,
}: {
	task?: TaskView;
	taskGroup?: TaskGroupView;
	request: ApprovalRequest | undefined;
	count?: React.ReactNode;
}) {
	const refresh = useSessionRefresh(task?.rootSessionId ?? taskGroup?.rootSessionId ?? "");
	if (request === undefined) return null;
	return (
		<SignatureWait
			request={request}
			variant="inline"
			count={count}
			details={
				<TaskDetails
					decision={
						task !== undefined
							? { kind: "signature_task", task }
							: { kind: "signature_task_group", taskGroup: taskGroup as TaskGroupView }
					}
				/>
			}
			onChanged={refresh}
		/>
	);
}

function ExternalCallDock({
	call,
	request,
	count,
}: {
	call: ExternalCallView;
	request: ApprovalRequest | undefined;
	count?: React.ReactNode;
}) {
	const { t } = useLingui();
	const refresh = useSessionRefresh(call.rootSessionId ?? "");
	const decide = useDecideExternalCall();
	if (request === undefined) return null;
	return (
		<ApprovalPanel
			request={request}
			variant="inline"
			count={count}
			busy={decide.isPending}
			error={decide.error}
			details={
				<InternalLink
					to="/approvals/external-calls/$externalCallId"
					params={{ externalCallId: call.id }}
					className="text-xs whitespace-nowrap"
				>
					{t`Review`}
				</InternalLink>
			}
			onDecide={(body) =>
				decide.mutate(
					{ id: call.id, body },
					{
						onSuccess: () => refresh(),
					},
				)
			}
		/>
	);
}

function PtyApprovalDock({
	item,
	request,
	count,
}: {
	item: PtyApprovalItem;
	request: ApprovalRequest | undefined;
	count?: React.ReactNode;
}) {
	const refresh = useSessionRefresh(item.rootSessionId);
	const decide = useDecideTerminalApproval();
	if (request === undefined) return null;
	return (
		<ApprovalPanel
			request={request}
			variant="inline"
			count={count}
			details={<TaskDetails decision={{ kind: "approval_pty", item }} />}
			busy={decide.isPending}
			error={decide.error}
			onDecide={(body: ApprovalBody) => {
				decide.mutate({ id: item.terminalId, body }, { onSuccess: () => refresh() });
			}}
		/>
	);
}

function PtySignatureDock({
	item,
	request,
	count,
}: {
	item: PtyApprovalItem;
	request: ApprovalRequest | undefined;
	count?: React.ReactNode;
}) {
	const refresh = useSessionRefresh(item.rootSessionId);
	if (request === undefined) return null;
	return (
		<PtySignatureWait
			terminalId={item.terminalId}
			request={request}
			variant="inline"
			count={count}
			details={<TaskDetails decision={{ kind: "signature_pty", item }} />}
			onChanged={refresh}
		/>
	);
}

function QuotaDock({ wait, count }: { wait: QuotaApproval; count?: React.ReactNode }) {
	const decide = useDecideQuota(wait.sessionId);
	return (
		<QuotaPanel
			wait={wait}
			count={count}
			busy={decide.isPending}
			error={decide.error}
			onDecide={(decision) => decide.mutate(decision)}
		/>
	);
}

function DockDecision({ decision, count }: { decision: SessionDecision; count?: React.ReactNode }) {
	switch (decision.kind) {
		case "quota":
			return <QuotaDock wait={decision.wait} count={count} />;
		case "approval_task":
			return <ApprovalDock task={decision.task} request={decision.request} count={count} />;
		case "approval_external_call":
			return <ExternalCallDock call={decision.call} request={decision.request} count={count} />;
		case "approval_task_group":
			return <ApprovalDock taskGroup={decision.taskGroup} request={decision.request} count={count} />;
		case "approval_pty":
			return <PtyApprovalDock item={decision.item} request={decision.request} count={count} />;
		case "signature_task":
			return <SignatureDock task={decision.task} request={decision.request} count={count} />;
		case "signature_task_group":
			return <SignatureDock taskGroup={decision.taskGroup} request={decision.request} count={count} />;
		case "signature_pty":
			return <PtySignatureDock item={decision.item} request={decision.request} count={count} />;
	}
}

/**
 * The decision panel docked where the composer sits (doc/design/webui.md "Session header"): the
 * first pending decision of the whole session tree, one item at a time, in its
 * own scroll and at most half of the session pane. The composer returns as soon
 * as nothing waits for this viewer.
 */
export function SessionDecisionDock({ decisions }: { decisions: SessionDecision[] }) {
	const first = decisions[0];
	if (first === undefined) return null;
	const count =
		decisions.length > 1 ? (
			<span className="text-xs whitespace-nowrap text-muted-foreground">
				<Trans>1 of {decisions.length}</Trans>
			</span>
		) : undefined;
	return (
		<div
			data-testid="session-decisions"
			data-decision={first.kind}
			data-decision-id={decisionId(first)}
			className="max-h-[50%] min-h-0 shrink-0 overflow-y-auto bg-background p-2 sm:p-3 [&_[data-slot=decision]]:bg-background"
		>
			<div className="mx-auto w-full max-w-(--session-column)">
				{/* Keyed by the item, so the next decision mounts fresh: no "submitted" notice, pasted text,
				    selected tab or mutation error of the one just answered carries over. */}
				<DockDecision key={`${first.kind}:${decisionId(first)}`} decision={first} count={count} />
			</div>
		</div>
	);
}

/**
 * The bottom of the session page: the docked decision when the tree has one for
 * this viewer, otherwise the normal composer. It replaces the composer instead
 * of stacking above the transcript, so the transcript keeps its height.
 */
export function SessionFooter({
	session,
	rootId,
	stoppable,
}: {
	session: SessionView;
	/** The tree root whose decisions this page shows; the session itself while it is still loading. */
	rootId: string | undefined;
	stoppable: boolean;
}) {
	const approvals = useApprovals();
	const rootSessionId = rootId ?? session.id;
	const decisions = useMemo(() => sessionDecisions(approvals.data, rootSessionId), [approvals.data, rootSessionId]);
	if (decisions.length === 0) return <Composer session={session} stoppable={stoppable} />;
	return <SessionDecisionDock decisions={decisions} />;
}
