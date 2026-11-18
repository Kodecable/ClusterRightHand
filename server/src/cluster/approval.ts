/**
 * What the approval of a single task and of a task group share (doc/design/access-control.md "Approvals"): a change
 * merged into the stored approval JSON, the handler columns of an agent routing, the decision of the
 * rules after they changed, and the audit events of a decision, an Auto Review verdict and an agent
 * routing. Each side keeps its own row writes and its own serialization: a task's approval runs on
 * core.taskQueue (task-approval.ts), a group's on TaskGroups' per-group approval queue (task-groups.ts).
 */
import type { ApprovalPhase, Review, ReviewPending, ReviewVerdict } from "@crh/api";
import type { AuditInput } from "../audit/audit.ts";
import type { RuleRef } from "../policy/store.ts";
import type { AgentRequest, ApprovalDecision, ApprovalExpect } from "./types.ts";

/** What waits for the approval: names the audit actions (`task.*`, `task_group.*`) and their target. */
export type ApprovalSubject = "task" | "task_group" | "external_call";

/** Auto Review's settled verdict on a waiting request. */
export type ApprovalReview = ReviewVerdict;

/** The marker written with the row that enters awaiting approval while Auto Review will judge it. */
export function pendingReview(at: string): ReviewPending {
	return { status: "pending", startedAt: at };
}

/** Whether a stored review is the pending marker rather than a settled verdict. */
export function isPendingReview(review: Review | null | undefined): boolean {
	return review !== null && review !== undefined && "status" in review && review.status === "pending";
}

/** Whether an approval JSON carries the pending-review marker; unreadable JSON has none. */
export function pendingReviewIn(json: string | null | undefined): boolean {
	if (!json) return false;
	try {
		return isPendingReview((JSON.parse(json) as { review?: Review }).review);
	} catch {
		return false;
	}
}

/**
 * What the API shows for one approval (doc/design/access-control.md "Auto Review"): `reviewing` while Auto
 * Review decides and the request is still a user's to receive, `awaiting_signature` for a task or task group
 * waiting for the user's signature, and `awaiting_user` for every other wait.
 */
export function approvalPhase(
	state: string,
	handlerType: string | null,
	review: Review | null | undefined,
): ApprovalPhase {
	if (state === "awaiting_authorization") return "awaiting_signature";
	return state === "awaiting_approval" && handlerType === "user" && isPendingReview(review)
		? "reviewing"
		: "awaiting_user";
}

/** The same phase from a stored approval JSON, for callers that read rows rather than views. */
export function approvalPhaseOf(state: string, handlerType: string | null, approvalJson: string | null): ApprovalPhase {
	if (state === "awaiting_authorization") return "awaiting_signature";
	if (state !== "awaiting_approval" || handlerType !== "user" || !approvalJson) return "awaiting_user";
	try {
		return approvalPhase(state, handlerType, (JSON.parse(approvalJson) as { review?: Review }).review);
	} catch {
		return "awaiting_user";
	}
}

/** The stored approval JSON (`{}` when there is none) with `change` merged in. */
export function mergeApproval<T extends object>(json: string | null, change: Partial<T>): T {
	return { ...(JSON.parse(json ?? "{}") as T), ...change };
}

/**
 * An agent routing of a waiting request (doc/design/agent-runtime.md "Handling subagent requests"): what the record's `agent`
 * becomes and who handles the request afterwards. A pending request is the ancestor agent's; an escalated
 * one is the user's again.
 */
export function agentRouting(
	session: string,
	state: AgentRequest["state"],
): {
	agent: AgentRequest;
	handler: { handler_type: "agent" | "user"; handler_session_id: string | null };
} {
	return {
		agent: { session, state },
		handler:
			state === "pending"
				? { handler_type: "agent", handler_session_id: session }
				: { handler_type: "user", handler_session_id: null },
	};
}

/** The rule chain stored on a waiting request when it contains `ref`, else null (the change does not concern it). */
export function chainWith(ruleChain: string | null, ref: RuleRef): RuleRef[] | null {
	const chain = JSON.parse(ruleChain ?? "[]") as RuleRef[];
	return chain.some((r) => r.type === ref.type && r.id === ref.id) ? chain : null;
}

/** The handler columns shared by a waiting task and task group. */
type HandlerColumns = {
	handler_type: "agent" | "user" | null;
	handler_session_id: string | null;
};

/**
 * Whether the row's handler matches what the caller read outside the lock. The omitted expectation still
 * requires a handler: a null one is a request already approved and being dispatched, not a waiting one.
 */
export function matchesHandler(row: HandlerColumns, expect?: ApprovalExpect): boolean {
	if (!expect) return row.handler_type !== null;
	if (expect.handlerType === "any-waiting") {
		if (row.handler_type === null) return false;
	} else if (row.handler_type !== expect.handlerType) {
		return false;
	}
	return expect.handlerSessionId === undefined || row.handler_session_id === expect.handlerSessionId;
}

/** The decision recorded when changed rules no longer require an approval. */
export function rulesApproval(at: string): ApprovalDecision {
	return { decision: "approved", by: { type: "system", id: "rules" }, at, reason: "allowed by changed rules" };
}

/** The decision recorded when changed rules deny every node of a waiting group. */
export function rulesRejection(at: string): ApprovalDecision {
	return { decision: "rejected", by: { type: "system", id: "rules" }, at, reason: "denied by the authorization rules" };
}

/** `<subject>.approval`: who settled the request and how. */
export function approvalAudit(
	subject: ApprovalSubject,
	id: string,
	onBehalfOfUserId: string,
	decision: ApprovalDecision,
): AuditInput {
	return {
		actor: {
			type: decision.by.type,
			id: decision.by.id,
			onBehalfOfUserId: decision.by.onBehalfOfUserId ?? onBehalfOfUserId,
		},
		action: `${subject}.approval`,
		target: { type: subject, id },
		detail: { decision: decision.decision, reason: decision.reason },
	};
}

/** `<subject>.review`: Auto Review's verdict. */
export function reviewAudit(
	subject: ApprovalSubject,
	id: string,
	onBehalfOfUserId: string,
	review: ApprovalReview,
): AuditInput {
	return {
		actor: { type: "system", id: "auto-review", onBehalfOfUserId },
		action: `${subject}.review`,
		target: { type: subject, id },
		detail: review,
	};
}

/** `<subject>.agent_request` or `<subject>.agent_escalated`: the request went to an agent, or back to the user. */
export function agentRoutingAudit(
	subject: ApprovalSubject,
	id: string,
	session: string,
	state: AgentRequest["state"],
): AuditInput {
	return {
		actor: { type: "system", id: "agent-routing" },
		action: `${subject}.${state === "pending" ? "agent_request" : "agent_escalated"}`,
		target: { type: subject, id },
		detail: { session },
	};
}
