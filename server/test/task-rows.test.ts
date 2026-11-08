import { randomUUID } from "node:crypto";
import { type TaskSpec, taskSpecToJson } from "@crh/protocol";
import { type Insertable, sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { refreshGroupPending } from "../src/cluster/authorization/plan.ts";
import {
	parseTaskAuthorization,
	serializeTaskAuthorization,
	type TaskAuthorizationRecord,
} from "../src/cluster/authorization.ts";
import { ClusterCore } from "../src/cluster/core.ts";
import { insertTask, writeTask } from "../src/cluster/task-rows.ts";
import { cancelTask } from "../src/cluster/task-wait.ts";
import type { Db } from "../src/storage/db.ts";
import type { TasksTable } from "../src/storage/schema.ts";
import { defaultOrgId } from "../src/users/service.ts";
import { openTestDb } from "./helpers/db.ts";

const EXEC: TaskSpec = {
	kind: "exec",
	command: { argv: ["true"] },
	env: {},
	cwd: "",
	stdin: null,
};
const SPEC = JSON.stringify(taskSpecToJson(EXEC));
const NOW = "2026-01-01T00:00:00.000Z";

/** A task row with the required columns; the writer's insert adds no rev and takes the default 0. */
function taskValues(
	id: string,
	orgId: string,
	state: TasksTable["state"],
	extra: Partial<Insertable<TasksTable>> = {},
): Insertable<TasksTable> {
	return {
		id,
		org_id: orgId,
		node_id: "node-1",
		task_group_id: null,
		kind: "exec",
		spec: SPEC,
		input_size: null,
		input_sha256: null,
		privileged: 0,
		attempt: 1,
		timeout_ms: null,
		output_mode: "full",
		state,
		exit_code: null,
		signal: null,
		timed_out: 0,
		cancelled: 0,
		error_code: null,
		error_message: null,
		actor_type: "user",
		actor_id: "user-1",
		on_behalf_of_user_id: "user-1",
		created_at: NOW,
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
		...extra,
	};
}

/** The stored record of a waiting member whose plan has a user path. */
function authorizationRecord(attempt: number, pending: boolean): TaskAuthorizationRecord {
	return {
		plan: { paths: [{ path: "user", entries: [], ttlMs: 3_600_000 }] },
		tried: [],
		dispatchedPath: null,
		payloadId: null,
		attempt,
		trustDigest: null,
		pending: pending ? { payload: "AA==", id: "payload", deadline: null, taskIds: [], attempt } : null,
		local: null,
		lastRejection: null,
		updatedAt: NOW,
	};
}

describe("task row versions (D118)", () => {
	let db: Db;
	let orgId: string;

	beforeEach(async () => {
		db = await openTestDb("sqlite");
		orgId = await defaultOrgId(db);
	});

	afterEach(async () => {
		await db.destroy();
	});

	const row = (id: string) => db.selectFrom("tasks").selectAll().where("id", "=", id).executeTakeFirstOrThrow();

	it("bumps rev on every write and a stale rev changes nothing", async () => {
		await insertTask(db, taskValues("t1", orgId, "awaiting_approval"));
		expect((await row("t1")).rev).toBe(0);
		// These writes test the writer's guards directly, not the queue discipline: the turn check a
		// rev-guarded write normally has to pass is exempted the same way cancelTask exempts itself.
		const outOfTurn = { outOfTurn: true };

		// The writer takes a read row and writes it back at that version.
		expect(await writeTask(db, "t1", { states: ["awaiting_approval"], rev: 0 }, { notice: "first" }, outOfTurn)).toBe(
			true,
		);
		expect(await row("t1")).toMatchObject({ rev: 1, notice: "first" });

		// The same read row is stale now: the later write matches nothing and leaves the row alone.
		expect(await writeTask(db, "t1", { states: ["awaiting_approval"], rev: 0 }, { notice: "stale" }, outOfTurn)).toBe(
			false,
		);
		expect(await row("t1")).toMatchObject({ rev: 1, notice: "first" });

		// A state-only write also bumps rev.
		expect(await writeTask(db, "t1", { states: ["awaiting_approval"] }, { attempt: 2 })).toBe(true);
		expect(await row("t1")).toMatchObject({ rev: 2, attempt: 2 });

		// The state and node guards are still WHERE clauses.
		expect(await writeTask(db, "t1", { states: ["dispatched"], rev: 2 }, { notice: "no" }, outOfTurn)).toBe(false);
		expect(await writeTask(db, "t1", { nodeId: "node-2", rev: 2 }, { notice: "no" }, outOfTurn)).toBe(false);
		expect(await row("t1")).toMatchObject({ rev: 2, notice: "first" });

		// A node-side write with no meaningful guard says so with an explicit `{}` and still bumps rev.
		expect(await writeTask(db, "t1", {}, { notice: "unguarded" })).toBe(true);
		expect(await row("t1")).toMatchObject({ rev: 3, notice: "unguarded" });
	});

	it("rejects an omitted guard and an empty state list", async () => {
		await insertTask(db, taskValues("t1", orgId, "awaiting_approval"));
		await expect(writeTask(db, "t1", undefined as never, { notice: "x" })).rejects.toThrow(/explicit guard/);
		await expect(writeTask(db, "t1", { states: [] }, { notice: "x" })).rejects.toThrow(/empty state list/);
		expect(await row("t1")).toMatchObject({ rev: 0, notice: null });
	});

	it("refuses a rev-guarded write outside the task's own queue turn", async () => {
		await insertTask(db, taskValues("t1", orgId, "awaiting_approval"));
		const core = new ClusterCore(db);
		const guard = { states: ["awaiting_approval"] as const, rev: 0 };

		// Outside a turn the stale-row decision must not be written (D118).
		await expect(writeTask(db, "t1", guard, { notice: "outside" })).rejects.toThrow(
			"outside the task queue turn (D118)",
		);
		expect(await row("t1")).toMatchObject({ rev: 0, notice: null });
		// A turn of another task's queue is not this task's turn either.
		await expect(core.taskQueue.run("t2", () => writeTask(db, "t1", guard, { notice: "other" }))).rejects.toThrow(
			"outside the task queue turn (D118)",
		);
		// The task's own turn is where the guarded write belongs.
		expect(await core.taskQueue.run("t1", () => writeTask(db, "t1", guard, { notice: "inside" }))).toBe(true);
		expect(await row("t1")).toMatchObject({ rev: 1, notice: "inside" });
		// The documented exceptions still write outside a turn (a cancel, the group payload refresh).
		expect(await writeTask(db, "t1", { ...guard, rev: 1 }, { notice: "exempt" }, { outOfTurn: true })).toBe(true);
		expect(await row("t1")).toMatchObject({ rev: 2, notice: "exempt" });
	});
});

describe("group payload refresh under concurrent member changes (D118)", () => {
	let db: Db;
	let orgId: string;
	let core: ClusterCore;

	beforeEach(async () => {
		db = await openTestDb("sqlite");
		orgId = await defaultOrgId(db);
		core = new ClusterCore(db);
	});

	afterEach(async () => {
		await db.destroy();
	});

	it("re-reads and recomputes when a member changed after the round read it", async () => {
		const groupId = "group-1";
		await db
			.insertInto("task_groups")
			.values({
				id: groupId,
				org_id: orgId,
				targets: "[]",
				node_ids: "[]",
				kind: "exec",
				parallel: 2,
				fail_fast: 0,
				output_mode: "status",
				privileged: 0,
				skipped: "[]",
				state: "awaiting_authorization",
				actor_type: "user",
				actor_id: "user-1",
				on_behalf_of_user_id: "user-1",
				created_at: NOW,
				finished_at: null,
				spec: SPEC,
				timeout_ms: null,
				rule_chain: null,
				approval: null,
				pending_input: null,
				root_session_id: null,
				handler_type: null,
				handler_session_id: null,
			})
			.execute();
		const members = ["member-a", "member-b"];
		for (const [index, id] of members.entries()) {
			await insertTask(
				db,
				taskValues(id, orgId, "awaiting_authorization", {
					task_group_id: groupId,
					node_id: randomUUID(),
					attempt: 1,
					created_at: `2026-01-01T00:00:0${index}.000Z`,
					authorization: serializeTaskAuthorization(authorizationRecord(1, true)),
				}),
			);
		}

		// The first member write is made to race another path's change of member-b: before it runs,
		// member-b moves to attempt 2 and its rev advances. Its rev-guarded write therefore misses, and
		// the refresh has to read the group again and recompute.
		const originalUpdate = db.updateTable.bind(db);
		let changed = false;
		const hook = (builder: object): object =>
			new Proxy(builder, {
				get(target, property) {
					const value = Reflect.get(target, property, target);
					if (typeof value !== "function") return value;
					if (property === "executeTakeFirst") {
						return async () => {
							if (!changed) {
								changed = true;
								await sql`update tasks set attempt = 2, rev = rev + 1 where id = ${"member-b"}`.execute(db);
							}
							return value.call(target);
						};
					}
					// Every Kysely builder method returns a fresh builder; wrap it so the final execute is seen.
					return (...args: unknown[]) => {
						const next: unknown = value.apply(target, args);
						return next !== null && typeof next === "object" && "executeTakeFirst" in next ? hook(next) : next;
					};
				},
			});
		Object.defineProperty(db, "updateTable", {
			configurable: true,
			value: ((table: "tasks") => hook(originalUpdate(table))) as typeof db.updateTable,
		});
		try {
			await refreshGroupPending(core, groupId);
		} finally {
			Object.defineProperty(db, "updateTable", { configurable: true, value: originalUpdate });
		}
		expect(changed).toBe(true);

		const rows = await db
			.selectFrom("tasks")
			.selectAll()
			.where("task_group_id", "=", groupId)
			.orderBy("created_at")
			.execute();
		expect(rows.map((row) => row.attempt)).toEqual([2, 2]);
		for (const row of rows) {
			expect(parseTaskAuthorization(row.authorization)).toMatchObject({
				attempt: 2,
				pending: { attempt: 2 },
			});
		}
	});
	it("a cancel of a waiting task follows a row another path bumped in between", async () => {
		await insertTask(db, taskValues("t-cancel", orgId, "awaiting_authorization"));
		const core = new ClusterCore(db);
		// The first read the cancel makes is stale by the time it writes: a re-plan bumps rev right after it.
		const read = core.row.bind(core);
		let bumped = false;
		core.row = async (id: string) => {
			const result = await read(id);
			if (!bumped) {
				bumped = true;
				await writeTask(db, id, { states: ["awaiting_authorization"] }, { notice: "re-planned" });
			}
			return result;
		};
		expect(await cancelTask(core, "t-cancel")).toBe(true);
		const ended = await db.selectFrom("tasks").selectAll().where("id", "=", "t-cancel").executeTakeFirstOrThrow();
		expect(ended).toMatchObject({ state: "rejected", error_code: "cancelled" });
	});
});
