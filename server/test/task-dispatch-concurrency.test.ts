/**
 * The main dispatch chain no longer holds a task's queue across a wait (doc/design/execution.md "Task row concurrency"): the offline
 * grace, the authorized task.start answer and the approval dispatch all run outside the task's turn.
 * These tests drive the real chain against fake crha links and assert that another path on the same
 * task is not blocked meanwhile.
 */
import { generateKeyPair } from "@crh/noise";
import type { TaskSpec } from "@crh/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiToken } from "../src/auth/api-tokens.ts";
import { Cluster } from "../src/cluster/cluster.ts";
import type { ServerIdentity } from "../src/cluster/identity.ts";
import type { NodeRow } from "../src/cluster/nodes.ts";
import { trustDigest } from "../src/cluster/trust.ts";
import { bindMasterKey, MasterKey } from "../src/keys/master-key.ts";
import { type AuthorizationSigningKey, loadAuthorizationSigningKey } from "../src/privilege/key.ts";
import type { Db } from "../src/storage/db.ts";
import { defaultOrgId } from "../src/storage/org.ts";
import { createUser } from "../src/users/service.ts";
import { newId } from "../src/util/id.ts";
import { type FakeCrha, handshakeInit, TestAgentServer, waitFor } from "./helpers/agent.ts";
import { openTestDb } from "./helpers/db.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const GRACE_MS = 800;

const EXEC: TaskSpec = {
	kind: "exec",
	command: { argv: ["systemctl", "restart", "nginx"] },
	env: {},
	cwd: "",
	stdin: null,
};

const START = { tasks: [], taskKinds: [], privilegedMode: "" };

const IDENTITIES = {
	unprivileged: { uid: 998, gid: 998, user: "crha" },
	privileged: { uid: 0, gid: 0, user: "root" },
};

describe("main chain dispatch and the task queue", () => {
	let db: Db;
	let cluster: Cluster;
	let agents: TestAgentServer;
	let signing: AuthorizationSigningKey;
	let ownerId = "";

	beforeEach(async () => {
		db = await openTestDb("sqlite");
		const masterKey = MasterKey.generate();
		await bindMasterKey(db, masterKey);
		signing = await loadAuthorizationSigningKey(db, masterKey);
		cluster = new Cluster(db, { authorizationKey: signing, trustWaitMs: 100, nodeOfflineGraceMs: GRACE_MS });
		const identity: ServerIdentity = { keyPair: generateKeyPair(), fingerprint: "test-fingerprint" };
		agents = await TestAgentServer.start(db, identity, cluster);
		ownerId = (await createUser(db, { username: "owner", kind: "member", password: "password-123" })).id;
	});

	afterEach(async () => {
		await cluster.close();
		await agents.close();
		await db.destroy();
	});

	const actor = () => ({ type: "user" as const, id: ownerId, onBehalfOfUserId: ownerId });

	const addNode = async (name: string, publicKey: Uint8Array | null): Promise<NodeRow> => {
		const id = newId();
		const now = new Date().toISOString();
		await db
			.insertInto("nodes")
			.values({
				id,
				org_id: await defaultOrgId(db),
				name,
				name_key: name.toLowerCase(),
				transport: "client",
				status: "active",
				public_key: publicKey ? Buffer.from(publicKey).toString("base64") : null,
				hostname: name,
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
				grantee_id: ownerId,
				target_type: "node",
				target_id: id,
				created_by_user_id: ownerId,
				created_at: now,
			})
			.execute();
		return (await db.selectFrom("nodes").selectAll().where("id", "=", id).executeTakeFirstOrThrow()) as NodeRow;
	};

	const rowOf = async (id: string) => db.selectFrom("tasks").selectAll().where("id", "=", id).executeTakeFirst();

	const connect = async (
		name: string,
		options: { mode?: string; trust?: boolean } = {},
	): Promise<{ node: NodeRow; crha: FakeCrha }> => {
		const key = generateKeyPair();
		const node = await addNode(name, key.publicKey);
		const crha = await agents.connect(key, handshakeInit());
		expect(await crha.peer.request("hello", { ...START, privilegedMode: options.mode ?? "forward" })).toEqual({
			acks: [],
		});
		await waitFor("link ready", () => cluster.isConnected(node.id));
		if (options.trust !== false) {
			const summary = {
				nodeId: node.id,
				aliases: [],
				clockSkewMs: 0,
				identities: IDENTITIES,
				trust: [crhsEntry()],
			};
			crha.trust({ kind: "ok", summary });
			await waitFor("trust stored", async () => (await rowNode(node.id))?.trust_digest === trustDigest(summary));
		}
		return { node, crha };
	};

	const rowNode = (id: string) => db.selectFrom("nodes").select("trust_digest").where("id", "=", id).executeTakeFirst();

	/** crhs's own signing key trusted by the node to restart nginx: the plan takes the crhs path. */
	const crhsEntry = () => ({
		name: "crhs",
		source: "local" as const,
		role: "crhs" as const,
		key: { kind: "sshsig" as const, publicKey: signing.authorizedKey, fingerprint: signing.fingerprint },
		kinds: ["execute" as const, "cosign" as const],
		requireExact: true,
		requireTask: false,
		requireUv: false,
		maxTtlMs: 5 * 60 * 1000,
		allow: [{ method: "exec" as const, match: "prefix" as const, pattern: "systemctl restart " }],
		deny: [],
		envAllow: [],
	});

	it("ends a task cancelled during the offline grace as cancelled, without a task.start", async () => {
		const key = generateKeyPair();
		const node = await addNode("cancel-during-grace", key.publicKey);
		const id = newId();
		const created = cluster.createTask({ nodeId: node.id, spec: EXEC, actor: actor(), id });
		// The row is written before dispatch starts waiting for the node.
		await waitFor("the task waits for its node", async () => (await rowOf(id))?.state === "awaiting_approval");

		const started = Date.now();
		expect(await cluster.cancelTask(id)).toBe(true);
		const cancelMs = Date.now() - started;
		// The cancel ends the task right away: it does not wait out the grace the dispatch is in.
		expect(cancelMs).toBeLessThan(GRACE_MS / 2);
		expect(await rowOf(id)).toMatchObject({ state: "rejected", error_code: "cancelled" });

		// The node reconnects within the grace: the dispatch must re-read the row and send nothing.
		const crha = await agents.connect(key, handshakeInit());
		expect(await crha.peer.request("hello", START)).toEqual({ acks: [] });
		await waitFor("link ready", () => cluster.isConnected(node.id));

		const view = await created;
		expect(view).toMatchObject({ state: "rejected", errorCode: "cancelled" });
		expect(crha.starts).toHaveLength(0);
	});

	it("handles task.exit while the authorized task.start is still in flight", async () => {
		const { node, crha } = await connect("forward-busy");
		let releaseStart!: () => void;
		const startGate = new Promise<void>((resolve) => {
			releaseStart = resolve;
		});
		crha.answerStart = async () => {
			await startGate;
		};
		const id = newId();
		const created = cluster.createTask({ nodeId: node.id, spec: EXEC, privileged: true, actor: actor(), id });
		await waitFor("task.start on the wire", () => crha.starts.length === 1);
		await waitFor("task claimed", async () => (await rowOf(id))?.state === "dispatched");

		// The send waits for the node's answer. Another turn on the same task, the node's task.exit, must
		// not wait for it: the authorized send no longer holds the task's queue.
		const started = Date.now();
		crha.exit(id, { kind: "code", value: 0 });
		await waitFor("task.exit handled", async () => (await rowOf(id))?.state === "exited");
		// It must run while the send is still blocked: far below the time the gate could ever take.
		expect(Date.now() - started).toBeLessThan(2_000);

		// The late acceptance settles in the queue after the exit and must not overwrite it.
		releaseStart();
		const view = await created;
		expect(view.state).toBe("exited");
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect((await rowOf(id))?.state).toBe("exited");
	});

	it("returns node_offline after the grace when a task on an offline node is approved", async () => {
		const id = await createWaitingTask("approve-offline");
		const started = Date.now();
		expect(await approve(id)).toBe("approved");
		const decideMs = Date.now() - started;
		// The approval waited out the grace for the node instead of failing or returning at once.
		expect(decideMs).toBeGreaterThanOrEqual(GRACE_MS - 100);
		expect(await rowOf(id)).toMatchObject({ state: "failed", error_code: "node_offline" });
	});

	it("refuses a second decide without waiting for the dispatch grace", async () => {
		const id = await createWaitingTask("approve-busy");
		const approving = approve(id);
		// The decision is recorded in its turn and clears the handler; the dispatch now waits out the grace.
		await waitFor("the decision recorded", async () => {
			const row = await rowOf(id);
			return row?.handler_type === null && JSON.parse(row.approval ?? "{}").decision?.decision === "approved";
		});
		// A second decide is a turn on the same task: the row no longer waits for anyone, so it is refused
		// at once instead of blocking on the first dispatch's grace — or overwriting an approved task.
		const started = Date.now();
		expect(
			await cluster.decide(id, {
				decision: "rejected",
				by: { type: "user", id: ownerId, onBehalfOfUserId: ownerId },
				at: new Date().toISOString(),
				reason: "changed my mind",
			}),
		).toBe(false);
		expect(Date.now() - started).toBeLessThan(GRACE_MS / 2);
		// The first decide still settles the decision it recorded, after its grace finds the node offline.
		expect(await approving).toBe("approved");
		expect(await rowOf(id)).toMatchObject({
			state: "failed",
			error_code: "node_offline",
		});
		const approval = JSON.parse((await rowOf(id))?.approval ?? "{}");
		expect(approval.decision).toMatchObject({ decision: "approved" });
	});

	/** Creates a task that waits for approval while its node is offline. */
	const createWaitingTask = async (name: string): Promise<string> => {
		const node = await addNode(name, null);
		const user = { sessionId: "s", userId: ownerId, username: "owner", kind: "member" as const };
		const { view: token } = await createApiToken(db, user, { name: "ask", rulePreset: "ask" });
		const id = newId();
		const created = await cluster.createTask({
			nodeId: node.id,
			spec: EXEC,
			chain: [{ type: "api_token", id: token.id }],
			actor: { type: "api_token", id: token.id, onBehalfOfUserId: ownerId },
			id,
		});
		expect(created.state).toBe("awaiting_approval");
		return id;
	};

	const approve = (id: string) =>
		cluster.decide(id, {
			decision: "approved",
			by: { type: "user", id: ownerId, onBehalfOfUserId: ownerId },
			at: new Date().toISOString(),
		});
});
