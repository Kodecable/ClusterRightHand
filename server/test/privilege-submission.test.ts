import { createHash } from "node:crypto";
import { generateKeyPair } from "@crh/noise";
import {
	type Authorization,
	authorizationCodec,
	decodeAuthorizationPayload,
	decode as decodeCbor,
	encode as encodeCbor,
	type Facts,
	RemoteError,
	type Signature,
	type TaskSpec,
	type TrustEntry,
	type TrustSummary,
} from "@crh/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Audit } from "../src/audit/audit.ts";
import { Cluster, EMPTY_INPUT_REF } from "../src/cluster/cluster.ts";
import type { ServerIdentity } from "../src/cluster/identity.ts";
import type { NodeRow } from "../src/cluster/nodes.ts";
import { TaskGroups, type TaskGroupView } from "../src/cluster/task-groups.ts";
import { trustDigest } from "../src/cluster/trust.ts";
import { bindMasterKey, MasterKey } from "../src/keys/master-key.ts";
import { authzEntryFromTrust, decide } from "../src/privilege/authz.ts";
import { type AuthorizationSigningKey, loadAuthorizationSigningKey } from "../src/privilege/key.ts";
import { type AuthorizationCommand, buildAuthorization, specSha256 } from "../src/privilege/payload.ts";
import { signSshsig, verifySshsig } from "../src/privilege/sshsig.ts";
import type { Db } from "../src/storage/db.ts";
import { createUser, defaultOrgId } from "../src/users/service.ts";
import { type FakeCrha, handshakeInit, TestAgentServer, waitFor } from "./helpers/agent.ts";
import { type App, call, login, makeApp } from "./helpers/api.ts";
import { createSshKey, type TestSshKey } from "./helpers/authenticator.ts";
import { openTestDb } from "./helpers/db.ts";

const WEBAUTHN = { rpId: "crh.example.com", rpName: "ClusterRightHand", origins: ["https://crh.example.com"] };

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

describe("user authorizations", () => {
	let db: Db;
	let audit: Audit;
	let cluster: Cluster;
	let agents: TestAgentServer;
	let signing: AuthorizationSigningKey;
	let app: App;
	let owner: { userId: string; cookie: string };
	let other: { userId: string; cookie: string };
	let adminCookie: string;
	let ownerKey: TestSshKey;
	let otherKey: TestSshKey;

	beforeEach(async () => {
		db = await openTestDb("sqlite");
		const masterKey = MasterKey.generate();
		await bindMasterKey(db, masterKey);
		signing = await loadAuthorizationSigningKey(db, masterKey);
		audit = new Audit(db);
		cluster = new Cluster(db, { authorizationKey: signing, trustWaitMs: 100, audit, clockWarnMs: 60_000 });
		const identity: ServerIdentity = { keyPair: generateKeyPair(), fingerprint: "test-fingerprint" };
		agents = await TestAgentServer.start(db, identity, cluster);
		const ownerUser = await createUser(db, { username: "owner", kind: "member", password: "password-123" });
		const otherUser = await createUser(db, { username: "other", kind: "member", password: "password-123" });
		await createUser(db, { username: "admin", kind: "admin", password: "password-123" });
		app = makeApp(db, undefined, {
			cluster,
			audit,
			authorizationKey: signing,
			webauthn: WEBAUTHN,
			clockWarnMs: 60_000,
		});
		owner = { userId: ownerUser.id, cookie: await login(app, "owner", "password-123") };
		other = { userId: otherUser.id, cookie: await login(app, "other", "password-123") };
		adminCookie = await login(app, "admin", "password-123");
		ownerKey = createSshKey("ssh-ed25519");
		otherKey = createSshKey("ssh-ed25519");
		await addSshCredential(ownerKey, owner.cookie);
		await addSshCredential(otherKey, other.cookie);
	});

	afterEach(async () => {
		await cluster.close();
		await agents.close();
		await db.destroy();
	});

	async function addSshCredential(key: TestSshKey, cookie: string): Promise<void> {
		const res = await call(app, "/api/me/credentials/ssh", { cookie, body: { publicKey: key.line, name: "test" } });
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
				owner_user_id: owner.userId,
				name,
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
		return (await db.selectFrom("nodes").selectAll().where("id", "=", id).executeTakeFirstOrThrow()) as NodeRow;
	};

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
		await waitFor("trust stored", async () => {
			const row = await db.selectFrom("nodes").select("trust_digest").where("id", "=", node.id).executeTakeFirst();
			return row?.trust_digest === trustDigest(report);
		});
		return { node, crha, key };
	};

	const summaryOf = (nodeId: string, trust: TrustEntry[], groups: string[] = []): TrustSummary => ({
		nodeId,
		groups,
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
	const ownerEntry = (overrides: Partial<TrustEntry> = {}): TrustEntry =>
		sshEntry("alice", "user", {
			key: { kind: "sshsig", publicKey: ownerKey.line, fingerprint: ownerKey.fingerprint },
			maxTtlMs: 24 * HOUR,
			allow: [{ method: "exec", match: "prefix", pattern: "systemctl restart " }],
			...overrides,
		});

	/** crhs's own key, allowed to restart nginx (and to cosign). */
	const crhsTrustEntry = (overrides: Partial<TrustEntry> = {}): TrustEntry =>
		sshEntry("crhs", "crhs", {
			key: { kind: "sshsig", publicKey: signing.authorizedKey, fingerprint: signing.fingerprint },
			kinds: ["execute", "cosign"],
			requireExact: true,
			maxTtlMs: 5 * 60 * 1000,
			allow: [{ method: "exec", match: "prefix", pattern: "systemctl restart " }],
			...overrides,
		});

	const localTrustEntry = (overrides: Partial<TrustEntry> = {}): TrustEntry =>
		sshEntry("local-admins", "local", {
			key: { kind: "local", uids: [0] },
			...overrides,
		});

	const actor = () => ({ type: "user" as const, id: owner.userId, onBehalfOfUserId: owner.userId });

	const createPrivileged = async (nodeId: string) =>
		cluster.createTask({ nodeId, spec: EXEC, privileged: true, actor: actor() });

	const taskView = async (id: string) => {
		const view = await cluster.getTask(id);
		if (!view) throw new Error(`task ${id} disappeared`);
		return view;
	};

	const waitState = (id: string, state: string, extra?: (view: Awaited<ReturnType<typeof taskView>>) => boolean) =>
		waitFor(`${state} ${id}`, async () => {
			const view = await taskView(id);
			return view.state === state && (!extra || extra(view)) ? view : undefined;
		});

	const pendingFor = async (
		taskId: string,
		cookie = owner.cookie,
	): Promise<{ authorization: Record<string, unknown> | null }> => {
		const res = await call(app, `/api/tasks/${taskId}/authorization`, { cookie });
		expect(res.status).toBe(200);
		return (await res.json()) as { authorization: Record<string, unknown> | null };
	};

	/** Signs payload bytes with an SSH key and wraps the authorization as `crha grant` prints it. */
	const signedAuthorization = (payload: Uint8Array, key: TestSshKey = ownerKey): string => {
		const signature: Signature = { kind: "sshsig", blob: signSshsig(key.privateKey, key.blob, payload) };
		const authorization: Authorization = { payload, signatures: [signature] };
		return Buffer.from(encodeCbor(authorizationCodec.encode(authorization))).toString("base64");
	};

	const submit = (authorization: string, cookie = owner.cookie) =>
		call(app, "/api/authorizations", { cookie, body: { authorization } });

	const seedReusable = async (input: {
		nodes: string[];
		revoked?: boolean;
		issuer?: string;
		/** The command restriction; `EXEC` by default. */
		command?: AuthorizationCommand;
	}): Promise<string> => {
		const built = buildAuthorization({
			nodes: input.nodes,
			command: input.command ?? {
				method: "exec",
				exact: { target: "systemctl restart nginx", specSha256: specSha256(EXEC) },
			},
			issuedAtMs: Date.now(),
			deadlineMs: Date.now() + HOUR,
			taskIds: null,
		});
		const signature: Signature = { kind: "sshsig", blob: signSshsig(ownerKey.privateKey, ownerKey.blob, built.bytes) };
		await db
			.insertInto("authorizations")
			.values({
				id: built.id,
				org_id: await defaultOrgId(db),
				payload: Buffer.from(built.bytes).toString("base64"),
				signatures: JSON.stringify([{ kind: "sshsig", blob: Buffer.from(signature.blob).toString("base64") }]),
				issuer_user_id: input.issuer ?? owner.userId,
				task_ids: null,
				deadline: new Date(Date.now() + HOUR).toISOString(),
				created_at: new Date().toISOString(),
				revoked_at: input.revoked ? new Date().toISOString() : null,
			})
			.execute();
		return built.id;
	};

	const auditRows = (action: string) =>
		db.selectFrom("audit_events").selectAll().where("action", "=", action).orderBy("seq").execute();

	it("parks a task with a stable payload and dispatches it when the owner signs", async () => {
		const { node, crha } = await connect("pending-1", (id) => summaryOf(id, [ownerEntry()]));
		const task = await createPrivileged(node.id);
		await waitState(task.id, "awaiting_authorization");
		expect(crha.starts).toHaveLength(0);

		const { authorization } = await pendingFor(task.id);
		expect(authorization).not.toBeNull();
		const pending = authorization as {
			id: string;
			payload: string;
			decoded: Record<string, unknown>;
			challenge: string;
			deadline: string;
			taskIds: string[];
			attempt: number;
			passkeys: unknown[];
			localRequested: boolean;
			tried: string[];
		};
		const payloadBytes = new Uint8Array(Buffer.from(pending.payload, "base64"));
		expect(pending.id).toBe(createHash("sha256").update(payloadBytes).digest("hex"));
		expect(pending.taskIds).toEqual([task.id]);
		expect(pending.attempt).toBe(1);
		expect(pending.decoded).toMatchObject({
			nodes: [node.id],
			taskIds: [task.id],
			attempt: 1,
			command: {
				method: "exec",
				match: "exact",
				target: "systemctl restart nginx",
				specSha256: Buffer.from(specSha256(EXEC)).toString("hex"),
			},
		});
		expect(pending.challenge).toBe(
			Buffer.from(createHash("sha256").update("crh-auth-v1\0").update(payloadBytes).digest()).toString("base64url"),
		);
		expect(new Date(pending.deadline).getTime() - Date.now()).toBeGreaterThan(23.9 * HOUR);
		expect(pending.passkeys).toEqual([]);
		expect(pending.localRequested).toBe(false);

		// Only the owner may read the payload; an administrator with access gets a 403.
		const forbidden = await call(app, `/api/tasks/${task.id}/authorization`, { cookie: adminCookie });
		expect(forbidden.status).toBe(403);
		const stranger = await call(app, `/api/tasks/${task.id}/authorization`, { cookie: other.cookie });
		expect(stranger.status).toBe(404);

		// A new Cluster over the same database reads the same persisted payload (nothing is in memory).
		const restarted = new Cluster(db, { authorizationKey: signing });
		const restartedApp = makeApp(db, undefined, { cluster: restarted, authorizationKey: signing });
		const again = (await (
			await call(restartedApp, `/api/tasks/${task.id}/authorization`, { cookie: owner.cookie })
		).json()) as { authorization: { id: string; payload: string } };
		restarted.close();
		expect(again.authorization).toMatchObject({ id: pending.id, payload: pending.payload });

		const res = await submit(signedAuthorization(payloadBytes));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ authorization: { id: pending.id, dispatched: [task.id] } });

		await waitFor("task.start", () => crha.starts.length === 1);
		const start = crha.starts[0];
		if (!start) throw new Error("missing task.start");
		expect(start).toMatchObject({ taskId: task.id, attempt: 1, privileged: true });
		expect(start.authorizations).toHaveLength(1);
		const wire = authorizationCodec.decode(decodeCbor(start.authorizations[0] as Uint8Array));
		expect(Buffer.from(wire.payload)).toEqual(Buffer.from(payloadBytes));
		if (wire.signatures[0]?.kind !== "sshsig") throw new Error("expected an SSH signature");
		expect(verifySshsig(ownerKey.line, wire.payload, wire.signatures[0].blob)).toMatchObject({ valid: true });
		const summary = summaryOf(node.id, [ownerEntry()]);
		const decision = decide({
			now: Date.now(),
			clockSkewMs: summary.clockSkewMs,
			nodeId: node.id,
			nodeGroups: summary.groups,
			trust: summary.trust.map(authzEntryFromTrust),
			task: { id: task.id, attempt: 1, spec: EXEC },
			authorization: {
				payload: wire.payload,
				decoded: decodeAuthorizationPayload(wire.payload),
				signatures: [{ entry: authzEntryFromTrust(summary.trust[0] as TrustEntry), valid: true, userVerified: false }],
			},
			localApproval: null,
		});
		expect(decision).toMatchObject({ result: "accepted", entry: "alice" });

		const running = await waitState(task.id, "running");
		expect(running.authorization).toMatchObject({
			dispatchedPath: "user",
			payloadId: pending.id,
			attempt: 1,
			pending: null,
		});
		const stored = await db
			.selectFrom("authorizations")
			.selectAll()
			.where("id", "=", pending.id)
			.executeTakeFirstOrThrow();
		expect(stored).toMatchObject({ issuer_user_id: owner.userId, revoked_at: null });
		expect(JSON.parse(stored.task_ids as string)).toEqual([task.id]);
		await audit.flush();
		const submitted = await auditRows("authorization.submitted");
		expect(submitted).toHaveLength(1);
		expect(submitted[0]).toMatchObject({ target_type: "authorization", target_id: pending.id });
	});

	it("dispatches a signature submitted while the node was away once it reconnects", async () => {
		const { node, crha, key } = await connect("pending-offline", (id) => summaryOf(id, [ownerEntry()]));
		const task = await createPrivileged(node.id);
		await waitState(task.id, "awaiting_authorization");
		const pending = (await pendingFor(task.id)).authorization as { id: string; payload: string };

		// The node goes away before the owner signs; the submission is stored but dispatches nothing.
		crha.ws.close();
		await crha.closed;
		await waitFor("link detached", () => !cluster.isConnected(node.id));
		const res = await submit(signedAuthorization(new Uint8Array(Buffer.from(pending.payload, "base64"))));
		expect(res.status).toBe(200);
		expect((await res.json()) as Record<string, unknown>).toEqual({
			authorization: { id: pending.id, dispatched: [] },
		});

		// It reconnects and reports the same trust summary: the stored signature is used, no re-signing.
		const second = await agents.connect(key, handshakeInit());
		expect(await second.peer.request("hello", { ...START, privilegedMode: "forward" })).toEqual({ acks: [] });
		await waitFor("link ready again", () => cluster.isConnected(node.id));
		second.trust({ kind: "ok", summary: summaryOf(node.id, [ownerEntry()]) });
		await waitFor("task.start after the reconnect", () => second.starts.length === 1);
		expect(second.starts[0]?.authorizations).toHaveLength(1);
		await waitState(task.id, "running");
	});

	it("refuses a submission signed by another user's key and an expired one", async () => {
		const { node } = await connect("pending-2", (id) => summaryOf(id, [ownerEntry()]));
		const task = await createPrivileged(node.id);
		await waitState(task.id, "awaiting_authorization");
		const pending = (await pendingFor(task.id)).authorization as { payload: string };
		const payloadBytes = new Uint8Array(Buffer.from(pending.payload, "base64"));

		const foreign = await submit(signedAuthorization(payloadBytes, otherKey));
		expect(foreign.status).toBe(400);
		expect(((await foreign.json()) as { error: string }).error).toMatch(/none of the signatures/);

		const expired = buildAuthorization({
			nodes: [node.id],
			command: { method: "exec", exact: { target: "systemctl restart nginx", specSha256: specSha256(EXEC) } },
			issuedAtMs: Date.now() - 2 * HOUR,
			deadlineMs: Date.now() - HOUR,
			taskIds: [task.id],
			attempt: 1,
		});
		const late = await submit(signedAuthorization(expired.bytes));
		expect(late.status).toBe(400);
		expect(((await late.json()) as { error: string }).error).toMatch(/expired/);
		expect((await taskView(task.id)).state).toBe("awaiting_authorization");
	});

	it("appends crhs's cosignature when the accepting entry requires one", async () => {
		const { node, crha } = await connect("cosign-1", (id) =>
			summaryOf(id, [
				ownerEntry({ kinds: ["execute", "require-cosign"] }),
				crhsTrustEntry({ kinds: ["cosign"], allow: [] }),
			]),
		);
		const task = await createPrivileged(node.id);
		const waiting = await waitState(task.id, "awaiting_authorization");
		expect(waiting.authorization?.plan.paths[0]).toMatchObject({
			path: "user",
			entries: [{ name: "alice", cosign: "available" }],
		});
		const pending = (await pendingFor(task.id)).authorization as { id: string; payload: string };
		const res = await submit(signedAuthorization(new Uint8Array(Buffer.from(pending.payload, "base64"))));
		expect(res.status).toBe(200);
		await waitFor("task.start", () => crha.starts.length === 1);
		const wire = authorizationCodec.decode(decodeCbor(crha.starts[0]?.authorizations[0] as Uint8Array));
		expect(wire.signatures).toHaveLength(2);
		const cosign = wire.signatures[1];
		if (cosign?.kind !== "sshsig") throw new Error("expected a crhs SSH signature");
		expect(verifySshsig(signing.authorizedKey, wire.payload, cosign.blob)).toMatchObject({ valid: true });
		const summary = summaryOf(node.id, [
			ownerEntry({ kinds: ["execute", "require-cosign"] }),
			crhsTrustEntry({ kinds: ["cosign"], allow: [] }),
		]);
		const decision = decide({
			now: Date.now(),
			clockSkewMs: summary.clockSkewMs,
			nodeId: node.id,
			nodeGroups: summary.groups,
			trust: summary.trust.map(authzEntryFromTrust),
			task: { id: task.id, attempt: 1, spec: EXEC },
			authorization: {
				payload: wire.payload,
				decoded: decodeAuthorizationPayload(wire.payload),
				signatures: [
					{ entry: authzEntryFromTrust(summary.trust[0] as TrustEntry), valid: true, userVerified: false },
					{ entry: authzEntryFromTrust(summary.trust[1] as TrustEntry), valid: true, userVerified: false },
				],
			},
			localApproval: null,
		});
		expect(decision.result).toBe("accepted");
		await waitState(task.id, "running");
		await audit.flush();
		expect(await auditRows("authorization.cosigned")).toHaveLength(1);
		const stored = await db
			.selectFrom("authorizations")
			.select("signatures")
			.where("id", "=", pending.id)
			.executeTakeFirstOrThrow();
		expect(JSON.parse(stored.signatures)).toHaveLength(2);
	});

	it("shows a missing cosignature in the plan and refuses the task", async () => {
		const { node, crha } = await connect("cosign-2", (id) =>
			summaryOf(id, [ownerEntry({ kinds: ["execute", "require-cosign"] })]),
		);
		const task = await createPrivileged(node.id);
		// No crhs trust entry can cosign, so no path exists at all: the plan says why.
		const rejected = await waitState(task.id, "rejected");
		expect(rejected.errorCode).toBe("authorization_required");
		expect(rejected.errorMessage).toMatch(/cosignature/);
		expect(rejected.authorization?.plan.paths).toEqual([]);
		expect(rejected.authorization?.plan.reason).toMatch(/cosignature/);
		expect(crha.starts).toHaveLength(0);
		expect((await pendingFor(task.id)).authorization).toBeNull();
	});

	it("reuses a stored reusable authorization instead of asking for a signature", async () => {
		const { node, crha } = await connect("reuse-1", (id) => summaryOf(id, [ownerEntry()]));
		const id = await seedReusable({ nodes: [node.id] });
		const task = await createPrivileged(node.id);
		await waitFor("task.start from the stored authorization", () => crha.starts.length === 1);
		expect(crha.starts[0]?.authorizations).toHaveLength(1);
		const running = await waitState(task.id, "running");
		expect(running.authorization).toMatchObject({ dispatchedPath: "user", payloadId: id, attempt: 1 });
	});

	it("does not retry a reusable authorization the node already rejected", async () => {
		const { node, crha } = await connect("reuse-rejected", (id) => summaryOf(id, [ownerEntry()]));
		await seedReusable({ nodes: [node.id] });
		crha.answerStart = () => {
			throw new RemoteError("authorization_rejected", "step 7: deny rule matched");
		};
		const task = await createPrivileged(node.id);
		// One automatic attempt with the stored authorization, then the task waits for a real signature
		// for attempt 2 instead of looping on the same rejected payload.
		const waiting = await waitFor("waiting for a new signature", async () => {
			const view = await taskView(task.id);
			return view.state === "awaiting_authorization" && view.authorization?.attempt === 2 ? view : undefined;
		});
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(crha.starts).toHaveLength(1);
		expect(waiting.authorization?.lastRejection).toMatchObject({ code: "authorization_rejected", attempt: 1 });
		expect((await pendingFor(task.id)).authorization).not.toBeNull();
	});

	it("does not reuse a reusable authorization for a require-cosign entry, nor a revoked one", async () => {
		const { node } = await connect("reuse-2", (id) =>
			summaryOf(id, [
				ownerEntry({ kinds: ["execute", "require-cosign"] }),
				crhsTrustEntry({ kinds: ["cosign"], allow: [] }),
			]),
		);
		await seedReusable({ nodes: [node.id] });
		const first = await createPrivileged(node.id);
		await waitState(first.id, "awaiting_authorization");

		const plain = await connect("reuse-3", (id) => summaryOf(id, [ownerEntry()]));
		await seedReusable({ nodes: [plain.node.id], revoked: true });
		const second = await createPrivileged(plain.node.id);
		await waitState(second.id, "awaiting_authorization");
		expect(plain.crha.starts).toHaveLength(0);
	});

	/** Every task.input chunk a fake crha received for a task, in order. */
	const inputOf = (crha: FakeCrha, taskId: string): Buffer =>
		Buffer.concat(crha.inputs.filter((chunk) => chunk.taskId === taskId).map((chunk) => Buffer.from(chunk.data)));

	it("carries an exec task's stdin through a reused owner authorization", async () => {
		const { node, crha } = await connect("reuse-input-exec", (id) => summaryOf(id, [ownerEntry({ allow: [] })]));
		const stdin = Buffer.from("first line\nsecond line\n");
		const stdinRef = { size: stdin.length, sha256: createHash("sha256").update(stdin).digest() };
		const stored: TaskSpec = { ...EXEC, command: { argv: ["cat"] }, stdin: stdinRef };
		await seedReusable({
			nodes: [node.id],
			command: { method: "exec", exact: { target: "cat", specSha256: specSha256(stored) } },
		});
		// The task is dispatched at once (no approval, no parking): its bytes exist only in memory here.
		const task = await cluster.createTask({
			nodeId: node.id,
			spec: { ...EXEC, command: { argv: ["cat"] } },
			input: stdin,
			privileged: true,
			actor: actor(),
		});
		await waitFor("task.start from the stored authorization", () => crha.starts.length === 1);
		await waitFor("the input of the reused task", () => inputOf(crha, task.id).length === stdin.length);
		expect(crha.starts[0]).toMatchObject({ taskId: task.id, privileged: true, authorizations: expect.any(Array) });
		expect(inputOf(crha, task.id).toString()).toBe(stdin.toString());
		expect(await taskView(task.id)).toMatchObject({
			state: "running",
			authorization: { dispatchedPath: "user" },
		});
	});

	it("carries a file.write's content through a reused owner authorization", async () => {
		const { node, crha } = await connect("reuse-input-write", (id) => summaryOf(id, [ownerEntry({ allow: [] })]));
		const content = Buffer.from("alpha\nbeta\n");
		const stored: TaskSpec = {
			kind: "file.write",
			path: "/tmp/reuse.txt",
			content: { size: content.length, sha256: createHash("sha256").update(content).digest() },
			overwrite: false,
			mode: 0,
			owner: "",
			group: "",
		};
		await seedReusable({
			nodes: [node.id],
			command: { method: "file.write", exact: { target: "/tmp/reuse.txt", specSha256: specSha256(stored) } },
		});
		const task = await cluster.createTask({
			nodeId: node.id,
			spec: { ...stored, content: EMPTY_INPUT_REF },
			input: content,
			privileged: true,
			actor: actor(),
		});
		await waitFor("task.start from the stored authorization", () => crha.starts.length === 1);
		await waitFor("the content of the reused task", () => inputOf(crha, task.id).length === content.length);
		expect(inputOf(crha, task.id).toString()).toBe(content.toString());
	});

	it("re-parks a rejected reuse with its input and sends it with the next attempt", async () => {
		const { node, crha } = await connect("reuse-input-retry", (id) => summaryOf(id, [ownerEntry({ allow: [] })]));
		const stdin = Buffer.from("payload the owner signed\n");
		const stdinRef = { size: stdin.length, sha256: createHash("sha256").update(stdin).digest() };
		const stored: TaskSpec = { ...EXEC, command: { argv: ["cat"] }, stdin: stdinRef };
		await seedReusable({
			nodes: [node.id],
			command: { method: "exec", exact: { target: "cat", specSha256: specSha256(stored) } },
		});
		let reject = true;
		crha.answerStart = () => {
			if (!reject) return;
			reject = false;
			throw new RemoteError("authorization_rejected", "step 7: deny rule matched");
		};
		const task = await cluster.createTask({
			nodeId: node.id,
			spec: { ...EXEC, command: { argv: ["cat"] } },
			input: stdin,
			privileged: true,
			actor: actor(),
		});
		const waiting = await waitFor("waiting for a new signature", async () => {
			const view = await taskView(task.id);
			return view.state === "awaiting_authorization" && view.authorization?.attempt === 2 ? view : undefined;
		});
		// Nothing ran and no input was sent; the rejected attempt's bytes are held for the retry.
		expect(crha.starts).toHaveLength(1);
		expect(crha.inputs).toHaveLength(0);
		const parked = await db
			.selectFrom("tasks")
			.select("pending_input")
			.where("id", "=", task.id)
			.executeTakeFirstOrThrow();
		expect(Buffer.from(parked.pending_input as string, "base64").toString()).toBe(stdin.toString());

		// The owner signs the attempt+1 payload; the task's input goes out with it.
		const { authorization } = await pendingFor(task.id);
		const payload = new Uint8Array(Buffer.from((authorization as { payload: string }).payload, "base64"));
		expect((await submit(signedAuthorization(payload))).status).toBe(200);
		await waitFor("the second task.start", () => crha.starts.length === 2);
		await waitFor("the input of the retried task", () => inputOf(crha, task.id).length === stdin.length);
		expect(crha.starts[1]).toMatchObject({ taskId: task.id, attempt: 2 });
		expect(inputOf(crha, task.id).toString()).toBe(stdin.toString());
		expect(waiting.authorization?.lastRejection).toMatchObject({ code: "authorization_rejected", attempt: 1 });
	});

	it("dispatches every task of a group with one signature and re-signs only a rejected node", async () => {
		const groups = new TaskGroups(db, cluster, { audit });
		const a = await connect("group-a", (id) => summaryOf(id, [ownerEntry()]));
		const b = await connect("group-b", (id) => summaryOf(id, [ownerEntry()]));
		const groupId = await groups.create({
			targets: [a.node.name, b.node.name],
			nodeIds: [a.node.id, b.node.id],
			spec: EXEC,
			privileged: true,
			actor: actor(),
			parallel: 2,
			outputMode: "status",
		});
		const view = async () => (await groups.get(groupId)) as TaskGroupView;
		await waitFor("both tasks waiting", async () => {
			const group = await view();
			return group.tasks.length === 2 && group.tasks.every((task) => task.state === "awaiting_authorization");
		});
		const res = await call(app, `/api/task-groups/${groupId}/authorization`, { cookie: owner.cookie });
		expect(res.status).toBe(200);
		const shared = (await res.json()) as {
			group: { authorization: { id: string; payload: string; taskIds: string[]; attempt: number }; tasks: unknown[] };
		};
		const tasks = (await view()).tasks;
		expect(shared.group.authorization.taskIds.sort()).toEqual(tasks.map((task) => task.id).sort());
		expect(shared.group.tasks).toHaveLength(2);

		// Only the owner sees the group payload.
		expect((await call(app, `/api/task-groups/${groupId}/authorization`, { cookie: other.cookie })).status).toBe(403);

		const submitted = await submit(
			signedAuthorization(new Uint8Array(Buffer.from(shared.group.authorization.payload, "base64"))),
		);
		expect(submitted.status).toBe(200);
		expect((await submitted.json()) as Record<string, unknown>).toEqual({
			authorization: {
				id: shared.group.authorization.id,
				dispatched: expect.arrayContaining(tasks.map((task) => task.id)),
			},
		});
		await waitFor("both starts", () => a.crha.starts.length === 1 && b.crha.starts.length === 1);
		expect(Buffer.from(a.crha.starts[0]?.authorizations[0] as Uint8Array)).toEqual(
			Buffer.from(b.crha.starts[0]?.authorizations[0] as Uint8Array),
		);
		await waitFor("both running", async () => {
			const group = await view();
			return group.tasks.every((task) => task.state === "running");
		});
	});

	it("carries the same authorization, cosignature included, to every node of a group", async () => {
		const groups = new TaskGroups(db, cluster, { audit });
		const a = await connect("group-cosign-a", (id) =>
			summaryOf(id, [
				ownerEntry({ kinds: ["execute", "require-cosign"] }),
				crhsTrustEntry({ kinds: ["cosign"], allow: [] }),
			]),
		);
		const b = await connect("group-cosign-b", (id) => summaryOf(id, [ownerEntry()]));
		const groupId = await groups.create({
			targets: [a.node.name, b.node.name],
			nodeIds: [a.node.id, b.node.id],
			spec: EXEC,
			privileged: true,
			actor: actor(),
			parallel: 2,
			outputMode: "status",
		});
		const view = async () => (await groups.get(groupId)) as TaskGroupView;
		await waitFor("both tasks waiting", async () => {
			const group = await view();
			return group.tasks.length === 2 && group.tasks.every((task) => task.state === "awaiting_authorization");
		});
		const shared = (await (
			await call(app, `/api/task-groups/${groupId}/authorization`, { cookie: owner.cookie })
		).json()) as { group: { authorization: { payload: string } } };
		await submit(signedAuthorization(new Uint8Array(Buffer.from(shared.group.authorization.payload, "base64"))));
		await waitFor("both starts", () => a.crha.starts.length === 1 && b.crha.starts.length === 1);
		const first = a.crha.starts[0]?.authorizations[0] as Uint8Array;
		const second = b.crha.starts[0]?.authorizations[0] as Uint8Array;
		expect(Buffer.from(first)).toEqual(Buffer.from(second));
		const wire = authorizationCodec.decode(decodeCbor(first));
		expect(wire.signatures).toHaveLength(2);
		expect(wire.signatures[1]?.kind).toBe("sshsig");
		await waitFor("both running", async () => {
			const group = await view();
			return group.tasks.every((task) => task.state === "running");
		});
	});

	it("re-plans only the node a group's signature was rejected on, with attempt + 1", async () => {
		const groups = new TaskGroups(db, cluster, { audit });
		const a = await connect("group-reject-a", (id) => summaryOf(id, [ownerEntry()]));
		const b = await connect("group-reject-b", (id) => summaryOf(id, [ownerEntry()]));
		a.crha.answerStart = () => {
			throw new RemoteError("authorization_rejected", "step 7: deny rule matched");
		};
		const groupId = await groups.create({
			targets: [a.node.name, b.node.name],
			nodeIds: [a.node.id, b.node.id],
			spec: EXEC,
			privileged: true,
			actor: actor(),
			parallel: 2,
			outputMode: "status",
		});
		const view = async () => (await groups.get(groupId)) as TaskGroupView;
		await waitFor("both tasks waiting", async () => {
			const group = await view();
			return group.tasks.length === 2 && group.tasks.every((task) => task.state === "awaiting_authorization");
		});
		const shared = (await (
			await call(app, `/api/task-groups/${groupId}/authorization`, { cookie: owner.cookie })
		).json()) as { group: { authorization: { payload: string } } };
		await submit(signedAuthorization(new Uint8Array(Buffer.from(shared.group.authorization.payload, "base64"))));

		// Node B accepted; node A rejected before accepting, so its task waits for a new payload for the
		// next attempt, covering only itself.
		const rejected = await waitFor("rejected task waiting again", async () => {
			const group = await view();
			const taskA = group.tasks.find((task) => task.nodeId === a.node.id);
			return taskA?.state === "awaiting_authorization" && taskA.authorization?.attempt === 2 ? taskA : undefined;
		});
		const taskB = (await view()).tasks.find((task) => task.nodeId === b.node.id);
		await waitFor("B running", async () => (await taskView(taskB?.id as string)).state === "running");
		expect(rejected.authorization).toMatchObject({
			attempt: 2,
			lastRejection: { code: "authorization_rejected", attempt: 1 },
			dispatchedPath: null,
		});
		expect(rejected.authorization?.tried).not.toContain("crhs");
		// The new payload covers only the rejected task, for the new attempt.
		const pending = (await pendingFor(rejected.id)).authorization as { taskIds: string[]; attempt: number };
		expect(pending.taskIds).toEqual([rejected.id]);
		expect(pending.attempt).toBe(2);
		expect(a.crha.starts).toHaveLength(1);
		expect(b.crha.starts).toHaveLength(1);
	});

	it("does not dispatch a waiting member of a group that already ended", async () => {
		const groups = new TaskGroups(db, cluster, { audit });
		const { node, crha } = await connect("group-ended", (id) => summaryOf(id, [ownerEntry()]));
		const groupId = await groups.create({
			targets: [node.name],
			nodeIds: [node.id],
			spec: EXEC,
			privileged: true,
			actor: actor(),
			outputMode: "status",
		});
		const waiting = await waitFor("waiting", async () => {
			const group = await groups.get(groupId);
			const task = group?.tasks[0];
			return task?.state === "awaiting_authorization" ? task : undefined;
		});
		// A restart interrupts the group; a signature that arrives afterwards must not start the member.
		await db.updateTable("task_groups").set({ state: "interrupted" }).where("id", "=", groupId).execute();
		const { authorization } = await pendingFor(waiting.id);
		const payload = new Uint8Array(Buffer.from((authorization as { payload: string }).payload, "base64"));
		const res = await submit(signedAuthorization(payload));
		expect(res.status).toBe(200);
		expect((await res.json()) as Record<string, unknown>).toMatchObject({ authorization: { dispatched: [] } });
		expect(crha.starts).toHaveLength(0);
		expect((await taskView(waiting.id)).state).toBe("awaiting_authorization");
	});

	it("requests local approval, dispatches on approval and rejects on denial", async () => {
		const { node, crha } = await connect("local-1", (id) => summaryOf(id, [localTrustEntry()]));
		const task = await createPrivileged(node.id);
		await waitFor("local.request", () => crha.localRequests.length === 1);
		expect((await taskView(task.id)).state).toBe("awaiting_authorization");
		expect(await pendingFor(task.id)).toEqual({ authorization: null });
		expect(crha.localRequests[0]).toMatchObject({ taskId: task.id, attempt: 1, spec: EXEC });

		crha.peer.emit("local.decision", { taskId: task.id, attempt: 1, state: { kind: "approved" } });
		await waitFor("task.start after approval", () => crha.starts.length === 1);
		expect(crha.starts[0]).toMatchObject({ taskId: task.id, attempt: 1, authorizations: [], privileged: true });
		const running = await waitState(task.id, "running");
		expect(running.authorization).toMatchObject({ dispatchedPath: "local", pending: null });

		const denied = await createPrivileged(node.id);
		await waitFor("second local.request", () => crha.localRequests.length === 2);
		crha.peer.emit("local.decision", {
			taskId: denied.id,
			attempt: 1,
			state: { kind: "denied", message: "not on my watch" },
		});
		const rejected = await waitFor("denied task", async () => {
			const view = await taskView(denied.id);
			return view.state === "rejected" ? view : undefined;
		});
		expect(rejected).toMatchObject({ errorCode: "authorization_rejected", errorMessage: "not on my watch" });
	});

	it("falls back from a rejected crhs signature to local approval with attempt + 1", async () => {
		const { node, crha } = await connect("fallback-local", (id) =>
			summaryOf(id, [crhsTrustEntry(), localTrustEntry()]),
		);
		let rejectFirst = true;
		crha.answerStart = () => {
			if (!rejectFirst) return;
			rejectFirst = false;
			throw new RemoteError("authorization_rejected", "step 7: deny rule matched");
		};
		const task = await createPrivileged(node.id);
		await waitFor("local.request for the retry", () => crha.localRequests.length === 1);
		expect(crha.starts).toHaveLength(1);
		expect(crha.starts[0]?.attempt).toBe(1);
		expect(crha.localRequests[0]).toMatchObject({ taskId: task.id, attempt: 2 });

		crha.peer.emit("local.decision", { taskId: task.id, attempt: 2, state: { kind: "approved" } });
		await waitFor("task.start after the local approval", () => crha.starts.length === 2);
		expect(crha.starts[1]).toMatchObject({ taskId: task.id, attempt: 2, authorizations: [] });
		await waitState(task.id, "running");
	});

	it("withdraws a local request when the owner signs and when the task is cancelled", async () => {
		const { node, crha } = await connect("local-2", (id) => summaryOf(id, [ownerEntry(), localTrustEntry()]));
		const task = await createPrivileged(node.id);
		await waitFor("local.request", () => crha.localRequests.length === 1);
		const pending = (await pendingFor(task.id)).authorization as { payload: string };
		expect(pending).not.toBeNull();
		await submit(signedAuthorization(new Uint8Array(Buffer.from(pending.payload, "base64"))));
		await waitFor("task.start", () => crha.starts.length === 1);
		await waitFor("local.withdraw", () => crha.localWithdrawals.length === 1);
		expect(crha.localWithdrawals[0]).toEqual({ taskId: task.id, attempt: 1 });

		const cancelled = await createPrivileged(node.id);
		await waitFor("second local.request", () => crha.localRequests.length === 2);
		expect(await cluster.cancelTask(cancelled.id)).toBe(true);
		await waitFor("withdraw on cancel", () => crha.localWithdrawals.length === 2);
		expect(crha.localWithdrawals[1]).toEqual({ taskId: cancelled.id, attempt: 1 });
	});

	it("resends local.request after a new ok trust report, and drops the path when the node refuses it", async () => {
		const { node, crha } = await connect("local-3", (id) => summaryOf(id, [localTrustEntry()]));
		await createPrivileged(node.id);
		await waitFor("local.request", () => crha.localRequests.length === 1);
		crha.trust({ kind: "ok", summary: summaryOf(node.id, [localTrustEntry()]) });
		await waitFor("local.request resent", () => crha.localRequests.length === 2);

		// A node that answers local_not_trusted: the local path is dropped and the task re-planned.
		const otherNode = await connect("local-4", (id) => summaryOf(id, [ownerEntry(), localTrustEntry()]));
		otherNode.crha.answerLocal = () => {
			throw new RemoteError("local_not_trusted", "no local trust entry");
		};
		const replanned = await createPrivileged(otherNode.node.id);
		const waiting = await waitState(replanned.id, "awaiting_authorization");
		expect(waiting.authorization?.tried).toContain("local");
		expect(waiting.authorization?.plan.paths.map((path) => path.path)).toEqual(["user"]);
		expect((await pendingFor(replanned.id)).authorization).not.toBeNull();
	});

	it("lets owners and administrators revoke an authorization, but not other users", async () => {
		const mine = await seedReusable({ nodes: ["some-node"] });
		const theirs = await seedReusable({ nodes: ["another-node"], issuer: other.userId });
		expect(
			(await call(app, `/api/authorizations/${theirs}/revoke`, { method: "POST", cookie: owner.cookie, body: {} }))
				.status,
		).toBe(403);
		const owned = await call(app, `/api/authorizations/${mine}/revoke`, {
			method: "POST",
			cookie: owner.cookie,
			body: {},
		});
		expect(owned.status).toBe(200);
		const byAdmin = await call(app, `/api/authorizations/${theirs}/revoke`, {
			method: "POST",
			cookie: adminCookie,
			body: {},
		});
		expect(byAdmin.status).toBe(200);
		const row = await db
			.selectFrom("authorizations")
			.select("revoked_at")
			.where("id", "=", theirs)
			.executeTakeFirstOrThrow();
		expect(row.revoked_at).not.toBeNull();

		const list = (await (await call(app, "/api/authorizations", { cookie: other.cookie })).json()) as {
			items: {
				id: string;
				revokedAt: string | null;
				command: { method: string; match: string; target: string; specSha256: string };
				nodes: string[];
				taskIds: string[] | null;
			}[];
		};
		expect(list.items.map((entry) => entry.id)).toEqual([theirs]);
		expect(list.items[0]?.revokedAt).not.toBeNull();
		expect(list.items[0]?.command).toEqual({
			method: "exec",
			match: "exact",
			target: "systemctl restart nginx",
			specSha256: Buffer.from(specSha256(EXEC)).toString("hex"),
		});
		expect(list.items[0]?.nodes).toEqual(["another-node"]);
		expect(list.items[0]?.taskIds).toBeNull();
		const adminList = (await (await call(app, "/api/authorizations", { cookie: adminCookie })).json()) as {
			items: unknown[];
		};
		expect(adminList.items).toHaveLength(2);
	});

	it("warns about a node whose clock differs from crhs", async () => {
		const { node, crha } = await connect("clock-1", (id) => summaryOf(id, []));
		const facts = (clockOffsetMs: number): Facts => ({
			hostname: node.name,
			osId: "ubuntu",
			osVersionId: "24.04",
			osPrettyName: "Ubuntu 24.04",
			kernel: "6.8",
			arch: "x86_64",
			initSystem: "systemd",
			packageManagers: ["apt"],
			privilegeTools: ["sudo"],
			notesPath: "",
			groups: [],
			clockOffsetMs,
			shells: { sh: "/bin/sh", bash: null },
		});
		crha.peer.emit("facts", facts(120_000));
		const warned = await waitFor("clock warning", async () => {
			const res = await call(app, `/api/nodes/${node.id}`, { cookie: owner.cookie });
			const body = (await res.json()) as { node: { clockWarning: string | null } };
			return body.node.clockWarning ?? undefined;
		});
		expect(warned).toContain("120 s");

		crha.peer.emit("facts", facts(30_000));
		await waitFor("no clock warning", async () => {
			const res = await call(app, `/api/nodes/${node.id}`, { cookie: owner.cookie });
			const body = (await res.json()) as { node: { clockWarning: string | null } };
			return body.node.clockWarning === null;
		});

		// clock_warn = 0 turns the warning off entirely.
		const quiet = makeApp(db, undefined, { cluster, clockWarnMs: 0, authorizationKey: signing });
		crha.peer.emit("facts", facts(600_000));
		await waitFor("facts stored", async () => {
			const row = await db.selectFrom("nodes").select("facts").where("id", "=", node.id).executeTakeFirst();
			return row?.facts?.includes("600000");
		});
		const body = (await (await call(quiet, `/api/nodes/${node.id}`, { cookie: owner.cookie })).json()) as {
			node: { clockWarning: string | null };
		};
		expect(body.node.clockWarning).toBeNull();
	});
});
