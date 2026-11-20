import { afterAll, beforeAll, expect, it } from "vitest";
import { waitingAuthorizationGroupIds } from "../src/channels/manager.ts";
import type { Db } from "../src/storage/db.ts";
import { defaultOrgId } from "../src/storage/org.ts";
import { describeBackends, openTestDb } from "./helpers/db.ts";

// The query once compared the root with `is $1`, which SQLite accepts and PostgreSQL rejects as a syntax
// error, so chat approval and signature cards never synced on PostgreSQL.
describeBackends("channel waits", (backend) => {
	let db: Db;

	const insertTask = async (
		id: string,
		rootId: string | null,
		groupId: string | null,
		state: "awaiting_authorization" | "running",
	) => {
		await db
			.insertInto("tasks")
			.values({
				id,
				org_id: await defaultOrgId(db),
				node_id: "node-x",
				task_group_id: groupId,
				kind: "exec",
				spec: "{}",
				input_size: null,
				input_sha256: null,
				attempt: 1,
				rev: 1,
				privileged: 1,
				authorization: null,
				timeout_ms: null,
				output_mode: "full",
				max_lines: null,
				max_bytes: null,
				state,
				exit_code: null,
				signal: null,
				timed_out: 0,
				error_code: null,
				error_message: null,
				actor_type: rootId === null ? "user" : "session",
				actor_id: rootId ?? "user-1",
				on_behalf_of_user_id: "user-1",
				created_at: new Date().toISOString(),
				dispatched_at: null,
				accepted_at: null,
				finished_at: null,
				output_bytes: 0,
				output_head: null,
				output_tail: null,
				notice: null,
				output_lines: null,
				output_file: null,
				result: null,
				late_result: null,
				transfer: null,
				purpose: null,
				rule_chain: "[]",
				approval: null,
				pending_input: null,
				root_session_id: rootId,
				handler_type: null,
				handler_session_id: null,
			})
			.execute();
	};

	beforeAll(async () => {
		db = await openTestDb(backend);
		await insertTask("t-1", "root-a", "g-1", "awaiting_authorization");
		await insertTask("t-2", "root-a", "g-1", "awaiting_authorization");
		await insertTask("t-3", "root-a", "g-2", "running");
		await insertTask("t-4", "root-a", null, "awaiting_authorization");
		await insertTask("t-5", "root-b", "g-3", "awaiting_authorization");
		await insertTask("t-6", null, "g-4", "awaiting_authorization");
	});

	afterAll(async () => {
		await db.destroy();
	});

	it("lists a session root's groups with a member waiting for a signature", async () => {
		expect(await waitingAuthorizationGroupIds(db, "root-a")).toEqual(["g-1"]);
		expect(await waitingAuthorizationGroupIds(db, "root-c")).toEqual([]);
	});

	it("lists the groups of tasks with no session for a null root", async () => {
		expect(await waitingAuthorizationGroupIds(db, null)).toEqual(["g-4"]);
	});
});
