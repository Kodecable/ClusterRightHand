/**
 * Creating and dispatching a task (doc/execution-plane.md#状态机): judging it with the rule chain, writing
 * its row, and moving it out of awaiting_approval to the node, to the authorization of a privileged task,
 * or to an SSH run.
 */
import { createHash } from "node:crypto";
import { type TaskSpec, taskSpecToJson } from "@crh/protocol";
import type { Insertable } from "kysely";
import { type Evaluation, evaluate, operationOf } from "../policy/rules.ts";
import { loadChain, type RuleRef } from "../policy/store.ts";
import type { TasksTable } from "../storage/schema.ts";
import { newId } from "../util/id.ts";
import { planPrivileged } from "./authorization/plan.ts";
import { checkedOutputLimits } from "./batch-output.ts";
import type { NodeConnection } from "./connection.ts";
import { type ClusterCore, now } from "./core.ts";
import { newLive } from "./live-output.ts";
import { userCanAccessNode } from "./node-access.ts";
import { nodeGroupIdsForNodes } from "./node-groups.ts";
import { getNode, type NodeRow } from "./nodes.ts";
import { summarize, withInputRef } from "./spec.ts";
import { runSsh } from "./ssh-runner.ts";
import { auditActor, endTask, endUndispatched, failNodeAccessRevoked, failNodeOffline } from "./task-end.ts";
import { sendTaskStart, taskStartOf } from "./task-start.ts";
import { getTask } from "./task-wait.ts";
import type { ApprovalRecord, CreateTaskInput, TaskView } from "./types.ts";

/** How the rule chain judges running `spec` on a node. */
export async function evaluateFor(
	core: ClusterCore,
	node: NodeRow,
	spec: TaskSpec,
	chain: RuleRef[],
	privileged: boolean,
): Promise<Evaluation> {
	const evaluations = await evaluateForNodes(core, [node], spec, chain, privileged);
	return evaluations.get(node.id) as Evaluation;
}

/**
 * How the rule chain judges `spec` on each node. A task group judges every node before its members start,
 * and the chain and the spec are the same for all of them: the chain is loaded once and the nodes' groups
 * in one query, instead of two queries per node (doc/execution-plane.md#状态机).
 */
export async function evaluateForNodes(
	core: ClusterCore,
	nodes: readonly NodeRow[],
	spec: TaskSpec,
	chain: RuleRef[],
	privileged: boolean,
): Promise<Map<string, Evaluation>> {
	const levels = await loadChain(core.db, chain);
	const nodeGroupIds = await nodeGroupIdsForNodes(
		core.db,
		nodes.map((node) => node.id),
	);
	const operations = operationOf(spec);
	const evaluations = new Map<string, Evaluation>();
	for (const node of nodes) {
		evaluations.set(
			node.id,
			evaluate(levels, {
				...operations,
				node: { id: node.id, groupIds: nodeGroupIds.get(node.id) ?? [] },
				privileged,
			}),
		);
	}
	return evaluations;
}

/**
 * Creates a task. With a rule chain it is first judged: denied, left waiting for approval, or
 * dispatched. A node that is not connected at dispatch gets the offline grace (D113) and then
 * fails with node_offline.
 */
export async function createTask(core: ClusterCore, input: CreateTaskInput): Promise<TaskView> {
	if (core.closing) throw new Error("the server is shutting down");
	const limits = checkedOutputLimits(input.maxLines, input.maxBytes);
	const node = await getNode(core.db, input.nodeId);
	if (!node) throw new Error(`no such node: ${input.nodeId}`);
	const kind = input.spec.kind;
	if (input.id) {
		const existing = await getTask(core, input.id);
		if (existing) return existing;
	}
	const id = input.id ?? newId();
	const inputBytes = input.input ?? new Uint8Array(0);
	const inputSha = createHash("sha256").update(inputBytes).digest();
	const spec = withInputRef(input.spec, input.input ? { size: inputBytes.length, sha256: inputSha } : undefined);

	let approval: ApprovalRecord | undefined;
	let verdict: "allow" | "deny" | "require-approval" = "allow";
	const privileged = input.privileged === true;
	if (input.chain) {
		// A task group already judged its nodes: judging them again would repeat the chain's reads.
		const evaluation = input.evaluation ?? (await evaluateFor(core, node, input.spec, input.chain, privileged));
		approval = { evaluation };
		verdict = evaluation.result;
		if (verdict === "require-approval" && input.approvedBy) {
			approval.decision = input.approvedBy;
			verdict = "allow";
		}
	}
	const waiting = verdict === "require-approval";
	const denied = verdict === "deny";
	// Group waiting approvals by session tree: the first session of the chain (a schedule comes before it).
	const root = input.chain?.find((ref) => ref.type === "session");
	const values: Insertable<TasksTable> = {
		id,
		org_id: node.org_id,
		node_id: node.id,
		task_group_id: input.taskGroupId ?? null,
		kind,
		spec: JSON.stringify(taskSpecToJson(spec)),
		attempt: 1,
		input_size: input.input ? inputBytes.length : null,
		input_sha256: input.input ? inputSha.toString("hex") : null,
		privileged: input.privileged ? 1 : 0,
		timeout_ms: input.timeoutMs ?? null,
		output_mode: input.outputMode ?? "full",
		max_lines: limits.maxLines,
		max_bytes: limits.maxBytes,
		// Allowed tasks pass through awaiting_approval only for the instant before dispatch.
		state: denied ? "denied" : "awaiting_approval",
		exit_code: null,
		signal: null,
		timed_out: 0,
		cancelled: 0,
		error_code: denied ? "policy_denied" : null,
		error_message: denied ? "denied by the authorization rules" : null,
		actor_type: input.actor.type,
		actor_id: input.actor.id,
		on_behalf_of_user_id: input.actor.onBehalfOfUserId,
		created_at: now(),
		dispatched_at: null,
		accepted_at: null,
		finished_at: denied ? now() : null,
		output_bytes: 0,
		output_head: null,
		output_tail: null,
		output_lines: null,
		notice: null,
		result: null,
		output_file: null,
		late_result: null,
		rule_chain: input.chain ? JSON.stringify(input.chain) : null,
		approval: approval ? JSON.stringify(approval) : null,
		pending_input: waiting && input.input ? Buffer.from(inputBytes).toString("base64") : null,
		root_session_id: root?.id ?? null,
		// Until an ancestor agent is routed, the user (the task's on_behalf user) is the handler.
		handler_type: waiting ? "user" : null,
		handler_session_id: null,
	};
	await endTask(core, id, {
		write: { insert: values, ended: denied },
		// A denied task never runs: it keeps no output, no one waits for it, and its task.created
		// audit carries the reason (no task.finished is recorded for it).
		notify: false,
		audit: false,
	});
	core.auditLater({
		actor: auditActor(input.actor),
		action: "task.created",
		target: { type: "task", id },
		detail: {
			node_id: node.id,
			kind,
			summary: summarize(JSON.stringify(taskSpecToJson(spec))),
			task_group_id: input.taskGroupId,
			input_sha256: input.input ? inputSha.toString("hex") : undefined,
			privileged,
			policy: approval ? approval.evaluation.result : "none",
			approved_by_group: approval?.decision ? input.taskGroupId : undefined,
		},
	});
	if (!waiting && !denied) {
		try {
			await core.taskQueue.run(id, () => dispatch(core, id, node, spec, inputBytes, input));
		} catch (err) {
			// The row was written to be dispatched at once: it must not stay in awaiting_approval, where it
			// would look like an approval nobody can decide (doc/execution-plane.md#状态机).
			await endUndispatched(core, id, err);
			throw err;
		}
	}
	const view = (await getTask(core, id)) as TaskView;
	if (waiting) {
		core.onChange?.(view.actorId);
		if (core.onAwaitingApproval) {
			void core.onAwaitingApproval(view).catch((err: unknown) => console.error("review:", err));
		}
	}
	return view;
}

/** Moves a task out of awaiting_approval: sends it, parks it for authorization, or fails it. */
export async function dispatch(
	core: ClusterCore,
	id: string,
	node: NodeRow,
	spec: TaskSpec,
	inputBytes: Uint8Array,
	opts: { privileged?: boolean; timeoutMs?: number },
): Promise<void> {
	let row = await core.row(id);
	// Access may have been revoked while the task waited for approval or a signature (D108). Check again
	// immediately before anything is sent; a revoked task ends without reaching the node.
	if (row && !(await userCanAccessNode(core.db, row.on_behalf_of_user_id, node.id))) {
		await failNodeAccessRevoked(core, id, row, ["awaiting_approval"]);
		return;
	}
	const before = await getNode(core.db, node.id);
	const ssh = node.transport === "ssh";
	// A forward privileged task also waits for its new connection's trust report (D113).
	const trust = !ssh && row?.privileged === 1 && before?.privileged_mode === "forward";
	// A connected node dispatches at once; planPrivileged then waits for the trust report as before.
	// D113: a node that is off when crhs wants to send gets the grace to reconnect, not an instant failure.
	const ready = await core.readyNode(node.id, { trust });
	if (!ready) {
		await failNodeOffline(core, id, row);
		return;
	}
	// The row may have been cancelled or settled while the grace ran.
	row = await core.row(id);
	if (row?.state !== "awaiting_approval") return;
	if (!(await userCanAccessNode(core.db, row.on_behalf_of_user_id, node.id))) {
		await failNodeAccessRevoked(core, id, row, ["awaiting_approval"]);
		return;
	}
	const fresh = ready.node;
	const link = ready.link;
	// A privileged task on a forward node needs an authorization before task.start (doc/privilege.md#授权路径).
	// native/ignore/reject nodes, SSH nodes and ordinary tasks keep the plain dispatch below.
	if (!ssh && link && row.privileged === 1 && fresh.privileged_mode === "forward") {
		await planPrivileged(core, id, fresh, link, spec, inputBytes, opts, ["awaiting_approval"]);
		return;
	}
	const res = await core.db
		.updateTable("tasks")
		.set({
			state: "dispatched",
			dispatched_at: now(),
			pending_input: null,
			handler_type: null,
			handler_session_id: null,
		})
		.where("id", "=", id)
		.where("state", "=", "awaiting_approval")
		.executeTakeFirst();
	if (res.numUpdatedRows === 0n) return;
	core.notify(id);
	if (ssh) {
		newLive(core, id, node.id, row.output_mode, row.task_group_id, row.max_lines, row.max_bytes);
		core.background(
			"ssh task failed",
			runSsh(
				core,
				id,
				node,
				spec,
				inputBytes.length > 0 ? inputBytes : undefined,
				opts.timeoutMs,
				opts.privileged === true,
			),
		);
	} else if (link) {
		newLive(core, id, node.id, row.output_mode, row.task_group_id, row.max_lines, row.max_bytes);
		// The start may be refused or the link may drop; the state machine follows the response.
		core.background("task dispatch failed", dispatchRemote(core, link, id, spec, inputBytes, opts));
	}
}

/**
 * Sends a plain `task.start` (sendTaskStart). It runs in the background, so every write that follows
 * the answer is serialized on the task's queue; an authorization_* code ends the task `rejected`, since a
 * plain start has no authorization to retry with.
 */
async function dispatchRemote(
	core: ClusterCore,
	link: { conn: NodeConnection },
	id: string,
	spec: TaskSpec,
	inputBytes: Uint8Array,
	opts: { privileged?: boolean; timeoutMs?: number },
): Promise<void> {
	const nodeId = link.conn.nodeId;
	const row = await core.row(id);
	const start = taskStartOf(id, row, spec, {
		privileged: opts.privileged ?? false,
		attempt: row?.attempt ?? 1,
		timeoutMs: opts.timeoutMs ?? 0,
	});
	await sendTaskStart(core, link, nodeId, start, inputBytes, {
		settle: (write) => core.taskQueue.run(id, write),
	});
}
