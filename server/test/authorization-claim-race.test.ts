/**
 * Regression test for the stale-row claim of `submitAuthorization` that used to regress a task's attempt
 * (doc/audit-2026-11-06.md, 低 / 服务端 cluster: "`submitAuthorization` 使用判定阶段读到的旧行 … 如果中间发生过
 * `refreshGroupPending`，attempt 可能回退"). The race is now prevented by the row version (D118): the claim
 * re-reads the row in its own queue turn, so it judges the refreshed attempt, and its write is guarded by
 * that row's `rev`.
 *
 * The interleaving this test opens:
 *
 * 1. The owner submits a one-shot authorization for task A of a group. A is claimed and its `task.start`
 *    is sent; the fake node withholds the answer.
 * 2. A reusable authorization for task B (same group, other node) is submitted. Its dispatch now runs in
 *    the background (D118): `submitAuthorization` stores the row and returns, then `judgeSubmitted`
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
import { ClusterCore } from "../src/cluster/core.ts";
import type { ServerIdentity } from "../src/cluster/identity.ts";
import type { NodeRow } from "../src/cluster/nodes.ts";
import { TaskGroups, type TaskGroupView } from "../src/cluster/task-groups.ts";
import { trustDigest } from "../src/cluster/trust.ts";
import { bindMasterKey, MasterKey } from "../src/keys/master-key.ts";
import { type AuthorizationSigningKey, loadAuthorizationSigningKey } from "../src/privilege/key.ts";
import { buildAuthorization, specSha256 } from "../src/privilege/payload.ts";
import { signSshsig } from "../src/privilege/sshsig.ts";
import type { Db } from "../src/storage/db.ts";
import { createUser, defaultOrgId } from "../src/users/service.ts";
import { type FakeCrha, handshakeInit, TestAgentServer, waitFor } from "./helpers/agent.ts";
import { type App, call, login, makeApp } from "./helpers/api.ts";
import { createSshKey, type TestSshKey } from "./helpers/authenticator.ts";
import { openTestDb } from "./helpers/db.ts";

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

interface RaceOutcome {
	/** B's attempt after the sibling's re-plan bumped the whole group, before the stale claim ran. */
	refreshedAttempt: number;
	/** B's attempt after the submission's claim (and its task.start). */
	finalAttempt: number;
	finalRecordAttempt: number | null;
	/** B's task.start attempts as the node received them (none when the claim refuses the stale row). */
	startAttempts: number[];
	secondStatus: number;
}

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
			trustWaitMs: 100,
			audit,
			clockWarnMs: 60_000,
			// The gate in runRace substitutes for the offline grace; keep a real one too, so a stray wait
			// cannot end a task while the test holds the window open.
			nodeOfflineGraceMs: 5_000,
		});
		const identity: ServerIdentity = { keyPair: generateKeyPair(), fingerprint: "test-fingerprint" };
		agents = await TestAgentServer.start(db, identity, cluster);
		const user = await createUser(db, { username: "owner", kind: "member", password: "password-123" });
		app = makeApp(db, undefined, { cluster, audit, authorizationKey: signing, clockWarnMs: 60_000 });
		owner = { userId: user.id, cookie: await login(app, "owner", "password-123") };
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
		const res = await call(app, "/api/me/credentials/ssh", {
			cookie: owner.cookie,
			body: { publicKey: key.line, name: "test" },
		});
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
				ssh_host_key: null,
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

	const actor = () => ({ type: "user" as const, id: owner.userId, onBehalfOfUserId: owner.userId });

	/** Signs payload bytes with the owner's SSH key and wraps the authorization as `crha grant` prints it. */
	const signedAuthorization = (payload: Uint8Array): string => {
		const signature: Signature = { kind: "sshsig", blob: signSshsig(ownerKey.privateKey, ownerKey.blob, payload) };
		const authorization: Authorization = { payload, signatures: [signature] };
		return Buffer.from(encodeCbor(authorizationCodec.encode(authorization))).toString("base64");
	};

	const submit = (authorization: string) =>
		call(app, "/api/authorizations", { cookie: owner.cookie, body: { authorization } });

	const taskRow = (id: string) => db.selectFrom("tasks").selectAll().where("id", "=", id).executeTakeFirstOrThrow();

	const command = () => ({
		method: "exec" as const,
		exact: { target: "systemctl restart nginx", specSha256: specSha256(EXEC) },
	});

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

	/**
	 * Runs the interleaving described in the file header and returns what the two writes did. `kind`
	 * selects the submitted authorization for B: a reusable one (`taskIds === null`, the case the audit
	 * names) or a one-shot one for B at attempt 1 (its `payload.attempt === row.attempt` check is made
	 * against the same stale row).
	 */
	const runRace = async (kind: "reusable" | "one-shot"): Promise<RaceOutcome> => {
		const a = await connect("race-a", (id) => summaryOf(id, [ownerEntry()]));
		const b = await connect("race-b", (id) => summaryOf(id, [ownerEntry()]));
		const { taskA, taskB } = await createWaitingGroup(a, b);

		// Submit #1: a one-shot authorization for A only. Its task.start is held at the node, so A stays
		// dispatched while the second submission runs; when released the node rejects it.
		let releaseRejection!: () => void;
		const rejectionGate = new Promise<void>((resolve) => {
			releaseRejection = resolve;
		});
		a.crha.answerStart = async () => {
			await rejectionGate;
			throw new RemoteError("authorization_rejected", "step 7: deny rule matched");
		};
		const oneShotA = buildAuthorization({
			nodes: [a.node.id],
			command: command(),
			issuedAtMs: Date.now(),
			deadlineMs: Date.now() + HOUR,
			taskIds: [taskA.id],
			attempt: 1,
		});
		const firstSubmission = submit(signedAuthorization(oneShotA.bytes));
		await waitFor("A's task.start on the wire", () => a.crha.starts.length === 1);
		await waitFor("A dispatched", async () => (await taskRow(taskA.id)).state === "dispatched");

		// Hold submit #2's judge of B at its waitNodeReady. By then judgeSubmitted has already read B's row
		// (owner-authorizations.ts:510); the gate is the offline-grace-shaped window of :518.
		let releaseJudge!: () => void;
		const judgeGate = new Promise<void>((resolve) => {
			releaseJudge = resolve;
		});
		let gated = false;
		let judgeIsWaiting = false;
		const originalWaitNodeReady = ClusterCore.prototype.waitNodeReady;
		const spy = vi.spyOn(ClusterCore.prototype, "waitNodeReady").mockImplementation(async function (
			this: unknown,
			nodeId: string,
			options?: { trust?: boolean },
		) {
			if (nodeId === b.node.id && !gated) {
				gated = true;
				judgeIsWaiting = true;
				await judgeGate;
			}
			return originalWaitNodeReady.call(this as ClusterCore, nodeId, options);
		});
		try {
			const submittedB =
				kind === "reusable"
					? buildAuthorization({
							nodes: [b.node.id],
							command: command(),
							issuedAtMs: Date.now(),
							deadlineMs: Date.now() + HOUR,
							taskIds: null,
						})
					: buildAuthorization({
							nodes: [b.node.id],
							command: command(),
							issuedAtMs: Date.now(),
							deadlineMs: Date.now() + HOUR,
							taskIds: [taskB.id],
							attempt: 1,
						});
			const secondSubmission = submit(signedAuthorization(submittedB.bytes));
			await waitFor("submit #2's judge waiting for B's node", () => judgeIsWaiting);
			// The judge's row: awaiting_authorization at attempt 1.
			const before = await taskRow(taskB.id);
			expect(before.state).toBe("awaiting_authorization");
			expect(before.attempt).toBe(1);

			// The sibling's rejected task.start re-plans A (attempt 2) and refreshGroupPending moves the
			// whole group to attempt 2. B's task queue is still held by its judge, so this is a raw write.
			releaseRejection();
			const firstResponse = await firstSubmission;
			expect(firstResponse.status).toBe(200);
			const refreshed = await waitFor("refresh moves B to attempt 2", async () => {
				const row = await taskRow(taskB.id);
				return row.attempt === 2 ? row : undefined;
			});
			expect(parseTaskAuthorization(refreshed.authorization)?.attempt).toBe(2);

			// Release the judge; its claim runs from the row read before the refresh. The dispatch is in
			// the background now, so drain before reading what it wrote.
			releaseJudge();
			const secondResponse = await secondSubmission;
			expect(secondResponse.status).toBe(200);
			await cluster.drain();
			const final = await taskRow(taskB.id);
			return {
				refreshedAttempt: refreshed.attempt,
				finalAttempt: final.attempt,
				finalRecordAttempt: parseTaskAuthorization(final.authorization)?.attempt ?? null,
				startAttempts: b.crha.starts.map((start) => start.attempt),
				secondStatus: secondResponse.status,
			};
		} finally {
			spy.mockRestore();
		}
	};

	it("does not regress attempt when a sibling is re-planned before a reusable claim", async () => {
		const outcome = await runRace("reusable");
		// The claim re-read B at the attempt the group refresh wrote and claims at attempt 2; the
		// rev-guarded write cannot put the older attempt back.
		expect(outcome.refreshedAttempt).toBe(2);
		expect(outcome.secondStatus).toBe(200);
		expect(outcome.finalAttempt).toBe(2);
		expect(outcome.finalRecordAttempt).toBe(2);
		// A fix may claim at the refreshed attempt or refuse the stale claim; either way no task.start
		// may carry the attempt read before the refresh.
		expect(outcome.startAttempts.filter((attempt) => attempt < 2)).toEqual([]);
	});

	it("does not regress attempt when a sibling is re-planned before a one-shot claim", async () => {
		const outcome = await runRace("one-shot");
		// The one-shot claim compares payload.attempt with the fresh row's attempt, so the now-stale
		// authorization is refused instead of writing its attempt 1 back.
		expect(outcome.refreshedAttempt).toBe(2);
		expect(outcome.secondStatus).toBe(200);
		expect(outcome.finalAttempt).toBe(2);
		expect(outcome.finalRecordAttempt).toBe(2);
		expect(outcome.startAttempts.filter((attempt) => attempt < 2)).toEqual([]);
	});
});
