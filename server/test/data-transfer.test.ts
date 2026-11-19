/**
 * Bookkeeping of a file plane transfer's id (doc/design/protocol.md "Data connections"): a transfer id
 * opens one data connection while its task lives, and is forgotten once the task ends.
 */
import type { TaskExit } from "@crh/protocol";
import type { Insertable } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClusterCore, now } from "../src/cluster/core.ts";
import { settleTransferOnExit } from "../src/cluster/data-transfer.ts";
import { endTask } from "../src/cluster/task-end.ts";
import type { Db } from "../src/storage/db.ts";
import { defaultOrgId } from "../src/storage/org.ts";
import type { TaskState, TasksTable } from "../src/storage/schema.ts";
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

	it("releases a transfer slot only for the ending that won the row", async () => {
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
			transfer: null,
		};
		await db.insertInto("tasks").values(values).execute();
		await core.transferScheduler.acquire(id, "node-1");
		expect(core.transferScheduler.holds(id)).toBe(true);

		const row = await db.selectFrom("tasks").select("rev").where("id", "=", id).executeTakeFirstOrThrow();
		const lost = await core.taskQueue.run(id, () =>
			endTask(core, id, {
				write: { from: ["running"], rev: row.rev + 1, set: { state: "exited", exit_code: 0 } },
				live: "none",
			}),
		);
		expect(lost).toBe(false);
		expect(core.transferScheduler.holds(id)).toBe(true);

		const won = await core.taskQueue.run(id, () =>
			endTask(core, id, {
				write: { from: ["running"], rev: row.rev, set: { state: "exited", exit_code: 0 } },
				live: "none",
			}),
		);
		expect(won).toBe(true);
		expect(core.transferScheduler.holds(id)).toBe(false);
	});
});

/**
 * A transfer whose entry is gone (crhs restarted mid-transfer): nothing was committed. A library pull
 * must not report success with no object published; a staging pull has nothing to commit either way.
 */
describe("settling a transfer whose entry crhs lost", () => {
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

	const seedPull = async (location: unknown, state: TaskState = "running"): Promise<string> => {
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
			state,
			exit_code: null,
			signal: null,
			timed_out: 0,
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
			transfer: JSON.stringify({ transferId: newId(), location }),
		};
		await db.insertInto("tasks").values(values).execute();
		return id;
	};

	const exit = (id: string, outcome: TaskExit["outcome"] = { kind: "code", value: 0 }): TaskExit => ({
		taskId: id,
		outcome,
		timedOut: false,
		cancelled: false,
		outputEnd: 0,
		outputFile: "",
		outputLines: 0,
		outputLost: false,
		result: { kind: "file.pull", size: 4, sha256: new Uint8Array(32) },
	});

	const LIBRARY = {
		kind: "library",
		libraryId: "lib-1",
		path: "docs/app.conf",
		overwrite: false,
		createdBy: userId,
		size: null,
		sha256: null,
	};
	const STAGING = { kind: "staging", path: "incoming", size: null, sha256: null };

	it("fails a library pull the node reported as successful but crhs lost", async () => {
		const id = await seedPull(LIBRARY);
		const row = (await db.selectFrom("tasks").selectAll().where("id", "=", id).executeTakeFirstOrThrow()) as {
			id: string;
			kind: string;
			transfer: string | null;
		};
		const failure = await settleTransferOnExit(core, row, exit(id));
		expect(failure).toEqual({ code: "io_error", message: "crhs lost the transfer before it finished" });
	});

	it("keeps a staging pull's success, which has no library object to publish", async () => {
		const id = await seedPull(STAGING);
		const row = (await db.selectFrom("tasks").selectAll().where("id", "=", id).executeTakeFirstOrThrow()) as {
			id: string;
			kind: string;
			transfer: string | null;
		};
		expect(await settleTransferOnExit(core, row, exit(id))).toBeUndefined();
	});

	it("does not turn a failed library pull into a lost-transfer failure", async () => {
		const id = await seedPull(LIBRARY);
		const row = (await db.selectFrom("tasks").selectAll().where("id", "=", id).executeTakeFirstOrThrow()) as {
			id: string;
			kind: string;
			transfer: string | null;
		};
		expect(
			await settleTransferOnExit(core, row, exit(id, { kind: "error", code: "io_error", message: "the node failed" })),
		).toBeUndefined();
	});
});
