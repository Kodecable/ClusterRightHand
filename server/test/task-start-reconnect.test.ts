/**
 * A task.start that fails with ConnectionError after the node already reconnected (cluster/task-start.ts):
 * the new link's hello may have missed the row, and a ready link disarms the grace, so the row would stay
 * `dispatched` forever and keep its transfer slot.
 */
import { generateKeyPair } from "@crh/noise";
import { ConnectionError, type TaskSpec, type TaskStatus } from "@crh/protocol";
import type { Insertable } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NodeConnection } from "../src/cluster/connection.ts";
import { ClusterCore } from "../src/cluster/core.ts";
import type { NodeLink } from "../src/cluster/links.ts";
import type { NodeRow } from "../src/cluster/nodes.ts";
import { onAccepted } from "../src/cluster/task-end.ts";
import { sendTaskStart, taskStartOf } from "../src/cluster/task-start.ts";
import type { Db } from "../src/storage/db.ts";
import { defaultOrgId } from "../src/storage/org.ts";
import type { TaskState, TasksTable } from "../src/storage/schema.ts";
import { createUser } from "../src/users/service.ts";
import { newId } from "../src/util/id.ts";
import { openTestDb } from "./helpers/db.ts";

const SPEC: TaskSpec = { kind: "file.stat", path: "/tmp" };

describe("a task.start that loses its connection after the node reconnected", () => {
	let db: Db;
	let core: ClusterCore;
	let node: NodeRow;
	let userId = "";

	beforeEach(async () => {
		db = await openTestDb("sqlite");
		core = new ClusterCore(db);
		userId = (await createUser(db, { username: "owner", kind: "admin", password: "password-123" })).id;
		const id = newId();
		const now = new Date().toISOString();
		await db
			.insertInto("nodes")
			.values({
				id,
				org_id: await defaultOrgId(db),
				name: "start-node",
				name_key: "start-node",
				transport: "client",
				status: "active",
				public_key: Buffer.from(generateKeyPair().publicKey).toString("base64"),
				hostname: "start-node",
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
		core.endWaits();
		// The confirmation after a reconnect runs in the background; let it return before the database goes.
		await core.drain();
		await db.destroy();
	});

	const seedTask = async (state: TaskState, overrides: Partial<Insertable<TasksTable>> = {}): Promise<string> => {
		const id = newId();
		const now = new Date().toISOString();
		const values: Insertable<TasksTable> = {
			id,
			org_id: node.org_id,
			node_id: node.id,
			task_group_id: null,
			kind: SPEC.kind,
			spec: JSON.stringify(SPEC),
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
			dispatched_at: state === "dispatched" ? now : null,
			accepted_at: null,
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
			...overrides,
		};
		await db.insertInto("tasks").values(values).execute();
		return id;
	};

	/**
	 * A link whose requests fail with ConnectionError when `fail` is set; otherwise `answer` is what a
	 * task.query request responds with (an empty object for every request when it is not given).
	 */
	const failingLink = (fail: boolean, answer?: TaskStatus) => {
		const requests: string[] = [];
		const conn = {
			nodeId: node.id,
			closed: false,
			close: (): void => {},
			peer: {
				request: async (name: string): Promise<unknown> => {
					requests.push(name);
					if (fail) throw new ConnectionError("the connection closed");
					if (name === "task.query" && answer) return answer;
					return {};
				},
			},
		} as unknown as NodeConnection;
		const link: NodeLink = {
			conn,
			active: true,
			ready: true,
			queried: new Set(),
			trustFresh: true,
			taskKinds: new Set(),
		};
		return { link, requests };
	};

	const startOf = async (id: string) =>
		taskStartOf(id, await core.row(id), SPEC, { privileged: false, attempt: 1, authorizations: [] });

	it("reports the task unknown when the send failed on a link the node already replaced", async () => {
		const id = await seedTask("dispatched");
		const stale = failingLink(true);
		const fresh = failingLink(false, { taskId: id, state: "unknown", outputEnd: 0 });
		// The node reconnected before the failure was handled: the link that was dispatched on is gone.
		core.links.set(node.id, fresh.link);

		await sendTaskStart(core, stale.link, node.id, await startOf(id), new Uint8Array(0), {
			settle: (write) => write(),
		});

		expect(stale.requests).toEqual(["task.start"]);
		// The confirmation runs in the background: the ready link is asked about the task it does not know.
		await vi.waitFor(async () => {
			expect(await core.row(id)).toMatchObject({
				state: "unknown",
				error_code: "dispatch_unconfirmed",
				error_message:
					"the connection broke before the node confirmed it received the task; it may or may not have run",
			});
		});
		expect(fresh.requests).toEqual(["task.query"]);
	});

	it("frees the transfer slot of the unknown transfer", async () => {
		const id = await seedTask("dispatched", {
			kind: "file.pull",
			spec: JSON.stringify({ kind: "file.pull", path: "/etc/app.conf", maxBytes: 1024 }),
			transfer: JSON.stringify({
				transferId: newId(),
				location: { kind: "staging", path: "incoming", size: null, sha256: null },
			}),
		});
		await core.transferScheduler.acquire(id, node.id);
		expect(core.transferScheduler.holds(id)).toBe(true);
		const stale = failingLink(true);
		const fresh = failingLink(false, { taskId: id, state: "unknown", outputEnd: 0 });
		core.links.set(node.id, fresh.link);

		await sendTaskStart(core, stale.link, node.id, await startOf(id), new Uint8Array(0), {
			settle: (write) => write(),
		});

		// The confirmation runs in the background: the ending frees the slot after it wrote the row.
		await vi.waitFor(async () => {
			expect(await core.row(id)).toMatchObject({ state: "unknown", error_code: "dispatch_unconfirmed" });
			expect(core.transferScheduler.holds(id)).toBe(false);
		});
		expect(fresh.requests).toEqual(["task.query"]);
	});

	it("keeps the task running when the ready link reports it", async () => {
		const id = await seedTask("dispatched");
		const stale = failingLink(true);
		const fresh = failingLink(false, { taskId: id, state: "running", outputEnd: 0 });
		core.links.set(node.id, fresh.link);

		await sendTaskStart(core, stale.link, node.id, await startOf(id), new Uint8Array(0), {
			settle: (write) => write(),
		});

		await vi.waitFor(async () => {
			expect(await core.row(id)).toMatchObject({ state: "running", error_code: null });
		});
		expect(fresh.requests).toEqual(["task.query"]);
	});

	it("leaves the row dispatched while the reconnected link is not ready", async () => {
		const id = await seedTask("dispatched");
		const stale = failingLink(true);
		const fresh = failingLink(false, { taskId: id, state: "unknown", outputEnd: 0 });
		// The node reconnected, but its hello has not been handled yet: the new link cannot be queried.
		fresh.link.ready = false;
		core.links.set(node.id, fresh.link);

		await sendTaskStart(core, stale.link, node.id, await startOf(id), new Uint8Array(0), {
			settle: (write) => write(),
		});

		// The background confirmation waits for the link to become ready; nothing settles the row meanwhile.
		expect(await core.row(id)).toMatchObject({ state: "dispatched", error_code: null });
		expect(fresh.requests).toEqual([]);
		// Ending the waits makes waitNodeReady return undefined at once instead of waiting out the grace.
		core.endWaits();
		await core.drain();
		expect(await core.row(id)).toMatchObject({ state: "dispatched", error_code: null });
		expect(fresh.requests).toEqual([]);
	});

	it("leaves the row to the grace when the same link is still current", async () => {
		const id = await seedTask("dispatched");
		const stale = failingLink(true);
		core.links.set(node.id, stale.link);

		await sendTaskStart(core, stale.link, node.id, await startOf(id), new Uint8Array(0), {
			settle: (write) => write(),
		});

		expect(stale.requests).toEqual(["task.start"]);
		expect(await core.row(id)).toMatchObject({ state: "dispatched" });
	});

	it("keeps a task the reconnected node reports in its hello", async () => {
		const id = await seedTask("dispatched");
		const stale = failingLink(true);
		const fresh = failingLink(false);
		// The node reconnected, but its hello has not been handled yet: the new link is not ready.
		fresh.link.ready = false;
		core.links.set(node.id, fresh.link);

		await sendTaskStart(core, stale.link, node.id, await startOf(id), new Uint8Array(0), {
			settle: (write) => write(),
		});
		// The hello then lists the task: the node had accepted the start before the old connection broke.
		await core.taskQueue.run(id, () => onAccepted(core, node.id, id));

		expect(await core.row(id)).toMatchObject({ state: "running", error_code: null });
	});

	it("does not settle a row another path already ended", async () => {
		const id = await seedTask("cancelled", { error_message: "the task was cancelled before it was dispatched" });
		core.links.set(node.id, failingLink(false).link);
		const stale = failingLink(true);
		// The row was read as dispatched at the start point; the cancel landed before the failure.
		stale.requests.length = 0;
		await sendTaskStart(core, stale.link, node.id, await startOf(id), new Uint8Array(0), {
			settle: (write) => write(),
		});
		// The send point reads the row again first: a cancelled row is never sent at all.
		expect(stale.requests).toEqual([]);
		expect(await core.row(id)).toMatchObject({ state: "cancelled" });
	});
});
