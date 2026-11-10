/**
 * The approval of a single task (doc/design/access-control.md "Approvals"): a user's or an agent's decision, Auto
 * Review's verdict, the routing to an ancestor session's agent, and the rules judging waiting tasks again
 * after they changed. The parts a task group's approval shares are in approval.ts; the writes here are
 * guarded by the row version, and decide() dispatches outside its turn instead of holding it.
 */
import { type TaskSpec, taskSpecFromJson } from "@crh/protocol";
import type { Selectable } from "kysely";
import type { Evaluation } from "../policy/rules.ts";
import type { RuleRef } from "../policy/store.ts";
import type { TasksTable } from "../storage/schema.ts";
import {
	type ApprovalReview,
	agentRouting,
	agentRoutingAudit,
	approvalAudit,
	chainWith,
	mergeApproval,
	reviewAudit,
	rulesApproval,
} from "./approval.ts";
import { type ClusterCore, now } from "./core.ts";
import { getNode, type NodeRow } from "./nodes.ts";
import { specFromRow } from "./spec.ts";
import { dispatch, evaluateFor } from "./task-dispatch.ts";
import { endTask, endUndispatched, failNodeDeleted } from "./task-end.ts";
import { writeTask } from "./task-rows.ts";
import { pendingInputOf } from "./task-start.ts";
import type { AgentRequest, ApprovalDecision, ApprovalExpect, ApprovalRecord, DecisionResult } from "./types.ts";

/**
 * Settles a task waiting for approval. Returns false if it is not waiting with the handler the caller
 * expects (already settled, never needed approval, or the handler changed); `node_deleted` when the
 * approval was recorded but the node had been deleted, so the task ended instead of dispatching.
 *
 * `expect` is checked again in the task's turn, on the row read there: the route's read is only a hint,
 * and a row without a handler is already allowed and being dispatched, not waiting for a decision. With
 * no expectation, any non-null handler matches.
 *
 * The decision (and, for an approval, the spec and input the dispatch needs) is recorded in the task's
 * turn; the dispatch itself runs after it, so an HTTP approve still waits for the dispatch result without
 * holding the task's queue across the offline grace and the whole send.
 */
export async function decide(
	core: ClusterCore,
	id: string,
	decision: ApprovalDecision,
	expect?: ApprovalExpect,
): Promise<DecisionResult> {
	const decided = await core.taskQueue.run(id, async (): Promise<DecidedApproval | false> => {
		const row = await core.row(id);
		if (row?.state !== "awaiting_approval" || !matchesHandler(row, expect)) return false;
		const record = mergeApproval<ApprovalRecord>(row.approval, { decision });
		if (decision.decision === "approved") {
			// Read the spec before recording the decision: migration 0019 may have left a row it could not
			// convert, and the caller gets a client error instead of a half-approved task.
			const spec = specFromRow(row.spec, "task");
			const node = await getNode(core.db, row.node_id);
			if (!node) {
				// The node was deleted while the task waited. There is nothing to dispatch to, so the task
				// ends as node_deleted with the decision it did get; the caller must not append an "always"
				// rule for a task that could not be approved (doc/design/execution.md "State machine").
				const ended = await failNodeDeleted(core, id, row, { approval: JSON.stringify(record) });
				if (!ended) return false;
				core.background("task approval audit failed", auditApproval(core, row, decision));
				return { kind: "node_deleted", actorId: row.actor_id };
			}
			// The approval also drops the handler: from here the row is the allowed shape awaiting its
			// claim, so a second decision, a rule change or a restart cannot mistake it for a fresh request.
			const recorded = await writeTask(
				core.db,
				id,
				{ states: ["awaiting_approval"], rev: row.rev },
				{ approval: JSON.stringify(record), handler_type: null, handler_session_id: null },
			);
			if (!recorded) return false;
			core.background("task approval audit failed", auditApproval(core, row, decision));
			return {
				kind: "approved",
				actorId: row.actor_id,
				dispatch: {
					node,
					spec,
					input: pendingInputOf(row),
					opts: { privileged: row.privileged === 1, timeoutMs: row.timeout_ms ?? undefined },
				},
			};
		}
		const rejected = await endTask(core, id, {
			write: {
				from: ["awaiting_approval"],
				rev: row.rev,
				set: {
					state: "rejected",
					error_code: "approval_rejected",
					error_message: decision.reason ?? "approval rejected",
					approval: JSON.stringify(record),
					pending_input: null,
					handler_type: null,
					handler_session_id: null,
				},
			},
			onChange: row.actor_id,
			audit: false,
		});
		if (!rejected) return false;
		// The rejection is audited as an approval, not as a task.finished (doc/design/access-control.md "Recorded events").
		core.background("task approval audit failed", auditApproval(core, row, decision));
		return { kind: "rejected" };
	});
	if (!decided) return false;
	if (decided.kind === "rejected") return "rejected";
	if (decided.kind === "node_deleted") return "node_deleted";
	// The row no longer waits for anyone: refresh the inbox before a dispatch may spend the offline grace.
	core.onChange?.(decided.actorId);
	if (decided.dispatch) {
		try {
			// Outside the turn: dispatch waits for the node and sends from its own short turn.
			await dispatch(
				core,
				id,
				decided.dispatch.node,
				decided.dispatch.spec,
				decided.dispatch.input,
				decided.dispatch.opts,
			);
		} catch (err) {
			// The decision is recorded, so the task is no longer waiting for one: it must not keep the
			// row in awaiting_approval (doc/design/execution.md "State machine").
			await endUndispatched(core, id, err);
			throw err;
		}
	}
	return "approved";
}

/**
 * Whether the row's handler matches what the caller read outside the turn. The omitted expectation still
 * requires a handler: a null one is an allowed task between its approval and its claim, not a request.
 */
function matchesHandler(row: Selectable<TasksTable>, expect?: ApprovalExpect): boolean {
	if (!expect) return row.handler_type !== null;
	if (expect.handlerType === "any-waiting") {
		if (row.handler_type === null) return false;
	} else if (row.handler_type !== expect.handlerType) {
		return false;
	}
	return expect.handlerSessionId === undefined || row.handler_session_id === expect.handlerSessionId;
}

/** What decide's turn recorded, for the work that runs after it. */
type DecidedApproval =
	| { kind: "rejected" }
	| { kind: "node_deleted"; actorId: string }
	| {
			kind: "approved";
			actorId: string;
			/** The dispatch to run after the turn. */
			dispatch: {
				node: NodeRow;
				spec: TaskSpec;
				input: Uint8Array;
				opts: { privileged?: boolean; timeoutMs?: number };
			};
	  };

async function auditApproval(core: ClusterCore, row: Selectable<TasksTable>, d: ApprovalDecision): Promise<void> {
	core.auditLater(approvalAudit("task", row.id, row.on_behalf_of_user_id, d));
}

/** Stores Auto Review's verdict on a waiting task. */
export async function recordReview(core: ClusterCore, id: string, review: ApprovalReview): Promise<void> {
	await core.taskQueue.run(id, async () => {
		const row = await core.row(id);
		// A row without a handler is approved and on its way to dispatch: a late review must not write it.
		if (row?.state !== "awaiting_approval" || row.handler_type === null) return;
		const record = mergeApproval<ApprovalRecord>(row.approval, { review });
		const recorded = await writeTask(
			core.db,
			id,
			{ states: ["awaiting_approval"], rev: row.rev },
			{ approval: JSON.stringify(record) },
		);
		if (!recorded) return;
		core.auditLater(reviewAudit("task", id, row.on_behalf_of_user_id, review));
	});
}

/**
 * Hands a waiting task's approval to an ancestor session's agent. False when it is no longer waiting (Auto Review
 * or the user settled it first).
 */
export function requestAgentDecision(core: ClusterCore, id: string, session: string): Promise<boolean> {
	return routeAgentDecision(core, id, session, "pending");
}

/** The agent passed the request on to the user: the approval page takes it from here. */
export function escalateAgentDecision(core: ClusterCore, id: string, session: string): Promise<boolean> {
	return routeAgentDecision(core, id, session, "escalated");
}

/**
 * Routes a waiting task's approval to an agent or back to the user. The write is guarded on the state
 * and the `rev` the row was read at, so a decision that settled the task in between is not overwritten.
 * A row without a handler is approved and being dispatched: routing it would make it look waiting again.
 */
function routeAgentDecision(
	core: ClusterCore,
	id: string,
	session: string,
	state: AgentRequest["state"],
): Promise<boolean> {
	return core.taskQueue.run(id, async () => {
		const row = await core.row(id);
		// The task is settled or approved and being dispatched: routing it again would make it look waiting.
		if (row?.state !== "awaiting_approval" || row.handler_type === null) return false;
		const routing = agentRouting(session, state);
		const record = mergeApproval<ApprovalRecord>(row.approval, { agent: routing.agent });
		const routed = await writeTask(
			core.db,
			id,
			{ states: ["awaiting_approval"], rev: row.rev },
			{ approval: JSON.stringify(record), ...routing.handler },
		);
		if (!routed) return false;
		core.onChange?.(row.actor_id);
		core.auditLater(agentRoutingAudit("task", id, session, state));
		return true;
	});
}

/**
 * Judges waiting tasks again after rules on their chain changed (doc/design/access-control.md "Approvals"): allow
 * dispatches them, deny ends them, require-approval leaves them waiting. (A task group's reevaluate
 * settles the whole group: it approves when no node still requires approval, and rejects when every
 * node is denied; see TaskGroups.reevaluate.)
 *
 * Only rows with a handler are waiting for a decision: an allowed task between its approval and its
 * claim has none, and re-judging it would write a second decision and start a duplicate dispatch. The
 * allows are dispatched in the background: waiting for an offline node's grace would otherwise hold the
 * caller's HTTP request for up to NODE_OFFLINE_GRACE_MS per task, serially.
 */
export async function reevaluate(core: ClusterCore, ref: RuleRef): Promise<void> {
	const rows = await core.db
		.selectFrom("tasks")
		.selectAll()
		.where("state", "=", "awaiting_approval")
		.where("handler_type", "is not", null)
		.where("rule_chain", "is not", null)
		.execute();
	for (const row of rows) {
		const chain = chainWith(row.rule_chain, ref);
		if (!chain) continue;
		const node = await getNode(core.db, row.node_id);
		if (!node) continue;
		let evaluation: Evaluation;
		try {
			evaluation = await evaluateFor(core, node, taskSpecFromJson(JSON.parse(row.spec)), chain, row.privileged === 1);
		} catch {
			continue; // a level is gone (e.g. a revoked token); expiry ends the task
		}
		if (evaluation.result === "allow") {
			// The decision is recorded in the task's turn; the dispatch then waits for the node outside
			// this call, and decide() ends the task itself when the dispatch fails.
			core.background(
				`task ${row.id}: dispatch after a rule change failed`,
				decide(core, row.id, rulesApproval(now())),
			);
		} else if (evaluation.result === "deny") {
			await core.taskQueue.run(row.id, async () => {
				// The row may have changed while it was judged: write the denial at the rev read in this turn.
				const current = await core.row(row.id);
				if (current?.state !== "awaiting_approval" || current.handler_type === null) return;
				await endTask(core, row.id, {
					write: {
						from: ["awaiting_approval"],
						rev: current.rev,
						set: {
							state: "denied",
							error_code: "policy_denied",
							error_message: "denied by the authorization rules",
							approval: JSON.stringify({ evaluation }),
							pending_input: null,
							handler_type: null,
							handler_session_id: null,
						},
					},
					onChange: current.actor_id,
				});
			});
		}
	}
}
