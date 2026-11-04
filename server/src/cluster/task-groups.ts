import { type TaskSpec, taskSpecToJson } from "@crh/protocol";
import type { Selectable } from "kysely";
import type { Audit, AuditInput } from "../audit/audit.ts";
import type { SessionUser } from "../auth/sessions.ts";
import { type RefMap, targetRefs } from "../policy/refs.ts";
import type { Evaluation } from "../policy/rules.ts";
import type { RuleRef } from "../policy/store.ts";
import type { Db } from "../storage/db.ts";
import type { BatchOutputMode, TaskGroupState, TaskGroupsTable } from "../storage/schema.ts";
import { defaultOrgId, UserError } from "../users/service.ts";
import { derivedId, newId } from "../util/id.ts";
import {
	type Actor,
	type AgentRequest,
	type ApprovalDecision,
	type Cluster,
	type CreateTaskInput,
	operationOfJson,
	specFromRow,
	summarize,
	type TaskView,
	TERMINAL,
} from "./cluster.ts";
import { ALL_TARGET, nameKey } from "./names.ts";
import { listNodesForUser } from "./nodes.ts";

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
	if (targets.length === 0) throw new UserError("targets must not be empty");
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
		if (!nodeGroup) throw new UserError(`no node or node group ${target} that you can access`);
		addRef(nodeGroup.id);
		for (const n of nodes) {
			if (n.nodeGroups.some((g) => g.id === nodeGroup.id)) ids.add(n.id);
		}
	}
	if (ids.size === 0) throw new UserError("the targets match no node that you can access");
	if (ids.size > MAX_TARGETS) throw new UserError(`at most ${MAX_TARGETS} targets per batch`);
	const singleNode = targets.length === 1 && refs[0] !== ALL_TARGET && nodes.some((n) => n.id === refs[0]);
	return { targets: refs, nodeIds: [...ids], singleNode };
}

export interface CreateTaskGroupInput
	extends Omit<CreateTaskInput, "nodeId" | "taskGroupId" | "approvedBy" | "evaluation"> {
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
export interface TaskGroupApprovalRecord {
	nodes: { nodeId: string; evaluation: Evaluation }[];
	decision?: ApprovalDecision;
	review?: { decision: "approve" | "escalate"; reason: string; model: string };
	agent?: AgentRequest;
}

export interface TaskGroupView {
	id: string;
	state: TaskGroupState;
	/** Stored target UUIDs or `_all`; names are in `refs`. */
	targets: string[];
	/** Display names for the UUID targets; null means the node or node group was deleted. */
	refs: RefMap;
	nodeIds: string[];
	parallel: number;
	failFast: boolean;
	/** The mode fixed at creation; every task in the group uses it. */
	outputMode: BatchOutputMode;
	/** Whether the group's tasks are privileged tasks (doc/privilege.md). */
	privileged: boolean;
	skipped: string[];
	tasks: TaskView[];
	createdAt: string;
	finishedAt: string | null;
	/** What runs on each node, for display. */
	summary: string;
	kind: string;
	ruleChain: RuleRef[] | null;
	approval: TaskGroupApprovalRecord | null;
	actorType: string;
	actorId: string;
	onBehalfOfUserId: string;
	/** What authorization rules match on, the same for every node. */
	operation: { method: string; target: string } | null;
	/** Root session of the rule chain, for grouping approvals by session tree. */
	rootSessionId: string | null;
	/** Who handles a waiting approval; null when it is not waiting. */
	handlerType: "agent" | "user" | null;
	handlerSessionId: string | null;
}

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
	/** Called once for every group that starts waiting for approval (Auto Review hooks in here). */
	onAwaitingApproval: ((group: TaskGroupView) => Promise<void>) | undefined;
	/** Called after a group starts waiting or its approval state/handler changes (the runtime refreshes its inbox). */
	onChange: ((actorId: string) => void) | undefined;
	/** Resolved when a waiting group is settled. */
	readonly #settled = new Map<string, Deferred>();
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

	/**
	 * Waits for the group runs this process started. Call after Cluster.close(): its wake-ups end the
	 * waitTask calls and its refusal of new tasks ends the workers; unfinished groups are recovered on
	 * the next start.
	 */
	async close(): Promise<void> {
		while (this.#running.size > 0) await Promise.all(this.#running.values());
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
		}
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
		let evaluations: Map<string, Evaluation> | undefined;
		const privileged = input.privileged === true;
		if (input.chain) {
			// One pass over the chain and one query for the nodes' groups, not two queries per node.
			const judged = await this.#cluster.evaluateForNodes(nodes, input.spec, input.chain, privileged);
			evaluations = judged;
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
				pending_input: waiting && input.input ? Buffer.from(input.input).toString("base64") : null,
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
			this.#start(id, { ...input, outputMode }, nodeIds, parallel, undefined, evaluations);
		}
		return id;
	}

	#taskInput(
		input: CreateTaskGroupInput,
		groupId: string,
		nodeId: string,
		approvedBy?: ApprovalDecision,
		evaluation?: Evaluation,
	) {
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
			...(evaluation ? { evaluation } : {}),
		};
	}

	#start(
		id: string,
		input: CreateTaskGroupInput,
		nodeIds: string[],
		parallel: number,
		approvedBy?: ApprovalDecision,
		evaluations?: Map<string, Evaluation>,
	) {
		const run = this.#run(id, input, nodeIds, parallel, approvedBy, evaluations)
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
		evaluations?: Map<string, Evaluation>,
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
		const worker = async () => {
			for (;;) {
				if (input.failFast && failed) return;
				const nodeId = queue.shift();
				if (nodeId === undefined) return;
				if (ending()) {
					abandoned = true;
					return;
				}
				const created = await this.#cluster.createTask(
					this.#taskInput(input, id, nodeId, approvedBy, evaluations?.get(nodeId)),
				);
				if (created.state === "awaiting_authorization") {
					parked.push(created);
					continue;
				}
				let done = await this.#cluster.waitTask(created.id, HOUR);
				while (done && !TERMINAL.has(done.state)) {
					if (ending()) {
						abandoned = true;
						break;
					}
					done = await this.#cluster.waitTask(created.id, HOUR);
				}
				if (done && countsAsFailure(done)) failed = true;
			}
		};
		const settleParked = async (task: TaskView) => {
			// waitTask returns on every state change, so keep waiting until the task is final.
			let done: TaskView | undefined = task;
			while (done && !TERMINAL.has(done.state)) {
				if (ending()) {
					abandoned = true;
					return;
				}
				done = await this.#cluster.waitTask(task.id, HOUR);
			}
			if (done && countsAsFailure(done)) failed = true;
		};
		try {
			await Promise.all(Array.from({ length: Math.min(parallel, queue.length) }, worker));
			// A parked task still belongs to the group, so the group is not finished while it waits.
			for (let task = parked.shift(); task !== undefined; task = parked.shift()) await settleParked(task);
		} catch (err) {
			failure = err;
		} finally {
			try {
				// Shutdown leaves an unfinished group to recover(), which marks it interrupted on the next start.
				if (!this.#cluster.closing && !abandoned) {
					if (failure === undefined) await this.#finish(id, queue);
					else await this.#fail(id, nodeIds, failure);
				}
			} finally {
				// The group is done as a whole; its tasks may already have been dropped one by one.
				this.#cluster.releaseGroupBudget(id);
			}
		}
		if (failure !== undefined) throw failure;
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
	}

	/**
	 * Settles a group waiting for approval: approving starts its non-denied nodes, rejecting (or expiry)
	 * ends it. Returns false if it is not waiting. Who may decide is checked by the caller.
	 */
	async decide(id: string, decision: ApprovalDecision): Promise<boolean> {
		const row = await this.#row(id);
		if (row?.state !== "awaiting_approval") return false;
		const approved = decision.decision === "approved";
		// Build the input before changing state: a legacy spec that cannot be read must fail the request
		// without leaving a group that is running but has no tasks.
		const input = approved ? this.#inputFromRow(row) : undefined;
		const record: TaskGroupApprovalRecord = {
			...(JSON.parse(row.approval ?? "{}") as TaskGroupApprovalRecord),
			decision,
		};
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
		this.#auditLater({
			actor: {
				type: decision.by.type,
				id: decision.by.id,
				onBehalfOfUserId: decision.by.onBehalfOfUserId ?? row.on_behalf_of_user_id,
			},
			action: "task_group.approval",
			target: { type: "task_group", id },
			detail: { decision: decision.decision, reason: decision.reason },
		});
		if (approved && input) {
			const started = await this.#startedNodes(id);
			const remaining = (JSON.parse(row.node_ids) as string[]).filter((n) => !started.has(n));
			// The members reuse the judgments the group recorded, instead of running the chain again.
			const evaluated = (JSON.parse(row.approval ?? "{}") as TaskGroupApprovalRecord).nodes ?? [];
			this.#start(
				id,
				input,
				remaining,
				row.parallel,
				{ ...decision, taskGroupId: id },
				new Map(evaluated.map((node) => [node.nodeId, node.evaluation])),
			);
		} else {
			// A rejected group never runs; release anything its denied tasks may have held.
			this.#cluster.releaseGroupBudget(id);
		}
		this.#settled.get(id)?.resolve();
		this.#settled.delete(id);
		return true;
	}

	async recordReview(id: string, review: NonNullable<TaskGroupApprovalRecord["review"]>): Promise<void> {
		const row = await this.#row(id);
		if (row?.state !== "awaiting_approval") return;
		const record: TaskGroupApprovalRecord = {
			...(JSON.parse(row.approval ?? "{}") as TaskGroupApprovalRecord),
			review,
		};
		await this.#db
			.updateTable("task_groups")
			.set({ approval: JSON.stringify(record) })
			.where("id", "=", id)
			.execute();
		this.#auditLater({
			actor: { type: "system", id: "auto-review", onBehalfOfUserId: row.on_behalf_of_user_id },
			action: "task_group.review",
			target: { type: "task_group", id },
			detail: review,
		});
	}

	/** Hands a waiting group's approval to an ancestor session's agent (doc/agent-runtime.md#处理子会话的请求). */
	async requestAgentDecision(id: string, session: string): Promise<boolean> {
		const row = await this.#row(id);
		if (row?.state !== "awaiting_approval") return false;
		const record: TaskGroupApprovalRecord = {
			...(JSON.parse(row.approval ?? "{}") as TaskGroupApprovalRecord),
			agent: { session, state: "pending" },
		};
		const res = await this.#db
			.updateTable("task_groups")
			.set({ approval: JSON.stringify(record), handler_type: "agent", handler_session_id: session })
			.where("id", "=", id)
			.where("state", "=", "awaiting_approval")
			.executeTakeFirst();
		if (res.numUpdatedRows === 0n) return false;
		this.onChange?.(row.actor_id);
		this.#auditLater({
			actor: { type: "system", id: "agent-routing" },
			action: "task_group.agent_request",
			target: { type: "task_group", id },
			detail: { session },
		});
		return true;
	}

	/** The agent passed the request on to the user: the approval page takes it from here. */
	async escalateAgentDecision(id: string, session: string): Promise<boolean> {
		const row = await this.#row(id);
		if (row?.state !== "awaiting_approval") return false;
		const record: TaskGroupApprovalRecord = {
			...(JSON.parse(row.approval ?? "{}") as TaskGroupApprovalRecord),
			agent: { session, state: "escalated" },
		};
		const res = await this.#db
			.updateTable("task_groups")
			.set({ approval: JSON.stringify(record), handler_type: "user", handler_session_id: null })
			.where("id", "=", id)
			.where("state", "=", "awaiting_approval")
			.executeTakeFirst();
		if (res.numUpdatedRows === 0n) return false;
		this.onChange?.(row.actor_id);
		this.#auditLater({
			actor: { type: "system", id: "agent-routing" },
			action: "task_group.agent_escalated",
			target: { type: "task_group", id },
			detail: { session },
		});
		return true;
	}

	/** Re-judges waiting groups on a chain whose rules changed; settles those that no longer need approval. */
	async reevaluate(ref: RuleRef): Promise<void> {
		const rows = await this.#db
			.selectFrom("task_groups")
			.selectAll()
			.where("state", "=", "awaiting_approval")
			.where("rule_chain", "is not", null)
			.execute();
		for (const row of rows) {
			const chain = JSON.parse(row.rule_chain ?? "[]") as RuleRef[];
			if (!chain.some((r) => r.type === ref.type && r.id === ref.id)) continue;
			let spec: TaskSpec;
			try {
				spec = specFromRow(row.spec, "task group");
			} catch (err) {
				// A row migration 0019 left behind must not stop the other waiting groups from settling.
				console.warn(`task group ${row.id}: ${err instanceof Error ? err.message : String(err)}`);
				continue;
			}
			const nodes = await this.#db
				.selectFrom("nodes")
				.selectAll()
				.where("id", "in", JSON.parse(row.node_ids))
				.execute();
			let stillWaiting = false;
			try {
				for (const node of nodes) {
					const evaluation = await this.#cluster.evaluateFor(node, spec, chain, row.privileged === 1);
					if (evaluation.result === "require-approval") stillWaiting = true;
				}
			} catch {
				continue; // a level is gone; expiry ends the group
			}
			if (!stillWaiting) {
				// Each task is judged again when it is created, so nodes now denied end up denied.
				await this.decide(row.id, {
					decision: "approved",
					by: { type: "system", id: "rules" },
					at: now(),
					reason: "allowed by changed rules",
				});
			}
		}
	}

	#inputFromRow(row: Selectable<TaskGroupsTable>): CreateTaskGroupInput {
		return {
			targets: JSON.parse(row.targets) as string[],
			nodeIds: JSON.parse(row.node_ids) as string[],
			spec: specFromRow(row.spec, "task group"),
			outputMode: row.output_mode,
			privileged: row.privileged === 1,
			...(row.pending_input ? { input: Buffer.from(row.pending_input, "base64") } : {}),
			...(row.timeout_ms !== null ? { timeoutMs: row.timeout_ms } : {}),
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
		const tasks = await this.#cluster.groupTasks(id);
		const targets = JSON.parse(row.targets) as string[];
		return {
			id: row.id,
			state: row.state,
			targets,
			refs: await targetRefs(this.#db, row.org_id, targets),
			nodeIds: JSON.parse(row.node_ids) as string[],
			parallel: row.parallel,
			failFast: row.fail_fast === 1,
			outputMode: row.output_mode,
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

/** Whether a settled task makes fail_fast stop the remaining nodes. */
function countsAsFailure(task: TaskView): boolean {
	// A retryable authorization rejection never settles a task (it goes back to awaiting_authorization), so a
	// settled task with an authorization code was finally rejected and counts (doc/execution-plane.md#状态机).
	return task.state !== "exited" || task.exitCode !== 0;
}
