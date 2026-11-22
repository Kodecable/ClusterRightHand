/**
 * waitTask registers its waiter before reading the row (cluster/task-wait.ts): a task that ends between
 * the read and the registration used to be noticed only when the timeout ran out.
 */
import type { Insertable } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClusterCore } from "../src/cluster/core.ts";
import { finish } from "../src/cluster/task-end.ts";
import { waitTask } from "../src/cluster/task-wait.ts";
import type { Db } from "../src/storage/db.ts";
import { defaultOrgId } from "../src/storage/org.ts";
import type { TaskState, TasksTable } from "../src/storage/schema.ts";
import { createUser } from "../src/users/service.ts";
import { newId } from "../src/util/id.ts";
import { waitFor } from "./helpers/agent.ts";
import { openTestDb } from "./helpers/db.ts";

const HOUR = 3_600_000;

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	return Promise.race([
		promise,
		new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms);
		}),
	]).finally(() => clearTimeout(timer));
}

describe("a task wait that races the task's end", () => {
	let db: Db;
	let core: ClusterCore;
	let userId = "";
	let nodeId = "";

	beforeEach(async () => {
		db = await openTestDb("sqlite");
		core = new ClusterCore(db);
		userId = (await createUser(db, { username: "owner", kind: "member", password: "password-123" })).id;
		nodeId = newId();
		const now = new Date().toISOString();
		await db
			.insertInto("nodes")
			.values({
				id: nodeId,
				org_id: await defaultOrgId(db),
				name: "wait-race-node",
				name_key: "wait-race-node",
				transport: "client",
				status: "active",
				public_key: "unused",
				hostname: "wait-race-node",
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
				trust_report: null,
				trust_digest: null,
				trust_updated_at: null,
			})
			.execute();
	});

	afterEach(async () => {
		core.endWaits();
		await db.destroy();
	});

	const seedTask = async (state: TaskState): Promise<string> => {
		const id = newId();
		const now = new Date().toISOString();
		const values: Insertable<TasksTable> = {
			id,
			org_id: await defaultOrgId(db),
			node_id: nodeId,
			task_group_id: null,
			kind: "file.stat",
			spec: JSON.stringify({ kind: "file.stat", path: "/tmp" }),
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
			created_at: now,
			dispatched_at: now,
			accepted_at: now,
			finished_at: null,
			output_bytes: 0,
			output_head: null,
			output_tail: null,
			output_lines: null,
			notice: null,
			result: null,
			output_file: null,
			rule_chain: null,
			approval: null,
			pending_input: null,
			root_session_id: null,
			handler_type: null,
			handler_session_id: null,
			transfer: null,
		};
		await db.insertInto("tasks").values(values).execute();
		return id;
	};

	it("notices a task that ended while its first read was in flight", async () => {
		const id = await seedTask("running");
		// Hold the first read after it captured the (non-terminal) row, so the task can end before the
		// caller would have registered its waiter.
		const row = core.row.bind(core);
		let releaseRead!: () => void;
		const gate = new Promise<void>((resolve) => {
			releaseRead = resolve;
		});
		let firstRead = true;
		core.row = (async (taskId: string) => {
			const value = await row(taskId);
			if (firstRead) {
				firstRead = false;
				await gate;
			}
			return value;
		}) as typeof core.row;

		const waiting = waitTask(core, id, HOUR);
		await waitFor("the in-flight first read", () => !firstRead);
		// The waiter must already exist: it is registered before the read, not after it.
		expect(core.waiters.has(id)).toBe(true);
		await finish(core, nodeId, id, { state: "exited", exit_code: 0 });
		releaseRead();

		const view = await withTimeout(waiting, 1_000, "the task wait after its end");
		expect(view).toMatchObject({ id, state: "exited", exitCode: 0 });
		expect(core.waiters.has(id)).toBe(false);
	});

	it("returns on the timeout without leaving an empty waiter set", async () => {
		const id = await seedTask("running");
		const view = await withTimeout(waitTask(core, id, 50), 1_000, "the timed-out task wait");
		expect(view).toMatchObject({ id, state: "running" });
		expect(core.waiters.has(id)).toBe(false);
	});

	it("returns on abort without waiting for the deadline", async () => {
		const id = await seedTask("running");
		const abort = new AbortController();
		const waiting = waitTask(core, id, HOUR, abort.signal);
		await waitFor("the waiter", () => core.waiters.has(id));
		abort.abort();
		const view = await withTimeout(waiting, 1_000, "the aborted task wait");
		expect(view).toMatchObject({ id, state: "running" });
		expect(core.waiters.has(id)).toBe(false);
	});
});
