import { fromJson, toJson } from "@bufbuild/protobuf";
import { TaskSpecSchema } from "@crh/protocol";
import type { Selectable } from "kysely";
import type { Audit } from "../audit/audit.ts";
import type { SessionUser } from "../auth/sessions.ts";
import { type Evaluation, operationOf } from "../policy/rules.ts";
import type { RuleRef } from "../policy/store.ts";
import type { Db } from "../storage/db.ts";
import type { TaskGroupState, TaskGroupsTable } from "../storage/schema.ts";
import { UserError } from "../users/service.ts";
import { derivedId, newId } from "../util/id.ts";
import {
	type Actor,
	type AgentRequest,
	type ApprovalDecision,
	type Cluster,
	type CreateTaskInput,
	summarize,
	type TaskView,
	TERMINAL,
} from "./cluster.ts";
import { listNodesForUser } from "./nodes.ts";

export const DEFAULT_PARALLEL = 10;
const MAX_PARALLEL = 100;
const MAX_TARGETS = 1000;
// setTimeout cannot wait longer than ~24.8 days, so long waits loop.
const HOUR = 3_600_000;

/**
 * Resolves a target list (node names and "group:<name>") to the active nodes the user may operate.
 * Unknown names are errors; groups simply match whatever nodes the user can operate.
 */
export async function resolveTargets(db: Db, user: SessionUser, targets: string[]): Promise<string[]> {
	if (targets.length === 0) throw new UserError("targets must not be empty");
	const nodes = (await listNodesForUser(db, user)).filter((n) => n.access !== "view" && n.status === "active");
	const ids = new Set<string>();
	for (const target of targets) {
		if (target.startsWith("group:")) {
			const group = target.slice("group:".length);
			for (const n of nodes) if (n.groups.includes(group)) ids.add(n.id);
		} else {
			const node = nodes.find((n) => n.name === target || n.id === target);
			if (!node) throw new UserError(`no node ${target} that you can operate`);
			ids.add(node.id);
		}
	}
	if (ids.size === 0) throw new UserError("the targets match no node that you can operate");
	if (ids.size > MAX_TARGETS) throw new UserError(`at most ${MAX_TARGETS} nodes per batch`);
	return [...ids];
}

export interface CreateTaskGroupInput extends Omit<CreateTaskInput, "nodeId" | "taskGroupId" | "approvedBy"> {
	targets: string[];
	nodeIds: string[];
	parallel?: number;
	failFast?: boolean;
	actor: Actor;
	/** A caller-chosen id; an existing group with it is returned as is (see CreateTaskInput.id). */
	id?: string;
}

/** The approval state of a task group: per-node evaluations, then the one decision for the group. */
export interface GroupApprovalRecord {
	nodes: { nodeId: string; evaluation: Evaluation }[];
	decision?: ApprovalDecision;
	review?: { decision: "approve" | "escalate"; reason: string; model: string };
	agent?: AgentRequest;
}

export interface TaskGroupView {
	id: string;
	state: TaskGroupState;
	targets: string[];
	nodeIds: string[];
	parallel: number;
	failFast: boolean;
	skipped: string[];
	tasks: TaskView[];
	createdAt: string;
	finishedAt: string | null;
	/** What runs on each node, for display. */
	summary: string;
	kind: string;
	ruleChain: RuleRef[] | null;
	approval: GroupApprovalRecord | null;
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
	/** Resolved when a waiting group is settled. */
	readonly #settled = new Map<string, Deferred>();

	constructor(db: Db, cluster: Cluster, options: { audit?: Audit } = {}) {
		this.#db = db;
		this.#cluster = cluster;
		this.#audit = options.audit;
	}

	/** Groups left running by a previous process can no longer start their remaining nodes. */
	async recover(): Promise<void> {
		const rows = await this.#db.selectFrom("task_groups").selectAll().where("state", "=", "running").execute();
		for (const row of rows) {
			const started = await this.#startedNodes(row.id);
			const skipped = (JSON.parse(row.node_ids) as string[]).filter((id) => !started.has(id));
			await this.#db
				.updateTable("task_groups")
				.set({ state: "interrupted", skipped: JSON.stringify(skipped), finished_at: now() })
				.where("id", "=", row.id)
				.execute();
		}
	}

	async create(input: CreateTaskGroupInput): Promise<string> {
		const parallel = Math.min(Math.max(input.parallel ?? DEFAULT_PARALLEL, 1), MAX_PARALLEL);
		if (input.id && (await this.#row(input.id))) return input.id;
		const id = input.id ?? newId();
		const nodes = await this.#db.selectFrom("nodes").selectAll().where("id", "in", input.nodeIds).execute();
		const first = nodes[0];
		if (!first) throw new UserError("no nodes");

		let approval: GroupApprovalRecord | undefined;
		if (input.chain) {
			approval = { nodes: [] };
			for (const node of nodes) {
				approval.nodes.push({
					nodeId: node.id,
					evaluation: await this.#cluster.evaluateFor(node, input.spec, input.chain),
				});
			}
		}
		const waiting = approval?.nodes.some((n) => n.evaluation.result === "require-approval") ?? false;
		const root = input.chain?.[0];
		await this.#db
			.insertInto("task_groups")
			.values({
				id,
				org_id: first.org_id,
				targets: JSON.stringify(input.targets),
				node_ids: JSON.stringify(input.nodeIds),
				kind: input.spec.kind.case ?? "",
				parallel,
				fail_fast: input.failFast ? 1 : 0,
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
				spec: JSON.stringify(toJson(TaskSpecSchema, input.spec)),
				timeout_ms: input.timeoutMs ?? null,
				root_session_id: root?.type === "session" ? root.id : null,
				// Until an ancestor agent is routed, the user (the group's on_behalf user) is the handler.
				handler_type: waiting ? "user" : null,
				handler_session_id: null,
			})
			.execute();
		void this.#audit?.record({
			actor: { type: input.actor.type, id: input.actor.id, onBehalfOfUserId: input.actor.onBehalfOfUserId },
			action: "task_group.created",
			target: { type: "task_group", id },
			detail: {
				targets: input.targets,
				node_ids: input.nodeIds,
				kind: input.spec.kind.case,
				policy: waiting ? "require-approval" : approval ? "evaluated" : "none",
			},
		});
		if (waiting) {
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
			this.#start(id, input, input.nodeIds, parallel);
		}
		return id;
	}

	#taskInput(input: CreateTaskGroupInput, groupId: string, nodeId: string, approvedBy?: ApprovalDecision) {
		const { nodeIds: _n, targets: _t, parallel: _p, failFast: _f, id: _i, ...task } = input;
		// A group with a stable id gives its tasks stable ids too, so a rerun reattaches to them.
		const id = input.id ? derivedId(`${input.id}/${nodeId}`) : undefined;
		return { ...task, nodeId, taskGroupId: groupId, ...(id ? { id } : {}), ...(approvedBy ? { approvedBy } : {}) };
	}

	#start(id: string, input: CreateTaskGroupInput, nodeIds: string[], parallel: number, approvedBy?: ApprovalDecision) {
		const run = this.#run(id, input, nodeIds, parallel, approvedBy).finally(() => this.#running.delete(id));
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
		let failed = false;
		const worker = async () => {
			for (;;) {
				if (input.failFast && failed) return;
				const nodeId = queue.shift();
				if (nodeId === undefined) return;
				const created = await this.#cluster.createTask(this.#taskInput(input, id, nodeId, approvedBy));
				let done = await this.#cluster.waitTask(created.id, HOUR);
				while (done && !TERMINAL.has(done.state)) done = await this.#cluster.waitTask(created.id, HOUR);
				if (done?.state !== "exited" || done.exitCode !== 0) failed = true;
			}
		};
		try {
			await Promise.all(Array.from({ length: Math.min(parallel, queue.length) }, worker));
		} finally {
			await this.#db
				.updateTable("task_groups")
				.set({
					state: "finished",
					skipped: JSON.stringify(queue),
					finished_at: now(),
					handler_type: null,
					handler_session_id: null,
				})
				.where("id", "=", id)
				.execute();
		}
	}

	/**
	 * Settles a group waiting for approval: approving starts its non-denied nodes, rejecting (or expiry)
	 * ends it. Returns false if it is not waiting. Who may decide is checked by the caller.
	 */
	async decide(id: string, decision: ApprovalDecision): Promise<boolean> {
		const row = await this.#row(id);
		if (row?.state !== "awaiting_approval") return false;
		const record: GroupApprovalRecord = { ...(JSON.parse(row.approval ?? "{}") as GroupApprovalRecord), decision };
		const approved = decision.decision === "approved";
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
		void this.#audit?.record({
			actor: {
				type: decision.by.type,
				id: decision.by.id,
				onBehalfOfUserId: decision.by.onBehalfOfUserId ?? row.on_behalf_of_user_id,
			},
			action: "task_group.approval",
			target: { type: "task_group", id },
			detail: { decision: decision.decision, reason: decision.reason },
		});
		if (approved) {
			const started = await this.#startedNodes(id);
			const remaining = (JSON.parse(row.node_ids) as string[]).filter((n) => !started.has(n));
			this.#start(id, this.#inputFromRow(row), remaining, row.parallel, { ...decision, taskGroupId: id });
		}
		this.#settled.get(id)?.resolve();
		this.#settled.delete(id);
		return true;
	}

	async recordReview(id: string, review: NonNullable<GroupApprovalRecord["review"]>): Promise<void> {
		const row = await this.#row(id);
		if (row?.state !== "awaiting_approval") return;
		const record: GroupApprovalRecord = { ...(JSON.parse(row.approval ?? "{}") as GroupApprovalRecord), review };
		await this.#db
			.updateTable("task_groups")
			.set({ approval: JSON.stringify(record) })
			.where("id", "=", id)
			.execute();
		void this.#audit?.record({
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
		const record: GroupApprovalRecord = {
			...(JSON.parse(row.approval ?? "{}") as GroupApprovalRecord),
			agent: { session, state: "pending" },
		};
		const res = await this.#db
			.updateTable("task_groups")
			.set({ approval: JSON.stringify(record), handler_type: "agent", handler_session_id: session })
			.where("id", "=", id)
			.where("state", "=", "awaiting_approval")
			.executeTakeFirst();
		if (res.numUpdatedRows === 0n) return false;
		void this.#audit?.record({
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
		const record: GroupApprovalRecord = {
			...(JSON.parse(row.approval ?? "{}") as GroupApprovalRecord),
			agent: { session, state: "escalated" },
		};
		const res = await this.#db
			.updateTable("task_groups")
			.set({ approval: JSON.stringify(record), handler_type: "user", handler_session_id: null })
			.where("id", "=", id)
			.where("state", "=", "awaiting_approval")
			.executeTakeFirst();
		if (res.numUpdatedRows === 0n) return false;
		void this.#audit?.record({
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
			const spec = fromJson(TaskSpecSchema, JSON.parse(row.spec ?? "{}"));
			const nodes = await this.#db
				.selectFrom("nodes")
				.selectAll()
				.where("id", "in", JSON.parse(row.node_ids))
				.execute();
			let stillWaiting = false;
			try {
				for (const node of nodes) {
					if ((await this.#cluster.evaluateFor(node, spec, chain)).result === "require-approval") stillWaiting = true;
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
			spec: fromJson(TaskSpecSchema, JSON.parse(row.spec ?? "{}")),
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
		const taskIds = await this.#db
			.selectFrom("tasks")
			.select("id")
			.where("task_group_id", "=", id)
			.orderBy("created_at")
			.execute();
		const tasks = (await Promise.all(taskIds.map((t) => this.#cluster.getTask(t.id)))).filter(
			(t): t is TaskView => t !== undefined,
		);
		return {
			id: row.id,
			state: row.state,
			targets: JSON.parse(row.targets) as string[],
			nodeIds: JSON.parse(row.node_ids) as string[],
			parallel: row.parallel,
			failFast: row.fail_fast === 1,
			skipped: JSON.parse(row.skipped) as string[],
			tasks,
			createdAt: row.created_at,
			finishedAt: row.finished_at,
			summary: row.spec ? summarize(row.spec) : "",
			kind: row.kind,
			ruleChain: row.rule_chain ? (JSON.parse(row.rule_chain) as RuleRef[]) : null,
			approval: row.approval ? (JSON.parse(row.approval) as GroupApprovalRecord) : null,
			actorType: row.actor_type,
			actorId: row.actor_id,
			onBehalfOfUserId: row.on_behalf_of_user_id,
			operation: row.spec ? operationOf(fromJson(TaskSpecSchema, JSON.parse(row.spec))) : null,
			rootSessionId: row.root_session_id,
			handlerType: row.handler_type,
			handlerSessionId: row.handler_session_id,
		};
	}

	/** Waits until the group is settled and every task has finished (or timeoutMs passes). */
	async wait(id: string, timeoutMs: number): Promise<TaskGroupView | undefined> {
		const deadline = Date.now() + timeoutMs;
		const until = (p: Promise<unknown>) => {
			let timer: NodeJS.Timeout | undefined;
			return Promise.race([p, new Promise((r) => (timer = setTimeout(r, Math.max(0, deadline - Date.now()))))]).finally(
				() => clearTimeout(timer),
			);
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
