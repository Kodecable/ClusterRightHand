import { generateKeyPair } from "@crh/noise";
import { type TaskSpec, taskSpecToJson } from "@crh/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionUser } from "../src/auth/sessions.ts";
import { Cluster } from "../src/cluster/cluster.ts";
import type { ServerIdentity } from "../src/cluster/identity.ts";
import { TaskGroups } from "../src/cluster/task-groups.ts";
import type { Db } from "../src/storage/db.ts";
import { TOOLS, type ToolContext } from "../src/tools/catalog.ts";
import { createUser, defaultOrgId } from "../src/users/service.ts";
import { newId } from "../src/util/id.ts";
import { type FakeCrha, handshakeInit, TestAgentServer, waitFor } from "./helpers/agent.ts";
import { openTestDb } from "./helpers/db.ts";

/** setTimeout cannot wait longer than ~24.8 days, so long waits loop (task-groups.ts, catalog.ts). */
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

/** Whether `promise` settled within `ms`; a race with endWaits must be able to prove it did not. */
function settledWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
	let timer: NodeJS.Timeout | undefined;
	return Promise.race([
		promise.then(() => true),
		new Promise<boolean>((resolve) => {
			timer = setTimeout(() => resolve(false), ms);
		}),
	]).finally(() => clearTimeout(timer));
}

// Shutdown ends long waits before it drains, so a request inside one returns its current state instead of
// holding the shutdown for its timeout (main.ts).
describe("ending waits at shutdown", () => {
	let db: Db;
	let cluster: Cluster;
	let groups: TaskGroups;
	let agents: TestAgentServer;
	let fake: FakeCrha;
	let nodeId: string;
	let userId: string;
	const spec: TaskSpec = { kind: "exec", command: { argv: ["sleep", "60"] }, env: {}, cwd: "", stdin: null };
	const actor = () => ({ type: "user" as const, id: userId, onBehalfOfUserId: userId });

	beforeEach(async () => {
		db = await openTestDb("sqlite");
		userId = (await createUser(db, { username: "owner", kind: "member", password: "password-123" })).id;
		const key = generateKeyPair();
		nodeId = newId();
		const now = new Date().toISOString();
		await db
			.insertInto("nodes")
			.values({
				id: nodeId,
				org_id: await defaultOrgId(db),
				name: "wait-node",
				name_key: "wait-node",
				transport: "client",
				status: "active",
				public_key: Buffer.from(key.publicKey).toString("base64"),
				hostname: "wait-node",
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
				trust_report: null,
				trust_digest: null,
				trust_updated_at: null,
			})
			.execute();
		await db
			.insertInto("node_access_grants")
			.values({
				id: newId(),
				org_id: await defaultOrgId(db),
				grantee_type: "user",
				grantee_id: userId,
				target_type: "node",
				target_id: nodeId,
				created_by_user_id: userId,
				created_at: now,
			})
			.execute();
		cluster = new Cluster(db, { reconnectGraceMs: 600_000 });
		groups = new TaskGroups(db, cluster);
		const identity: ServerIdentity = { keyPair: generateKeyPair(), fingerprint: "test-fingerprint" };
		agents = await TestAgentServer.start(db, identity, cluster);
		fake = await agents.connect(key, handshakeInit());
		expect(await fake.peer.request("hello", { tasks: [], taskKinds: [], privilegedMode: "" })).toEqual({ acks: [] });
		await waitFor("node connected", () => cluster.isConnected(nodeId));
	});

	afterEach(async () => {
		cluster.endWaits();
		groups.endWaits();
		await cluster.close();
		await groups.close();
		await agents.close();
		await db.destroy();
	});

	/** A group row waiting for its approval, as groups.create leaves one. */
	async function addWaitingGroup(id: string): Promise<void> {
		await db
			.insertInto("task_groups")
			.values({
				id,
				org_id: await defaultOrgId(db),
				targets: "[]",
				node_ids: JSON.stringify([nodeId]),
				kind: "exec",
				parallel: 1,
				fail_fast: 0,
				output_mode: "status",
				privileged: 0,
				skipped: "[]",
				state: "awaiting_approval",
				actor_type: "user",
				actor_id: userId,
				on_behalf_of_user_id: userId,
				created_at: new Date().toISOString(),
				finished_at: null,
				spec: JSON.stringify(taskSpecToJson(spec)),
				timeout_ms: null,
				rule_chain: null,
				approval: null,
				pending_input: null,
				root_session_id: null,
				handler_type: "user",
				handler_session_id: null,
			})
			.execute();
	}

	it("returns a task's current view when its long wait is ended", async () => {
		const created = await cluster.createTask({ nodeId, spec, actor: actor() });
		await waitFor("task running", async () => (await cluster.getTask(created.id))?.state === "running");
		expect(fake.starts).toHaveLength(1);

		const waiting = cluster.waitTask(created.id, HOUR);
		expect(await settledWithin(waiting, 50)).toBe(false);

		cluster.endWaits();
		const view = await withTimeout(waiting, 1_000, "the task wait after endWaits");
		expect(view).toMatchObject({ id: created.id, state: "running" });
		// A wait started after the end returns at once too.
		const later = await withTimeout(cluster.waitTask(created.id, HOUR), 1_000, "a new task wait");
		expect(later).toMatchObject({ id: created.id, state: "running" });
	});

	it("returns a group's current view when it is waiting for approval", async () => {
		const id = newId();
		await addWaitingGroup(id);

		const waiting = groups.wait(id, HOUR);
		expect(await settledWithin(waiting, 50)).toBe(false);

		groups.endWaits();
		const view = await withTimeout(waiting, 1_000, "the group wait after endWaits");
		expect(view).toMatchObject({ id, state: "awaiting_approval", tasks: [] });
		expect((await withTimeout(groups.wait(id, HOUR), 1_000, "a new group wait"))?.state).toBe("awaiting_approval");
	});

	it("returns a running group's current view when its wait is ended", async () => {
		const id = await groups.create({ targets: ["wait-node"], nodeIds: [nodeId], spec, actor: actor() });
		await waitFor("the group's task running", async () => {
			const group = await groups.get(id);
			return group?.state === "running" && group.tasks.some((t) => t.state === "running");
		});

		const waiting = groups.wait(id, HOUR);
		expect(await settledWithin(waiting, 50)).toBe(false);

		groups.endWaits();
		const view = await withTimeout(waiting, 1_000, "the group wait after endWaits");
		expect(view?.state).toBe("running");
		expect(view?.tasks.map((t) => t.state)).toEqual(["running"]);
		expect(fake.starts).toHaveLength(1);
	});

	it("returns the current state from a task_wait tool call that waits through approval", async () => {
		const id = newId();
		await addWaitingGroup(id);
		const statuses: Record<string, unknown>[] = [];
		const user: SessionUser = { sessionId: "s", userId, username: "owner", kind: "member" };
		const ctx = {
			db,
			cluster,
			taskGroups: groups,
			user,
			actor: actor(),
			chain: [],
			approvalUrl: (kind: string, groupId: string) => `/approvals/${kind}/${groupId}`,
			taskGroupUrl: (groupId: string) => `/task-groups/${groupId}`,
			waitThroughApproval: true,
			defaultWaitS: 1,
			onStatus: async (status: Record<string, unknown>) => {
				statuses.push(status);
			},
		} as unknown as ToolContext;
		const tool = TOOLS.find((t) => t.name === "task_wait");
		if (!tool) throw new Error("task_wait tool missing");

		// waitTaskGroupFor loops on groups.wait(id, HOUR); only ending the waits makes it return the waiting state.
		const call = tool.handler({ task_group_id: id, wait: 1 }, ctx);
		expect(await settledWithin(call, 100)).toBe(false);
		groups.endWaits();
		const result = await withTimeout(call, 2_000, "the task_wait tool call");
		const value = JSON.parse(result.content[0]?.text ?? "") as Record<string, unknown>;
		expect(value).toMatchObject({ task_group_id: id, state: "awaiting_approval" });
		expect(statuses[0]).toMatchObject({ task_group_id: id, state: "awaiting_approval" });
	});
});
