/**
 * The approval of a single task (doc/access-control.md#审批): a user's or an agent's decision, Auto
 * Review's verdict, the routing to an ancestor session's agent, and the rules judging waiting tasks again
 * after they changed. The parts a task group's approval shares are in approval.ts; here every step runs
 * on the task's queue, so the row writes need no state guard of their own.
 */
import { taskSpecFromJson } from "@crh/protocol";
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
import { getNode } from "./nodes.ts";
import { specFromRow } from "./spec.ts";
import { dispatch, evaluateFor } from "./task-dispatch.ts";
import { endTask, endUndispatched } from "./task-end.ts";
import { pendingInputOf } from "./task-start.ts";
import type { AgentRequest, ApprovalDecision, ApprovalRecord } from "./types.ts";

/**
 * Settles a task waiting for approval. Returns false if it is not waiting (already settled, or never
 * needed approval). Who may decide is checked by the caller.
 */
export function decide(core: ClusterCore, id: string, decision: ApprovalDecision): Promise<boolean> {
	return core.taskQueue.run(id, async () => {
		const row = await core.row(id);
		if (row?.state !== "awaiting_approval") return false;
		const record = mergeApproval<ApprovalRecord>(row.approval, { decision });
		if (decision.decision === "approved") {
			// Read the spec before recording the decision: migration 0019 may have left a row it could not
			// convert, and the caller gets a client error instead of a half-approved task.
			const spec = specFromRow(row.spec, "task");
			await core.db
				.updateTable("tasks")
				.set({ approval: JSON.stringify(record) })
				.where("id", "=", id)
				.execute();
			const node = await getNode(core.db, row.node_id);
			const input = pendingInputOf(row);
			core.background("task approval audit failed", auditApproval(core, row, decision));
			if (node) {
				try {
					await dispatch(core, id, node, spec, input, {
						privileged: row.privileged === 1,
						timeoutMs: row.timeout_ms ?? undefined,
					});
				} catch (err) {
					// The decision is recorded, so the task is no longer waiting for one: it must not keep the
					// row in awaiting_approval (doc/execution-plane.md#状态机).
					await endUndispatched(core, id, err);
					throw err;
				}
			}
			core.onChange?.(row.actor_id);
			return true;
		}
		const rejected = await endTask(core, id, {
			write: {
				from: ["awaiting_approval"],
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
		// The rejection is audited as an approval, not as a task.finished (doc/access-control.md#记录内容).
		core.background("task approval audit failed", auditApproval(core, row, decision));
		return true;
	});
}

async function auditApproval(core: ClusterCore, row: Selectable<TasksTable>, d: ApprovalDecision): Promise<void> {
	core.auditLater(approvalAudit("task", row.id, row.on_behalf_of_user_id, d));
}

/** Stores Auto Review's verdict on a waiting task. */
export async function recordReview(core: ClusterCore, id: string, review: ApprovalReview): Promise<void> {
	await core.taskQueue.run(id, async () => {
		const row = await core.row(id);
		if (row?.state !== "awaiting_approval") return;
		const record = mergeApproval<ApprovalRecord>(row.approval, { review });
		await core.db
			.updateTable("tasks")
			.set({ approval: JSON.stringify(record) })
			.where("id", "=", id)
			.execute();
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
 * Routes a waiting task's approval to an agent or back to the user. The write is not guarded on the
 * state: the task's queue already keeps a decision from settling it in between (a group's routing runs
 * on the group's approval queue and guards its write as well).
 */
function routeAgentDecision(
	core: ClusterCore,
	id: string,
	session: string,
	state: AgentRequest["state"],
): Promise<boolean> {
	return core.taskQueue.run(id, async () => {
		const row = await core.row(id);
		if (row?.state !== "awaiting_approval") return false;
		const routing = agentRouting(session, state);
		const record = mergeApproval<ApprovalRecord>(row.approval, { agent: routing.agent });
		await core.db
			.updateTable("tasks")
			.set({ approval: JSON.stringify(record), ...routing.handler })
			.where("id", "=", id)
			.execute();
		core.onChange?.(row.actor_id);
		core.auditLater(agentRoutingAudit("task", id, session, state));
		return true;
	});
}

/**
 * Judges waiting tasks again after rules on their chain changed (doc/access-control.md#审批): allow
 * dispatches them, deny ends them, require-approval leaves them waiting. (A task group's reevaluate
 * settles the whole group: it approves when no node still requires approval, and rejects when every
 * node is denied; see TaskGroups.reevaluate.)
 */
export async function reevaluate(core: ClusterCore, ref: RuleRef): Promise<void> {
	const rows = await core.db
		.selectFrom("tasks")
		.selectAll()
		.where("state", "=", "awaiting_approval")
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
			await decide(core, row.id, rulesApproval(now()));
		} else if (evaluation.result === "deny") {
			await core.taskQueue.run(row.id, async () => {
				await endTask(core, row.id, {
					write: {
						from: ["awaiting_approval"],
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
					onChange: row.actor_id,
				});
			});
		}
	}
}
