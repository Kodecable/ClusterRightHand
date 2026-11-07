import { generateKeyPair } from "@crh/noise";
import { RemoteError, type TaskSpec } from "@crh/protocol";
import type { Insertable } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendAuthorizedStart } from "../src/cluster/authorization/authorized-start.ts";
import type { TaskAuthorizationRecord } from "../src/cluster/authorization.ts";
import type { NodeConnection } from "../src/cluster/connection.ts";
import { ClusterCore } from "../src/cluster/core.ts";
import type { NodeLink } from "../src/cluster/links.ts";
import { newLive } from "../src/cluster/live-output.ts";
import type { NodeRow } from "../src/cluster/nodes.ts";
import { runSsh } from "../src/cluster/ssh-runner.ts";
import { onAccepted } from "../src/cluster/task-end.ts";
import { sendTaskStart, taskStartOf } from "../src/cluster/task-start.ts";
import { cancelTask } from "../src/cluster/task-wait.ts";
import type { Db } from "../src/storage/db.ts";
import type { TaskState, TasksTable } from "../src/storage/schema.ts";
import { createUser, defaultOrgId } from "../src/users/service.ts";
import { newId } from "../src/util/id.ts";
import { waitFor } from "./helpers/agent.ts";
import { openTestDb } from "./helpers/db.ts";

// The SSH connection is never opened in this suite: the dispatch must stop on the task's row first.
const sshFake = vi.hoisted(() => ({
	calls: 0,
	connect: async (_route: unknown): Promise<unknown> => {
		throw new Error("no SSH connection expected");
	},
}));

vi.mock("../src/cluster/ssh/connection.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/cluster/ssh/connection.ts")>();
	return {
		...actual,
		connect: ((route: unknown) => {
			sshFake.calls++;
			return sshFake.connect(route);
		}) as typeof actual.connect,
	};
});

// The offline grace is what these tests wait out, so they are slower than a plain unit test.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const GRACE_MS = 300;
const CANCELLED_MESSAGE = "the task was cancelled before it was dispatched";
const SPEC: TaskSpec = { kind: "file.stat", path: "/tmp" };

/**
 * A task cancelled between its claim (`dispatched`) and its task.start (doc/execution-plane.md#任务取消):
 * the cancel is recorded on the row, the send point re-reads it, and a node that already received the
 * cancel refuses the late start. The dispatch paths are driven directly against a fake node link, so
 * the window is deterministic.
 */
describe("cancelling a task before its task.start", () => {
	let db: Db;
	let core: ClusterCore;
	let node: NodeRow;
	let userId = "";

	beforeEach(async () => {
		db = await openTestDb("sqlite");
		core = new ClusterCore(db, { nodeOfflineGraceMs: GRACE_MS, trustWaitMs: 20 });
		const user = await createUser(db, { username: "owner", kind: "admin", password: "password-123" });
		userId = user.id;
		const id = newId();
		const now = new Date().toISOString();
		await db
			.insertInto("nodes")
			.values({
				id,
				org_id: await defaultOrgId(db),
				name: "cancel-node",
				name_key: "cancel-node",
				transport: "client",
				status: "active",
				public_key: Buffer.from(generateKeyPair().publicKey).toString("base64"),
				hostname: "cancel-node",
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
				ssh_host_key: null,
				ssh_credential_id: null,
				ssh_jumps: null,
			})
			.execute();
		node = (await db.selectFrom("nodes").selectAll().where("id", "=", id).executeTakeFirstOrThrow()) as NodeRow;
	});

	afterEach(async () => {
		await db.destroy();
	});

	/** Inserts a task row as the dispatch path would leave it at the given state. */
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
			output_mode: "full",
			state,
			exit_code: null,
			signal: null,
			timed_out: 0,
			cancelled: 0,
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
			late_result: null,
			rule_chain: null,
			approval: null,
			pending_input: null,
			root_session_id: null,
			handler_type: null,
			handler_session_id: null,
			...overrides,
		};
		await db.insertInto("tasks").values(values).execute();
		return id;
	};

	const record = (): TaskAuthorizationRecord => ({
		plan: { paths: [] },
		tried: [],
		dispatchedPath: "crhs",
		payloadId: null,
		attempt: 1,
		trustDigest: null,
		pending: null,
		local: null,
		lastRejection: null,
		updatedAt: new Date().toISOString(),
	});

	/** A ready node link that records every request; `answer` drives task.start. */
	const fakeNode = (answer?: (name: string, body: unknown) => Promise<unknown>) => {
		const requests: { name: string; body: unknown }[] = [];
		const conn = {
			nodeId: node.id,
			closed: false,
			supportsForward: true,
			peer: {
				request: async (name: string, body: unknown): Promise<unknown> => {
					requests.push({ name, body });
					return answer ? answer(name, body) : {};
				},
			},
		} as unknown as NodeConnection;
		const link: NodeLink = {
			conn,
			active: true,
			ready: true,
			queried: new Set(),
			trustFresh: true,
			trustWaiters: new Set(),
		};
		return { link, requests };
	};

	const startOf = async (id: string) =>
		taskStartOf(id, await core.row(id), SPEC, { privileged: true, attempt: 1, authorizations: [] });

	it("cancels while the node is offline and never sends the start after it reconnects", async () => {
		const id = await seedTask("dispatched");
		const sending = sendAuthorizedStart(core, node.id, await startOf(id), new Uint8Array(0), record());
		// The task is claimed and the dispatch is now inside the offline grace.
		await waitFor("the dispatch to wait for the node", () => core.linkWaiters.has(node.id));
		expect(await cancelTask(core, id)).toBe(true);
		expect(await core.row(id)).toMatchObject({ state: "dispatched", cancelled: 1 });

		// The node comes back within the grace: the send point must not send the start.
		const fake = fakeNode();
		core.links.set(node.id, fake.link);
		core.notifyLink(node.id);
		await sending;
		expect(fake.requests.filter((request) => request.name === "task.start")).toHaveLength(0);
		expect(await core.row(id)).toMatchObject({
			state: "rejected",
			error_code: "cancelled",
			error_message: CANCELLED_MESSAGE,
			cancelled: 1,
		});
	});

	it("ends a cancelled task as cancelled when the grace runs out without a reconnect", async () => {
		const id = await seedTask("dispatched");
		const sending = sendAuthorizedStart(core, node.id, await startOf(id), new Uint8Array(0), record());
		await waitFor("the dispatch to wait for the node", () => core.linkWaiters.has(node.id));
		expect(await cancelTask(core, id)).toBe(true);
		// No node comes back: the task still ends as the cancellation, not as node_offline.
		await sending;
		expect(await core.row(id)).toMatchObject({
			state: "rejected",
			error_code: "cancelled",
			error_message: CANCELLED_MESSAGE,
			cancelled: 1,
		});
	});

	it("sends task.cancel for a claimed task whose node is connected", async () => {
		const id = await seedTask("dispatched");
		const fake = fakeNode();
		core.links.set(node.id, fake.link);
		expect(await cancelTask(core, id)).toBe(true);
		expect(fake.requests).toEqual([{ name: "task.cancel", body: { taskId: id } }]);
		expect(await core.row(id)).toMatchObject({ state: "dispatched", cancelled: 1 });
	});

	it("reads the cancelled flag right before the start and ends the task as cancelled", async () => {
		const id = await seedTask("dispatched", { cancelled: 1 });
		const fake = fakeNode();
		core.links.set(node.id, fake.link);
		await sendAuthorizedStart(core, node.id, await startOf(id), new Uint8Array(0), record());
		expect(fake.requests).toHaveLength(0);
		expect(await core.row(id)).toMatchObject({
			state: "rejected",
			error_code: "cancelled",
			error_message: CANCELLED_MESSAGE,
			cancelled: 1,
		});
	});

	it("does not send a start for a task that ended as unknown", async () => {
		const id = await seedTask("unknown", { error_code: "dispatch_unconfirmed" });
		const fake = fakeNode();
		core.links.set(node.id, fake.link);
		await sendAuthorizedStart(core, node.id, await startOf(id), new Uint8Array(0), record());
		expect(fake.requests).toHaveLength(0);
		expect(await core.row(id)).toMatchObject({ state: "unknown", error_code: "dispatch_unconfirmed" });
	});

	it("treats a node's cancelled refusal as a cancellation, not a failure", async () => {
		const id = await seedTask("dispatched");
		const fake = fakeNode(async (name) => {
			if (name === "task.start") throw new RemoteError("cancelled", "the task was cancelled before it started");
			return {};
		});
		await sendTaskStart(core, fake.link, node.id, await startOf(id), new Uint8Array(0), {
			settle: (write) => write(),
		});
		expect(fake.requests.map((request) => request.name)).toEqual(["task.start"]);
		expect(await core.row(id)).toMatchObject({
			state: "rejected",
			error_code: "cancelled",
			error_message: CANCELLED_MESSAGE,
			cancelled: 1,
		});
	});

	it("sends task.cancel when the start is accepted after the cancel was recorded", async () => {
		const id = await seedTask("dispatched", { cancelled: 1 });
		const fake = fakeNode();
		core.links.set(node.id, fake.link);
		await onAccepted(core, node.id, id);
		expect(fake.requests).toEqual([{ name: "task.cancel", body: { taskId: id } }]);
		expect(await core.row(id)).toMatchObject({ state: "running", cancelled: 1 });
	});

	it("does not open an SSH connection for a task cancelled before its run starts", async () => {
		const id = await seedTask("dispatched", { cancelled: 1 });
		const sshCore = new ClusterCore(db, {
			sshRoute: async () => ({ hops: [], privateKey: "test" }),
		});
		newLive(sshCore, id, node.id, "full", null);
		const before = sshFake.calls;
		await runSsh(sshCore, id, node, SPEC, undefined, undefined, false);
		expect(sshFake.calls).toBe(before);
		expect(await sshCore.row(id)).toMatchObject({ state: "exited", cancelled: 1 });
	});
});
