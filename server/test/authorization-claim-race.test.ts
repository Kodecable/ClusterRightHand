/**
 * Regression test for the stale-row claim of `submitAuthorization` that used to regress a task's attempt:
 * the claim judged the row read at decision time, so a `refreshGroupPending` in between could roll the
 * attempt back. The race is now prevented by the row version: the claim
 * re-reads the row in its own queue turn, so it judges the refreshed attempt, and its write is guarded by
 * that row's `rev`.
 *
 * The interleaving this test opens:
 *
 * 1. The owner submits a one-shot authorization for task A of a group. A is claimed and its `task.start`
 *    is sent; the fake node withholds the answer.
 * 2. A reusable authorization for task B (same group, other node) is submitted. Its dispatch now runs in
 *    the background: `submitAuthorization` stores the row and returns, then `judgeSubmitted`
 *    reads B's row (attempt 1) and waits for B's node — held open here by a `waitNodeReady` stub, the
 *    same window the real offline grace creates.
 * 3. The withheld answer becomes an authorization rejection. `retryAuthorization` moves A to
 *    `attempt + 1` and re-plans it; the re-plan parks A and calls `refreshGroupPending`, which is the one
 *    writer that raises an `awaiting_authorization` member's attempt without changing its state. It runs
 *    on the group queue, so it lands while B's judge is still waiting for its node. The whole group moves
 *    to attempt 2.
 * 4. B's judge returns the row it read at attempt 1. The claim runs in a *separate* `core.taskQueue.run`
 *    turn and re-reads B: a reusable authorization claims the refreshed attempt 2, while a one-shot
 *    authorization for attempt 1 is refused because its attempt no longer matches. No write puts attempt 1
 *    back, and no task.start carries an attempt below 2. `cluster.drain()` waits for that background
 *    dispatch before the outcome is read.
 *
 * Both tests must pass; before the fix they reproduced the regression and were marked `it.fails`.
 */
import { generateKeyPair } from "@crh/noise";
import {
	type Authorization,
	authorizationCodec,
	encode as encodeCbor,
	RemoteError,
	type Signature,
	type TaskSpec,
	type TrustEntry,
	type TrustSummary,
} from "@crh/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Audit } from "../src/audit/audit.ts";
import { parseTaskAuthorization } from "../src/cluster/authorization.ts";
import { Cluster } from "../src/cluster/cluster.ts";
import type { ServerIdentity } from "../src/cluster/identity.ts";
import type { NodeRow } from "../src/cluster/nodes.ts";
import { TaskGroups, type TaskGroupView } from "../src/cluster/task-groups.ts";
import { trustDigest } from "../src/cluster/trust.ts";
import { bindMasterKey, MasterKey } from "../src/keys/master-key.ts";
import { type AuthorizationSigningKey, loadAuthorizationSigningKey } from "../src/privilege/key.ts";
import { specSha256 } from "../src/privilege/payload.ts";
import { signSshsig } from "../src/privilege/sshsig.ts";
import type { Db } from "../src/storage/db.ts";
import { defaultOrgId } from "../src/storage/org.ts";
import { createUser } from "../src/users/service.ts";
import { type FakeCrha, handshakeInit, TestAgentServer, waitFor } from "./helpers/agent.ts";
import { type App, call, login, makeApp } from "./helpers/api.ts";
import { createSshKey, type TestSshKey } from "./helpers/authenticator.ts";
import { openTestDb } from "./helpers/db.ts";
import { registerSshCredential } from "./helpers/signing-credentials.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const EXEC: TaskSpec = {
	kind: "exec",
	command: { argv: ["systemctl", "restart", "nginx"] },
	env: {},
	cwd: "",
	stdin: null,
};

const IDENTITIES = {
	unprivileged: { uid: 998, gid: 998, user: "crha" },
	privileged: { uid: 0, gid: 0, user: "root" },
};

const START = { tasks: [], taskKinds: [] };
const HOUR = 3_600_000;

describe("submitAuthorization claims from a stale row", () => {
	let db: Db;
	let audit: Audit;
	let cluster: Cluster;
	let agents: TestAgentServer;
	let signing: AuthorizationSigningKey;
	let app: App;
	let owner: { userId: string; cookie: string };
	let ownerKey: TestSshKey;

	beforeEach(async () => {
		db = await openTestDb("sqlite");
		const masterKey = MasterKey.generate();
		await bindMasterKey(db, masterKey);
		signing = await loadAuthorizationSigningKey(db, masterKey);
		audit = new Audit(db);
		cluster = new Cluster(db, {
			authorizationKey: signing,
			audit,
			clockWarnMs: 60_000,
			// The gate in runRace substitutes for the offline grace; keep a real one too, so a stray wait
			// cannot end a task while the test holds the window open.
			nodeOfflineGraceMs: 5_000,
		});
		const identity: ServerIdentity = { keyPair: generateKeyPair(), fingerprint: "test-fingerprint" };
		agents = await TestAgentServer.start(db, identity, cluster);
		const user = await createUser(db, { username: "owner", kind: "member", password: "password-123" });
		app = makeApp(db, undefined, {
			cluster,
			audit,
			authorizationKey: signing,
			clockWarnMs: 60_000,
			serverFingerprint: "test-server",
		});
		owner = { userId: user.id, cookie: await login(app, "owner", "password-123") };
		ownerKey = createSshKey("ssh-ed25519");
		await addSshSigningCredential(ownerKey);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await cluster.close();
		await agents.close();
		await db.destroy();
	});

	async function addSshSigningCredential(key: TestSshKey): Promise<void> {
		const res = await registerSshCredential(app, owner.cookie, key, "test");
		expect(res.status).toBe(201);
	}

	const addNode = async (name: string, key: Uint8Array): Promise<NodeRow> => {
		const id = crypto.randomUUID();
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
				public_key: Buffer.from(key).toString("base64"),
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
				id: crypto.randomUUID(),
				org_id: await defaultOrgId(db),
				grantee_type: "user",
				grantee_id: owner.userId,
				target_type: "node",
				target_id: id,
				created_by_user_id: owner.userId,
				created_at: now,
			})
			.execute();
		return (await db.selectFrom("nodes").selectAll().where("id", "=", id).executeTakeFirstOrThrow()) as NodeRow;
	};

	/** Connects a fake crha that reports `forward` and pushes `summary`. */
	const connect = async (
		name: string,
		summary: (nodeId: string) => TrustSummary,
	): Promise<{ node: NodeRow; crha: FakeCrha }> => {
		const key = generateKeyPair();
		const node = await addNode(name, key.publicKey);
		const crha = await agents.connect(key, handshakeInit());
		expect(await crha.peer.request("hello", { ...START, privilegedMode: "forward" })).toEqual({ acks: [] });
		await waitFor("link ready", () => cluster.isConnected(node.id));
		const report = summary(node.id);
		crha.trust({ kind: "ok", summary: report });
		await waitFor("trust stored", async () => {
			const row = await db.selectFrom("nodes").select("trust_digest").where("id", "=", node.id).executeTakeFirst();
			return row?.trust_digest === trustDigest(report);
		});
		return { node, crha };
	};

	const summaryOf = (nodeId: string, trust: TrustEntry[]): TrustSummary => ({
		nodeId,
		aliases: [],
		clockSkewMs: 60_000,
		identities: IDENTITIES,
		trust,
		localWindow: { kind: "closed" },
	});

	const sshEntry = (name: string, role: TrustEntry["role"], overrides: Partial<TrustEntry> = {}): TrustEntry => ({
		name,
		source: "local",
		role,
		key: { kind: "sshsig", publicKey: `ssh-ed25519 AAAA${name}`, fingerprint: `SHA256:${name}` },
		kinds: ["execute"],
		requireSpec: false,
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

	const actor = () => ({ type: "user" as const, id: owner.userId, onBehalfOfUserId: owner.userId });

	/** Signs payload bytes with the owner's SSH key and wraps the authorization as `crhu sign` prints it. */
	const signedAuthorization = (payload: Uint8Array): string => {
		const signature: Signature = { kind: "sshsig", blob: signSshsig(ownerKey.privateKey, ownerKey.blob, payload) };
		const authorization: Authorization = { payload, signatures: [signature] };
		return Buffer.from(encodeCbor(authorizationCodec.encode(authorization))).toString("base64");
	};

	const submit = (authorization: string) =>
		call(app, "/api/authorizations", { cookie: owner.cookie, body: { authorization } });

	const taskRow = (id: string) => db.selectFrom("tasks").selectAll().where("id", "=", id).executeTakeFirstOrThrow();

	const _command = () => ({ specSha256: specSha256(EXEC) });

	/** Creates a two-member privileged group and waits until both members wait for a signature. */
	const createWaitingGroup = async (
		a: { node: NodeRow },
		b: { node: NodeRow },
	): Promise<{ taskA: TaskGroupView["tasks"][number]; taskB: TaskGroupView["tasks"][number] }> => {
		const groups = new TaskGroups(db, cluster, { audit });
		const groupId = await groups.create({
			targets: [a.node.name, b.node.name],
			nodeIds: [a.node.id, b.node.id],
			spec: EXEC,
			privileged: true,
			actor: actor(),
			parallel: 2,
			outputMode: "status",
		});
		const group = await waitFor("both tasks waiting", async () => {
			const view = await groups.get(groupId);
			return view && view.tasks.length === 2 && view.tasks.every((task) => task.state === "awaiting_authorization")
				? view
				: undefined;
		});
		const taskA = group.tasks.find((task) => task.nodeId === a.node.id);
		const taskB = group.tasks.find((task) => task.nodeId === b.node.id);
		if (!taskA || !taskB) throw new Error("the waiting group has no task on each node");
		return { taskA, taskB };
	};

	it("keeps a sibling's attempt when the group is re-planned during a rejection", async () => {
		const a = await connect("race-a", (id) => summaryOf(id, [ownerEntry()]));
		const b = await connect("race-b", (id) => summaryOf(id, [ownerEntry()]));
		const { taskA, taskB } = await createWaitingGroup(a, b);
		a.crha.answerStart = () => {
			throw new RemoteError("authorization_rejected", "step 7: deny rule matched");
		};
		const groupId = taskA.taskGroupId;
		if (!groupId) throw new Error("the group task has no group id");

		// One signature for the group: A's node rejects it, B's node accepts it.
		const res = await call(app, `/api/task-groups/${groupId}/authorization`, { cookie: owner.cookie });
		expect(res.status).toBe(200);
		const shared = (await res.json()) as {
			taskGroup: { authorization: { options: { kind: string; payload?: { payload: string } }[] } };
		};
		const sign = shared.taskGroup.authorization.options.find((option) => option.kind === "sign");
		if (!sign?.payload) throw new Error("missing sign payload");
		expect(
			(await submit(signedAuthorization(Uint8Array.from(Buffer.from(sign.payload.payload, "base64"))))).status,
		).toBe(200);

		// A waits again for attempt 2, covering only itself; B is running and untouched.
		await waitFor("A waiting for the next attempt", async () => {
			const row = await taskRow(taskA.id);
			return row.state === "awaiting_authorization" && parseTaskAuthorization(row.authorization)?.attempt === 2
				? row
				: undefined;
		});
		await waitFor("B running", async () => (await taskRow(taskB.id)).state === "running");
		expect(b.crha.starts).toHaveLength(1);

		// A trust change on A's node re-plans the group: only A still waits, and its attempt stays 2.
		a.crha.trust({ kind: "ok", summary: { ...summaryOf(a.node.id, [ownerEntry()]), aliases: ["changed"] } });
		await new Promise((resolve) => setTimeout(resolve, 150));
		const replanned = parseTaskAuthorization((await taskRow(taskA.id)).authorization);
		expect(replanned?.attempt).toBe(2);
		expect(replanned?.options[0]).toMatchObject({ kind: "sign", payload: { attempt: 2, taskIds: [taskA.id] } });

		// The node now accepts: signing the attempt-2 payload sends A once at attempt 2; B is never re-sent.
		a.crha.answerStart = () => {};
		const pending = await call(app, `/api/tasks/${taskA.id}/authorization`, { cookie: owner.cookie });
		const pendingBody = (await pending.json()) as {
			authorization: { options: { kind: string; payload?: { payload: string } }[] };
		};
		const next = pendingBody.authorization.options.find((option) => option.kind === "sign");
		if (!next?.payload) throw new Error("missing next payload");
		await submit(signedAuthorization(Uint8Array.from(Buffer.from(next.payload.payload, "base64"))));
		await waitFor("A's second start", () => a.crha.starts.length === 2);
		expect(a.crha.starts[1]?.attempt).toBe(2);
		expect(b.crha.starts).toHaveLength(1);
		await waitFor("A running", async () => (await taskRow(taskA.id)).state === "running");
	});
});
