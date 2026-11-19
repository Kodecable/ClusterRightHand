/**
 * The authorization sync of tasks and task groups (doc/design/privilege.md "Authorization path") against
 * fake crha links: one pass per unit at a time, rev-checked writes, attempts that only rise and never
 * touch a dispatched task, rejected authorizations that are never sent again, at most two signatures
 * asked per unit, payloads that stay put until something changes, and the owner's group rejection.
 */
import { generateKeyPair } from "@crh/noise";
import {
	decodeAuthorizationPayload,
	RemoteError,
	type Signature,
	type TaskSpec,
	type TrustEntry,
	type TrustSummary,
} from "@crh/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseTaskAuthorization } from "../src/cluster/authorization.ts";
import { Cluster } from "../src/cluster/cluster.ts";
import type { ServerIdentity } from "../src/cluster/identity.ts";
import type { NodeRow } from "../src/cluster/nodes.ts";
import { TaskGroups } from "../src/cluster/task-groups.ts";
import { trustDigest } from "../src/cluster/trust.ts";
import { bindMasterKey, MasterKey } from "../src/keys/master-key.ts";
import { type AuthorizationSigningKey, loadAuthorizationSigningKey } from "../src/privilege/key.ts";
import { buildAuthorization, specBytes, specSha256 } from "../src/privilege/payload.ts";
import { planAuthorization } from "../src/privilege/planner.ts";
import { signSshsig } from "../src/privilege/sshsig.ts";
import { signaturesToJson } from "../src/privilege/submission.ts";
import type { Db } from "../src/storage/db.ts";
import { defaultOrgId } from "../src/storage/org.ts";
import { createUser } from "../src/users/service.ts";
import { derivedId, newId } from "../src/util/id.ts";
import { type FakeCrha, handshakeInit, TestAgentServer, waitFor } from "./helpers/agent.ts";
import { type App, call, login, makeApp } from "./helpers/api.ts";
import { createSshKey, type TestSshKey } from "./helpers/authenticator.ts";
import { openTestDb } from "./helpers/db.ts";
import { registerSshCredential } from "./helpers/signing-credentials.ts";

// Count planner calls without changing what they do: a group member's first dispatch must only plan the group.
vi.mock("../src/privilege/planner.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/privilege/planner.ts")>();
	return { ...actual, planAuthorization: vi.fn(actual.planAuthorization) };
});

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

describe("authorization paths and the task queue", () => {
	let db: Db;
	let cluster: Cluster;
	let taskGroups: TaskGroups;
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
		cluster = new Cluster(db, { authorizationKey: signing, nodeOfflineGraceMs: GRACE_MS });
		taskGroups = new TaskGroups(db, cluster);
		const identity: ServerIdentity = { keyPair: generateKeyPair(), fingerprint: "test-fingerprint" };
		agents = await TestAgentServer.start(db, identity, cluster);
		ownerId = (await createUser(db, { username: "owner", kind: "member", password: "password-123" })).id;
		app = makeApp(db, undefined, { cluster, taskGroups, serverFingerprint: "test-server" });
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
		const cookie = await login(app, "owner", "password-123");
		const res = await registerSshCredential(app, cookie, key, "test");
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

	/** crhs's own key, allowed to restart nginx: the plan can take the crhs path. */
	const crhsEntry = (): TrustEntry =>
		sshEntry("crhs", "crhs", {
			key: { kind: "sshsig", publicKey: signing.authorizedKey, fingerprint: signing.fingerprint },
			kinds: ["execute", "cosign"],
			requireSpec: true,
			maxTtlMs: 5 * 60 * 1000,
			allow: [{ method: "exec", match: "prefix", pattern: "systemctl restart " }],
		});

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
			command: { specSha256: specSha256(EXEC) },
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

	it("uses a stored authorization on the next trust sync and sends one task.start", async () => {
		const { node, crha } = await connect("stored-wait", (id) => summaryOf(id, [ownerEntry()]));
		const task = await createPrivileged(node.id);
		await waitFor("the task waits for a signature", async () => {
			const row = await rowOf(task.id);
			return row?.state === "awaiting_authorization" ? row : undefined;
		});
		await storeOwnerAuthorization(node, task.id);

		// The next digest change syncs the waiting task, and the planner's stored-authorization path
		// claims and sends it. The task queue is free meanwhile: the pass holds no turn while it reads.
		crha.trust({ kind: "ok", summary: { ...summaryOf(node.id, [ownerEntry()]), aliases: ["stored"] } });
		await waitFor("task.start from the stored authorization", () => crha.starts.length === 1);
		expect(crha.starts[0]).toMatchObject({ taskId: task.id, attempt: 1, privileged: true });
		const running = await waitFor("the stored-authorization task running", async () => {
			const row = await rowOf(task.id);
			return row?.state === "running" ? row : undefined;
		});
		expect(parseTaskAuthorization(running.authorization)).toMatchObject({ dispatchedPath: "user", attempt: 1 });

		// A second digest change must not send the same signed payload again.
		crha.trust({ kind: "ok", summary: { ...summaryOf(node.id, [ownerEntry()]), aliases: ["stored-2"] } });
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(crha.starts).toHaveLength(1);
	});

	it("dispatches a mixed group's usable members, parks only the signable one and fails the rest", async () => {
		vi.mocked(planAuthorization).mockClear();
		const a = await connect("mixed-a", (id) => summaryOf(id, [crhsEntry()]));
		const b = await connect("mixed-b", (id) => summaryOf(id, [ownerEntry()]));
		const c = await connect("mixed-c", (id) => summaryOf(id, [ownerEntry()]));
		const d = await connect("mixed-d", (id) => summaryOf(id, []));

		const groupId = newId();
		const taskOf = (node: NodeRow) => derivedId(`${groupId}/${node.id}`);
		const taskA = taskOf(a.node);
		const taskB = taskOf(b.node);
		const taskC = taskOf(c.node);
		const taskD = taskOf(d.node);
		await storeOwnerAuthorization(b.node, taskB);

		const actorRef = actor();
		await taskGroups.create({
			id: groupId,
			targets: [a.node.name, b.node.name, c.node.name, d.node.name],
			nodeIds: [a.node.id, b.node.id, c.node.id, d.node.id],
			spec: EXEC,
			privileged: true,
			actor: actorRef,
			parallel: 4,
			outputMode: "status",
		});

		// A (crhs) and B (stored owner authorization) are sent without the owner doing anything.
		await waitFor("task.start on the crhs node", () => a.crha.starts.length === 1);
		await waitFor("task.start on the stored-authorization node", () => b.crha.starts.length === 1);
		expect(a.crha.starts[0]).toMatchObject({ taskId: taskA, privileged: true });
		expect(b.crha.starts[0]).toMatchObject({ taskId: taskB, privileged: true });

		const view = async () => {
			const group = await taskGroups.get(groupId);
			if (!group) throw new Error("group disappeared");
			return group;
		};
		// Every plan of the first dispatch is the group's; a member is never planned on its own.
		expect(vi.mocked(planAuthorization).mock.calls.every(([input]) => input.target.kind === "group")).toBe(true);
		const running = await waitFor("A and B running", async () => {
			const group = await view();
			const members = new Map(group.tasks.map((task) => [task.id, task]));
			return members.get(taskA)?.state === "running" && members.get(taskB)?.state === "running" ? group : undefined;
		});
		const byId = new Map(running.tasks.map((task) => [task.id, task]));
		expect(byId.get(taskC)).toMatchObject({ state: "awaiting_authorization" });
		expect(byId.get(taskD)).toMatchObject({ state: "rejected", errorCode: "authorization_required" });
		expect(c.crha.starts).toHaveLength(0);

		// The parked member's options are the group's shared sign option, covering only the waiting member.
		const parkedRow = await rowOf(taskC);
		const parked = parseTaskAuthorization(parkedRow?.authorization ?? null);
		const sign = parked?.options.find((option) => option.kind === "sign");
		if (sign?.kind !== "sign" || sign.payload === null) throw new Error("missing shared sign option");
		expect(sign.payload.taskIds).toEqual([taskC]);

		// The approvals endpoint lists the group even though some of its members already run.
		const cookie = await login(app, "owner", "password-123");
		const approvals = await call(app, "/api/approvals", { cookie });
		expect(approvals.status).toBe(200);
		const approvalsBody = (await approvals.json()) as {
			authorizations: { tasks: { id: string }[]; taskGroups: { id: string }[] };
		};
		expect(approvalsBody.authorizations.tasks.map((task) => task.id)).not.toContain(taskC);
		expect(approvalsBody.authorizations.taskGroups.map((group) => group.id)).toContain(groupId);

		// The group's pending endpoint serves the shared sign option.
		const pending = await call(app, `/api/task-groups/${groupId}/authorization`, { cookie });
		expect(pending.status).toBe(200);
		const pendingBody = (await pending.json()) as {
			taskGroup: { authorization: { options: { kind: string; payload?: { taskIds: string[] } }[] } } | null;
		};
		const option = pendingBody.taskGroup?.authorization.options.find((candidate) => candidate.kind === "sign");
		expect(option?.payload?.taskIds).toEqual([taskC]);

		// A later sync of the waiting member never rewrites the members that already started, and a trust
		// change that does not change what the owner is asked for keeps the payload (and the row) as it is.
		const beforeA = await rowOf(taskA);
		const beforeB = await rowOf(taskB);
		const beforeC = await rowOf(taskC);
		const changed = summaryOf(c.node.id, [ownerEntry(), sshEntry("extra", "user")]);
		c.crha.trust({ kind: "ok", summary: changed });
		await waitFor("trust stored", async () => (await rowNode(c.node.id))?.trust_digest === trustDigest(changed));
		await cluster.drain();
		expect(await rowOf(taskA)).toMatchObject({ rev: beforeA?.rev, authorization: beforeA?.authorization });
		expect(await rowOf(taskB)).toMatchObject({ rev: beforeB?.rev, authorization: beforeB?.authorization });
		expect(await rowOf(taskC)).toMatchObject({ rev: beforeC?.rev, authorization: beforeC?.authorization });

		// The owner signs the shared payload: the waiting member is sent through the same sync path.
		const signedRow = await rowOf(taskC);
		const signedRecord = parseTaskAuthorization(signedRow?.authorization ?? null);
		const signed = signedRecord?.options.find((candidate) => candidate.kind === "sign");
		if (signed?.kind !== "sign" || signed.payload === null) throw new Error("missing sign payload");
		const payloadBytes = Uint8Array.from(Buffer.from(signed.payload.payload, "base64"));
		const submitted = {
			id: signed.payload.id,
			payload: decodeAuthorizationPayload(payloadBytes),
			payloadBytes,
			signatures: [{ kind: "sshsig" as const, blob: signSshsig(ownerKey.privateKey, ownerKey.blob, payloadBytes) }],
		};
		const submittedBy = { sessionId: "s", userId: ownerId, username: "owner", kind: "member" as const };
		await cluster.submitAuthorization(submittedBy, submitted);
		await waitFor("task.start for the signed member", () => c.crha.starts.length === 1);
		expect(c.crha.starts[0]).toMatchObject({ taskId: taskC, privileged: true });
		const cRunning = await waitFor("the signed member running", async () => {
			const row = await rowOf(taskC);
			return row?.state === "running" ? row : undefined;
		});
		expect(parseTaskAuthorization(cRunning.authorization)).toMatchObject({ dispatchedPath: "user", attempt: 1 });
	});

	it("plans a group member's first dispatch only through the group", async () => {
		const a = await connect("one-plan-a", (id) => summaryOf(id, [crhsEntry()]));
		const groupId = newId();
		const taskId = derivedId(`${groupId}/${a.node.id}`);
		vi.mocked(planAuthorization).mockClear();
		await taskGroups.create({
			id: groupId,
			targets: [a.node.name],
			nodeIds: [a.node.id],
			spec: EXEC,
			privileged: true,
			actor: actor(),
			parallel: 1,
			outputMode: "status",
		});
		await waitFor("task.start for the single member", () => a.crha.starts.length === 1);
		expect(parseTaskAuthorization((await rowOf(taskId))?.authorization ?? null)).toMatchObject({
			dispatchedPath: "crhs",
		});
		const targets = vi.mocked(planAuthorization).mock.calls.map(([input]) => input.target.kind);
		expect(targets).toEqual(["group"]);
	});
	/** A reusable owner authorization for restarting services on the node, stored at `createdAt`. */
	const storeReusable = async (node: NodeRow, createdAt: Date): Promise<string> => {
		const deadlineMs = Date.now() + HOUR;
		const built = buildAuthorization({
			nodes: [node.id],
			command: { method: "exec", prefix: "systemctl restart " },
			issuedAtMs: createdAt.getTime(),
			deadlineMs,
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
				task_ids: null,
				deadline: new Date(deadlineMs).toISOString(),
				created_at: createdAt.toISOString(),
			})
			.execute();
		return built.id;
	};

	const signOptionOf = (row: { authorization: string | null } | undefined) => {
		const option = parseTaskAuthorization(row?.authorization ?? null)?.options.find(
			(candidate) => candidate.kind === "sign",
		);
		return option?.kind === "sign" ? option : undefined;
	};

	const submitSigned = async (payloadBase64: string, id: string) => {
		const payloadBytes = Uint8Array.from(Buffer.from(payloadBase64, "base64"));
		await cluster.submitAuthorization(
			{ sessionId: "s", userId: ownerId, username: "owner", kind: "member" },
			{
				id,
				payload: decodeAuthorizationPayload(payloadBytes),
				payloadBytes,
				signatures: [{ kind: "sshsig", blob: signSshsig(ownerKey.privateKey, ownerKey.blob, payloadBytes) }],
			},
		);
	};

	const rejectEveryStart = (crha: FakeCrha) => {
		crha.answerStart = () => {
			throw new RemoteError("authorization_rejected", "the node says no");
		};
	};

	it("never sends a stored authorization crha rejected again, nor one stored before it", async () => {
		const { node, crha } = await connect("rejected-twice", (id) => summaryOf(id, [ownerEntry()]));
		const older = await storeReusable(node, new Date(Date.now() - 2_000));
		const newer = await storeReusable(node, new Date(Date.now() - 1_000));
		rejectEveryStart(crha);
		const task = await createPrivileged(node.id);
		const waiting = await waitFor("the task waits for a signature again", async () => {
			const row = await rowOf(task.id);
			return row?.state === "awaiting_authorization" && signOptionOf(row) ? row : undefined;
		});
		await cluster.drain();
		// The newest one was tried and refused; the older one is not tried after it.
		expect(crha.starts).toHaveLength(1);
		expect(crha.starts[0]?.authorizations).toHaveLength(1);
		const record = parseTaskAuthorization(waiting.authorization);
		expect(record?.payloadId).toBe(newer);
		expect(record?.rejectedBefore).not.toBeNull();
		expect(older).not.toBe(newer);
		expect(waiting.attempt).toBe(2);
	});

	it("asks the owner for at most two signatures, then ends the task", async () => {
		const { node, crha } = await connect("two-signatures", (id) => summaryOf(id, [ownerEntry()]));
		rejectEveryStart(crha);
		const task = await createPrivileged(node.id);
		for (const attempt of [1, 2]) {
			const row = await waitFor(`the signature request for attempt ${attempt}`, async () => {
				const current = await rowOf(task.id);
				return current?.state === "awaiting_authorization" && current.attempt === attempt && signOptionOf(current)
					? current
					: undefined;
			});
			const sign = signOptionOf(row);
			if (!sign?.payload) throw new Error("missing sign payload");
			await submitSigned(sign.payload.payload, sign.payload.id);
			await waitFor(`task.start ${attempt}`, () => crha.starts.length === attempt);
		}
		const ended = await waitFor("the task ends after the second refusal", async () => {
			const row = await rowOf(task.id);
			return row?.state === "rejected" ? row : undefined;
		});
		expect(ended.error_code).toBe("authorization_rejected");
		expect(crha.starts).toHaveLength(2);
	});

	it("parks every member of a group whose plans overlap with one payload covering them all", async () => {
		const actual = await vi.importActual<typeof import("../src/privilege/planner.ts")>("../src/privilege/planner.ts");
		let calls = 0;
		vi.mocked(planAuthorization).mockImplementation(async (input) => {
			const plan = await actual.planAuthorization(input);
			calls++;
			// The second pass is slow: members enter the wait while it runs.
			if (calls === 2) await new Promise((resolve) => setTimeout(resolve, 400));
			return plan;
		});
		const nodes = [];
		for (let i = 0; i < 4; i++) nodes.push(await connect(`overlap-${i}`, (id) => summaryOf(id, [ownerEntry()])));
		const groupId = newId();
		await taskGroups.create({
			id: groupId,
			targets: nodes.map((entry) => entry.node.name),
			nodeIds: nodes.map((entry) => entry.node.id),
			spec: EXEC,
			privileged: true,
			actor: actor(),
			parallel: 2,
			outputMode: "status",
		});
		const ids = nodes.map((entry) => derivedId(`${groupId}/${entry.node.id}`));
		const rows = await waitFor("every member parked with the same payload for all four", async () => {
			const current = await Promise.all(ids.map(rowOf));
			const payloads = new Set(current.map((row) => signOptionOf(row)?.payload?.id));
			const covered = signOptionOf(current[0])?.payload?.taskIds.length;
			return current.every((row) => row?.state === "awaiting_authorization") && payloads.size === 1 && covered === 4
				? current
				: undefined;
		});
		expect(rows.every((row) => row?.state === "awaiting_authorization")).toBe(true);
	});

	it("raises the attempt of the group's waiting members only, never a dispatched one", async () => {
		const a = await connect("attempt-a", (id) => summaryOf(id, [crhsEntry(), ownerEntry()]));
		const b = await connect("attempt-b", (id) => summaryOf(id, [ownerEntry()]));
		const c = await connect("attempt-c", (id) => summaryOf(id, [crhsEntry()]));
		rejectEveryStart(a.crha);
		const groupId = newId();
		const [taskA, taskB, taskC] = [a, b, c].map((entry) => derivedId(`${groupId}/${entry.node.id}`));
		await taskGroups.create({
			id: groupId,
			targets: [a.node.name, b.node.name, c.node.name],
			nodeIds: [a.node.id, b.node.id, c.node.id],
			spec: EXEC,
			privileged: true,
			actor: actor(),
			parallel: 3,
			outputMode: "status",
		});
		const runningC = await waitFor("C running", async () => {
			const row = await rowOf(taskC as string);
			return row?.state === "running" ? row : undefined;
		});
		// A's crhs signature was refused (attempt 1 → 2); the shared payload then covers A and B at attempt 2.
		const [rowA, rowB] = await waitFor("A and B share a payload at attempt 2", async () => {
			const both = await Promise.all([rowOf(taskA as string), rowOf(taskB as string)]);
			const payloads = both.map((row) => signOptionOf(row)?.payload);
			return both.every((row) => row?.state === "awaiting_authorization" && row.attempt === 2) &&
				payloads.every((payload) => payload?.attempt === 2 && payload.taskIds.length === 2)
				? both
				: undefined;
		});
		expect(parseTaskAuthorization(rowA?.authorization ?? null)?.crhsRejected).toEqual({ window: null });
		expect(rowB?.attempt).toBe(2);
		// The member that runs keeps its attempt and its row.
		await cluster.drain();
		expect(await rowOf(taskC as string)).toMatchObject({ attempt: 1, rev: runningC.rev, state: "running" });
	});

	it("rejects a member that comes back to the wait after the owner rejected its group", async () => {
		const a = await connect("bounced-a", (id) => summaryOf(id, [crhsEntry()]));
		const b = await connect("bounced-b", (id) => summaryOf(id, [ownerEntry()]));
		let refuse!: () => void;
		const held = new Promise<void>((resolve) => {
			refuse = resolve;
		});
		a.crha.answerStart = async () => {
			await held;
			throw new RemoteError("authorization_rejected", "the node says no");
		};
		const groupId = newId();
		const [taskA, taskB] = [a, b].map((entry) => derivedId(`${groupId}/${entry.node.id}`));
		await taskGroups.create({
			id: groupId,
			targets: [a.node.name, b.node.name],
			nodeIds: [a.node.id, b.node.id],
			spec: EXEC,
			privileged: true,
			actor: actor(),
			parallel: 2,
			outputMode: "status",
		});
		await waitFor("A sent", () => a.crha.starts.length === 1);
		await waitFor("B waiting with options", async () => signOptionOf(await rowOf(taskB as string)) !== undefined);
		expect(await taskGroups.rejectAuthorization(groupId, "not now", actor())).toBe(true);
		expect(await rowOf(taskB as string)).toMatchObject({ state: "rejected", error_code: "authorization_declined" });

		// crha now refuses A, which goes back to the wait: the group's rejection ends it instead of a new plan.
		refuse();
		const endedA = await waitFor("A rejected", async () => {
			const row = await rowOf(taskA as string);
			return row?.state === "rejected" ? row : undefined;
		});
		expect(endedA).toMatchObject({ error_code: "authorization_declined", error_message: "not now" });
		const group = await waitFor("the group ended", async () => {
			const view = await taskGroups.get(groupId);
			return view?.state === "rejected" ? view : undefined;
		});
		expect(group.state).toBe("rejected");
		expect(a.crha.starts).toHaveLength(1);
		expect(b.crha.starts).toHaveLength(0);
	});

	it("replaces a sign payload that is due, by timer and by the sweep", async () => {
		const { node, crha } = await connect("refresh", (id) => summaryOf(id, [ownerEntry()]));
		const task = await createPrivileged(node.id);
		await waitFor("the first payload", async () => {
			const row = await rowOf(task.id);
			if (row?.state !== "awaiting_authorization") throw new Error(`task ended: ${row?.state} ${row?.error_message}`);
			return signOptionOf(row)?.payload ?? undefined;
		});
		// The task offers a payload that lives two seconds (still the same task, attempt and entry, so a
		// sync keeps it): its timer replaces it half a second before its deadline.
		const short = buildAuthorization({
			nodes: [node.id],
			command: { specSha256: specSha256(EXEC) },
			issuedAtMs: Date.now(),
			deadlineMs: Date.now() + 2_000,
			taskIds: [task.id],
			attempt: 1,
		});
		const offered = parseTaskAuthorization((await rowOf(task.id))?.authorization ?? null);
		if (!offered) throw new Error("missing record");
		await db
			.updateTable("tasks")
			.set({
				authorization: JSON.stringify({
					...offered,
					options: offered.options.map((option) =>
						option.kind === "sign"
							? {
									...option,
									payload: {
										payload: Buffer.from(short.bytes).toString("base64"),
										spec: Buffer.from(specBytes(EXEC)).toString("base64"),
										id: short.id,
										deadline: new Date(short.payload.deadlineMs as number).toISOString(),
										taskIds: [task.id],
										attempt: 1,
									},
								}
							: option,
					),
				}),
			})
			.where("id", "=", task.id)
			.execute();
		const changed = { ...summaryOf(node.id, [ownerEntry()]), aliases: ["refresh"] };
		crha.trust({ kind: "ok", summary: changed });
		await waitFor("trust stored", async () => (await rowNode(node.id))?.trust_digest === trustDigest(changed));
		await cluster.drain();
		expect(signOptionOf(await rowOf(task.id))?.payload?.id).toBe(short.id);
		const first = { id: short.id, deadline: new Date(short.payload.deadlineMs as number).toISOString() };
		const second = await waitFor(
			"the refreshed payload",
			async () => {
				const payload = signOptionOf(await rowOf(task.id))?.payload;
				return payload && payload.id !== first.id ? payload : undefined;
			},
			5_000,
		);
		expect(Date.parse(second.deadline as string)).toBeGreaterThan(Date.parse(first.deadline));

		// A payload that came due while no timer ran (crhs was down) is replaced by the sweep.
		const stale = buildAuthorization({
			nodes: [node.id],
			command: { specSha256: specSha256(EXEC) },
			issuedAtMs: Date.now() - 10_000,
			deadlineMs: Date.now() - 1_000,
			taskIds: [task.id],
			attempt: 1,
		});
		const row = await rowOf(task.id);
		const record = parseTaskAuthorization(row?.authorization ?? null);
		if (!record) throw new Error("missing record");
		const options = record.options.map((option) =>
			option.kind === "sign"
				? {
						...option,
						payload: {
							payload: Buffer.from(stale.bytes).toString("base64"),
							spec: Buffer.from(specBytes(EXEC)).toString("base64"),
							id: stale.id,
							deadline: new Date(Date.now() - 1_000).toISOString(),
							taskIds: [task.id],
							attempt: 1,
						},
					}
				: option,
		);
		await db
			.updateTable("tasks")
			.set({ authorization: JSON.stringify({ ...record, options }) })
			.where("id", "=", task.id)
			.execute();
		await cluster.sweepAuthorizationWaits();
		const swept = await waitFor("the swept payload", async () => {
			const payload = signOptionOf(await rowOf(task.id))?.payload;
			return payload && payload.id !== stale.id ? payload : undefined;
		});
		expect(Date.parse(swept.deadline as string)).toBeGreaterThan(Date.now());
	});

	it("keeps the payload and the row when a trust report changes nothing the owner is asked for", async () => {
		const { node, crha } = await connect("stable", (id) => summaryOf(id, [ownerEntry()]));
		const task = await createPrivileged(node.id);
		const parked = await waitFor("parked", async () => {
			const row = await rowOf(task.id);
			return signOptionOf(row) ? row : undefined;
		});
		const changed = { ...summaryOf(node.id, [ownerEntry()]), aliases: ["unrelated"] };
		crha.trust({ kind: "ok", summary: changed });
		await waitFor("trust stored", async () => (await rowNode(node.id))?.trust_digest === trustDigest(changed));
		await cluster.drain();
		expect(await rowOf(task.id)).toMatchObject({ rev: parked.rev, authorization: parked.authorization });
	});

	it("runs one pass of a unit at a time and folds the requests made meanwhile", async () => {
		const { node } = await connect("coalesce", (id) => summaryOf(id, [ownerEntry()]));
		const task = await createPrivileged(node.id);
		await waitFor("parked", async () => signOptionOf(await rowOf(task.id)) !== undefined);
		await cluster.drain();
		const actual = await vi.importActual<typeof import("../src/privilege/planner.ts")>("../src/privilege/planner.ts");
		let running = 0;
		let most = 0;
		let calls = 0;
		vi.mocked(planAuthorization).mockImplementation(async (input) => {
			running++;
			calls++;
			most = Math.max(most, running);
			await new Promise((resolve) => setTimeout(resolve, 100));
			try {
				return await actual.planAuthorization(input);
			} finally {
				running--;
			}
		});
		// Every sweep asks for the task's sync (its options are cleared first, so it counts as missed).
		await db
			.updateTable("tasks")
			.set({
				authorization: JSON.stringify({
					...parseTaskAuthorization((await rowOf(task.id))?.authorization ?? null),
					options: [],
				}),
			})
			.where("id", "=", task.id)
			.execute();
		await Promise.all(Array.from({ length: 10 }, () => cluster.sweepAuthorizationWaits()));
		await cluster.drain();
		expect(most).toBe(1);
		expect(calls).toBeLessThanOrEqual(3);
		expect(signOptionOf(await rowOf(task.id))).toBeDefined();
	});
});
