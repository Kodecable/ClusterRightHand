import type { SessionUser } from "../auth/sessions.ts";
import type { Db } from "../storage/db.ts";
import { UserError } from "../users/service.ts";
import { newId } from "../util/id.ts";
import type { Actor, Cluster, CreateTaskInput, TaskView } from "./cluster.ts";
import { listNodesForUser } from "./nodes.ts";

export const DEFAULT_PARALLEL = 10;
const MAX_PARALLEL = 100;
const MAX_TARGETS = 1000;
// setTimeout cannot wait longer than ~24.8 days, so long waits loop.
const HOUR = 3_600_000;
const FINAL = new Set(["exited", "failed", "rejected", "unknown"]);

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

export interface CreateTaskGroupInput extends Omit<CreateTaskInput, "nodeId" | "taskGroupId"> {
	targets: string[];
	nodeIds: string[];
	parallel?: number;
	failFast?: boolean;
	actor: Actor;
}

export interface TaskGroupView {
	id: string;
	state: "running" | "finished" | "interrupted";
	targets: string[];
	nodeIds: string[];
	parallel: number;
	failFast: boolean;
	skipped: string[];
	tasks: TaskView[];
	createdAt: string;
	finishedAt: string | null;
}

/** Runs one task per node with bounded parallelism; see doc/agent-runtime.md#批量执行. */
export class TaskGroups {
	readonly #db: Db;
	readonly #cluster: Cluster;
	readonly #running = new Map<string, Promise<void>>();

	constructor(db: Db, cluster: Cluster) {
		this.#db = db;
		this.#cluster = cluster;
	}

	/** Groups left running by a previous process can no longer start their remaining nodes. */
	async recover(): Promise<void> {
		const rows = await this.#db.selectFrom("task_groups").selectAll().where("state", "=", "running").execute();
		for (const row of rows) {
			const started = new Set(
				(await this.#db.selectFrom("tasks").select("node_id").where("task_group_id", "=", row.id).execute()).map(
					(t) => t.node_id,
				),
			);
			const skipped = (JSON.parse(row.node_ids) as string[]).filter((id) => !started.has(id));
			await this.#db
				.updateTable("task_groups")
				.set({ state: "interrupted", skipped: JSON.stringify(skipped), finished_at: new Date().toISOString() })
				.where("id", "=", row.id)
				.execute();
		}
	}

	async create(input: CreateTaskGroupInput): Promise<string> {
		const parallel = Math.min(Math.max(input.parallel ?? DEFAULT_PARALLEL, 1), MAX_PARALLEL);
		const id = newId();
		const org = await this.#db
			.selectFrom("nodes")
			.select("org_id")
			.where("id", "=", input.nodeIds[0] ?? "")
			.executeTakeFirst();
		if (!org) throw new UserError("no nodes");
		await this.#db
			.insertInto("task_groups")
			.values({
				id,
				org_id: org.org_id,
				targets: JSON.stringify(input.targets),
				node_ids: JSON.stringify(input.nodeIds),
				kind: input.spec.kind.case ?? "",
				parallel,
				fail_fast: input.failFast ? 1 : 0,
				skipped: "[]",
				state: "running",
				actor_type: input.actor.type,
				actor_id: input.actor.id,
				on_behalf_of_user_id: input.actor.onBehalfOfUserId,
				created_at: new Date().toISOString(),
				finished_at: null,
			})
			.execute();
		const run = this.#run(id, input, parallel).finally(() => this.#running.delete(id));
		this.#running.set(id, run);
		return id;
	}

	async #run(id: string, input: CreateTaskGroupInput, parallel: number): Promise<void> {
		const queue = [...input.nodeIds];
		let failed = false;
		const worker = async () => {
			for (;;) {
				if (input.failFast && failed) return;
				const nodeId = queue.shift();
				if (nodeId === undefined) return;
				const { nodeIds: _n, targets: _t, parallel: _p, failFast: _f, ...task } = input;
				const created = await this.#cluster.createTask({ ...task, nodeId, taskGroupId: id });
				let done = await this.#cluster.waitTask(created.id, HOUR);
				while (done && !FINAL.has(done.state)) done = await this.#cluster.waitTask(created.id, HOUR);
				if (done?.state !== "exited" || done.exitCode !== 0) failed = true;
			}
		};
		try {
			await Promise.all(Array.from({ length: Math.min(parallel, queue.length) }, worker));
		} finally {
			await this.#db
				.updateTable("task_groups")
				.set({ state: "finished", skipped: JSON.stringify(queue), finished_at: new Date().toISOString() })
				.where("id", "=", id)
				.execute();
		}
	}

	async get(id: string): Promise<TaskGroupView | undefined> {
		const row = await this.#db.selectFrom("task_groups").selectAll().where("id", "=", id).executeTakeFirst();
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
		};
	}

	/** Waits until every task has finished (or timeoutMs passes). */
	async wait(id: string, timeoutMs: number): Promise<TaskGroupView | undefined> {
		const run = this.#running.get(id);
		if (run) {
			let timer: NodeJS.Timeout | undefined;
			await Promise.race([run, new Promise((r) => (timer = setTimeout(r, timeoutMs)))]);
			clearTimeout(timer);
		}
		return this.get(id);
	}
}
