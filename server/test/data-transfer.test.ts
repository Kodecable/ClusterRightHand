/**
 * Bookkeeping of a file plane transfer's id (doc/design/protocol.md "Data connections"): a transfer id
 * opens one data connection while its task lives, and is forgotten once the task ends.
 */
import type { Insertable } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClusterCore, now } from "../src/cluster/core.ts";
import { endTask } from "../src/cluster/task-end.ts";
import type { Db } from "../src/storage/db.ts";
import { defaultOrgId } from "../src/storage/org.ts";
import type { TasksTable } from "../src/storage/schema.ts";
import { createUser } from "../src/users/service.ts";
import { newId } from "../src/util/id.ts";
import { openTestDb } from "./helpers/db.ts";

describe("a transfer task's id", () => {
	let db: Db;
	let core: ClusterCore;
	let userId = "";

	beforeEach(async () => {
		db = await openTestDb("sqlite");
		core = new ClusterCore(db, { transferRoot: "/nonexistent" });
		userId = (await createUser(db, { username: "owner", kind: "member", password: "password-123" })).id;
	});

	afterEach(async () => {
		core.endWaits();
		await db.destroy();
	});

	it("is kept while the task lives and dropped when it ends", async () => {
		const transferId = "transfer-1";
		const id = newId();
		const values: Insertable<TasksTable> = {
			id,
			org_id: await defaultOrgId(db),
			node_id: "node-1",
			task_group_id: null,
			kind: "file.pull",
			spec: JSON.stringify({ kind: "file.pull", path: "/etc/app.conf", maxBytes: 1024 }),
			input_size: null,
			input_sha256: null,
			privileged: 0,
			attempt: 1,
			timeout_ms: null,
			output_mode: "status",
			state: "running",
			exit_code: null,
			signal: null,
			timed_out: 0,
			cancelled: 0,
			error_code: null,
			error_message: null,
			actor_type: "user",
			actor_id: userId,
			on_behalf_of_user_id: userId,
			created_at: now(),
			dispatched_at: now(),
			accepted_at: now(),
			finished_at: null,
			output_bytes: 0,
			output_head: null,
			output_tail: null,
			output_lines: null,
			notice: null,
			result: null,
			output_file: null,
			late_result: null,
			rule_chain: null,
			approval: null,
			pending_input: null,
			root_session_id: null,
			handler_type: null,
			handler_session_id: null,
			transfer: JSON.stringify({
				transferId,
				location: { kind: "staging", path: "incoming", size: null, sha256: null },
			}),
		};
		await db.insertInto("tasks").values(values).execute();
		core.usedTransfers.add(transferId);
		expect(core.usedTransfers.has(transferId)).toBe(true);

		await endTask(core, id, {
			write: { from: ["running"], set: { state: "exited", exit_code: 0 } },
			live: "none",
		});
		expect(core.usedTransfers.has(transferId)).toBe(false);
	});
});
