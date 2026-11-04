import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { generateKeyPair } from "@crh/noise";
import {
	authorizationCodec,
	decode as decodeCbor,
	type TaskSpec,
	type TrustEntry,
	type TrustSummary,
} from "@crh/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Audit } from "../src/audit/audit.ts";
import { Cluster } from "../src/cluster/cluster.ts";
import type { ServerIdentity } from "../src/cluster/identity.ts";
import type { NodeRow } from "../src/cluster/nodes.ts";
import { trustDigest } from "../src/cluster/trust.ts";
import { bindMasterKey, MasterKey } from "../src/keys/master-key.ts";
import { type AuthorizationSigningKey, loadAuthorizationSigningKey } from "../src/privilege/key.ts";
import { verifyAssertion, webauthnChallenge } from "../src/privilege/webauthn.ts";
import type { Db } from "../src/storage/db.ts";
import { createUser, defaultOrgId } from "../src/users/service.ts";
import { handshakeInit, TestAgentServer, waitFor } from "./helpers/agent.ts";
import { type App, call, login, makeApp } from "./helpers/api.ts";
import { SoftwareAuthenticator } from "./helpers/authenticator.ts";
import { openTestDb } from "./helpers/db.ts";

const WEBAUTHN = { rpId: "crh.example.com", rpName: "ClusterRightHand", origins: ["https://crh.example.com"] };
const BROWSER = { origin: "https://crh.example.com", host: "crh.example.com" };

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

interface WebauthnVector {
	id: string;
	trust: { credentialIdHex: string; coseKeyHex: string; rpId: string; origins: string[]; requireUv: boolean };
	payloadHex: string;
	signature: { credentialIdHex: string; authenticatorDataHex: string; clientDataJson: string; signatureHex: string };
	valid: boolean;
}

const bytesOf = (hex: string): Uint8Array => Uint8Array.from(Buffer.from(hex, "hex"));
const b64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");

describe("WebAuthn assertion verification", () => {
	it("accepts and rejects exactly the reference verifier's cases from test/interop/m4_vectors.json", async () => {
		const path = fileURLToPath(new URL("../../test/interop/m4_vectors.json", import.meta.url));
		const vectors = (JSON.parse(readFileSync(path, "utf8")) as { webauthn: WebauthnVector[] }).webauthn;
		expect(vectors.length).toBeGreaterThan(10);
		for (const vector of vectors) {
			const response = {
				id: b64url(bytesOf(vector.signature.credentialIdHex)),
				rawId: b64url(bytesOf(vector.signature.credentialIdHex)),
				type: "public-key" as const,
				clientExtensionResults: {},
				response: {
					clientDataJSON: b64url(Uint8Array.from(Buffer.from(vector.signature.clientDataJson, "utf8"))),
					authenticatorData: b64url(bytesOf(vector.signature.authenticatorDataHex)),
					signature: b64url(bytesOf(vector.signature.signatureHex)),
				},
			};
			let accepted = false;
			try {
				const result = await verifyAssertion({
					credential: {
						credentialId: b64url(bytesOf(vector.trust.credentialIdHex)),
						coseKey: bytesOf(vector.trust.coseKeyHex),
						rpId: vector.trust.rpId,
						origins: vector.trust.origins,
					},
					payload: bytesOf(vector.payloadHex),
					response,
				});
				accepted = !vector.trust.requireUv || result.userVerified;
			} catch {
				accepted = false;
			}
			expect({ id: vector.id, accepted }).toEqual({ id: vector.id, accepted: vector.valid });
		}
	});
});

describe("Passkey authorization submission", () => {
	let db: Db;
	let audit: Audit;
	let cluster: Cluster;
	let agents: TestAgentServer;
	let signing: AuthorizationSigningKey;
	let app: App;
	let cookie: string;
	let userId: string;
	let authenticator: SoftwareAuthenticator;
	let webauthnEntry: TrustEntry;

	beforeEach(async () => {
		db = await openTestDb("sqlite");
		const masterKey = MasterKey.generate();
		await bindMasterKey(db, masterKey);
		signing = await loadAuthorizationSigningKey(db, masterKey);
		audit = new Audit(db);
		cluster = new Cluster(db, { authorizationKey: signing, trustWaitMs: 100, audit });
		const identity: ServerIdentity = { keyPair: generateKeyPair(), fingerprint: "test-fingerprint" };
		agents = await TestAgentServer.start(db, identity, cluster);
		const user = await createUser(db, { username: "owner", kind: "member", password: "password-123" });
		userId = user.id;
		app = makeApp(db, undefined, { cluster, audit, authorizationKey: signing, webauthn: WEBAUTHN });
		cookie = await login(app, "owner", "password-123");

		// Register a Passkey through the API, as the WebUI does.
		authenticator = new SoftwareAuthenticator({ alg: "ES256" });
		const optionsRes = await call(app, "/api/me/credentials/webauthn/options", {
			method: "POST",
			cookie,
			body: {},
			headers: BROWSER,
		});
		const options = ((await optionsRes.json()) as { options: { challenge: string } }).options;
		const registered = await call(app, "/api/me/credentials/webauthn", {
			method: "POST",
			cookie,
			body: { name: "yubikey", response: authenticator.registrationResponse(options.challenge) },
			headers: BROWSER,
		});
		expect(registered.status).toBe(201);
		webauthnEntry = {
			name: "passkey",
			source: "local",
			role: "user",
			key: {
				kind: "webauthn",
				credentialId: authenticator.credentialId,
				coseKey: authenticator.coseKey,
				rpId: authenticator.rpId,
				origins: [authenticator.origin],
			},
			kinds: ["execute"],
			requireExact: false,
			requireTask: false,
			requireUv: true,
			maxTtlMs: 24 * 3_600_000,
			allow: [{ method: "exec", match: "prefix", pattern: "systemctl restart " }],
			deny: [],
			envAllow: [],
		};
	});

	afterEach(async () => {
		await cluster.close();
		await agents.close();
		await db.destroy();
	});

	const addNode = async (name: string, key: Uint8Array): Promise<NodeRow> => {
		const id = crypto.randomUUID();
		const now = new Date().toISOString();
		await db
			.insertInto("nodes")
			.values({
				id,
				org_id: await defaultOrgId(db),
				owner_user_id: userId,
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
		return (await db.selectFrom("nodes").selectAll().where("id", "=", id).executeTakeFirstOrThrow()) as NodeRow;
	};

	const connect = async (
		name: string,
		trust: TrustEntry[] = [webauthnEntry],
	): Promise<{ node: NodeRow; crha: Awaited<ReturnType<TestAgentServer["connect"]>> }> => {
		const key = generateKeyPair();
		const node = await addNode(name, key.publicKey);
		const crha = await agents.connect(key, handshakeInit());
		expect(await crha.peer.request("hello", { tasks: [], taskKinds: [], privilegedMode: "forward" })).toEqual({
			acks: [],
		});
		await waitFor("link ready", () => cluster.isConnected(node.id));
		const summary: TrustSummary = {
			nodeId: node.id,
			groups: [],
			clockSkewMs: 60_000,
			identities: IDENTITIES,
			trust,
		};
		crha.trust({ kind: "ok", summary });
		await waitFor("trust stored", async () => {
			const row = await db.selectFrom("nodes").select("trust_digest").where("id", "=", node.id).executeTakeFirst();
			return row?.trust_digest === trustDigest(summary);
		});
		return { node, crha };
	};

	it("signs a pending payload with a Passkey and dispatches the task", async () => {
		const { node, crha } = await connect("passkey-1");
		const task = await cluster.createTask({
			nodeId: node.id,
			spec: EXEC,
			privileged: true,
			actor: { type: "user", id: userId, onBehalfOfUserId: userId },
		});
		await waitFor("awaiting_authorization", async () => {
			const view = await cluster.getTask(task.id);
			return view?.state === "awaiting_authorization";
		});
		const pending = (await (await call(app, `/api/tasks/${task.id}/authorization`, { cookie })).json()) as {
			authorization: {
				id: string;
				payload: string;
				challenge: string;
				passkeys: { credentialId: string; rpId: string; requireUv: boolean }[];
			};
		};
		const payload = new Uint8Array(Buffer.from(pending.authorization.payload, "base64"));
		expect(pending.authorization.challenge).toBe(b64url(webauthnChallenge(payload)));
		expect(pending.authorization.passkeys).toEqual([
			{
				credentialId: b64url(authenticator.credentialId),
				name: "yubikey",
				rpId: "crh.example.com",
				origins: ["https://crh.example.com"],
				requireUv: true,
				entry: "passkey",
			},
		]);

		const response = authenticator.assertionResponse(payload);
		const res = await call(app, "/api/authorizations", {
			cookie,
			body: { payloadId: pending.authorization.id, webauthn: response },
		});
		expect(res.status).toBe(200);
		expect((await res.json()) as Record<string, unknown>).toEqual({
			authorization: { id: pending.authorization.id, dispatched: [task.id] },
		});
		await waitFor("task.start", () => crha.starts.length === 1);
		const wire = authorizationCodec.decode(decodeCbor(crha.starts[0]?.authorizations[0] as Uint8Array));
		expect(wire.signatures).toHaveLength(1);
		expect(wire.signatures[0]?.kind).toBe("webauthn");
		expect(Buffer.from(wire.payload)).toEqual(Buffer.from(payload));
	});

	it("signs with an Ed25519 Passkey as well", async () => {
		const eddsa = new SoftwareAuthenticator({ alg: "EdDSA" });
		const optionsRes = await call(app, "/api/me/credentials/webauthn/options", {
			method: "POST",
			cookie,
			body: {},
			headers: BROWSER,
		});
		const options = ((await optionsRes.json()) as { options: { challenge: string } }).options;
		const registered = await call(app, "/api/me/credentials/webauthn", {
			method: "POST",
			cookie,
			body: { name: "eddsa-key", response: eddsa.registrationResponse(options.challenge) },
			headers: BROWSER,
		});
		expect(registered.status).toBe(201);
		const entry: TrustEntry = {
			...webauthnEntry,
			key: {
				kind: "webauthn",
				credentialId: eddsa.credentialId,
				coseKey: eddsa.coseKey,
				rpId: eddsa.rpId,
				origins: [eddsa.origin],
			},
		};
		const { node, crha } = await connect("passkey-eddsa", [entry]);
		const task = await cluster.createTask({
			nodeId: node.id,
			spec: EXEC,
			privileged: true,
			actor: { type: "user", id: userId, onBehalfOfUserId: userId },
		});
		await waitFor("awaiting_authorization", async () => {
			const view = await cluster.getTask(task.id);
			return view?.state === "awaiting_authorization";
		});
		const pending = (await (await call(app, `/api/tasks/${task.id}/authorization`, { cookie })).json()) as {
			authorization: { id: string; payload: string };
		};
		const payload = new Uint8Array(Buffer.from(pending.authorization.payload, "base64"));
		const res = await call(app, "/api/authorizations", {
			cookie,
			body: { payloadId: pending.authorization.id, webauthn: eddsa.assertionResponse(payload) },
		});
		expect(res.status).toBe(200);
		await waitFor("task.start", () => crha.starts.length === 1);
		const wire = authorizationCodec.decode(decodeCbor(crha.starts[0]?.authorizations[0] as Uint8Array));
		expect(wire.signatures[0]?.kind).toBe("webauthn");
	});

	it("refuses a Passkey assertion over another payload or for a credential that is not registered", async () => {
		const { node } = await connect("passkey-2");
		const task = await cluster.createTask({
			nodeId: node.id,
			spec: EXEC,
			privileged: true,
			actor: { type: "user", id: userId, onBehalfOfUserId: userId },
		});
		await waitFor("awaiting_authorization", async () => {
			const view = await cluster.getTask(task.id);
			return view?.state === "awaiting_authorization";
		});
		const pending = (await (await call(app, `/api/tasks/${task.id}/authorization`, { cookie })).json()) as {
			authorization: { id: string; payload: string };
		};
		const payload = new Uint8Array(Buffer.from(pending.authorization.payload, "base64"));

		// A different payload (a re-plan, a phishing page) does not verify.
		const other = new TextEncoder().encode("some other payload");
		const wrongPayload = await call(app, "/api/authorizations", {
			cookie,
			body: { payloadId: pending.authorization.id, webauthn: authenticator.assertionResponse(other) },
		});
		expect(wrongPayload.status).toBe(400);

		// A credential the user never registered.
		const foreign = new SoftwareAuthenticator();
		const unknown = await call(app, "/api/authorizations", {
			cookie,
			body: { payloadId: pending.authorization.id, webauthn: foreign.assertionResponse(payload) },
		});
		expect(unknown.status).toBe(400);
		expect(((await unknown.json()) as { error: string }).error).toMatch(/not one of yours/);

		// The payload id must be one of this user's pending payloads.
		const missing = await call(app, "/api/authorizations", {
			cookie,
			body: { payloadId: "0".repeat(64), webauthn: authenticator.assertionResponse(payload) },
		});
		expect(missing.status).toBe(400);
		expect(((await missing.json()) as { error: string }).error).toMatch(/no pending authorization/);
		expect((await cluster.getTask(task.id))?.state).toBe("awaiting_authorization");
	});
});
