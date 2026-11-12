import type { ApprovalBody, ApprovalList, QuotaApproval, SessionView, TaskGroupView, TaskView } from "@crh/api";
import { Trans, useLingui } from "@lingui/react/macro";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useMemo } from "react";
import { ApprovalDecision } from "@/components/decision/approval-decision";
import { useApprovalLookups, useApprovals, useDecideApproval } from "@/features/approvals/api";
import { SignatureWait } from "@/features/authorizations/signature-wait";
import { cn, linkClass } from "@/lib/utils";
import { sessionKeys, useDecideQuota } from "./api";
import { Composer } from "./composer";
import { QuotaDecision } from "./quota-decision";

export type SessionDecision =
	| { kind: "quota"; wait: QuotaApproval }
	| { kind: "approval_task"; task: TaskView }
	| { kind: "approval_task_group"; taskGroup: TaskGroupView }
	| { kind: "signature_task"; task: TaskView }
	| { kind: "signature_task_group"; taskGroup: TaskGroupView };

function oldest<T extends { createdAt: string }>(items: T[]): T[] {
	return [...items].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

/**
 * The pending decisions of one session tree, in the order the dock offers them
 * (doc/design/webui.md "Session header"): the used-up quota, rule approvals,
 * task-group approvals, then signature waits, oldest first in each group. The
 * approvals list already holds only what this viewer may answer.
 */
export function sessionDecisions(data: ApprovalList | undefined, rootSessionId: string): SessionDecision[] {
	if (data === undefined) return [];
	const inTree = (id: string | null | undefined) => id === rootSessionId;
	const quotas = [...data.quotas]
		.filter((wait) => wait.sessionId === rootSessionId)
		.sort((left, right) => left.since.localeCompare(right.since))
		.map((wait): SessionDecision => ({ kind: "quota", wait }));
	return [
		...quotas,
		...oldest(data.tasks.filter((task) => inTree(task.rootSessionId))).map(
			(task): SessionDecision => ({ kind: "approval_task", task }),
		),
		...oldest(data.taskGroups.filter((taskGroup) => inTree(taskGroup.rootSessionId))).map(
			(taskGroup): SessionDecision => ({ kind: "approval_task_group", taskGroup }),
		),
		...oldest(data.authorizations.tasks.filter((task) => inTree(task.rootSessionId))).map(
			(task): SessionDecision => ({ kind: "signature_task", task }),
		),
		...oldest(data.authorizations.taskGroups.filter((taskGroup) => inTree(taskGroup.rootSessionId))).map(
			(taskGroup): SessionDecision => ({ kind: "signature_task_group", taskGroup }),
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
		case "approval_task_group":
		case "signature_task_group":
			return decision.taskGroup.id;
	}
}

/** A link to the task or task group a decision is about. */
function TaskDetails({ decision }: { decision: SessionDecision }) {
	const { t } = useLingui();
	const className = cn(linkClass, "text-xs whitespace-nowrap");
	switch (decision.kind) {
		case "approval_task":
		case "signature_task":
			return (
				<Link to="/tasks/$taskId" params={{ taskId: decision.task.id }} className={className}>
					{t`Task details`}
				</Link>
			);
		case "approval_task_group":
		case "signature_task_group":
			return (
				<Link to="/task-groups/$taskGroupId" params={{ taskGroupId: decision.taskGroup.id }} className={className}>
					{t`Task details`}
				</Link>
			);
		case "quota":
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
	count,
}: {
	task?: TaskView;
	taskGroup?: TaskGroupView;
	count?: React.ReactNode;
}) {
	const sessionId = task?.rootSessionId ?? taskGroup?.rootSessionId ?? "";
	const refresh = useSessionRefresh(sessionId);
	const lookups = useApprovalLookups();
	const decide = useDecideApproval();
	const item =
		task !== undefined
			? ({ kind: "task", task } as const)
			: ({ kind: "task_group", taskGroup: taskGroup as TaskGroupView } as const);
	const id = task?.id ?? taskGroup?.id ?? "";
	const onDecide = (body: ApprovalBody) => {
		decide.mutate(
			{ kind: task !== undefined ? "task" : "task_group", id, body },
			{
				onSuccess: () => {
					refresh();
				},
			},
		);
	};
	return (
		<ApprovalDecision
			item={item}
			nodeNames={lookups.nodeNames}
			refNames={lookups.refNames}
			tokenNames={lookups.tokenNames}
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
	count,
}: {
	task?: TaskView;
	taskGroup?: TaskGroupView;
	count?: React.ReactNode;
}) {
	const lookups = useApprovalLookups();
	const item =
		task !== undefined
			? ({ kind: "task", task } as const)
			: ({ kind: "task_group", taskGroup: taskGroup as TaskGroupView } as const);
	const refresh = useSessionRefresh(task?.rootSessionId ?? taskGroup?.rootSessionId ?? "");
	return (
		<SignatureWait
			kind={task !== undefined ? "task" : "task_group"}
			id={task?.id ?? taskGroup?.id}
			item={item}
			nodeNames={lookups.nodeNames}
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

function QuotaDock({ wait, count }: { wait: QuotaApproval; count?: React.ReactNode }) {
	const decide = useDecideQuota(wait.sessionId);
	return (
		<QuotaDecision
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
			return <ApprovalDock task={decision.task} count={count} />;
		case "approval_task_group":
			return <ApprovalDock taskGroup={decision.taskGroup} count={count} />;
		case "signature_task":
			return <SignatureDock task={decision.task} count={count} />;
		case "signature_task_group":
			return <SignatureDock taskGroup={decision.taskGroup} count={count} />;
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
			className="max-h-[50%] min-h-0 shrink-0 overflow-y-auto bg-muted/30 p-2 sm:p-3"
		>
			<DockDecision decision={first} count={count} />
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
