import { createHash } from "node:crypto";
import type { SigningKey } from "@crh/api";
import { generateKeyPair } from "@crh/noise";
import {
	authorizationCodec,
	decodeAuthorizationPayload,
	decode as decodeCbor,
	RemoteError,
	type TaskSpec,
	type TrustEntry,
	type TrustSummary,
	taskSpecToJson,
} from "@crh/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Audit } from "../src/audit/audit.ts";
import { dispatchCrhs } from "../src/cluster/authorization/authorized-start.ts";
import type { TaskAuthorizationRecord } from "../src/cluster/authorization.ts";
import { Cluster } from "../src/cluster/cluster.ts";
import { ClusterCore } from "../src/cluster/core.ts";
import type { ServerIdentity } from "../src/cluster/identity.ts";
import type { NodeLink } from "../src/cluster/links.ts";
import type { NodeRow } from "../src/cluster/nodes.ts";
import { TaskGroups, type TaskGroupView } from "../src/cluster/task-groups.ts";
import { trustDigest } from "../src/cluster/trust.ts";
import { bindMasterKey, MasterKey } from "../src/keys/master-key.ts";
import { authzEntryFromTrust, decide } from "../src/privilege/authz.ts";
import {
	type AuthorizationSigningKey,
	type AuthorizationSigningKeyStore,
	loadAuthorizationSigningKeys,
} from "../src/privilege/key.ts";
import { buildAuthorization, specSha256 } from "../src/privilege/payload.ts";
import { verifySshsig } from "../src/privilege/sshsig.ts";
import type { Db } from "../src/storage/db.ts";
import { createUser, defaultOrgId } from "../src/users/service.ts";
import { newId } from "../src/util/id.ts";
import { type FakeCrha, handshakeInit, TestAgentServer, waitFor } from "./helpers/agent.ts";
import { type App, call, login, makeApp } from "./helpers/api.ts";
import { openTestDb } from "./helpers/db.ts";

// Database setup and the fake agent handshake are cheap in isolation but not under a loaded machine.
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

describe("privileged forward dispatch", () => {
	let db: Db;
	let audit: Audit;
	let cluster: Cluster;
	let agents: TestAgentServer;
	let signing: AuthorizationSigningKey;
	let signingKeys: AuthorizationSigningKeyStore;
	let owner: { sessionId: string; userId: string; username: string; kind: "member" };
	let app: App;
	let cookie: string;

	beforeEach(async () => {
		db = await openTestDb("sqlite");
		const masterKey = MasterKey.generate();
		await bindMasterKey(db, masterKey);
		signingKeys = await loadAuthorizationSigningKeys(db, masterKey);
		const newest = signingKeys.newest;
		if (!newest) throw new Error("missing signing key");
		signing = newest;
		audit = new Audit(db);
		// A short trust wait keeps the "no report" case fast; every other test reports before dispatching.
		cluster = new Cluster(db, { signingKeys, trustWaitMs: 100, audit, nodeOfflineGraceMs: 10 });
		const identity: ServerIdentity = { keyPair: generateKeyPair(), fingerprint: "test-fingerprint" };
		agents = await TestAgentServer.start(db, identity, cluster);
		const user = await createUser(db, { username: "owner", kind: "member", password: "password-123" });
		owner = { sessionId: "s", userId: user.id, username: user.username, kind: "member" };
		app = makeApp(db, undefined, { cluster, audit, signingKeys });
		cookie = await login(app, "owner", "password-123");
	});

	afterEach(async () => {
		await cluster.close();
		await agents.close();
		await db.destroy();
	});

	const addNode = async (name: string, key: Uint8Array): Promise<NodeRow> => {
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
				id: newId(),
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

	/** Connects a fake crha that reports `mode` in Hello. */
	const connect = async (
		name: string,
		options: { mode?: string } = {},
	): Promise<{ node: NodeRow; crha: FakeCrha; key: ReturnType<typeof generateKeyPair> }> => {
		const key = generateKeyPair();
		const node = await addNode(name, key.publicKey);
		const crha = await agents.connect(key, handshakeInit());
		expect(await crha.peer.request("hello", { ...START, privilegedMode: options.mode ?? "forward" })).toEqual({
			acks: [],
		});
		await waitFor("link ready", () => cluster.isConnected(node.id));
		return { node, crha, key };
	};

	const summaryOf = (nodeId: string, trust: TrustEntry[], aliases: string[] = []): TrustSummary => ({
		nodeId,
		aliases,
		clockSkewMs: 0,
		identities: IDENTITIES,
		trust,
	});

	const sshEntry = (name: string, role: TrustEntry["role"], overrides: Partial<TrustEntry> = {}): TrustEntry => ({
		name,
		source: "local",
		role,
		key: { kind: "sshsig", publicKey: `ssh-ed25519 AAAA${name} ${name}`, fingerprint: `SHA256:${name}` },
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

	/** One of crhs's keys, allowed to restart nginx. */
	const crhsEntryFor = (key: AuthorizationSigningKey, name: string, overrides: Partial<TrustEntry> = {}): TrustEntry =>
		sshEntry(name, "crhs", {
			key: { kind: "sshsig", publicKey: key.authorizedKey, fingerprint: key.fingerprint },
			kinds: ["execute", "cosign"],
			requireExact: true,
			maxTtlMs: 5 * 60 * 1000,
			allow: [{ method: "exec", match: "prefix", pattern: "systemctl restart " }],
			...overrides,
		});

	/** crhs's first key, allowed to restart nginx. */
	const crhsEntry = (overrides: Partial<TrustEntry> = {}): TrustEntry => crhsEntryFor(signing, "crhs", overrides);

	/** The decoded authorization of a task.start, for key checks. */
	const authorizationOf = (start: FakeCrha["starts"][number] | undefined) => {
		const encoded = start?.authorizations?.[0];
		if (!encoded) throw new Error("missing authorization");
		return authorizationCodec.decode(decodeCbor(encoded));
	};

	/** The first SSHSIG of a task.start's authorization. */
	const authorizationSignature = (start: FakeCrha["starts"][number] | undefined): Uint8Array => {
		const signature = authorizationOf(start).signatures[0];
		if (signature?.kind !== "sshsig") throw new Error("expected an sshsig signature");
		return new Uint8Array(signature.blob);
	};

	/** The owner's own SSH key. */
	const aliceEntry = (): TrustEntry => sshEntry("alice", "user", { maxTtlMs: 24 * 60 * 60 * 1000 });

	const addCredential = async (): Promise<void> => {
		await db
			.insertInto("user_credentials")
			.values({
				id: newId(),
				user_id: owner.userId,
				kind: "ssh",
				name: "alice",
				public_key: "ssh-ed25519 AAAAalice alice",
				fingerprint: "SHA256:alice",
				credential_id: null,
				rp_id: null,
				created_at: new Date().toISOString(),
			})
			.execute();
	};

	/** Waits until the node row holds the digest of `summary`; the trust event itself is asynchronous. */
	const waitTrust = async (nodeId: string, summary: TrustSummary): Promise<void> => {
		await waitFor("trust stored", async () => {
			const row = await db.selectFrom("nodes").select("trust_digest").where("id", "=", nodeId).executeTakeFirst();
			return row?.trust_digest === trustDigest(summary);
		});
	};

	const auditRows = (action: string) =>
		db.selectFrom("audit_events").selectAll().where("action", "=", action).orderBy("seq").execute();

	const actor = () => ({ type: "user" as const, id: owner.userId, onBehalfOfUserId: owner.userId });

	const createPrivileged = (nodeId: string) =>
		cluster.createTask({ nodeId, spec: EXEC, privileged: true, actor: actor() });

	const taskView = async (id: string) => {
		const view = await cluster.getTask(id);
		if (!view) throw new Error(`task ${id} disappeared`);
		return view;
	};

	describe("trust cache", () => {
		it("stores a trust.summary and audits it only when the digest or status changes", async () => {
			const { node, crha } = await connect("trust-1");
			const first = summaryOf(node.id, [crhsEntry()]);

			crha.trust({ kind: "ok", summary: first });
			await waitTrust(node.id, first);
			const row = await db
				.selectFrom("nodes")
				.select(["trust_report", "trust_digest", "trust_updated_at"])
				.where("id", "=", node.id)
				.executeTakeFirstOrThrow();
			expect(row.trust_digest).toBe(trustDigest(first));
			expect(row.trust_updated_at).not.toBeNull();
			expect(JSON.parse(row.trust_report as string)).toMatchObject({ kind: "ok", summary: { nodeId: node.id } });
			await audit.flush();
			let events = await auditRows("node.trust_changed");
			expect(events).toHaveLength(1);
			expect(JSON.parse(events[0]?.detail as string)).toMatchObject({
				old_digest: null,
				old_status: null,
				new_digest: trustDigest(first),
				status: "ok",
			});

			// The same report again: stored, but not audited a second time.
			crha.trust({ kind: "ok", summary: first });
			await new Promise((resolve) => setTimeout(resolve, 50));
			await audit.flush();
			expect(await auditRows("node.trust_changed")).toHaveLength(1);

			// A changed summary (other aliases) changes the digest, so it is an actual change.
			const second = summaryOf(node.id, [crhsEntry()], ["prod"]);
			crha.trust({ kind: "ok", summary: second });
			await waitTrust(node.id, second);
			await audit.flush();
			events = await auditRows("node.trust_changed");
			expect(events).toHaveLength(2);
			expect(JSON.parse(events[1]?.detail as string)).toMatchObject({
				old_digest: trustDigest(first),
				old_status: "ok",
				new_digest: trustDigest(second),
				status: "ok",
			});
		});

		it("stores an unavailable report without a digest", async () => {
			const { node, crha } = await connect("trust-2");
			const ok = summaryOf(node.id, [crhsEntry()]);
			crha.trust({ kind: "ok", summary: ok });
			await waitTrust(node.id, ok);

			crha.trust({ kind: "unavailable", message: "the privileged mode is not running" });
			await waitFor("unavailable report stored", async () => {
				const row = await db
					.selectFrom("nodes")
					.select(["trust_report", "trust_digest"])
					.where("id", "=", node.id)
					.executeTakeFirst();
				return row?.trust_report?.includes('"unavailable"') ? row : undefined;
			});
			const row = await db
				.selectFrom("nodes")
				.select(["trust_report", "trust_digest"])
				.where("id", "=", node.id)
				.executeTakeFirstOrThrow();
			expect(row.trust_digest).toBeNull();
			expect(JSON.parse(row.trust_report as string)).toEqual({
				kind: "unavailable",
				message: "the privileged mode is not running",
			});
			await audit.flush();
			const events = await auditRows("node.trust_changed");
			expect(events).toHaveLength(2);
			expect(JSON.parse(events[1]?.detail as string)).toMatchObject({ new_digest: null, status: "unavailable" });
		});

		it("never sends revocations.add, not even after a trust report or a dispatch", async () => {
			const { node, crha } = await connect("no-revocations");
			const summary = summaryOf(node.id, [crhsEntry()]);
			crha.trust({ kind: "ok", summary });
			await waitTrust(node.id, summary);
			await createPrivileged(node.id);
			await waitFor("task.start", () => crha.starts.length === 1);
			// Let the report's follow-up work (re-planning, stored signatures) run before checking.
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(crha.commands).not.toContain("revocations.add");
		});
	});

	describe("forward dispatch", () => {
		it("signs a crhs authorization that the node's trust summary accepts", async () => {
			const { node, crha } = await connect("forward-1");
			const summary = summaryOf(node.id, [crhsEntry()]);
			crha.trust({ kind: "ok", summary });
			await waitTrust(node.id, summary);

			const created = await createPrivileged(node.id);
			await waitFor("task.start", () => crha.starts.length === 1);
			const start = crha.starts[0];
			if (!start) throw new Error("missing task.start");
			expect(start).toMatchObject({ taskId: created.id, attempt: 1, privileged: true });
			expect(start.authorizations).toHaveLength(1);

			// The bytes are CBOR(Authorization) and the signature is a valid SSHSIG over the payload.
			const authorization = authorizationCodec.decode(decodeCbor(start.authorizations[0] as Uint8Array));
			const signature = authorization.signatures[0];
			expect(signature?.kind).toBe("sshsig");
			if (signature?.kind !== "sshsig") throw new Error("expected an sshsig signature");
			expect(verifySshsig(signing.authorizedKey, authorization.payload, signature.blob)).toMatchObject({
				valid: true,
				keyType: "ssh-ed25519",
			});
			const payload = decodeAuthorizationPayload(authorization.payload);
			expect(payload).toMatchObject({
				nodes: [node.id],
				taskIds: [created.id],
				attempt: 1,
				command: { method: "exec" },
			});

			// The real decision port accepts it for the summary the node reported.
			const decision = decide({
				now: Date.now(),
				clockSkewMs: summary.clockSkewMs,
				nodeId: node.id,
				aliases: summary.aliases,
				trust: summary.trust.map(authzEntryFromTrust),
				task: { id: created.id, attempt: 1, spec: EXEC },
				authorization: {
					payload: authorization.payload,
					decoded: payload,
					signatures: [
						{ entry: authzEntryFromTrust(summary.trust[0] as TrustEntry), valid: true, userVerified: false },
					],
				},
				localApproval: null,
			});
			expect(decision).toMatchObject({ result: "accepted", entry: "crhs" });

			// The payload is stored verbatim, with the id being its SHA-256.
			const id = createHash("sha256").update(authorization.payload).digest("hex");
			const stored = await db.selectFrom("authorizations").selectAll().execute();
			expect(stored).toHaveLength(1);
			expect(stored[0]).toMatchObject({ id, issuer_user_id: null });
			expect(JSON.parse(stored[0]?.signatures as string)).toEqual([
				{ kind: "sshsig", blob: Buffer.from(signature.blob).toString("base64") },
			]);
			await audit.flush();
			const issued = await auditRows("authorization.issued");
			expect(issued).toHaveLength(1);
			expect(issued[0]).toMatchObject({ target_type: "authorization", target_id: id });
			expect(JSON.parse(issued[0]?.detail as string)).toMatchObject({
				node_id: node.id,
				task_id: created.id,
				attempt: 1,
				trust_digest: trustDigest(summary),
			});

			const running = await waitFor("running", async () => {
				const view = await taskView(created.id);
				return view.state === "running" ? view : undefined;
			});
			expect(running.authorization).toMatchObject({
				dispatchedPath: "crhs",
				payloadId: id,
				attempt: 1,
				trustDigest: trustDigest(summary),
			});
			expect(running.authorization?.plan.paths.map((path) => path.path)).toEqual(["crhs"]);
		});

		it("signs with the newest key each node trusts and the older key for a node that has not caught up", async () => {
			const older = signing;
			const newer = await signingKeys.add();
			const behind = await connect("forward-keys-behind");
			const caughtUp = await connect("forward-keys-caught-up");
			const behindSummary = summaryOf(behind.node.id, [crhsEntryFor(older, "crhs-old")]);
			const caughtUpSummary = summaryOf(caughtUp.node.id, [
				crhsEntryFor(older, "crhs-old"),
				crhsEntryFor(newer, "crhs-new"),
			]);
			behind.crha.trust({ kind: "ok", summary: behindSummary });
			caughtUp.crha.trust({ kind: "ok", summary: caughtUpSummary });
			await waitTrust(behind.node.id, behindSummary);
			await waitTrust(caughtUp.node.id, caughtUpSummary);

			const first = await createPrivileged(behind.node.id);
			await waitFor("task.start behind", () => behind.crha.starts.length === 1);
			expect(
				verifySshsig(
					older.authorizedKey,
					authorizationOf(behind.crha.starts[0]).payload,
					authorizationSignature(behind.crha.starts[0]),
				).valid,
			).toBe(true);
			expect(
				verifySshsig(
					newer.authorizedKey,
					authorizationOf(behind.crha.starts[0]).payload,
					authorizationSignature(behind.crha.starts[0]),
				).valid,
			).toBe(false);

			const second = await createPrivileged(caughtUp.node.id);
			await waitFor("task.start caught up", () => caughtUp.crha.starts.length === 1);
			expect(
				verifySshsig(
					newer.authorizedKey,
					authorizationOf(caughtUp.crha.starts[0]).payload,
					authorizationSignature(caughtUp.crha.starts[0]),
				).valid,
			).toBe(true);
			expect(
				verifySshsig(
					older.authorizedKey,
					authorizationOf(caughtUp.crha.starts[0]).payload,
					authorizationSignature(caughtUp.crha.starts[0]),
				).valid,
			).toBe(false);
			expect(first.nodeId).toBe(behind.node.id);
			expect(second.nodeId).toBe(caughtUp.node.id);
		});

		it("retries with attempt + 1 on authorization_rejected and falls back to the owner's user path", async () => {
			const { node, crha } = await connect("forward-2");
			await addCredential();
			const summary = summaryOf(node.id, [crhsEntry(), aliceEntry()]);
			crha.trust({ kind: "ok", summary });
			await waitTrust(node.id, summary);
			crha.answerStart = () => {
				throw new RemoteError("authorization_rejected", "step 7: deny rule matched");
			};

			const created = await createPrivileged(node.id);
			const waiting = await waitFor("awaiting_authorization with the user plan", async () => {
				const view = await taskView(created.id);
				return view.state === "awaiting_authorization" && view.authorization?.plan.paths[0]?.path === "user"
					? view
					: undefined;
			});
			expect(crha.starts).toHaveLength(1);
			expect(crha.starts[0]?.attempt).toBe(1);
			expect(waiting.authorization?.attempt).toBe(2);
			expect(waiting.handlerType).toBe("user");
			const rejectedPayload = waiting.authorization?.payloadId;
			expect(rejectedPayload).not.toBeNull();
			expect(
				await db
					.selectFrom("authorizations")
					.select("id")
					.where("id", "=", rejectedPayload as string)
					.executeTakeFirst(),
			).toBeDefined();
			expect(waiting.authorization).toMatchObject({
				tried: ["crhs"],
				dispatchedPath: null,
				attempt: 2,
				lastRejection: { code: "authorization_rejected", message: "step 7: deny rule matched", attempt: 1 },
			});
			expect(waiting.authorization?.plan.paths[0]?.entries).toEqual([
				{ name: "alice", role: "user", credential: "sshsig" },
			]);
			const row = await db.selectFrom("tasks").select("attempt").where("id", "=", created.id).executeTakeFirstOrThrow();
			expect(row.attempt).toBe(2);
		});

		it("ends rejected with the last crha code when no user or local path remains", async () => {
			const { node, crha } = await connect("forward-3");
			const summary = summaryOf(node.id, [crhsEntry()]);
			crha.trust({ kind: "ok", summary });
			await waitTrust(node.id, summary);
			crha.answerStart = () => {
				throw new RemoteError("authorization_rejected", "step 7: deny rule matched");
			};

			const created = await createPrivileged(node.id);
			const rejected = await waitFor("rejected", async () => {
				const view = await taskView(created.id);
				return view.state === "rejected" ? view : undefined;
			});
			expect(rejected.errorCode).toBe("authorization_rejected");
			expect(rejected.errorMessage).toContain("step 7: deny rule matched");
			expect(rejected.errorMessage).toContain("no one on this node can authorize this command");
			expect(rejected.authorization?.attempt).toBe(2);
			expect(crha.starts).toHaveLength(1);
		});

		it("re-plans a waiting task when the node's trust digest changes", async () => {
			const { node, crha } = await connect("forward-4");
			await addCredential();
			const before = summaryOf(node.id, [aliceEntry()]);
			crha.trust({ kind: "ok", summary: before });
			await waitTrust(node.id, before);

			const created = await createPrivileged(node.id);
			const waiting = await waitFor("awaiting_authorization", async () => {
				const view = await taskView(created.id);
				return view.state === "awaiting_authorization" ? view : undefined;
			});
			expect(waiting.authorization?.plan.paths.map((path) => path.path)).toEqual(["user"]);
			expect(crha.starts).toHaveLength(0);

			// The node now trusts crhs's key as well, so the same task can be dispatched without a signature.
			const after = summaryOf(node.id, [aliceEntry(), crhsEntry()]);
			crha.trust({ kind: "ok", summary: after });
			await waitFor("task.start after the digest change", () => crha.starts.length === 1);
			const running = await waitFor("running", async () => {
				const view = await taskView(created.id);
				return view.state === "running" ? view : undefined;
			});
			expect(running.authorization?.attempt).toBe(1);
			expect(running.authorization).toMatchObject({
				dispatchedPath: "crhs",
				attempt: 1,
				trustDigest: trustDigest(after),
			});
			expect(running.authorization?.plan.paths.map((path) => path.path)).toEqual(["crhs", "user"]);
		});

		it("rejects a waiting task when the new trust summary leaves no path", async () => {
			const { node, crha } = await connect("forward-10");
			await addCredential();
			const before = summaryOf(node.id, [aliceEntry()]);
			crha.trust({ kind: "ok", summary: before });
			await waitTrust(node.id, before);

			const created = await createPrivileged(node.id);
			await waitFor(
				"awaiting_authorization",
				async () => (await taskView(created.id)).state === "awaiting_authorization",
			);

			// The node stopped trusting the owner's key: the plan has no path left.
			crha.trust({ kind: "ok", summary: summaryOf(node.id, []) });
			const rejected = await waitFor("rejected", async () => {
				const view = await taskView(created.id);
				return view.state === "rejected" ? view : undefined;
			});
			expect(rejected.errorCode).toBe("authorization_required");
			expect(rejected.errorMessage).toContain("no one on this node can authorize this command");
			expect(rejected.authorization?.plan.paths).toEqual([]);
			expect(crha.starts).toHaveLength(0);
		});

		it("fails with privileged_unavailable when the node reports no usable trust summary", async () => {
			const { node, crha } = await connect("forward-5");
			crha.trust({ kind: "unavailable", message: "the privileged mode is not running" });
			await waitFor("unavailable stored", async () => {
				const row = await db.selectFrom("nodes").select("trust_report").where("id", "=", node.id).executeTakeFirst();
				return row?.trust_report?.includes('"unavailable"');
			});

			const created = await createPrivileged(node.id);
			const failed = await waitFor("failed", async () => {
				const view = await taskView(created.id);
				return view.state === "failed" ? view : undefined;
			});
			expect(failed).toMatchObject({
				errorCode: "privileged_unavailable",
				errorMessage: "the privileged mode is not running",
			});
			expect(crha.starts).toHaveLength(0);
		});

		it("does not plan from a trust summary kept from a previous connection", async () => {
			const { node, crha, key } = await connect("forward-11");
			const summary = summaryOf(node.id, [crhsEntry()]);
			crha.trust({ kind: "ok", summary });
			await waitTrust(node.id, summary);
			crha.ws.close();
			await crha.closed;
			await waitFor("link detached", () => !cluster.isConnected(node.id));

			// The node comes back but has not pushed its summary on the new connection yet.
			const second = await agents.connect(key, handshakeInit());
			expect(await second.peer.request("hello", { ...START, privilegedMode: "forward" })).toEqual({ acks: [] });
			await waitFor("link ready again", () => cluster.isConnected(node.id));

			const created = await createPrivileged(node.id);
			const failed = await waitFor("failed", async () => {
				const view = await taskView(created.id);
				return view.state === "failed" ? view : undefined;
			});
			expect(failed.errorCode).toBe("privileged_unavailable");
			expect(failed.errorMessage).toContain("on this connection");
			expect(second.starts).toHaveLength(0);
		});

		it("fails with privileged_unavailable when no report arrives", async () => {
			const { node, crha } = await connect("forward-6");
			const created = await createPrivileged(node.id);
			const failed = await waitFor("failed", async () => {
				const view = await taskView(created.id);
				return view.state === "failed" ? view : undefined;
			});
			expect(failed.errorCode).toBe("privileged_unavailable");
			expect(failed.errorMessage).toContain("has not reported a trust summary");
			expect(crha.starts).toHaveLength(0);
		});

		it("sends native privileged tasks without authorizations", async () => {
			const { node, crha } = await connect("native-1", { mode: "native" });
			const created = await createPrivileged(node.id);
			await waitFor("task.start", () => crha.starts.length === 1);
			expect(crha.starts[0]).toMatchObject({
				taskId: created.id,
				attempt: 1,
				privileged: true,
				authorizations: [],
			});
			await waitFor("running", async () => (await taskView(created.id)).state === "running");
		});

		it("keeps the plain dispatch for non-privileged tasks", async () => {
			const { node, crha } = await connect("forward-8");
			const created = await cluster.createTask({ nodeId: node.id, spec: EXEC, actor: actor() });
			await waitFor("task.start", () => crha.starts.length === 1);
			expect(crha.starts[0]).toMatchObject({ taskId: created.id, privileged: false, authorizations: [] });
		});

		it("cancels a task that waits for an authorization", async () => {
			const { node, crha } = await connect("forward-9");
			await addCredential();
			const summary = summaryOf(node.id, [aliceEntry()]);
			crha.trust({ kind: "ok", summary });
			await waitTrust(node.id, summary);

			const created = await createPrivileged(node.id);
			await waitFor(
				"awaiting_authorization",
				async () => (await taskView(created.id)).state === "awaiting_authorization",
			);
			expect(await cluster.cancelTask(created.id)).toBe(true);
			const cancelled = await taskView(created.id);
			expect(cancelled).toMatchObject({ state: "rejected", errorCode: "cancelled", cancelled: true });
			expect(cancelled.finishedAt).not.toBeNull();
			expect(crha.starts).toHaveLength(0);
			await audit.flush();
			const events = await auditRows("task.finished");
			expect(events).toHaveLength(1);
			// Without an actor the system cancelled it.
			expect(events[0]).toMatchObject({ actor_type: "system", actor_id: "cluster" });
		});

		it("names the actor who cancelled a waiting task in the audit", async () => {
			const { node, crha } = await connect("cancel-actor");
			await addCredential();
			const summary = summaryOf(node.id, [aliceEntry()]);
			crha.trust({ kind: "ok", summary });
			await waitTrust(node.id, summary);

			const created = await createPrivileged(node.id);
			await waitFor(
				"awaiting_authorization",
				async () => (await taskView(created.id)).state === "awaiting_authorization",
			);
			expect(await cluster.cancelTask(created.id, "the session was stopped", actor())).toBe(true);
			await audit.flush();
			const events = await auditRows("task.finished");
			expect(events).toHaveLength(1);
			expect(events[0]).toMatchObject({
				action: "task.finished",
				actor_type: "user",
				actor_id: owner.userId,
				on_behalf_of_user_id: owner.userId,
			});
			expect(JSON.parse(events[0]?.detail as string)).toMatchObject({ cancelled: true });
		});

		it("names the HTTP user who cancelled a task", async () => {
			const { node, crha } = await connect("cancel-api-actor");
			await addCredential();
			const summary = summaryOf(node.id, [aliceEntry()]);
			crha.trust({ kind: "ok", summary });
			await waitTrust(node.id, summary);

			const created = await createPrivileged(node.id);
			await waitFor(
				"awaiting_authorization",
				async () => (await taskView(created.id)).state === "awaiting_authorization",
			);
			const res = await call(app, `/api/tasks/${created.id}/cancel`, { method: "POST", cookie, body: {} });
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ cancelled: true });
			await audit.flush();
			const events = await auditRows("task.finished");
			expect(events).toHaveLength(1);
			expect(events[0]).toMatchObject({ actor_type: "user", actor_id: owner.userId });
		});

		it("names the actor of a running task's cancellation", async () => {
			const { node, crha } = await connect("cancel-running-actor");
			const created = await cluster.createTask({
				nodeId: node.id,
				spec: { ...EXEC, command: { argv: ["sleep", "30"] } },
				actor: actor(),
			});
			await waitFor("running", async () => (await taskView(created.id)).state === "running");
			expect(await cluster.cancelTask(created.id, undefined, actor())).toBe(true);
			crha.exit(created.id, { kind: "signal", value: "TERM" }, { cancelled: true });
			const done = await waitFor("exited", async () => {
				const view = await taskView(created.id);
				return view.state === "exited" ? view : undefined;
			});
			expect(done.cancelled).toBe(true);
			await audit.flush();
			const events = await auditRows("task.finished");
			expect(events).toHaveLength(1);
			expect(events[0]).toMatchObject({
				actor_type: "user",
				actor_id: owner.userId,
				on_behalf_of_user_id: owner.userId,
			});
		});
	});

	describe("task groups", () => {
		it("shows awaiting_authorization while every unfinished task waits, then finishes mixed", async () => {
			const groups = new TaskGroups(db, cluster, { audit });
			const a = await connect("group-a");
			const b = await connect("group-b");
			await addCredential();
			const summaryA = summaryOf(a.node.id, [crhsEntry()]);
			const summaryB = summaryOf(b.node.id, [aliceEntry()]);
			a.crha.trust({ kind: "ok", summary: summaryA });
			b.crha.trust({ kind: "ok", summary: summaryB });
			await waitTrust(a.node.id, summaryA);
			await waitTrust(b.node.id, summaryB);

			const groupId = await groups.create({
				targets: [a.node.name, b.node.name],
				nodeIds: [a.node.id, b.node.id],
				spec: EXEC,
				privileged: true,
				actor: actor(),
				parallel: 2,
				outputMode: "status",
			});

			// Node A is dispatched and runs; node B waits for a signature, so the group keeps running.
			await waitFor("task.start on node A", () => a.crha.starts.length === 1);
			const view = async () => (await groups.get(groupId)) as TaskGroupView;
			await waitFor("group running", async () => (await view()).state === "running");
			const taskA = (await view()).tasks.find((task) => task.nodeId === a.node.id);
			const taskB = (await view()).tasks.find((task) => task.nodeId === b.node.id);
			if (!taskA || !taskB) throw new Error("group tasks missing");
			expect(taskB.state).toBe("awaiting_authorization");
			expect(b.crha.starts).toHaveLength(0);

			// Once the only unfinished task waits for a signature, the group shows it.
			a.crha.exit(taskA.id, { kind: "code", value: 0 });
			await waitFor("group awaiting_authorization", async () => (await view()).state === "awaiting_authorization");

			expect(await cluster.cancelTask(taskB.id)).toBe(true);
			const finished = await waitFor("group finished", async () => {
				const group = await view();
				return group.state === "finished" ? group : undefined;
			});
			const byNode = new Map(finished.tasks.map((task) => [task.nodeId, task]));
			expect(byNode.get(a.node.id)).toMatchObject({ state: "exited", exitCode: 0 });
			expect(byNode.get(b.node.id)).toMatchObject({ state: "rejected", errorCode: "cancelled" });
			expect(finished.skipped).toEqual([]);
		});

		it("finishes a group when a deleted node ends its waiting member", async () => {
			const groups = new TaskGroups(db, cluster, { audit });
			const a = await connect("group-delete-a");
			const b = await connect("group-delete-b");
			await addCredential();
			const summaryA = summaryOf(a.node.id, [crhsEntry()]);
			const summaryB = summaryOf(b.node.id, [aliceEntry()]);
			a.crha.trust({ kind: "ok", summary: summaryA });
			b.crha.trust({ kind: "ok", summary: summaryB });
			await waitTrust(a.node.id, summaryA);
			await waitTrust(b.node.id, summaryB);

			const groupId = await groups.create({
				targets: [a.node.name, b.node.name],
				nodeIds: [a.node.id, b.node.id],
				spec: EXEC,
				privileged: true,
				actor: actor(),
				parallel: 2,
				outputMode: "status",
			});
			await waitFor("task.start on node A", () => a.crha.starts.length === 1);
			const view = async () => (await groups.get(groupId)) as TaskGroupView;
			await waitFor("group running", async () => (await view()).state === "running");
			const taskA = (await view()).tasks.find((task) => task.nodeId === a.node.id);
			const taskB = (await view()).tasks.find((task) => task.nodeId === b.node.id);
			if (!taskA || !taskB) throw new Error("group tasks missing");
			expect(taskB.state).toBe("awaiting_authorization");

			a.crha.exit(taskA.id, { kind: "code", value: 0 });
			await waitFor("group awaiting_authorization", async () => (await view()).state === "awaiting_authorization");

			// Deleting node B ends its parked member; the group's worker then sees the member settled and
			// finishes the group instead of waiting for a signature that can never arrive.
			expect(await cluster.endNodeTasks(b.node.id)).toBe(1);
			const finished = await waitFor("group finished", async () => {
				const group = await view();
				return group.state === "finished" ? group : undefined;
			});
			const byNode = new Map(finished.tasks.map((task) => [task.nodeId, task]));
			expect(byNode.get(a.node.id)).toMatchObject({ state: "exited", exitCode: 0 });
			expect(byNode.get(b.node.id)).toMatchObject({ state: "failed", errorCode: "node_deleted" });
			expect(finished.skipped).toEqual([]);
		});
	});

	describe("privilege API", () => {
		it("serves the node's trust panel and marks a kept report stale after a disconnect", async () => {
			const { node, crha } = await connect("api-trust");
			const summary = summaryOf(node.id, [crhsEntry()]);
			crha.trust({ kind: "ok", summary });
			await waitTrust(node.id, summary);

			const fresh = await call(app, `/api/nodes/${node.id}/trust`, { cookie });
			expect(fresh.status).toBe(200);
			const body = (await fresh.json()) as { trust: Record<string, unknown> };
			expect(body.trust).toMatchObject({ status: "ok", digest: trustDigest(summary), stale: false });
			expect((body.trust.summary as TrustSummary).trust[0]).toMatchObject({ name: "crhs", role: "crhs" });

			crha.ws.close();
			await crha.closed;
			await waitFor("link detached", () => !cluster.isConnected(node.id));
			const after = (await (await call(app, `/api/nodes/${node.id}/trust`, { cookie })).json()) as {
				trust: Record<string, unknown>;
			};
			expect(after.trust).toMatchObject({ status: "ok", digest: trustDigest(summary), stale: true });
		});

		it("lists, adds and deletes signing keys with their trust, refusing to drop a trusted key without force", async () => {
			await createUser(db, { username: "admin", kind: "admin", password: "password-123" });
			const admin = await login(app, "admin", "password-123");
			// The key routes are administrator-only and session-authenticated; a bearer token gets no session.
			expect((await call(app, "/api/privilege/signing-keys", { cookie })).status).toBe(403);
			expect(
				(await call(app, "/api/privilege/signing-keys", { headers: { authorization: "Bearer crh_token" } })).status,
			).toBe(401);

			const { node, crha } = await connect("keys-api");
			const newer = await signingKeys.add();
			const summary = summaryOf(node.id, [
				crhsEntryFor(signing, "crhs-old", { kinds: ["execute"] }),
				crhsEntryFor(newer, "crhs-new", { kinds: ["execute", "cosign"] }),
			]);
			crha.trust({ kind: "ok", summary });
			await waitTrust(node.id, summary);

			const listed = await call(app, "/api/privilege/signing-keys", { cookie: admin });
			expect(listed.status).toBe(200);
			const body = (await listed.json()) as { keys: SigningKey[] };
			expect(body.keys.map((key) => key.id)).toEqual([newer.id, signing.id]);
			expect(body.keys[0]).toMatchObject({
				publicKey: newer.authorizedKey,
				fingerprint: newer.fingerprint,
				createdAt: expect.any(String),
				trustedBy: [{ nodeId: node.id, nodeName: node.name, kinds: ["execute", "cosign"] }],
			});
			expect(body.keys[1]).toMatchObject({
				publicKey: signing.authorizedKey,
				trustedBy: [{ nodeId: node.id, nodeName: node.name, kinds: ["execute"] }],
			});
			// Keys are identified by fingerprint; a client still sending a name is refused.
			expect(body.keys[0]).not.toHaveProperty("name");

			const named = await call(app, "/api/privilege/signing-keys", {
				method: "POST",
				cookie: admin,
				body: { name: "third" },
			});
			expect(named.status).toBe(400);

			const added = await call(app, "/api/privilege/signing-keys", {
				method: "POST",
				cookie: admin,
				body: {},
			});
			expect(added.status).toBe(201);
			const addedKey = ((await added.json()) as { key: SigningKey }).key;
			expect(addedKey).toMatchObject({ trustedBy: [] });
			expect(addedKey).not.toHaveProperty("name");
			expect(signingKeys.newest?.id).toBe(addedKey.id);
			await audit.flush();
			const addedEvents = await auditRows("signing_key.added");
			expect(addedEvents).toHaveLength(1);
			expect(JSON.parse(addedEvents[0]?.detail as string)).toEqual({
				fingerprint: addedKey.fingerprint,
			});

			// A node still trusts the rotation key: deleting it needs an explicit force.
			const refused = await call(app, `/api/privilege/signing-keys/${newer.id}`, {
				method: "DELETE",
				cookie: admin,
				body: {},
			});
			expect(refused.status).toBe(409);
			expect(await refused.json()).toMatchObject({
				nodes: [{ nodeId: node.id, nodeName: node.name, kinds: ["execute", "cosign"] }],
			});
			expect(signingKeys.get(newer.id)).toBeDefined();

			const forced = await call(app, `/api/privilege/signing-keys/${newer.id}`, {
				method: "DELETE",
				cookie: admin,
				body: { force: true },
			});
			expect(forced.status).toBe(200);
			expect(signingKeys.get(newer.id)).toBeUndefined();
			await audit.flush();
			const deleted = await auditRows("signing_key.deleted");
			expect(JSON.parse(deleted.at(-1)?.detail as string)).toEqual({
				fingerprint: newer.fingerprint,
				force: true,
			});

			// Deleting down to zero is allowed: crhs then never signs, and planning treats crhs entries as unusable.
			for (const key of [...signingKeys.keys]) {
				const res = await call(app, `/api/privilege/signing-keys/${key.id}?force=true`, {
					method: "DELETE",
					cookie: admin,
					body: {},
				});
				expect(res.status).toBe(200);
			}
			expect(signingKeys.keys).toEqual([]);
			expect((await call(app, "/api/privilege/crhs-key", { cookie })).status).toBe(503);
			const created = await createPrivileged(node.id);
			const rejected = await waitFor("rejected without keys", async () => {
				const view = await taskView(created.id);
				return view.state === "rejected" ? view : undefined;
			});
			expect(rejected.errorCode).toBe("authorization_required");
			expect(crha.starts).toHaveLength(0);
		});

		it("serves crhs's newest authorized key, every key and its fingerprint", async () => {
			const res = await call(app, "/api/privilege/crhs-key", { cookie });
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({
				key: { authorizedKey: signing.authorizedKey, fingerprint: signing.fingerprint },
				keys: [{ authorizedKey: signing.authorizedKey, fingerprint: signing.fingerprint }],
			});

			// Without a signing key there is nothing to export.
			const bare = makeApp(db);
			const missing = await call(bare, "/api/privilege/crhs-key", { cookie });
			expect(missing.status).toBe(503);
		});
	});

	describe("authorization audit", () => {
		it("does not record authorization.issued when the claim loses the task", async () => {
			const node = await addNode("audit-claim", generateKeyPair().publicKey);
			const id = newId();
			const now = new Date().toISOString();
			await db
				.insertInto("tasks")
				.values({
					id,
					org_id: node.org_id,
					node_id: node.id,
					task_group_id: null,
					kind: EXEC.kind,
					spec: JSON.stringify(taskSpecToJson(EXEC)),
					input_size: null,
					input_sha256: null,
					privileged: 1,
					attempt: 1,
					timeout_ms: null,
					output_mode: "full",
					state: "awaiting_approval",
					exit_code: null,
					signal: null,
					timed_out: 0,
					cancelled: 0,
					error_code: null,
					error_message: null,
					actor_type: "user",
					actor_id: owner.userId,
					on_behalf_of_user_id: owner.userId,
					created_at: now,
					dispatched_at: null,
					accepted_at: null,
					finished_at: null,
					output_bytes: 0,
					output_head: null,
					output_tail: null,
					notice: null,
					output_file: null,
					late_result: null,
					rule_chain: null,
					approval: null,
					pending_input: null,
					root_session_id: null,
					handler_type: "user",
					handler_session_id: null,
				})
				.execute();
			const row = await db.selectFrom("tasks").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
			// Another path settles the task between the row read and the claim.
			await db.updateTable("tasks").set({ state: "rejected", error_code: "cancelled" }).where("id", "=", id).execute();

			const authorization = buildAuthorization({
				nodes: [node.id],
				command: {
					method: "exec",
					exact: { target: "systemctl restart nginx", specSha256: specSha256(EXEC) },
				},
				issuedAtMs: Date.now(),
				deadlineMs: Date.now() + 60_000,
				taskIds: [id],
				attempt: 1,
			});
			const record: TaskAuthorizationRecord = {
				plan: { paths: [] },
				tried: [],
				dispatchedPath: null,
				payloadId: null,
				attempt: 1,
				trustDigest: null,
				pending: null,
				local: null,
				lastRejection: null,
				updatedAt: now,
			};
			const core = new ClusterCore(db, { signingKeys, audit });
			await dispatchCrhs(
				core,
				id,
				row,
				node,
				{} as unknown as NodeLink,
				EXEC,
				new Uint8Array(),
				{},
				record,
				authorization,
				signing.fingerprint,
				["awaiting_approval"],
			);

			await audit.flush();
			expect(await auditRows("authorization.issued")).toEqual([]);
			// The payload row stays: it is written before the claim, and the record names it.
			expect(
				await db.selectFrom("authorizations").select("id").where("id", "=", authorization.id).executeTakeFirst(),
			).toBeDefined();
			expect((await db.selectFrom("tasks").select("state").where("id", "=", id).executeTakeFirstOrThrow()).state).toBe(
				"rejected",
			);
		});
	});
});
