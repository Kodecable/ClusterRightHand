import { generateKeyPair } from "@crh/noise";
import { type TaskExit, type TaskSpec, taskSpecToJson } from "@crh/protocol";
import type { Insertable } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NodeConnection } from "../src/cluster/connection.ts";
import { ClusterCore } from "../src/cluster/core.ts";
import { dropLive, newLive, releaseGroupBudget } from "../src/cluster/live-output.ts";
import type { NodeRow } from "../src/cluster/nodes.ts";
import { onExit } from "../src/cluster/task-end.ts";
import { waitTask } from "../src/cluster/task-wait.ts";
import type { Db } from "../src/storage/db.ts";
import { defaultOrgId } from "../src/storage/org.ts";
import type { TasksTable } from "../src/storage/schema.ts";
import { createUser } from "../src/users/service.ts";
import { newId } from "../src/util/id.ts";
import { openTestDb } from "./helpers/db.ts";

const EXEC: TaskSpec = { kind: "exec", command: { argv: ["true"] }, env: {}, cwd: "", stdin: null };

/**
 * The live output the cluster keeps between dispatch and the recorded end (doc/design/execution.md "Output"):
 * a group's budget is created once, released when the group ends, and never re-created by a late result.
 */
describe("live output budgets", () => {
	let db: Db;
	let core: ClusterCore;
	let node: NodeRow;
	let ownerId = "";

	beforeEach(async () => {
		db = await openTestDb("sqlite");
		core = new ClusterCore(db, { nodeOfflineGraceMs: 10 });
		const user = await createUser(db, { username: "owner", kind: "admin", password: "password-123" });
		ownerId = user.id;
		const id = newId();
		const now = new Date().toISOString();
		await db
			.insertInto("nodes")
			.values({
				id,
				org_id: await defaultOrgId(db),
				name: "budget-node",
				name_key: "budget-node",
				transport: "client",
				status: "active",
				public_key: Buffer.from(generateKeyPair().publicKey).toString("base64"),
				hostname: "budget-node",
				facts: null,
				client_version: null,
				privileged_mode: null,
				last_seen_at: null,
				created_at: now,
				approved_at: now,
				approved_by_user_id: null,
				ssh_host: null,
				ssh_port: null,
				ssh_user: null,
				ssh_host_fingerprint: null,
				ssh_credential_id: null,
				ssh_jumps: null,
			})
			.execute();
		node = (await db.selectFrom("nodes").selectAll().where("id", "=", id).executeTakeFirstOrThrow()) as NodeRow;
	});

	afterEach(async () => {
		await db.destroy();
	});

	const seedTask = async (state: TasksTable["state"], overrides: Partial<Insertable<TasksTable>> = {}) => {
		const id = newId();
		const now = new Date().toISOString();
		await db
			.insertInto("tasks")
			.values({
				id,
				org_id: node.org_id,
				node_id: node.id,
				task_group_id: null,
				kind: EXEC.kind,
				spec: JSON.stringify(taskSpecToJson(EXEC)),
				input_size: null,
				input_sha256: null,
				privileged: 0,
				attempt: 1,
				timeout_ms: null,
				output_mode: "head",
				state,
				exit_code: null,
				signal: null,
				timed_out: 0,
				cancelled: 0,
				error_code: null,
				error_message: null,
				actor_type: "user",
				actor_id: ownerId,
				on_behalf_of_user_id: ownerId,
				created_at: now,
				dispatched_at: null,
				accepted_at: null,
				finished_at: null,
				output_bytes: 0,
				output_head: null,
				output_tail: null,
				notice: null,
				output_file: null,
				late_result: null,
				rule_chain: null,
				approval: null,
				pending_input: null,
				root_session_id: null,
				handler_type: null,
				handler_session_id: null,
				...overrides,
			})
			.execute();
		return id;
	};

	it("creates one budget per group and keeps it until the group ends", () => {
		newLive(core, "task-a", node.id, "head", "group-1");
		newLive(core, "task-b", node.id, "head", "group-1");
		expect([...core.budgets.keys()]).toEqual(["group:group-1"]);

		// The tasks end one by one; the group's budget outlives them and is released by the group.
		dropLive(core, "task-a");
		dropLive(core, "task-b");
		expect(core.budgets.has("group:group-1")).toBe(true);
		expect(releaseGroupBudget(core, "group-1")).toBe(true);
		expect(core.budgets.size).toBe(0);
		expect(releaseGroupBudget(core, "group-1")).toBe(false);
	});

	it("does not re-create a released group budget for an ended group's late record", () => {
		const live = newLive(core, "late", node.id, "head", "group-1", null, null, { groupEnded: true });
		// The record still keeps its own bounded output, but no shared budget appears in the map.
		expect(live.output.append(0, Buffer.from("late output\n"))).toBe(true);
		expect(core.budgets.size).toBe(0);
		dropLive(core, "late");
		expect(core.budgets.size).toBe(0);
	});

	it("keeps a single task's own budget and releases it with the record", () => {
		const live = newLive(core, "single", node.id, "text", null);
		expect([...core.budgets.keys()]).toEqual(["task:single"]);
		live.output.append(0, Buffer.from("tail\n"));
		dropLive(core, "single");
		expect(core.budgets.size).toBe(0);
	});

	it("does not re-create a finished group's budget when an unknown member reports its exit", async () => {
		const groupId = newId();
		await db
			.insertInto("task_groups")
			.values({
				id: groupId,
				org_id: node.org_id,
				targets: JSON.stringify([node.id]),
				node_ids: JSON.stringify([node.id]),
				kind: "exec",
				parallel: 1,
				fail_fast: 0,
				output_mode: "head",
				node_max_lines: null,
				node_max_bytes: null,
				privileged: 0,
				skipped: "[]",
				state: "finished",
				actor_type: "user",
				actor_id: ownerId,
				on_behalf_of_user_id: ownerId,
				created_at: new Date().toISOString(),
				finished_at: new Date().toISOString(),
			})
			.execute();
		const taskId = await seedTask("unknown", { task_group_id: groupId });
		const exit: TaskExit = {
			taskId,
			outcome: { kind: "code", value: 0 },
			timedOut: false,
			cancelled: false,
			outputEnd: 0,
			outputFile: "",
			outputLines: 0,
			result: null,
		};
		const conn = { nodeId: node.id, peer: { emit: () => {} } } as unknown as NodeConnection;

		await onExit(core, conn, exit);

		expect(core.budgets.size).toBe(0);
		const row = await db.selectFrom("tasks").select("late_result").where("id", "=", taskId).executeTakeFirstOrThrow();
		expect(row.late_result).not.toBeNull();
	});

	it("removes a link wait's empty set when it times out", async () => {
		await core.waitLink("no-such-node", 1);
		expect(core.linkWaiters.size).toBe(0);
	});

	it("removes a task wait's empty set when its timeout passes", async () => {
		const id = await seedTask("awaiting_approval");
		expect((await waitTask(core, id, 1))?.state).toBe("awaiting_approval");
		expect(core.waiters.size).toBe(0);
	});
});
