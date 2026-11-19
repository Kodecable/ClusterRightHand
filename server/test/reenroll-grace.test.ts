/**
 * A re-enrolled node reconnects as pending: its new link cannot report the tasks of its previous
 * identity, so the reconnect grace must stay armed for them instead of being cleared by attach
 * (cluster/links.ts, doc/design/execution.md "Reconnect").
 */
import { generateKeyPair } from "@crh/noise";
import type { TaskSpec } from "@crh/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Cluster } from "../src/cluster/cluster.ts";
import type { ServerIdentity } from "../src/cluster/identity.ts";
import type { NodeRow } from "../src/cluster/nodes.ts";
import type { Db } from "../src/storage/db.ts";
import { defaultOrgId } from "../src/storage/org.ts";
import { createUser } from "../src/users/service.ts";
import { newId } from "../src/util/id.ts";
import { type FakeCrha, handshakeInit, TestAgentServer, waitFor } from "./helpers/agent.ts";
import { openTestDb } from "./helpers/db.ts";

// The grace is what the test waits out; keep it short but long enough for a reconnect handshake.
const GRACE_MS = 1_000;
const HELLO = { tasks: [], taskKinds: [], privilegedMode: "" };
const EXEC: TaskSpec = { kind: "exec", command: { argv: ["sleep", "60"] }, env: {}, cwd: "", stdin: null };

describe("the reconnect grace of a re-enrolled node", () => {
	let db: Db;
	let cluster: Cluster;
	let agents: TestAgentServer;
	let ownerUserId = "";
	let node: NodeRow;
	let oldKey: ReturnType<typeof generateKeyPair>;
	let old: FakeCrha;

	beforeEach(async () => {
		db = await openTestDb("sqlite");
		cluster = new Cluster(db, { reconnectGraceMs: GRACE_MS });
		const identity: ServerIdentity = { keyPair: generateKeyPair(), fingerprint: "test-fingerprint" };
		agents = await TestAgentServer.start(db, identity, cluster);
		ownerUserId = (await createUser(db, { username: "owner", kind: "member", password: "password-123" })).id;
		oldKey = generateKeyPair();
		const id = newId();
		const now = new Date().toISOString();
		await db
			.insertInto("nodes")
			.values({
				id,
				org_id: await defaultOrgId(db),
				name: "reenrolled-node",
				name_key: "reenrolled-node",
				transport: "client",
				status: "active",
				public_key: Buffer.from(oldKey.publicKey).toString("base64"),
				hostname: "reenrolled-node",
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
		await db
			.insertInto("node_access_grants")
			.values({
				id: newId(),
				org_id: await defaultOrgId(db),
				grantee_type: "user",
				grantee_id: ownerUserId,
				target_type: "node",
				target_id: id,
				created_by_user_id: ownerUserId,
				created_at: now,
			})
			.execute();
		node = await db.selectFrom("nodes").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
		old = await agents.connect(oldKey, handshakeInit());
		expect(await old.peer.request("hello", HELLO)).toEqual({ acks: [] });
		await waitFor("link ready", () => cluster.isConnected(node.id));
	});

	afterEach(async () => {
		await cluster.close();
		await agents.close();
		await db.destroy();
	});

	it("expires a task running on the previous identity when the node returns as pending", async () => {
		const task = await cluster.createTask({
			nodeId: node.id,
			spec: EXEC,
			actor: { type: "user", id: ownerUserId, onBehalfOfUserId: ownerUserId },
		});
		await waitFor("the task to run", async () => (await cluster.getTask(task.id))?.state === "running");

		// Re-enrollment: the row takes the new key and waits for approval; the old connection goes away.
		const newKey = generateKeyPair();
		await db
			.updateTable("nodes")
			.set({
				public_key: Buffer.from(newKey.publicKey).toString("base64"),
				status: "pending",
				approved_at: null,
				approved_by_user_id: null,
			})
			.where("id", "=", node.id)
			.execute();
		old.ws.close();
		await waitFor("the old link to go", () => !cluster.isConnected(node.id));

		// The new connection is pending: it gets no task list and never reports the old task.
		const fresh = await agents.connect(newKey, handshakeInit());
		expect(fresh.response).toMatchObject({ nodeId: node.id, nodeState: "pending" });

		// The grace still covers the running task: the pending link is not the node coming back.
		const view = await waitFor(
			"the running task to expire",
			async () => {
				const current = await cluster.getTask(task.id);
				return current?.state === "unknown" ? current : undefined;
			},
			GRACE_MS * 4,
		);
		expect(view).toMatchObject({ state: "unknown", errorCode: "connection_lost" });
	});
});
