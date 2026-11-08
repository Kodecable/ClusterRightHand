import type { RefMap, TaskGroupApprovalRecord, TaskGroupView } from "@crh/api";
import { type TaskSpec, taskSpecToJson } from "@crh/protocol";
import type { Selectable } from "kysely";
import type { Audit, AuditInput } from "../audit/audit.ts";
import type { SessionUser } from "../auth/sessions.ts";
import { targetRefs } from "../policy/refs.ts";
import type { Evaluation } from "../policy/rules.ts";
import type { RuleRef } from "../policy/store.ts";
import type { Db } from "../storage/db.ts";
import type { BatchOutputMode, TaskGroupsTable } from "../storage/schema.ts";
import { defaultOrgId } from "../users/service.ts";
import { UserError } from "../util/errors.ts";
import { derivedId, newId } from "../util/id.ts";
import { KeyedQueue } from "../util/keyed-queue.ts";
import { ALL_TARGET, nameKey } from "../util/names.ts";
import {
	agentRouting,
	agentRoutingAudit,
	approvalAudit,
	chainWith,
	mergeApproval,
	reviewAudit,
	rulesApproval,
	rulesRejection,
} from "./approval.ts";
import { checkedOutputLimits } from "./batch-output.ts";
import type { Cluster } from "./cluster.ts";
import { listNodesForUser } from "./nodes.ts";
import { operationOfJson, specFromRow, summarize } from "./spec.ts";
import { pendingInputColumn, pendingInputOf } from "./task-start.ts";
import {
	type Actor,
	type AgentRequest,
	type ApprovalDecision,
	type ApprovalExpect,
	type CreateTaskInput,
	GROUP_TERMINAL,
	type TaskView,
	TERMINAL,
} from "./types.ts";

export const DEFAULT_PARALLEL = 10;
/** One task group targets at most this many nodes, after target expansion and de-duplication (D85). */
export const MAX_GROUP_NODES = 512;
const MAX_PARALLEL = 100;
const MAX_TARGETS = 1000;

/**
 * A group's output mode. An exec group chooses `status` (default) or `text`; a file operation always
 * keeps each node's head, since a status has nothing to show for a page and exec's tail cannot be
 * continued line by line (doc/execution-plane.md#输出).
 */
export function outputModeFor(kind: string, requested?: BatchOutputMode): BatchOutputMode {
	if (kind === "exec") {
		if (requested === undefined) return "status";
		if (requested !== "head") return requested;
		throw new UserError('an exec task group takes outputMode "status" or "text"');
	}
	if (requested !== undefined && requested !== "head") {
		throw new UserError(`${kind} task groups keep each node's head (outputMode "head")`);
	}
	return "head";
}
// setTimeout cannot wait longer than ~24.8 days, so long waits loop.
const HOUR = 3_600_000;
/** Why a member that never started ends when a restart interrupts its group (doc/execution-plane.md#状态机). */
export const GROUP_INTERRUPTED_REASON = "the task group was interrupted by a restart";
/** Why a member that never started ends when its group's run threw (doc/execution-plane.md#状态机). */
export const GROUP_FAILED_REASON = "the task group failed";
/** Why a member that never started ends when the group is cancelled (doc/execution-plane.md#状态机). */
export const GROUP_CANCELLED_REASON = "the task group was cancelled";

/** Targets resolved at task-group creation: stored references and the expanded, operable nodes. */
export interface ResolvedTargets {
	/** Node/node-group UUIDs or `_all`, in input order and de-duplicated; what the group stores. */
	targets: string[];
	/** The active nodes the user may operate, after expansion and de-duplication. */
	nodeIds: string[];
	/** True for exactly one input entry that names one node: that call is a single task, not a task group. */
	singleNode: boolean;
}

/**
 * Resolves node and node-group names (case-insensitive), UUIDs or `_all` to a task group's targets and nodes
 * (D109, doc/agent-runtime.md#批量执行). An explicit node the user cannot access is an error; a node group or
 * `_all` simply expands to the current members the user can access.
 */
export async function resolveTargets(db: Db, user: SessionUser, targets: string[]): Promise<ResolvedTargets> {
	if (targets.length === 0) throw new UserError("targets must not be empty", "invalid_argument");
	const orgId = await defaultOrgId(db);
	const nodes = (await listNodesForUser(db, user)).filter((n) => n.status === "active");
	const nodeGroups = await db.selectFrom("node_groups").select(["id", "name"]).where("org_id", "=", orgId).execute();
	const ids = new Set<string>();
	const refs: string[] = [];
	const addRef = (ref: string): void => {
		if (!refs.includes(ref)) refs.push(ref);
	};
	for (const target of targets) {
		if (target === ALL_TARGET) {
			addRef(ALL_TARGET);
			for (const node of nodes) ids.add(node.id);
			continue;
		}
		const node = nodes.find((n) => n.id === target || nameKey(n.name) === nameKey(target));
		if (node) {
			addRef(node.id);
			ids.add(node.id);
			continue;
		}
		const nodeGroup = nodeGroups.find((g) => g.id === target || nameKey(g.name) === nameKey(target));
		if (!nodeGroup) throw new UserError(`no node or node group ${target} that you can access`, "no_such_node");
		addRef(nodeGroup.id);
		for (const n of nodes) {
			if (n.nodeGroups.some((g) => g.id === nodeGroup.id)) ids.add(n.id);
		}
	}
	if (ids.size === 0) throw new UserError("the targets match no node that you can access", "no_such_node");
	if (ids.size > MAX_TARGETS) throw new UserError(`at most ${MAX_TARGETS} targets per batch`, "invalid_argument");
	const singleNode = targets.length === 1 && refs[0] !== ALL_TARGET && nodes.some((n) => n.id === refs[0]);
	return { targets: refs, nodeIds: [...ids], singleNode };
}

export interface CreateTaskGroupInput
	extends Omit<CreateTaskInput, "nodeId" | "taskGroupId" | "approvedBy" | "noWait"> {
	targets: string[];
	nodeIds: string[];
	parallel?: number;
	failFast?: boolean;
	/** Batch output mode; defaults to `status` for exec and is fixed to `head` for file operations. */
	outputMode?: BatchOutputMode;
	actor: Actor;
	/** A caller-chosen id; an existing group with it is returned as is (see CreateTaskInput.id). */
	id?: string;
}

/** The approval state of a task group: per-node evaluations, then the one decision for the group. */
export type { TaskGroupApprovalRecord, TaskGroupView };

interface Deferred {
	promise: Promise<void>;
	resolve: () => void;
}

/**
 * Runs one task per node with bounded parallelism; see doc/agent-runtime.md#批量执行. With a rule chain
 * the nodes are judged first; if any needs approval the whole group waits for one decision.
 */
export class TaskGroups {
	readonly #db: Db;
	readonly #cluster: Cluster;
	readonly #audit: Audit | undefined;
	readonly #running = new Map<string, Promise<void>>();
	/**
	 * In-memory stop flag per group, set by cancel() or by a worker that threw. A flag is enough even when
	 * persist fails: the workers check it before every node, so no further member is created. The reason is
	 * kept for the members cancelled here; the group row has no reason column (doc/execution-plane.md#状态机).
	 */
	readonly #cancelled = new Map<string, string>();
	/** Called once for every group that starts waiting for approval (Auto Review hooks in here). */
	onAwaitingApproval: ((group: TaskGroupView) => Promise<void>) | undefined;
	/** Called after a group starts waiting or its approval state/handler changes (the runtime refreshes its inbox). */
	onChange: ((actorId: string) => void) | undefined;
	/** Resolved when a waiting group is settled. */
	readonly #settled = new Map<string, Deferred>();
	/** Serializes a group's approval steps, so a decision, a review and a re-evaluation cannot interleave. */
	readonly #approvalQueue = new KeyedQueue("task group approval queue");
	/** Set by endWaits(): every current and later wait returns the group's current view at once. */
	#waitsEnded = false;
	/** Waiters of wait(), woken by endWaits(). */
	readonly #waiters = new Set<() => void>();

	constructor(db: Db, cluster: Cluster, options: { audit?: Audit } = {}) {
		this.#db = db;
		this.#cluster = cluster;
		this.#audit = options.audit;
	}

	/** Whether endWaits() has run: wait no longer sleeps and the catalog wait loops stop. */
	get waitsEnded(): boolean {
		return this.#waitsEnded;
	}

	/**
	 * Ends every wait() at once without closing anything: each returns the group's current view, and so does
	 * every wait() started afterwards. Shutdown calls it after the agent runtime closes, so a request waiting on
	 * a group (an approval, a long run) returns instead of holding the drain (main.ts).
	 */
	endWaits(): void {
		if (this.#waitsEnded) return;
		this.#waitsEnded = true;
		for (const wake of [...this.#waiters]) wake();
		this.#waiters.clear();
	}

	/** Fire-and-forget audit write; a failure is logged, never an unhandled rejection. */
	#auditLater(input: AuditInput): void {
		if (this.#audit)
			void this.#audit
				.record(input)
				.catch((err: unknown) => console.error(`audit: failed to record ${input.action}:`, err));
	}

	/** Releases a wait() parked on the group: the group ended, by a decision or by any other path. */
	#settle(id: string): void {
		this.#settled.get(id)?.resolve();
		this.#settled.delete(id);
	}

	/**
	 * Waits for the group runs this process started and the approval steps still queued. Call after
	 * Cluster.close(): its wake-ups end the waitTask calls and its refusal of new tasks ends the workers;
	 * unfinished groups are recovered on the next start.
	 */
	async close(): Promise<void> {
		while (this.#running.size > 0 || this.#approvalQueue.size > 0) {
			await Promise.all([...this.#running.values(), ...this.#approvalQueue.pending]);
		}
	}

	/** Groups left running by a previous process can no longer start their remaining nodes. */
	async recover(): Promise<void> {
		const rows = await this.#db
			.selectFrom("task_groups")
			.selectAll()
			.where("state", "in", ["running", "awaiting_authorization"])
			.execute();
		for (const row of rows) {
			const started = await this.#startedNodes(row.id);
			const skipped = (JSON.parse(row.node_ids) as string[]).filter((id) => !started.has(id));
			await this.#db
				.updateTable("task_groups")
				.set({ state: "interrupted", skipped: JSON.stringify(skipped), finished_at: now() })
				.where("id", "=", row.id)
				.execute();
			// A member that had not started yet must not run now: its approval or signature can still
			// arrive, so it is cancelled with the reason instead of being left waiting forever.
			await this.#endWaiting(row.id);
			this.#cluster.releaseGroupBudget(row.id);
			this.#settle(row.id);
		}
	}

	/**
	 * Cancels a group and every member that has not ended (doc/execution-plane.md#状态机). The flag is
	 * checked by the group's workers before they take the next node and after every wait, so a large batch
	 * stops creating members even though only the members that exist can be cancelled. A group with no run
	 * in this process (still waiting for approval, or left over by a caller) moves to `cancelled` here; a
	 * running group's worker moves it when it returns, so the run and its skipped nodes agree.
	 *
	 * Returns false when the group is already terminal (nothing to cancel).
	 */
	async cancel(id: string, reason: string = GROUP_CANCELLED_REASON, by?: Actor): Promise<boolean> {
		const row = await this.#row(id);
		if (!row || GROUP_TERMINAL.has(row.state)) return false;
		this.#cancelled.set(id, reason);
		const owned = this.#running.has(id);
		let ended = false;
		if (!owned) {
			// Nobody in this process owns the group (waiting for approval, or a stale row): end it here.
			ended = await this.#markCancelled(id, row);
			// A member's state sync can move the group between the read and the write; one retry on the
			// current row is enough, and a decision that started a run is left to that run's worker.
			if (!ended && !this.#running.has(id)) {
				const current = await this.#row(id);
				if (current && !GROUP_TERMINAL.has(current.state)) ended = await this.#markCancelled(id, current);
			}
			if (ended) {
				this.#cluster.releaseGroupBudget(id);
				this.#settle(id);
				this.#cancelled.delete(id);
			}
		}
		// Cancel what exists either way: this wakes a worker parked in waitTask so it can see the flag,
		// and ends the waiting members of a group that had no run to do it.
		await this.#cancelMembers(id, reason, by);
		return ended || this.#running.has(id);
	}

	/** Writes a group's cancelled end state if it is still in the state read, with its unstarted nodes skipped. */
	async #markCancelled(id: string, row: Selectable<TaskGroupsTable>): Promise<boolean> {
		const started = await this.#startedNodes(id);
		const nodeIds = JSON.parse(row.node_ids) as string[];
		const updated = await this.#db
			.updateTable("task_groups")
			.set({
				state: "cancelled",
				skipped: JSON.stringify(nodeIds.filter((nodeId) => !started.has(nodeId))),
				finished_at: now(),
				handler_type: null,
				handler_session_id: null,
			})
			.where("id", "=", id)
			.where("state", "=", row.state)
			.executeTakeFirst();
		return updated.numUpdatedRows > 0n;
	}

	/** Cancels every member that has not reached a terminal state, including ones still waiting to dispatch. */
	async #cancelMembers(groupId: string, reason: string, by?: Actor): Promise<void> {
		const rows = await this.#db
			.selectFrom("tasks")
			.select("id")
			.where("task_group_id", "=", groupId)
			.where("state", "not in", [...TERMINAL])
			.execute();
		for (const { id } of rows) await this.#cluster.cancelTask(id, reason, by);
	}

	/** Ends the members of an interrupted group that never reached the node. */
	async #endWaiting(groupId: string, reason: string = GROUP_INTERRUPTED_REASON): Promise<void> {
		const rows = await this.#db
			.selectFrom("tasks")
			.select("id")
			.where("task_group_id", "=", groupId)
			.where("state", "in", ["awaiting_approval", "awaiting_authorization"])
			.execute();
		for (const { id } of rows) await this.#cluster.cancelTask(id, reason);
	}

	async create(input: CreateTaskGroupInput): Promise<string> {
		const parallel = Math.min(Math.max(input.parallel ?? DEFAULT_PARALLEL, 1), MAX_PARALLEL);
		const outputMode = outputModeFor(input.spec.kind, input.outputMode);
		if (input.id && (await this.#row(input.id))) return input.id;
		// The per-node caps are copied to every member task; reject a bad budget before writing anything.
		const limits = checkedOutputLimits(input.maxLines, input.maxBytes);
		// Reject before writing anything: truncating would make the caller think every node ran (D85).
		const nodeIds = [...new Set(input.nodeIds)];
		if (nodeIds.length > MAX_GROUP_NODES) {
			throw new UserError(
				`task group targets ${nodeIds.length} nodes (max ${MAX_GROUP_NODES}); split it into smaller batches`,
			);
		}
		const id = input.id ?? newId();
		const nodes = await this.#db.selectFrom("nodes").selectAll().where("id", "in", nodeIds).execute();
		const first = nodes[0];
		if (!first) throw new UserError("no nodes");

		let approval: TaskGroupApprovalRecord | undefined;
		const privileged = input.privileged === true;
		if (input.chain) {
			// One pass over the chain and one query for the nodes' groups, not two queries per node.
			const judged = await this.#cluster.evaluateForNodes(nodes, input.spec, input.chain, privileged);
			approval = { nodes: nodes.map((node) => ({ nodeId: node.id, evaluation: judged.get(node.id) as Evaluation })) };
		}
		const waiting = approval?.nodes.some((n) => n.evaluation.result === "require-approval") ?? false;
		// Group waiting approvals by session tree: the first session of the chain (a schedule comes before it).
		const root = input.chain?.find((ref) => ref.type === "session");
		await this.#db
			.insertInto("task_groups")
			.values({
				id,
				org_id: first.org_id,
				targets: JSON.stringify(input.targets),
				node_ids: JSON.stringify(nodeIds),
				kind: input.spec.kind,
				parallel,
				fail_fast: input.failFast ? 1 : 0,
				output_mode: outputMode,
				node_max_lines: limits.maxLines,
				node_max_bytes: limits.maxBytes,
				privileged: privileged ? 1 : 0,
				skipped: "[]",
				state: waiting ? "awaiting_approval" : "running",
				actor_type: input.actor.type,
				actor_id: input.actor.id,
				on_behalf_of_user_id: input.actor.onBehalfOfUserId,
				created_at: now(),
				finished_at: null,
				rule_chain: input.chain ? JSON.stringify(input.chain) : null,
				approval: approval ? JSON.stringify(approval) : null,
				// An empty but present input has always been stored as "" here; the helper uses null for no bytes.
				pending_input: waiting && input.input ? (pendingInputColumn(input.input) ?? "") : null,
				spec: JSON.stringify(taskSpecToJson(input.spec)),
				timeout_ms: input.timeoutMs ?? null,
				root_session_id: root?.id ?? null,
				// Until an ancestor agent is routed, the user (the group's on_behalf user) is the handler.
				handler_type: waiting ? "user" : null,
				handler_session_id: null,
			})
			.execute();
		this.#auditLater({
			actor: { type: input.actor.type, id: input.actor.id, onBehalfOfUserId: input.actor.onBehalfOfUserId },
			action: "task_group.created",
			target: { type: "task_group", id },
			detail: {
				targets: input.targets,
				node_ids: nodeIds,
				kind: input.spec.kind,
				privileged,
				policy: waiting ? "require-approval" : approval ? "evaluated" : "none",
			},
		});
		if (waiting) {
			this.onChange?.(input.actor.id);
			// Denied nodes get their (denied) task now, so the group shows why they will not run.
			for (const n of approval?.nodes ?? []) {
				if (n.evaluation.result === "deny") await this.#cluster.createTask(this.#taskInput(input, id, n.nodeId));
			}
			const hook = this.onAwaitingApproval;
			if (hook) {
				const view = await this.get(id);
				if (view) void hook(view).catch((err: unknown) => console.error("review:", err));
			}
		} else {
			// Every member is judged again when it is created, even though this group runs at once: a rule
			// added while the group runs must still apply to the nodes that have not started yet.
			this.#start(id, { ...input, outputMode }, nodeIds, parallel, undefined);
		}
		return id;
	}

	#taskInput(input: CreateTaskGroupInput, groupId: string, nodeId: string, approvedBy?: ApprovalDecision) {
		const { nodeIds: _n, targets: _t, parallel: _p, failFast: _f, id: _i, ...task } = input;
		// A group with a stable id gives its tasks stable ids too, so a rerun reattaches to them.
		const id = input.id ? derivedId(`${input.id}/${nodeId}`) : undefined;
		return {
			...task,
			// The group's mode is fixed; a task left waiting keeps it until dispatch.
			outputMode: input.outputMode ?? "status",
			nodeId,
			taskGroupId: groupId,
			...(id ? { id } : {}),
			...(approvedBy ? { approvedBy } : {}),
			// A member cannot stop to wait for an approval: only an approved group covers require-approval,
			// and a direct-run group has already started (doc/access-control.md#审批).
			noWait: !approvedBy,
		};
	}

	#start(id: string, input: CreateTaskGroupInput, nodeIds: string[], parallel: number, approvedBy?: ApprovalDecision) {
		const run = this.#run(id, input, nodeIds, parallel, approvedBy)
			.catch((err: unknown) => console.error(`task group ${id} failed:`, err))
			.finally(() => this.#running.delete(id));
		this.#running.set(id, run);
	}

	async #run(
		id: string,
		input: CreateTaskGroupInput,
		nodeIds: string[],
		parallel: number,
		approvedBy?: ApprovalDecision,
	): Promise<void> {
		const queue = [...nodeIds];
		// Tasks that wait for an authorization signature do not hold a worker slot: another node may still
		// start, and the group waits for them only at the end (doc/execution-plane.md#状态机).
		const parked: TaskView[] = [];
		let failed = false;
		// Waits ended before every task finished: the group is left for recover(), which marks it interrupted.
		let abandoned = false;
		// The worker threw (a storage error while creating a member, for one): the group ends as failed.
		let failure: unknown;
		// Shutdown ends the waits: waitTask then returns at once, so a loop must check this or it would spin.
		const ending = () => this.#waitsEnded || this.#cluster.waitsEnded;
		const cancelled = () => this.#cancelled.has(id);
		const worker = async () => {
			for (;;) {
				// The group's cancel() (a stopped session, an aborted tool call) stops taking nodes at once.
				if (cancelled() || (input.failFast && failed)) return;
				const nodeId = queue.shift();
				if (nodeId === undefined) return;
				if (ending()) {
					queue.unshift(nodeId);
					abandoned = true;
					return;
				}
				if (cancelled()) {
					// Not started: put it back so it is recorded as skipped by the cancellation.
					queue.unshift(nodeId);
					return;
				}
				const created = await this.#cluster.createTask(this.#taskInput(input, id, nodeId, approvedBy));
				// cancel() cancelled the members it could see before this one existed; end it before waiting.
				if (cancelled()) {
					await this.#cluster.cancelTask(created.id, this.#cancelled.get(id) ?? GROUP_CANCELLED_REASON);
					continue;
				}
				if (created.state === "awaiting_authorization") {
					parked.push(created);
					continue;
				}
				let done = await this.#cluster.waitTask(created.id, HOUR);
				while (done && !TERMINAL.has(done.state)) {
					if (cancelled()) return;
					if (ending()) {
						abandoned = true;
						break;
					}
					done = await this.#cluster.waitTask(created.id, HOUR);
				}
				if (cancelled()) return;
				if (done && countsAsFailure(done)) failed = true;
			}
		};
		/** A worker that threw stops the others: set the flag, and cancel the members they are waiting on. */
		const guardedWorker = async () => {
			try {
				await worker();
			} catch (err) {
				if (failure === undefined) failure = err;
				this.#cancelled.set(id, GROUP_FAILED_REASON);
				try {
					await this.#cancelMembers(id, `${GROUP_FAILED_REASON}: ${err instanceof Error ? err.message : String(err)}`);
				} catch (cancelErr) {
					console.error(`task group ${id}: cancelling its members after a failure failed:`, cancelErr);
				}
			}
		};
		const settleParked = async (task: TaskView) => {
			// waitTask returns on every state change, so keep waiting until the task is final.
			let done: TaskView | undefined = task;
			while (done && !TERMINAL.has(done.state)) {
				if (cancelled()) return;
				if (ending()) {
					abandoned = true;
					return;
				}
				done = await this.#cluster.waitTask(task.id, HOUR);
			}
			if (cancelled()) return;
			if (done && countsAsFailure(done)) failed = true;
		};
		try {
			// Every worker runs to its own return: one throwing must not let Promise.all resolve (and the
			// group finish) while the others are still creating members.
			await Promise.all(Array.from({ length: Math.min(parallel, queue.length) }, guardedWorker));
			// A parked task still belongs to the group, so the group is not finished while it waits.
			if (failure === undefined && !cancelled()) {
				for (let task = parked.shift(); task !== undefined; task = parked.shift()) await settleParked(task);
			}
		} catch (err) {
			failure = err;
		} finally {
			try {
				// Shutdown leaves an unfinished group to recover(), which marks it interrupted on the next start.
				if (!this.#cluster.closing && !abandoned) {
					if (failure !== undefined) await this.#fail(id, nodeIds, failure);
					else if (cancelled()) await this.#finishCancelled(id, queue);
					else await this.#finish(id, queue);
				}
			} finally {
				// The group is done as a whole; its tasks may already have been dropped one by one.
				this.#cluster.releaseGroupBudget(id);
				this.#cancelled.delete(id);
			}
		}
		if (failure !== undefined) throw failure;
	}

	/**
	 * Ends a cancelled run (doc/execution-plane.md#状态机): no member may start any more, so the nodes still in
	 * the queue are recorded as skipped. The members already created were cancelled by cancel(); this is also
	 * the last chance to catch one created in the dispatch window after that.
	 */
	async #finishCancelled(id: string, skipped: string[]): Promise<void> {
		const reason = this.#cancelled.get(id) ?? GROUP_CANCELLED_REASON;
		await this.#db
			.updateTable("task_groups")
			.set({
				state: "cancelled",
				skipped: JSON.stringify(skipped),
				finished_at: now(),
				handler_type: null,
				handler_session_id: null,
			})
			.where("id", "=", id)
			.where("state", "not in", [...GROUP_TERMINAL])
			.execute();
		try {
			await this.#cancelMembers(id, reason);
		} catch (err) {
			console.error(`task group ${id}: cancelling its remaining members failed:`, err);
		}
		this.#settle(id);
	}

	/** The group's members all settled (or were skipped): the group is finished. */
	async #finish(id: string, skipped: string[]): Promise<void> {
		await this.#db
			.updateTable("task_groups")
			.set({
				state: "finished",
				skipped: JSON.stringify(skipped),
				finished_at: now(),
				handler_type: null,
				handler_session_id: null,
			})
			.where("id", "=", id)
			.execute();
		this.#settle(id);
	}

	/**
	 * Ends a group whose run threw (doc/execution-plane.md#状态机): no member that never reached the node may be
	 * left waiting, and nodes without a task are recorded as skipped. The group ends `interrupted`, the closest
	 * state to a failure: a group is never retried, and `finished` would claim a complete run.
	 */
	async #fail(id: string, nodeIds: string[], error: unknown): Promise<void> {
		const reason = `${GROUP_FAILED_REASON}: ${error instanceof Error ? error.message : String(error)}`;
		const started = await this.#startedNodes(id);
		await this.#db
			.updateTable("task_groups")
			.set({
				state: "interrupted",
				skipped: JSON.stringify(nodeIds.filter((nodeId) => !started.has(nodeId))),
				finished_at: now(),
				handler_type: null,
				handler_session_id: null,
			})
			.where("id", "=", id)
			.execute();
		await this.#endWaiting(id, reason);
		this.#settle(id);
	}

	/**
	 * Settles a group waiting for approval: approving starts its non-denied nodes, rejecting (or expiry)
	 * ends it. Runs on the group's approval queue, so decisions, reviews and re-evaluations cannot
	 * interleave. Returns false if it is not waiting with the handler the caller expects. Who may decide
	 * is checked by the caller; `expect` is checked again on the row read in the queue turn.
	 */
	decide(id: string, decision: ApprovalDecision, expect?: ApprovalExpect): Promise<boolean> {
		return this.#approvalQueue.run(id, () => this.#decide(id, decision, expect));
	}

	/**
	 * The unqueued body of decide(): callers already hold the group's queue slot. Approving lets every
	 * remaining member judge itself again, so a node a rule now denies ends denied. The handler check
	 * repeats the caller's read: a request routed to an agent must not be decided by the user page (and
	 * the other way around) when the two read the row at different times.
	 */
	async #decide(id: string, decision: ApprovalDecision, expect?: ApprovalExpect): Promise<boolean> {
		const row = await this.#row(id);
		if (row?.state !== "awaiting_approval" || !matchesHandler(row, expect)) return false;
		const approved = decision.decision === "approved";
		// Build the input before changing state: a legacy spec that cannot be read must fail the request
		// without leaving a group that is running but has no tasks.
		const input = approved ? this.#inputFromRow(row) : undefined;
		const record = mergeApproval<TaskGroupApprovalRecord>(row.approval, { decision });
		const res = await this.#db
			.updateTable("task_groups")
			.set({
				state: approved ? "running" : "rejected",
				approval: JSON.stringify(record),
				pending_input: null,
				handler_type: null,
				handler_session_id: null,
				...(approved ? {} : { finished_at: now() }),
			})
			.where("id", "=", id)
			.where("state", "=", "awaiting_approval")
			.executeTakeFirst();
		if (res.numUpdatedRows === 0n) return false;
		this.onChange?.(row.actor_id);
		this.#auditLater(approvalAudit("task_group", id, row.on_behalf_of_user_id, decision));
		if (approved && input) {
			// Members created while the group waited (the denied ones from create()) are not started again.
			const started = await this.#startedNodes(id);
			const remaining = (JSON.parse(row.node_ids) as string[]).filter((n) => !started.has(n));
			this.#start(id, input, remaining, row.parallel, { ...decision, taskGroupId: id });
		} else {
			// A rejected group never runs; release anything its denied tasks may have held.
			this.#cluster.releaseGroupBudget(id);
		}
		this.#settle(id);
		return true;
	}

	/** Stores Auto Review's verdict on a waiting group, on the group's approval queue. */
	async recordReview(id: string, review: NonNullable<TaskGroupApprovalRecord["review"]>): Promise<void> {
		await this.#approvalQueue.run(id, async () => {
			const row = await this.#row(id);
			// A settled or approved group is no longer a request; a late review must not write it.
			if (row?.state !== "awaiting_approval" || row.handler_type === null) return;
			const record = mergeApproval<TaskGroupApprovalRecord>(row.approval, { review });
			const res = await this.#db
				.updateTable("task_groups")
				.set({ approval: JSON.stringify(record) })
				.where("id", "=", id)
				.where("state", "=", "awaiting_approval")
				.executeTakeFirst();
			if (res.numUpdatedRows === 0n) return;
			this.#auditLater(reviewAudit("task_group", id, row.on_behalf_of_user_id, review));
		});
	}

	/** Hands a waiting group's approval to an ancestor session's agent (doc/agent-runtime.md#处理子会话的请求). */
	requestAgentDecision(id: string, session: string): Promise<boolean> {
		return this.#routeAgentDecision(id, session, "pending");
	}

	/** The agent passed the request on to the user: the approval page takes it from here. */
	escalateAgentDecision(id: string, session: string): Promise<boolean> {
		return this.#routeAgentDecision(id, session, "escalated");
	}

	/** Routes a waiting group's approval to an agent or back to the user, on the group's approval queue. */
	#routeAgentDecision(id: string, session: string, state: AgentRequest["state"]): Promise<boolean> {
		return this.#approvalQueue.run(id, async () => {
			const row = await this.#row(id);
			// The group is settled or already starting: routing it again would make it look waiting.
			if (row?.state !== "awaiting_approval" || row.handler_type === null) return false;
			const routing = agentRouting(session, state);
			const record = mergeApproval<TaskGroupApprovalRecord>(row.approval, { agent: routing.agent });
			const res = await this.#db
				.updateTable("task_groups")
				.set({ approval: JSON.stringify(record), ...routing.handler })
				.where("id", "=", id)
				.where("state", "=", "awaiting_approval")
				.executeTakeFirst();
			if (res.numUpdatedRows === 0n) return false;
			this.onChange?.(row.actor_id);
			this.#auditLater(agentRoutingAudit("task_group", id, session, state));
			return true;
		});
	}

	/**
	 * Re-judges waiting groups on a chain whose rules changed, one group at a time on its approval queue.
	 * A group whose nodes all deny is rejected; one that no longer has a node requiring approval is
	 * approved, and its members then judge themselves again, so denied nodes end denied.
	 */
	async reevaluate(ref: RuleRef): Promise<void> {
		const rows = await this.#db
			.selectFrom("task_groups")
			.selectAll()
			.where("state", "=", "awaiting_approval")
			.where("rule_chain", "is not", null)
			.execute();
		for (const row of rows) {
			await this.#approvalQueue.run(row.id, async () => {
				// The group may have been settled while it waited for its queue slot.
				const current = await this.#row(row.id);
				if (current?.state !== "awaiting_approval") return;
				const chain = chainWith(current.rule_chain, ref);
				if (!chain) return;
				let spec: TaskSpec;
				try {
					spec = specFromRow(current.spec, "task group");
				} catch (err) {
					// A row migration 0019 left behind must not stop the other waiting groups from settling.
					console.warn(`task group ${current.id}: ${err instanceof Error ? err.message : String(err)}`);
					return;
				}
				const nodes = await this.#db
					.selectFrom("nodes")
					.selectAll()
					.where("id", "in", JSON.parse(current.node_ids))
					.execute();
				let stillWaiting = false;
				let allDenied = nodes.length > 0;
				try {
					for (const node of nodes) {
						const evaluation = await this.#cluster.evaluateFor(node, spec, chain, current.privileged === 1);
						if (evaluation.result === "require-approval") stillWaiting = true;
						if (evaluation.result !== "deny") allDenied = false;
					}
				} catch {
					return; // a level is gone; expiry ends the group
				}
				if (allDenied) {
					await this.#decide(current.id, rulesRejection(now()));
				} else if (!stillWaiting) {
					await this.#decide(current.id, rulesApproval(now()));
				}
			});
		}
	}

	#inputFromRow(row: Selectable<TaskGroupsTable>): CreateTaskGroupInput {
		return {
			targets: JSON.parse(row.targets) as string[],
			nodeIds: JSON.parse(row.node_ids) as string[],
			spec: specFromRow(row.spec, "task group"),
			outputMode: row.output_mode,
			privileged: row.privileged === 1,
			...(row.pending_input ? { input: pendingInputOf(row) } : {}),
			...(row.timeout_ms !== null ? { timeoutMs: row.timeout_ms } : {}),
			...(row.node_max_lines !== null ? { maxLines: row.node_max_lines } : {}),
			...(row.node_max_bytes !== null ? { maxBytes: row.node_max_bytes } : {}),
			failFast: row.fail_fast === 1,
			actor: { type: row.actor_type as Actor["type"], id: row.actor_id, onBehalfOfUserId: row.on_behalf_of_user_id },
			...(row.rule_chain ? { chain: JSON.parse(row.rule_chain) as RuleRef[] } : {}),
		};
	}

	async #row(id: string): Promise<Selectable<TaskGroupsTable> | undefined> {
		return this.#db.selectFrom("task_groups").selectAll().where("id", "=", id).executeTakeFirst();
	}

	async #startedNodes(id: string): Promise<Set<string>> {
		const rows = await this.#db.selectFrom("tasks").select("node_id").where("task_group_id", "=", id).execute();
		return new Set(rows.map((t) => t.node_id));
	}

	async get(id: string): Promise<TaskGroupView | undefined> {
		const row = await this.#row(id);
		if (!row) return undefined;
		return this.#view(row, await this.#cluster.groupTasks(id));
	}

	/**
	 * Several groups in a few queries, in the input order; an id with no row is omitted, like `get` returning
	 * undefined. A caller showing a list must not read the rows, members and reference names per group.
	 */
	async getMany(ids: readonly string[]): Promise<TaskGroupView[]> {
		if (ids.length === 0) return [];
		const unique = [...new Set(ids)];
		const rows = await this.#db.selectFrom("task_groups").selectAll().where("id", "in", unique).execute();
		if (rows.length === 0) return [];
		const tasksByGroup = await this.#cluster.groupTasksMany(unique);
		const targetsByOrg = new Map<string, Set<string>>();
		for (const row of rows) {
			const targets = targetsByOrg.get(row.org_id) ?? new Set<string>();
			for (const target of JSON.parse(row.targets) as string[]) targets.add(target);
			targetsByOrg.set(row.org_id, targets);
		}
		// All groups of one list share an organization; the reference names are resolved once per organization.
		const refsByOrg = new Map<string, RefMap>(
			await Promise.all(
				[...targetsByOrg].map(
					async ([orgId, targets]) => [orgId, await targetRefs(this.#db, orgId, [...targets])] as const,
				),
			),
		);
		const byId = new Map(rows.map((row) => [row.id, row] as const));
		const out: TaskGroupView[] = [];
		for (const id of ids) {
			const row = byId.get(id);
			if (!row) continue;
			const targets = JSON.parse(row.targets) as string[];
			const allRefs: RefMap = refsByOrg.get(row.org_id) ?? {};
			const refs: RefMap = {};
			// targetRefs stores only UUID references; `_all` and historical entries stay absent, as in `get`.
			for (const target of targets) if (Object.hasOwn(allRefs, target)) refs[target] = allRefs[target] ?? null;
			out.push(await this.#view(row, tasksByGroup.get(id) ?? [], refs));
		}
		return out;
	}

	/** One group's view; `refs` is passed when a caller resolved several groups' targets in one query. */
	async #view(row: Selectable<TaskGroupsTable>, tasks: TaskView[], refs?: RefMap): Promise<TaskGroupView> {
		const targets = JSON.parse(row.targets) as string[];
		return {
			id: row.id,
			state: row.state,
			targets,
			refs: refs ?? (await targetRefs(this.#db, row.org_id, targets)),
			nodeIds: JSON.parse(row.node_ids) as string[],
			parallel: row.parallel,
			failFast: row.fail_fast === 1,
			outputMode: row.output_mode,
			nodeMaxLines: row.node_max_lines,
			nodeMaxBytes: row.node_max_bytes,
			privileged: row.privileged === 1,
			skipped: JSON.parse(row.skipped) as string[],
			tasks,
			createdAt: row.created_at,
			finishedAt: row.finished_at,
			summary: row.spec ? summarize(row.spec) : "",
			kind: row.kind,
			ruleChain: row.rule_chain ? (JSON.parse(row.rule_chain) as RuleRef[]) : null,
			approval: row.approval ? (JSON.parse(row.approval) as TaskGroupApprovalRecord) : null,
			actorType: row.actor_type,
			actorId: row.actor_id,
			onBehalfOfUserId: row.on_behalf_of_user_id,
			operation: row.spec ? operationOfJson(row.spec) : null,
			rootSessionId: row.root_session_id,
			handlerType: row.handler_type,
			handlerSessionId: row.handler_session_id,
		};
	}

	/**
	 * Waits until the group is settled and every task has finished (or timeoutMs passes, endWaits() ends the
	 * waits, or the caller's signal aborts); returns its current view.
	 */
	async wait(id: string, timeoutMs: number, signal?: AbortSignal): Promise<TaskGroupView | undefined> {
		if (this.#waitsEnded || signal?.aborted) return this.get(id);
		const deadline = Date.now() + timeoutMs;
		const until = (p: Promise<unknown>) => {
			if (this.#waitsEnded || signal?.aborted) return Promise.resolve();
			return new Promise<void>((resolve) => {
				const done = () => {
					clearTimeout(timer);
					this.#waiters.delete(done);
					signal?.removeEventListener("abort", done);
					resolve();
				};
				const timer = setTimeout(done, Math.max(0, deadline - Date.now()));
				this.#waiters.add(done);
				signal?.addEventListener("abort", done);
				void p.then(done, done);
			});
		};
		const row = await this.#row(id);
		if (row?.state === "awaiting_approval") {
			let d = this.#settled.get(id);
			if (!d) {
				let resolve!: () => void;
				const promise = new Promise<void>((r) => (resolve = r));
				d = { promise, resolve };
				this.#settled.set(id, d);
			}
			await until(d.promise);
		}
		const run = this.#running.get(id);
		if (run) await until(run);
		return this.get(id);
	}
}

function now(): string {
	return new Date().toISOString();
}

/**
 * Whether the group row's handler matches what the caller read outside the approval queue. The omitted
 * expectation still requires a handler: a waiting group always has one, so a null handler means it is
 * no longer waiting for a decision.
 */
function matchesHandler(row: Selectable<TaskGroupsTable>, expect?: ApprovalExpect): boolean {
	if (!expect) return row.handler_type !== null;
	if (expect.handlerType === "any-waiting") {
		if (row.handler_type === null) return false;
	} else if (row.handler_type !== expect.handlerType) {
		return false;
	}
	return expect.handlerSessionId === undefined || row.handler_session_id === expect.handlerSessionId;
}

/** Whether a settled task makes fail_fast stop the remaining nodes. */
function countsAsFailure(task: TaskView): boolean {
	// A retryable authorization rejection never settles a task (it goes back to awaiting_authorization), so a
	// settled task with an authorization code was finally rejected and counts (doc/execution-plane.md#状态机).
	return task.state !== "exited" || task.exitCode !== 0;
}
