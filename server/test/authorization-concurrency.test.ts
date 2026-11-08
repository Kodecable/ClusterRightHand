/**
 * The local-approval and stored-authorization paths against a task's queue (D118, step 2b): no path
 * holds the task's turn across a wait for the node or across a request that waits for its answer.
 * These tests drive the real paths against fake crha links and assert that a concurrent path on the
 * same task is not blocked meanwhile, that a cancel during the offline grace wins, and that at most one
 * task.start comes out of a race between a stored authorization and a trust re-plan.
 */
import { generateKeyPair } from "@crh/noise";
import { RemoteError, type Signature, type TaskSpec, type TrustEntry, type TrustSummary } from "@crh/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseTaskAuthorization } from "../src/cluster/authorization.ts";
import { Cluster } from "../src/cluster/cluster.ts";
import { ClusterCore } from "../src/cluster/core.ts";
import type { ServerIdentity } from "../src/cluster/identity.ts";
import type { NodeRow } from "../src/cluster/nodes.ts";
import { trustDigest } from "../src/cluster/trust.ts";
import { bindMasterKey, MasterKey } from "../src/keys/master-key.ts";
import { type AuthorizationSigningKey, loadAuthorizationSigningKey } from "../src/privilege/key.ts";
import { buildAuthorization, specSha256 } from "../src/privilege/payload.ts";
import { signSshsig } from "../src/privilege/sshsig.ts";
import { signaturesToJson } from "../src/privilege/submission.ts";
import type { Db } from "../src/storage/db.ts";
import { createUser, defaultOrgId } from "../src/users/service.ts";
import { newId } from "../src/util/id.ts";
import { type FakeCrha, handshakeInit, TestAgentServer, waitFor } from "./helpers/agent.ts";
import { type App, call, login, makeApp } from "./helpers/api.ts";
import { createSshKey, type TestSshKey } from "./helpers/authenticator.ts";
import { openTestDb } from "./helpers/db.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/** The offline grace of the tests: short enough to run out, long enough to cancel well inside it. */
const GRACE_MS = 600;

const EXEC: TaskSpec = {
	kind: "exec",
	command: { argv: ["systemctl", "restart", "nginx"] },
	env: {},
	cwd: "",
	stdin: null,
};

const START = { tasks: [], taskKinds: [] };

const IDENTITIES = {
	unprivileged: { uid: 998, gid: 998, user: "crha" },
	privileged: { uid: 0, gid: 0, user: "root" },
};

const HOUR = 3_600_000;

describe("authorization paths and the task queue (D118)", () => {
	let db: Db;
	let cluster: Cluster;
	let agents: TestAgentServer;
	let signing: AuthorizationSigningKey;
	let app: App;
	let ownerId = "";
	let ownerKey: TestSshKey;

	beforeEach(async () => {
		db = await openTestDb("sqlite");
		const masterKey = MasterKey.generate();
		await bindMasterKey(db, masterKey);
		signing = await loadAuthorizationSigningKey(db, masterKey);
		cluster = new Cluster(db, { authorizationKey: signing, trustWaitMs: 100, nodeOfflineGraceMs: GRACE_MS });
		const identity: ServerIdentity = { keyPair: generateKeyPair(), fingerprint: "test-fingerprint" };
		agents = await TestAgentServer.start(db, identity, cluster);
		ownerId = (await createUser(db, { username: "owner", kind: "member", password: "password-123" })).id;
		app = makeApp(db, undefined, { cluster });
		ownerKey = createSshKey("ssh-ed25519");
		await addSshCredential(ownerKey);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await cluster.close();
		await agents.close();
		await db.destroy();
	});

	async function addSshCredential(key: TestSshKey): Promise<void> {
		const cookie = await login(app, "owner", "password-123");
		const res = await call(app, "/api/me/credentials/ssh", {
			cookie,
			body: { publicKey: key.line, name: "test" },
		});
		expect(res.status).toBe(201);
	}

	const actor = () => ({ type: "user" as const, id: ownerId, onBehalfOfUserId: ownerId });

	const addNode = async (name: string, publicKey: Uint8Array): Promise<NodeRow> => {
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
				public_key: Buffer.from(publicKey).toString("base64"),
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
				ssh_host_key: null,
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

	const rowOf = (id: string) => db.selectFrom("tasks").selectAll().where("id", "=", id).executeTakeFirst();

	const rowNode = (id: string) => db.selectFrom("nodes").select("trust_digest").where("id", "=", id).executeTakeFirst();

	/** Connects a fake crha that reports `forward` and pushes `summary`. */
	const connect = async (
		name: string,
		summary: (nodeId: string) => TrustSummary,
	): Promise<{ node: NodeRow; crha: FakeCrha; key: ReturnType<typeof generateKeyPair> }> => {
		const key = generateKeyPair();
		const node = await addNode(name, key.publicKey);
		const crha = await agents.connect(key, handshakeInit());
		expect(await crha.peer.request("hello", { ...START, privilegedMode: "forward" })).toEqual({ acks: [] });
		await waitFor("link ready", () => cluster.isConnected(node.id));
		const report = summary(node.id);
		crha.trust({ kind: "ok", summary: report });
		await waitFor("trust stored", async () => (await rowNode(node.id))?.trust_digest === trustDigest(report));
		return { node, crha, key };
	};

	const summaryOf = (nodeId: string, trust: TrustEntry[]): TrustSummary => ({
		nodeId,
		aliases: [],
		clockSkewMs: 60_000,
		identities: IDENTITIES,
		trust,
	});

	const sshEntry = (name: string, role: TrustEntry["role"], overrides: Partial<TrustEntry> = {}): TrustEntry => ({
		name,
		source: "local",
		role,
		key: { kind: "sshsig", publicKey: `ssh-ed25519 AAAA${name}`, fingerprint: `SHA256:${name}` },
		kinds: ["execute"],
		requireExact: false,
		requireTask: false,
		requireUv: false,
		maxTtlMs: null,
		allow: [],
		deny: [],
		envAllow: [],
		...overrides,
	});

	/** A user trust entry for the owner's SSH key, allowed to restart nginx. */
	const ownerEntry = (): TrustEntry =>
		sshEntry("alice", "user", {
			key: { kind: "sshsig", publicKey: ownerKey.line, fingerprint: ownerKey.fingerprint },
			maxTtlMs: 24 * HOUR,
			allow: [{ method: "exec", match: "prefix", pattern: "systemctl restart " }],
		});

	/** crhs's own key, allowed to restart nginx: the plan can take the crhs path. */
	const crhsEntry = (): TrustEntry =>
		sshEntry("crhs", "crhs", {
			key: { kind: "sshsig", publicKey: signing.authorizedKey, fingerprint: signing.fingerprint },
			kinds: ["execute", "cosign"],
			requireExact: true,
			maxTtlMs: 5 * 60 * 1000,
			allow: [{ method: "exec", match: "prefix", pattern: "systemctl restart " }],
		});

	/** A local trust entry: the node can approve the task on the spot. */
	const localEntry = (): TrustEntry => sshEntry("local-admins", "local", { key: { kind: "local", uids: [0] } });

	const createPrivileged = (nodeId: string) =>
		cluster.createTask({ nodeId, spec: EXEC, privileged: true, actor: actor() });

	/**
	 * Stores an owner authorization for the task the way POST /api/authorizations stores it before
	 * dispatching (the sweep after a trust report finds it and uses it).
	 */
	const storeOwnerAuthorization = async (node: NodeRow, taskId: string): Promise<void> => {
		const deadlineMs = Date.now() + HOUR;
		const built = buildAuthorization({
			nodes: [node.id],
			command: { method: "exec", exact: { target: "systemctl restart nginx", specSha256: specSha256(EXEC) } },
			issuedAtMs: Date.now(),
			deadlineMs,
			taskIds: [taskId],
			attempt: 1,
		});
		const signature: Signature = { kind: "sshsig", blob: signSshsig(ownerKey.privateKey, ownerKey.blob, built.bytes) };
		await db
			.insertInto("authorizations")
			.values({
				id: built.id,
				org_id: await defaultOrgId(db),
				payload: Buffer.from(built.bytes).toString("base64"),
				signatures: signaturesToJson([signature]),
				issuer_user_id: ownerId,
				task_ids: JSON.stringify([taskId]),
				deadline: new Date(deadlineMs).toISOString(),
				created_at: new Date().toISOString(),
			})
			.execute();
	};

	it("does not hold the queue for a local approval waiting out the offline grace; a cancel wins", async () => {
		const { node, crha, key } = await connect("local-offline", (id) => summaryOf(id, [localEntry()]));
		const task = await createPrivileged(node.id);
		await waitFor("local.request", () => crha.localRequests.length === 1);
		await waitFor("waiting for a signature", async () => (await rowOf(task.id))?.state === "awaiting_authorization");

		// Hold the dispatch right where it waits for its node: the approval has been decided, the grace
		// for the node has not run yet. The wait must not hold the task's queue (D118).
		const original = ClusterCore.prototype.readyNode;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let waiting = false;
		const spy = vi.spyOn(ClusterCore.prototype, "readyNode").mockImplementation(async function (
			this: ClusterCore,
			nodeId: string,
			options?: { trust?: boolean },
		) {
			if (nodeId === node.id) {
				waiting = true;
				await gate;
			}
			return original.call(this, nodeId, options);
		});
		try {
			crha.peer.emit("local.decision", { taskId: task.id, attempt: 1, state: { kind: "approved" } });
			await waitFor("the local dispatch waiting for its node", () => waiting);

			// The cancel arrives while that wait is in flight: it is not parked behind the task's queue and
			// settles the row at once.
			const started = Date.now();
			expect(await cluster.cancelTask(task.id)).toBe(true);
			expect(Date.now() - started).toBeLessThan(GRACE_MS / 2);
			expect(await rowOf(task.id)).toMatchObject({ state: "rejected", error_code: "cancelled" });

			// The node goes away before the dispatch can send; the grace then finds the row cancelled.
			crha.ws.close();
			await waitFor("the node detached", () => !cluster.isConnected(node.id));
			release();
			// Let the grace run out: the offline turn re-reads the row and must leave it cancelled.
			await new Promise((resolve) => setTimeout(resolve, GRACE_MS + 200));
		} finally {
			spy.mockRestore();
		}

		// A node that comes back afterwards gets no task.start for the cancelled task.
		const again = await agents.connect(key, handshakeInit());
		expect(await again.peer.request("hello", { ...START, privilegedMode: "forward" })).toEqual({ acks: [] });
		again.trust({ kind: "ok", summary: summaryOf(node.id, [localEntry()]) });
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(again.starts).toHaveLength(0);
		expect(await rowOf(task.id)).toMatchObject({ state: "rejected", error_code: "cancelled", cancelled: 1 });
	});

	it("ends a locally approved task whose node stays offline through the grace", async () => {
		const { node, crha } = await connect("local-offline-fail", (id) => summaryOf(id, [localEntry()]));
		const task = await createPrivileged(node.id);
		await waitFor("local.request", () => crha.localRequests.length === 1);

		const original = ClusterCore.prototype.readyNode;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let waiting = false;
		const spy = vi.spyOn(ClusterCore.prototype, "readyNode").mockImplementation(async function (
			this: ClusterCore,
			nodeId: string,
			options?: { trust?: boolean },
		) {
			if (nodeId === node.id) {
				waiting = true;
				await gate;
			}
			return original.call(this, nodeId, options);
		});
		try {
			crha.peer.emit("local.decision", { taskId: task.id, attempt: 1, state: { kind: "approved" } });
			await waitFor("the local dispatch waiting for its node", () => waiting);
			// The node is away for the whole grace: the approval must not leave the task waiting forever.
			crha.ws.close();
			await waitFor("the node detached", () => !cluster.isConnected(node.id));
			release();
			await waitFor("the task failed node_offline", async () => {
				const row = await rowOf(task.id);
				return row?.state === "failed" && row.error_code === "node_offline" ? row : undefined;
			});
		} finally {
			spy.mockRestore();
			release();
		}
		expect(crha.starts).toHaveLength(0);
	});

	it("lets a trust re-plan dispatch a stored-authorization task while the sweep still waits for the node", async () => {
		const { node, crha } = await connect("stored-wait", (id) => summaryOf(id, [ownerEntry()]));
		const task = await createPrivileged(node.id);
		await waitFor("the task waits for a signature", async () => {
			const row = await rowOf(task.id);
			return row?.state === "awaiting_authorization" ? row : undefined;
		});
		await storeOwnerAuthorization(node, task.id);

		// The sweep after the next trust report waits for the node (the offline grace's shape), held open
		// here instead of actually waiting it out. The task's queue must stay free meanwhile (D118).
		const original = ClusterCore.prototype.waitNodeReady;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let gated = false;
		let waiting = false;
		const spy = vi.spyOn(ClusterCore.prototype, "waitNodeReady").mockImplementation(async function (
			this: ClusterCore,
			nodeId: string,
			options?: { trust?: boolean },
		) {
			if (nodeId === node.id && !gated) {
				gated = true;
				waiting = true;
				await gate;
			}
			return original.call(this, nodeId, options);
		});
		try {
			// The same report starts the sweep of the stored authorization: its wait for this node is in flight.
			crha.trust({ kind: "ok", summary: summaryOf(node.id, [ownerEntry()]) });
			await waitFor("the stored-authorization sweep waiting for its node", () => waiting);

			// A second report changes the trust: the plan takes crhs's own path now. Its turn on the same
			// task must not wait for the sweep's wait, and it claims and sends while the sweep is held.
			crha.trust({ kind: "ok", summary: summaryOf(node.id, [crhsEntry()]) });
			await waitFor("the re-plan's task.start while the sweep waits", () => crha.starts.length === 1);
			expect(crha.starts[0]).toMatchObject({ taskId: task.id, attempt: 1, privileged: true });
			expect(crha.starts[0]?.authorizations).toHaveLength(1);
			const running = await waitFor("the re-plan's task running", async () => {
				const row = await rowOf(task.id);
				return row?.state === "running" ? row : undefined;
			});
			expect(running.attempt).toBe(1);
			expect(parseTaskAuthorization(running.authorization)).toMatchObject({ dispatchedPath: "crhs", attempt: 1 });

			// The released sweep re-reads the row, finds it moved on, and sends nothing else.
			release();
			await new Promise((resolve) => setTimeout(resolve, 150));
			expect(crha.starts).toHaveLength(1);
			const final = await rowOf(task.id);
			expect(final?.state).toBe("running");
			expect(final?.attempt).toBe(1);
		} finally {
			spy.mockRestore();
			release();
		}
	});

	it("retries a locally approved task.start the node rejected for its authorization", async () => {
		const { node, crha } = await connect("local-retry", (id) => summaryOf(id, [localEntry()]));
		let rejectFirst = true;
		crha.answerStart = () => {
			if (!rejectFirst) return;
			rejectFirst = false;
			throw new RemoteError("authorization_rejected", "step 7: deny rule matched");
		};
		const task = await createPrivileged(node.id);
		await waitFor("local.request", () => crha.localRequests.length === 1);
		expect(crha.localRequests[0]).toMatchObject({ taskId: task.id, attempt: 1 });

		crha.peer.emit("local.decision", { taskId: task.id, attempt: 1, state: { kind: "approved" } });
		// The rejected task.start goes through retryAuthorization: the task moves to attempt + 1 and the
		// plan asks for local approval again, none of it inside a task queue turn (D118).
		await waitFor("local.request for the retry", () => crha.localRequests.length === 2);
		expect(crha.localRequests[1]).toMatchObject({ taskId: task.id, attempt: 2 });
		expect(await rowOf(task.id)).toMatchObject({ state: "awaiting_authorization", attempt: 2 });

		crha.peer.emit("local.decision", { taskId: task.id, attempt: 2, state: { kind: "approved" } });
		await waitFor("task.start after the retried approval", () => crha.starts.length === 2);
		expect(crha.starts.map((start) => start.attempt)).toEqual([1, 2]);
		expect(crha.starts[1]).toMatchObject({ taskId: task.id, attempt: 2, authorizations: [], privileged: true });
		const running = await waitFor("the retried task running", async () => {
			const row = await rowOf(task.id);
			return row?.state === "running" ? row : undefined;
		});
		expect(running.attempt).toBe(2);
		expect(parseTaskAuthorization(running.authorization)).toMatchObject({ dispatchedPath: "local", attempt: 2 });
	});
});
