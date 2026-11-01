/**
 * The task state machine (doc/execution-plane.md#状态机): creating a task, dispatching it, recording its
 * output while it runs, settling it in its terminal state, cancelling it and the waiters, approval and
 * rule-change decisions, and the state of the task groups those tasks belong to.
 */
import { createHash } from "node:crypto";
import {
	ConnectionError,
	ProtocolError,
	RemoteError,
	type TaskExit,
	type TaskSpec,
	taskResultToJson,
	taskSpecFromJson,
	taskSpecToJson,
} from "@crh/protocol";
import type { Insertable, Selectable, Updateable } from "kysely";
import { type Evaluation, evaluate, operationOf } from "../policy/rules.ts";
import { loadChain, type RuleRef } from "../policy/store.ts";
import type { OutputMode, TaskState as TaskRowState, TasksTable } from "../storage/schema.ts";
import { newId } from "../util/id.ts";
import { parseTaskAuthorization } from "./authorization.ts";
import { planPrivileged, withdrawLocal } from "./authorization-flow.ts";
import { createLiveTask, GroupBudget, type LiveTask, type OutputSnapshot } from "./batch-output.ts";
import type { NodeConnection } from "./connection.ts";
import { type ClusterCore, now } from "./core.ts";
import { getNode, type NodeRow, nodeGroupNames } from "./nodes.ts";
import { specFromRow, summarize, withInputRef } from "./spec.ts";
import { runSsh } from "./ssh-runner.ts";
import { taskStartOf } from "./task-start.ts";
import { outputColumns, toView } from "./task-view.ts";
import {
	type Actor,
	type ApprovalDecision,
	type ApprovalRecord,
	AUTHORIZATION_CODES,
	type CreateTaskInput,
	GROUP_TERMINAL,
	recorded,
	type TaskView,
	TERMINAL,
} from "./types.ts";

/** A task between dispatch and its recorded end: output accumulates here, not in the database. */
export interface Live {
	id: string;
	nodeId: string;
	/** The task's group, for the shared batch budget; null for a single task. */
	groupId: string | null;
	output: LiveTask;
}

/** No output at all: a task that never ran, or a status task before task.exit names its file. */
const EMPTY_OUTPUT: OutputSnapshot = {
	stdoutBytes: 0,
	stderrBytes: 0,
	stdoutHead: null,
	stdoutTail: null,
	stderrHead: null,
	stderrTail: null,
};

/**
 * The row write that ends a task: an update of a task that was running, or the insert of a task that
 * is denied as it is created (which never exists in a non-terminal state).
 */
type TaskRowWrite =
	| {
			/** Creates the row; `ended` says whether it is already terminal (a task denied at creation). */
			insert: Insertable<TasksTable>;
			ended: boolean;
	  }
	| { from: readonly TaskRowState[]; set: Updateable<TasksTable>; nodeId?: string };

/**
 * One ending of a task: the row write, then the side effects every ending shares, in this order: the
 * live output, the waiters, the group's state, the session inbox and the task.finished audit. The
 * options say which of them apply; see each call site for the combination it needs.
 */
interface TaskEnd {
	write: TaskRowWrite;
	/** What happens to the live output; "none" for a task that never had one (it was still waiting). */
	live?: "drop" | "keep" | "none";
	/**
	 * Whether the live output and the waiters are handled even when the write matched no row: the
	 * dispatch side must clean up after a task another path has already ended.
	 */
	always?: boolean;
	/** Whether the waiters are woken (default true). */
	notify?: boolean;
	/**
	 * The group whose state is re-derived after the write: an id, the task's own group ("row"), or
	 * null for none. The group of a task that never started is not synced today (see the call sites).
	 */
	group?: string | null | "row";
	/** Whether the group sync is awaited (the dispatch side does) or left in the background. */
	awaitGroup?: boolean;
	/** The actor whose session state changed; the runtime refreshes its inbox. */
	onChange?: string;
	/** Whether task.finished is audited (default true); the approval paths audit themselves. */
	audit?: boolean;
	/** Runs after the row was written (and matched), after the waiters are woken: an outstanding local request. */
	afterWrite?: () => void;
}

// ---- creating and dispatching tasks ----

/** How the rule chain judges running `spec` on a node. */
export async function evaluateFor(
	core: ClusterCore,
	node: NodeRow,
	spec: TaskSpec,
	chain: RuleRef[],
	privileged: boolean,
): Promise<Evaluation> {
	const groups = (await nodeGroupNames(core.db, [node.id])).get(node.id) ?? [];
	const levels = await loadChain(core.db, chain);
	return evaluate(levels, {
		...operationOf(spec),
		node: { id: node.id, name: node.name, groups },
		privileged,
	});
}

/**
 * Creates a task. With a rule chain it is first judged: denied, left waiting for approval, or
 * dispatched. A node that is not connected at dispatch fails it at once with node_offline.
 */
export async function createTask(core: ClusterCore, input: CreateTaskInput): Promise<TaskView> {
	if (core.closing) throw new Error("the server is shutting down");
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
		const evaluation = await evaluateFor(core, node, input.spec, input.chain, privileged);
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
		stdout_bytes: 0,
		stderr_bytes: 0,
		stdout_head: null,
		stdout_tail: null,
		stderr_head: null,
		stderr_tail: null,
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
	if (!waiting && !denied) await core.taskQueue.run(id, () => dispatch(core, id, node, spec, inputBytes, input));
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
	const ssh = node.transport === "ssh";
	const link = core.links.get(node.id);
	const row = await core.row(id);
	const fresh = await getNode(core.db, node.id);
	const online =
		fresh?.status === "active" && (ssh ? core.sshRoute !== undefined : link?.ready === true && !link.conn.closed);
	if (!online) {
		await endTask(core, id, {
			write: {
				from: ["awaiting_approval"],
				set: {
					state: "failed",
					error_code: "node_offline",
					error_message: "the node is not connected",
					pending_input: null,
					handler_type: null,
					handler_session_id: null,
				},
			},
			group: row?.task_group_id ?? null,
		});
		return;
	}
	// A privileged task on a forward node needs an authorization before task.start (doc/privilege.md#授权路径).
	// native/ignore/reject nodes, SSH nodes and ordinary tasks keep the plain dispatch below.
	if (!ssh && link && row?.privileged === 1 && fresh?.privileged_mode === "forward") {
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
		newLive(core, id, node.id, row?.output_mode ?? "full", row?.task_group_id ?? null);
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
		newLive(core, id, node.id, row?.output_mode ?? "full", row?.task_group_id ?? null);
		// The start may be refused or the link may drop; the state machine follows the response.
		core.background("task dispatch failed", dispatchRemote(core, link, id, spec, inputBytes, opts));
	}
}

/**
 * Sends `task.start` exactly once, then, once accepted, the input as pipelined `task.input` requests.
 * See doc/execution-plane.md#不重复执行与授权重试.
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
	try {
		await link.conn.peer.request("task.start", start);
	} catch (err) {
		if (err instanceof ConnectionError) {
			// The task stays dispatched; the grace timer reports dispatch_unconfirmed.
			return;
		}
		if (err instanceof RemoteError) {
			const final: Updateable<TasksTable> = AUTHORIZATION_CODES.has(err.code)
				? { state: "rejected", error_code: err.code, error_message: err.message }
				: { state: "failed", error_code: err.code, error_message: err.message };
			await core.taskQueue.run(id, () => finish(core, nodeId, id, final));
			return;
		}
		if (err instanceof ProtocolError) {
			// Raised locally while encoding: the request was never sent, so nothing can have run.
			await core.taskQueue.run(id, () =>
				finish(core, nodeId, id, { state: "failed", error_code: "invalid_spec", error_message: err.message }),
			);
			return;
		}
		console.error("task.start failed:", err);
		link.conn.close("send failed");
		return;
	}
	await core.taskQueue.run(id, () => onAccepted(core, nodeId, id));
	// Pipelined: crha processes the chunks in order; a failed chunk fails the task on its side.
	for (let off = 0; off < inputBytes.length; off += core.chunkBytes) {
		const data = inputBytes.subarray(off, off + core.chunkBytes);
		void link.conn.peer
			.request("task.input", { taskId: id, offset: off, data })
			.catch((err: unknown) => console.error(`task.input for ${id} failed:`, err));
	}
}

/** The node accepted the start: the task runs. */
export async function onAccepted(core: ClusterCore, nodeId: string, taskId: string): Promise<void> {
	await core.db
		.updateTable("tasks")
		.set({ state: "running", accepted_at: now() })
		.where("id", "=", taskId)
		.where("node_id", "=", nodeId)
		.where("state", "=", "dispatched")
		.execute();
	core.notify(taskId);
}

/** task.exit: the node reports the task's end, with the output it says it sent before it. */
export async function onExit(core: ClusterCore, conn: NodeConnection, exit: TaskExit): Promise<void> {
	const row = await core.row(exit.taskId);
	if (!row || row.node_id !== conn.nodeId) return;
	const existing = core.live.get(exit.taskId);
	// The result is already recorded and crha resent task.exit after a lost task.exit.ack: there is no
	// live record to complete, and re-sending the task must not close the connection in a loop.
	if (recorded(row.state) && !existing) {
		conn.peer.emit("task.exit.ack", { taskId: row.id });
		return;
	}
	const live = existing ?? newLive(core, exit.taskId, conn.nodeId, row.output_mode, row.task_group_id);
	// TaskExit follows all output on the wire; if bytes are missing, the client will resend after a
	// reconnect and send TaskExit again. Record what we have only when complete. A `status` task gets
	// no task.output at all, so there is nothing to wait for (doc/execution-plane.md#输出).
	const complete =
		row.output_mode === "status" ||
		(live.output.end("stdout") >= exit.stdoutEnd && live.output.end("stderr") >= exit.stderrEnd);
	if (!complete) return conn.close("output incomplete at exit");

	// A status task's byte totals come from task.exit; the other modes already received the bytes.
	const output =
		row.output_mode === "status"
			? live.output.snapshot({ stdout: exit.stdoutEnd, stderr: exit.stderrEnd })
			: live.output.snapshot();
	const outcome = exit.outcome;
	const fields: Updateable<TasksTable> = {
		exit_code: outcome.kind === "code" ? outcome.value : null,
		signal: outcome.kind === "signal" ? outcome.value : null,
		error_code: outcome.kind === "error" ? outcome.code : null,
		error_message: outcome.kind === "error" ? outcome.message : null,
		timed_out: exit.timedOut ? 1 : 0,
		cancelled: exit.cancelled ? 1 : 0,
		result: exit.result === null ? null : JSON.stringify(taskResultToJson(exit.result)),
		...outputColumns(output),
		output_file: exit.outputFile || null,
	};
	if (row.state === "unknown") {
		// Already reported as unknown: keep that answer, but record what really happened.
		await core.db
			.updateTable("tasks")
			.set({ late_result: JSON.stringify(fields) })
			.where("id", "=", row.id)
			.execute();
	} else if (!TERMINAL.has(row.state)) {
		await finish(core, conn.nodeId, row.id, { ...fields, state: outcome.kind === "error" ? "failed" : "exited" });
	}
	dropLive(core, row.id);
	conn.peer.emit("task.exit.ack", { taskId: row.id });
}

// ---- the terminal state and its side effects ----

/**
 * Ends a task: writes its terminal row, then runs the side effects every ending shares (see TaskEnd
 * for the order). Returns whether the row matched: an ending that lost a race is a no-op for
 * everything the caller works on afterwards.
 */
export async function endTask(core: ClusterCore, id: string, end: TaskEnd): Promise<boolean> {
	const { write } = end;
	let updated: boolean;
	if ("insert" in write) {
		await core.db.insertInto("tasks").values(write.insert).execute();
		updated = write.ended;
	} else {
		updated = await writeTerminal(core, id, write.from, write.set, write.nodeId);
	}
	if (!updated && !end.always) return false;
	if (end.live === "drop") dropLive(core, id);
	else if (end.live === "keep") keepUnknownOutput(core, id);
	if (end.notify !== false) core.notify(id);
	if (updated) {
		end.afterWrite?.();
		const sync =
			end.group === "row" ? syncGroupOfTask(core, id) : end.group ? syncGroupState(core, end.group) : undefined;
		if (sync) {
			if (end.awaitGroup) await sync;
			else core.background("task group state update failed", sync);
		}
		if (end.onChange !== undefined) core.onChange?.(end.onChange);
		if (end.audit !== false) await auditFinish(core, id);
	}
	return updated;
}

/** The guarded row write of an ending: only a task in one of `from` (on `nodeId`) is written. */
async function writeTerminal(
	core: ClusterCore,
	id: string,
	from: readonly TaskRowState[],
	set: Updateable<TasksTable>,
	nodeId?: string,
): Promise<boolean> {
	let update = core.db
		.updateTable("tasks")
		.set({ ...set, finished_at: now() })
		.where("id", "=", id)
		.where("state", "in", [...from]);
	if (nodeId !== undefined) update = update.where("node_id", "=", nodeId);
	const res = await update.executeTakeFirst();
	return res.numUpdatedRows > 0n;
}

/** The dispatch side's ending: the outcome the node reported, on a task that was sent to it. */
export async function finish(
	core: ClusterCore,
	nodeId: string,
	id: string,
	fields: Updateable<TasksTable>,
): Promise<void> {
	await endTask(core, id, {
		write: { from: ["dispatched", "running"], set: fields, nodeId },
		live: fields.state === "unknown" ? "keep" : "drop",
		always: true,
		group: "row",
		awaitGroup: true,
	});
}

/** The node's answer is unknown (no link, no result): the task ends as `unknown(reason)`. */
export async function markUnknown(core: ClusterCore, id: string, reason: string): Promise<void> {
	const row = await core.row(id);
	if (!row || TERMINAL.has(row.state)) return;
	const output = core.live.get(id)?.output.snapshot() ?? EMPTY_OUTPUT;
	await finish(core, row.node_id, id, {
		state: "unknown",
		error_code: reason,
		error_message: "execution status unknown",
		...outputColumns(output),
	});
}

/** Updates a task only from the states the caller has observed, so a settled task is never rewritten. */
export async function updateTask(
	core: ClusterCore,
	id: string,
	from: readonly TaskRowState[],
	set: Updateable<TasksTable>,
): Promise<boolean> {
	const res = await core.db
		.updateTable("tasks")
		.set(set)
		.where("id", "=", id)
		.where("state", "in", [...from])
		.executeTakeFirst();
	if (res.numUpdatedRows === 0n) return false;
	core.notify(id);
	return true;
}

// ---- task groups ----

/**
 * A task group shows awaiting_authorization while every unfinished task of it waits for a signature,
 * and running otherwise (doc/execution-plane.md#状态机). The group's own end states are left alone.
 */
export async function syncGroupState(core: ClusterCore, groupId: string | null): Promise<void> {
	if (!groupId) return;
	const group = await core.db.selectFrom("task_groups").select("state").where("id", "=", groupId).executeTakeFirst();
	if (!group || (group.state !== "running" && group.state !== "awaiting_authorization")) return;
	const rows = await core.db.selectFrom("tasks").select("state").where("task_group_id", "=", groupId).execute();
	const unfinished = rows.filter((row) => !TERMINAL.has(row.state));
	const next =
		unfinished.length > 0 && unfinished.every((row) => row.state === "awaiting_authorization")
			? "awaiting_authorization"
			: "running";
	if (next === group.state) return;
	await core.db
		.updateTable("task_groups")
		.set({ state: next })
		.where("id", "=", groupId)
		.where("state", "=", group.state)
		.execute();
}

/** Re-derives the state of the task's group after the task settled. */
async function syncGroupOfTask(core: ClusterCore, id: string): Promise<void> {
	const row = await core.db.selectFrom("tasks").select("task_group_id").where("id", "=", id).executeTakeFirst();
	if (row?.task_group_id) await syncGroupState(core, row.task_group_id);
}

/** Whether the task's group already ended, so none of its members may run any more. */
export async function groupEnded(core: ClusterCore, groupId: string | null): Promise<boolean> {
	if (!groupId) return false;
	const group = await core.db.selectFrom("task_groups").select("state").where("id", "=", groupId).executeTakeFirst();
	return group !== undefined && GROUP_TERMINAL.has(group.state);
}

// ---- the audits of a task's end ----

/** task.finished: the outcome, as recorded. A cancellation names the actor who asked for it. */
async function auditFinish(core: ClusterCore, id: string): Promise<void> {
	const cancelledBy = core.cancelledBy.get(id);
	core.cancelledBy.delete(id);
	if (!core.audit) return;
	const row = await core.row(id);
	if (!row) return;
	const outputHash = createHash("sha256")
		.update(`${row.stdout_head ?? ""}\n${row.stdout_tail ?? ""}\n${row.stderr_head ?? ""}\n${row.stderr_tail ?? ""}`)
		.digest("hex");
	core.auditLater({
		actor:
			cancelledBy && row.cancelled === 1
				? auditActor(cancelledBy)
				: { type: "system", id: "cluster", onBehalfOfUserId: row.on_behalf_of_user_id },
		action: "task.finished",
		target: { type: "task", id },
		detail: {
			node_id: row.node_id,
			state: row.state,
			exit_code: row.exit_code,
			signal: row.signal,
			error_code: row.error_code,
			timed_out: row.timed_out === 1,
			cancelled: row.cancelled === 1,
			stdout_bytes: Number(row.stdout_bytes),
			stderr_bytes: Number(row.stderr_bytes),
			// Of the kept head and tail; crhs never has the full output.
			kept_output_sha256: outputHash,
			output_file: row.output_file,
		},
	});
}

async function auditApproval(core: ClusterCore, row: Selectable<TasksTable>, d: ApprovalDecision): Promise<void> {
	core.auditLater({
		actor: { type: d.by.type, id: d.by.id, onBehalfOfUserId: d.by.onBehalfOfUserId ?? row.on_behalf_of_user_id },
		action: "task.approval",
		target: { type: "task", id: row.id },
		detail: { decision: d.decision, reason: d.reason },
	});
}

function auditActor(actor: Actor) {
	return { type: actor.type, id: actor.id, onBehalfOfUserId: actor.onBehalfOfUserId };
}

// ---- approval decisions ----

/**
 * Settles a task waiting for approval. Returns false if it is not waiting (already settled, or never
 * needed approval). Who may decide is checked by the caller.
 */
export function decide(core: ClusterCore, id: string, decision: ApprovalDecision): Promise<boolean> {
	return core.taskQueue.run(id, async () => {
		const row = await core.row(id);
		if (row?.state !== "awaiting_approval") return false;
		const record: ApprovalRecord = { ...(JSON.parse(row.approval ?? "{}") as ApprovalRecord), decision };
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
			const input = row.pending_input ? Buffer.from(row.pending_input, "base64") : new Uint8Array(0);
			core.background("task approval audit failed", auditApproval(core, row, decision));
			if (node) {
				await dispatch(core, id, node, spec, input, {
					privileged: row.privileged === 1,
					timeoutMs: row.timeout_ms ?? undefined,
				});
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

/** Stores Auto Review's verdict on a waiting task. */
export async function recordReview(
	core: ClusterCore,
	id: string,
	review: NonNullable<ApprovalRecord["review"]>,
): Promise<void> {
	await core.taskQueue.run(id, async () => {
		const row = await core.row(id);
		if (row?.state !== "awaiting_approval") return;
		const record: ApprovalRecord = { ...(JSON.parse(row.approval ?? "{}") as ApprovalRecord), review };
		await core.db
			.updateTable("tasks")
			.set({ approval: JSON.stringify(record) })
			.where("id", "=", id)
			.execute();
		core.auditLater({
			actor: { type: "system", id: "auto-review", onBehalfOfUserId: row.on_behalf_of_user_id },
			action: "task.review",
			target: { type: "task", id },
			detail: review,
		});
	});
}

/**
 * Hands a waiting task's approval to an ancestor session's agent. False when it is no longer waiting (Auto Review
 * or the user settled it first).
 */
export function requestAgentDecision(core: ClusterCore, id: string, session: string): Promise<boolean> {
	return core.taskQueue.run(id, async () => {
		const row = await core.row(id);
		if (row?.state !== "awaiting_approval") return false;
		const record: ApprovalRecord = {
			...(JSON.parse(row.approval ?? "{}") as ApprovalRecord),
			agent: { session, state: "pending" },
		};
		await core.db
			.updateTable("tasks")
			.set({
				approval: JSON.stringify(record),
				handler_type: "agent",
				handler_session_id: session,
			})
			.where("id", "=", id)
			.execute();
		core.onChange?.(row.actor_id);
		core.auditLater({
			actor: { type: "system", id: "agent-routing" },
			action: "task.agent_request",
			target: { type: "task", id },
			detail: { session },
		});
		return true;
	});
}

/** The agent passed the request on to the user: the approval page takes it from here. */
export function escalateAgentDecision(core: ClusterCore, id: string, session: string): Promise<boolean> {
	return core.taskQueue.run(id, async () => {
		const row = await core.row(id);
		if (row?.state !== "awaiting_approval") return false;
		const record: ApprovalRecord = {
			...(JSON.parse(row.approval ?? "{}") as ApprovalRecord),
			agent: { session, state: "escalated" },
		};
		await core.db
			.updateTable("tasks")
			.set({
				approval: JSON.stringify(record),
				handler_type: "user",
				handler_session_id: null,
			})
			.where("id", "=", id)
			.execute();
		core.onChange?.(row.actor_id);
		core.auditLater({
			actor: { type: "system", id: "agent-routing" },
			action: "task.agent_escalated",
			target: { type: "task", id },
			detail: { session },
		});
		return true;
	});
}

/**
 * Judges waiting tasks again after rules on their chain changed (doc/access-control.md#审批): allow
 * dispatches them, deny ends them, require-approval leaves them waiting.
 */
export async function reevaluate(core: ClusterCore, ref: RuleRef): Promise<void> {
	const rows = await core.db
		.selectFrom("tasks")
		.selectAll()
		.where("state", "=", "awaiting_approval")
		.where("rule_chain", "is not", null)
		.execute();
	for (const row of rows) {
		const chain = JSON.parse(row.rule_chain ?? "[]") as RuleRef[];
		if (!chain.some((r) => r.type === ref.type && r.id === ref.id)) continue;
		const node = await getNode(core.db, row.node_id);
		if (!node) continue;
		let evaluation: Evaluation;
		try {
			evaluation = await evaluateFor(core, node, taskSpecFromJson(JSON.parse(row.spec)), chain, row.privileged === 1);
		} catch {
			continue; // a level is gone (e.g. a revoked token); expiry ends the task
		}
		const by = { type: "system", id: "rules" };
		if (evaluation.result === "allow") {
			await decide(core, row.id, { decision: "approved", by, at: now(), reason: "allowed by changed rules" });
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

// ---- reading, waiting for and cancelling a task ----

export async function getTask(core: ClusterCore, id: string): Promise<TaskView | undefined> {
	const row = await core.row(id);
	return row ? toView(row, core.live.get(id)) : undefined;
}

/**
 * Waits until the task is in a final state, the timeout passes or endWaits() ends the waits; returns its
 * current view (never undefined for an existing task). A wait ended by shutdown returns at once, so a
 * handler holding it does not hold the drain; close() runs before the database is destroyed, so that
 * read is safe.
 */
export async function waitTask(
	core: ClusterCore,
	id: string,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<TaskView | undefined> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const view = await getTask(core, id);
		if (!view || TERMINAL.has(view.state) || core.waitsEnded || Date.now() >= deadline || signal?.aborted) {
			return view;
		}
		await new Promise<void>((resolve) => {
			const waiters = core.waiters.get(id) ?? new Set();
			core.waiters.set(id, waiters);
			const done = () => {
				clearTimeout(timer);
				waiters.delete(done);
				signal?.removeEventListener("abort", done);
				resolve();
			};
			const timer = setTimeout(done, deadline - Date.now());
			signal?.addEventListener("abort", done);
			waiters.add(done);
		});
	}
}

/**
 * Asks the node to cancel a running task. A task that still waits for its approval or its
 * authorization signature was never dispatched, so it ends here instead (there is no node-side task).
 * Returns false if the task already ended or the node is offline. `message` replaces the default reason of
 * a task that ends before dispatch (e.g. its session was stopped). `by` is the actor who asked for the
 * cancellation: the task.finished audit event names it, or the system when it is absent.
 */
export async function cancelTask(
	core: ClusterCore,
	id: string,
	message = "the task was cancelled before it was dispatched",
	by?: Actor,
): Promise<boolean> {
	const row = await core.row(id);
	if (!row || TERMINAL.has(row.state)) return false;
	if (by) core.cancelledBy.set(id, by);
	if (row.state === "awaiting_approval" || row.state === "awaiting_authorization") {
		const record = parseTaskAuthorization(row.authorization);
		const link = core.links.get(row.node_id);
		return endTask(core, id, {
			write: {
				from: [row.state],
				set: {
					state: "rejected",
					error_code: "cancelled",
					error_message: message,
					cancelled: 1,
					pending_input: null,
					handler_type: null,
					handler_session_id: null,
				},
			},
			afterWrite: () => withdrawLocal(link, id, record),
			group: row.task_group_id,
			onChange: row.actor_id,
		});
	}
	const ssh = core.sshCancels.get(id);
	if (ssh) {
		ssh.abort();
		return true;
	}
	const link = core.links.get(row.node_id);
	if (!link?.ready) return false;
	void link.conn.peer.request("task.cancel", { taskId: id }).catch((err: unknown) => {
		if (!(err instanceof ConnectionError)) console.error(`task.cancel for ${id} failed:`, err);
	});
	return true;
}

// ---- live output ----

/** The live record of a task between dispatch and its recorded end. */
export function newLive(core: ClusterCore, id: string, nodeId: string, mode: OutputMode, groupId: string | null): Live {
	// `text` and `head` draw from the group's budget; a single task's `full` keeps its own head/tail.
	const budget = mode === "text" || mode === "head" ? budgetFor(core, budgetKey(groupId, id)) : undefined;
	const live: Live = { id, nodeId, groupId, output: createLiveTask(mode, budget) };
	core.live.set(id, live);
	return live;
}

function budgetFor(core: ClusterCore, key: string): GroupBudget {
	let budget = core.budgets.get(key);
	if (!budget) {
		budget = new GroupBudget();
		core.budgets.set(key, budget);
	}
	return budget;
}

/** Drops the live record. A group's budget outlives its tasks and goes with releaseGroupBudget. */
export function dropLive(core: ClusterCore, id: string): void {
	const timer = core.unknownTimers.get(id);
	if (timer) {
		clearTimeout(timer);
		core.unknownTimers.delete(id);
	}
	const live = core.live.get(id);
	if (!live) return;
	core.live.delete(id);
	// A text task outside a group has no group end to release its budget.
	if (live.groupId === null) core.budgets.delete(budgetKey(null, live.id));
}

/** Keeps an unknown task's output for a late result, but no longer than UNKNOWN_OUTPUT_KEEP_MS. */
function keepUnknownOutput(core: ClusterCore, id: string): void {
	if (!core.live.has(id) || core.unknownTimers.has(id)) return;
	core.unknownTimers.set(
		id,
		setTimeout(() => {
			core.unknownTimers.delete(id);
			dropLive(core, id);
		}, core.unknownKeepMs),
	);
}

/** The live record of a task if the connection reporting it owns the task. */
export function ownLive(core: ClusterCore, nodeId: string, taskId: string): Live | undefined {
	const live = core.live.get(taskId);
	return live?.nodeId === nodeId ? live : undefined;
}

/**
 * Releases the output budget a batch `text` group shares. TaskGroups calls this when the group itself is
 * done (finished, interrupted or rejected), not when its last task ends: with `parallel: 1` every node
 * would otherwise get a fresh budget. Returns whether a budget was still held.
 */
export function releaseGroupBudget(core: ClusterCore, groupId: string): boolean {
	return core.budgets.delete(groupBudgetKey(groupId));
}

/** A group's budget is shared by its tasks; a single text task (not produced by the code) gets its own. */
function budgetKey(groupId: string | null, taskId: string): string {
	return groupId ? groupBudgetKey(groupId) : `task:${taskId}`;
}

function groupBudgetKey(groupId: string): string {
	return `group:${groupId}`;
}
