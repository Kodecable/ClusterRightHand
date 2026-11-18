import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Audit } from "../src/audit/audit.ts";
import { SshRegistrationChallenges } from "../src/privilege/signing-credentials.ts";
import { REGISTER_NAMESPACE, signSshsig, sshString } from "../src/privilege/sshsig.ts";
import { RegistrationChallenges } from "../src/privilege/webauthn.ts";
import type { Db } from "../src/storage/db.ts";
import { createUser } from "../src/users/service.ts";
import { type App, call, login, makeApp } from "./helpers/api.ts";
import { createSshKey, SoftwareAuthenticator } from "./helpers/authenticator.ts";
import { openTestDb } from "./helpers/db.ts";
import { registerSshCredential } from "./helpers/signing-credentials.ts";

const WEBAUTHN = { rpId: "crh.example.com", rpName: "ClusterRightHand", origins: ["https://crh.example.com"] };
/** The CSRF guard wants Origin and Host to agree; the WebAuthn RP is derived from the Origin. */
const BROWSER = { origin: "https://crh.example.com", host: "crh.example.com" };

describe("signing credentials API", () => {
	let db: Db;
	let audit: Audit;
	let app: App;
	let cookie: string;
	let otherCookie: string;

	beforeEach(async () => {
		db = await openTestDb("sqlite");
		audit = new Audit(db);
		app = makeApp(db, undefined, { webauthn: WEBAUTHN, audit, serverFingerprint: "test-server" });
		await createUser(db, { username: "owner", kind: "member", password: "password-123" });
		await createUser(db, { username: "other", kind: "member", password: "password-123" });
		cookie = await login(app, "owner", "password-123");
		otherCookie = await login(app, "other", "password-123");
	});

	afterEach(async () => {
		await db.destroy();
	});

	const auditRows = (action: string) =>
		db.selectFrom("audit_events").selectAll().where("action", "=", action).orderBy("seq").execute();

	const registerPasskey = async (
		authenticator: SoftwareAuthenticator,
		name: string | undefined,
		withCookie = cookie,
	) => {
		const optionsRes = await call(app, "/api/me/signing-credentials/webauthn/options", {
			method: "POST",
			cookie: withCookie,
			body: {},
			headers: BROWSER,
		});
		expect(optionsRes.status).toBe(200);
		const { options } = (await optionsRes.json()) as {
			options: { challenge: string; pubKeyCredParams: { alg: number }[] };
		};
		const response = authenticator.registrationResponse(options.challenge);
		return {
			options,
			res: await call(app, "/api/me/signing-credentials/webauthn", {
				method: "POST",
				cookie: withCookie,
				body: { name, response },
				headers: BROWSER,
			}),
		};
	};

	it("adds, lists and deletes an SSH credential with a proof of possession", async () => {
		const key = createSshKey("ssh-ed25519");
		// The armored form is what ssh-keygen writes and the manual recipe produces.
		const res = await registerSshCredential(app, cookie, key, "test-key", { armored: true });
		expect(res.status).toBe(201);
		const { signingCredential } = (await res.json()) as { signingCredential: Record<string, unknown> };
		expect(signingCredential).toMatchObject({ kind: "ssh", name: "test-key", fingerprint: key.fingerprint });
		expect(signingCredential.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);

		// The same key again, a malformed signature, a signature over another challenge and an
		// unsupported key type are all refused.
		const duplicate = await registerSshCredential(app, cookie, key, "duplicate");
		expect(duplicate.status).toBe(400);
		expect(((await duplicate.json()) as { error: string }).error).toMatch(/already registered/);
		await call(app, "/api/me/signing-credentials/ssh/challenge", { method: "POST", cookie, body: {} });
		const malformed = await call(app, "/api/me/signing-credentials/ssh", {
			cookie,
			body: { signature: "not base64" },
		});
		expect(malformed.status).toBe(400);
		expect(((await malformed.json()) as { error: string }).error).toMatch(/base64/);

		const challengeRes = await call(app, "/api/me/signing-credentials/ssh/challenge", {
			method: "POST",
			cookie,
			body: {},
		});
		const { challenge } = (await challengeRes.json()) as { challenge: string };
		const wrongChallenge = signSshsig(key.privateKey, key.blob, Buffer.from("another challenge"), {
			namespace: REGISTER_NAMESPACE,
		});
		const wrong = await call(app, "/api/me/signing-credentials/ssh", {
			cookie,
			body: { signature: Buffer.from(wrongChallenge).toString("base64") },
		});
		expect(wrong.status).toBe(400);
		expect(((await wrong.json()) as { error: string }).error).toMatch(/does not verify/);
		expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
		const decoded = Buffer.from(challenge, "base64url").toString("utf8");
		expect(decoded).toContain(`${REGISTER_NAMESPACE}\nuser:`);
		expect(decoded).toContain("\nserver:test-server\nnonce:");

		// An SSHSIG naming a key type the verifier does not support is refused before any signature check.
		const rsaBlob = Buffer.concat([
			Buffer.from(sshString("ssh-rsa")),
			Buffer.from(sshString(Buffer.from("not a real key"))),
		]);
		const unsupported = Buffer.concat([
			Buffer.from("SSHSIG"),
			Buffer.from([0, 0, 0, 1]),
			Buffer.from(sshString(rsaBlob)),
		]);
		await call(app, "/api/me/signing-credentials/ssh/challenge", { method: "POST", cookie, body: {} });
		const refused = await call(app, "/api/me/signing-credentials/ssh", {
			cookie,
			body: { signature: unsupported.toString("base64") },
		});
		expect(refused.status).toBe(400);
		expect(((await refused.json()) as { error: string }).error).toMatch(/supported SSH public key/);

		const listed = (await (await call(app, "/api/me/signing-credentials", { cookie })).json()) as {
			signingCredentials: { id: string; name: string }[];
		};
		expect(listed.signingCredentials).toHaveLength(1);

		// Another user sees none of them and cannot delete one.
		const theirs = (await (await call(app, "/api/me/signing-credentials", { cookie: otherCookie })).json()) as {
			signingCredentials: unknown[];
		};
		expect(theirs.signingCredentials).toEqual([]);
		const id = listed.signingCredentials[0]?.id as string;
		expect(
			(await call(app, `/api/me/signing-credentials/${id}`, { method: "DELETE", cookie: otherCookie, body: {} }))
				.status,
		).toBe(404);
		expect((await call(app, `/api/me/signing-credentials/${id}`, { method: "DELETE", cookie, body: {} })).status).toBe(
			200,
		);
		const after = (await (await call(app, "/api/me/signing-credentials", { cookie })).json()) as {
			signingCredentials: unknown[];
		};
		expect(after.signingCredentials).toHaveLength(0);

		await audit.flush();
		expect(await auditRows("signing_credential.added")).toHaveLength(1);
		expect(await auditRows("signing_credential.removed")).toHaveLength(1);
	});

	it("consumes an SSH challenge on any attempt and refuses one never issued", async () => {
		const key = createSshKey("ssh-ed25519");
		const challengeRes = await call(app, "/api/me/signing-credentials/ssh/challenge", {
			method: "POST",
			cookie,
			body: {},
		});
		const { challenge } = (await challengeRes.json()) as { challenge: string };
		// A failed verification still consumes the challenge, so it cannot be retried.
		const wrong = signSshsig(key.privateKey, key.blob, Buffer.from("not the challenge"), {
			namespace: REGISTER_NAMESPACE,
		});
		const failed = await call(app, "/api/me/signing-credentials/ssh", {
			cookie,
			body: { signature: Buffer.from(wrong).toString("base64") },
		});
		expect(failed.status).toBe(400);
		const good = signSshsig(key.privateKey, key.blob, Buffer.from(challenge, "base64url"), {
			namespace: REGISTER_NAMESPACE,
		});
		const retry = await call(app, "/api/me/signing-credentials/ssh", {
			cookie,
			body: { signature: Buffer.from(good).toString("base64") },
		});
		expect(retry.status).toBe(400);
		expect(((await retry.json()) as { error: string }).error).toMatch(/no pending/);

		// A signature that names a different namespace is refused, and the challenge stays consumed.
		await call(app, "/api/me/signing-credentials/ssh/challenge", { method: "POST", cookie, body: {} });
		const authorizationSignature = signSshsig(key.privateKey, key.blob, Buffer.from("x"));
		const wrongNamespace = await call(app, "/api/me/signing-credentials/ssh", {
			cookie,
			body: { signature: Buffer.from(authorizationSignature).toString("base64") },
		});
		expect(wrongNamespace.status).toBe(400);
		expect(((await wrongNamespace.json()) as { error: string }).error).toMatch(/namespace/);
	});

	it("expires SSH registration challenges, keeps one per user and caps the global store", () => {
		let now = 1_000_000;
		const challenges = new SshRegistrationChallenges(() => now, 2);
		const first = challenges.issue({ userId: "u1", serverIdentity: "srv", ttlMs: 1_000 });
		const second = challenges.issue({ userId: "u1", serverIdentity: "srv", ttlMs: 1_000 });
		// A new request replaces the user's previous challenge.
		expect(first.challenge).not.toBe(second.challenge);
		expect(challenges.takeForUser("u1")?.challenge).toBe(second.challenge);
		expect(challenges.takeForUser("u1")).toBeUndefined();

		const other = challenges.issue({ userId: "u2", serverIdentity: "srv", ttlMs: 1_000 });
		now += 2_000;
		expect(challenges.takeForUser("u2")).toBeUndefined();
		expect(other.expiresAt).toBeLessThan(now);

		// Across users, the oldest pending challenge is evicted to keep the global cap.
		const capped = new SshRegistrationChallenges(() => now, 2);
		capped.issue({ userId: "u1", serverIdentity: "srv" });
		const middle = capped.issue({ userId: "u2", serverIdentity: "srv" });
		const newest = capped.issue({ userId: "u3", serverIdentity: "srv" });
		expect(capped.takeForUser("u1")).toBeUndefined();
		expect(capped.takeForUser("u2")?.challenge).toBe(middle.challenge);
		expect(capped.takeForUser("u3")?.challenge).toBe(newest.challenge);
	});

	it("rejects bodies that do not match the route's schemas", async () => {
		const ssh = await call(app, "/api/me/signing-credentials/ssh", { cookie, body: { signature: 42 } });
		expect(ssh.status).toBe(400);
		expect(((await ssh.json()) as { error: string }).error).toMatch(/^signature: /);
		const webauthn = await call(app, "/api/me/signing-credentials/webauthn", {
			cookie,
			body: { response: "not a registration response" },
		});
		expect(webauthn.status).toBe(400);
		expect(((await webauthn.json()) as { error: string }).error).toMatch(/^response: /);
	});

	it("registers a Passkey with P-256 and Ed25519 and records its RP", async () => {
		const keys = {
			ES256: new SoftwareAuthenticator({ alg: "ES256" }),
			EdDSA: new SoftwareAuthenticator({ alg: "EdDSA" }),
		};
		for (const [alg, authenticator] of Object.entries(keys)) {
			const { options, res } = await registerPasskey(authenticator, `passkey-${alg}`);
			expect(res.status).toBe(201);
			const { signingCredential } = (await res.json()) as { signingCredential: Record<string, unknown> };
			expect(signingCredential).toMatchObject({
				kind: "webauthn",
				name: `passkey-${alg}`,
				credentialId: Buffer.from(authenticator.credentialId).toString("base64url"),
				rpId: "crh.example.com",
				origins: ["https://crh.example.com"],
			});
			// Only the three algorithms crha can verify are offered (doc/design/protocol.md "Authorization object").
			expect(options.pubKeyCredParams.map((param) => param.alg)).toEqual([-7, -8, -257]);
		}
		const listed = (await (await call(app, "/api/me/signing-credentials", { cookie })).json()) as {
			signingCredentials: { kind: string; credentialId: string }[];
		};
		expect(listed.signingCredentials.map((credential) => credential.kind)).toEqual(["webauthn", "webauthn"]);

		// The same credential cannot be registered twice (a new challenge is issued, the attestation repeats).
		const again = await registerPasskey(keys.ES256, "duplicate");
		expect(again.res.status).toBe(400);
		expect(((await again.res.json()) as { error: string }).error).toMatch(/already registered/);
		await audit.flush();
		expect(await auditRows("signing_credential.added")).toHaveLength(2);
	});

	it("consumes a registration challenge once and refuses an unknown one", async () => {
		const authenticator = new SoftwareAuthenticator();
		const optionsRes = await call(app, "/api/me/signing-credentials/webauthn/options", {
			method: "POST",
			cookie,
			body: {},
			headers: BROWSER,
		});
		const { options } = (await optionsRes.json()) as { options: { challenge: string } };
		const response = authenticator.registrationResponse(options.challenge);
		const first = await call(app, "/api/me/signing-credentials/webauthn", {
			method: "POST",
			cookie,
			body: { response },
			headers: BROWSER,
		});
		expect(first.status).toBe(201);
		const second = await call(app, "/api/me/signing-credentials/webauthn", {
			method: "POST",
			cookie,
			body: { name: "replay", response },
			headers: BROWSER,
		});
		expect(second.status).toBe(400);
		expect(((await second.json()) as { error: string }).error).toMatch(/challenge/);

		// A challenge this server never issued.
		const foreign = new SoftwareAuthenticator();
		const foreignResponse = foreign.registrationResponse("not-a-real-challenge");
		const unknown = await call(app, "/api/me/signing-credentials/webauthn", {
			method: "POST",
			cookie,
			body: { response: foreignResponse },
			headers: BROWSER,
		});
		expect(unknown.status).toBe(400);
	});

	it("expires registration challenges and accepts each only once", async () => {
		let now = 1_000_000;
		const challenges = new RegistrationChallenges(() => now);
		const rp = { rpId: "crh.example.com", rpName: "CRH", origins: ["https://crh.example.com"] };
		const issued = await challenges.issue({
			rp,
			userId: "u1",
			userName: "owner",
			userDisplayName: "owner",
			excludeCredentialIds: [],
			ttlMs: 1_000,
		});
		expect(challenges.take(issued.challenge)).toMatchObject({ userId: "u1" });
		expect(challenges.take(issued.challenge)).toBeUndefined();
		const expired = await challenges.issue({
			rp,
			userId: "u1",
			userName: "owner",
			userDisplayName: "owner",
			excludeCredentialIds: [],
			ttlMs: 1_000,
		});
		now += 2_000;
		expect(challenges.take(expired.challenge)).toBeUndefined();
	});

	it("keeps at most one pending registration challenge per user", async () => {
		const challenges = new RegistrationChallenges();
		const rp = { rpId: "crh.example.com", rpName: "CRH", origins: ["https://crh.example.com"] };
		const issue = (userId: string) =>
			challenges.issue({
				rp,
				userId,
				userName: userId,
				userDisplayName: userId,
				excludeCredentialIds: [],
			});

		const first = await issue("u1");
		const second = await issue("u1");
		const other = await issue("u2");
		// A new request replaces the user's previous challenge instead of adding another one.
		expect(challenges.take(first.challenge)).toBeUndefined();
		expect(challenges.take(second.challenge)).toMatchObject({ userId: "u1" });
		expect(challenges.take(other.challenge)).toMatchObject({ userId: "u2" });
	});

	it("evicts the oldest registration challenge at the global cap", async () => {
		const challenges = new RegistrationChallenges(Date.now, 2);
		const rp = { rpId: "crh.example.com", rpName: "CRH", origins: ["https://crh.example.com"] };
		const issue = (userId: string) =>
			challenges.issue({
				rp,
				userId,
				userName: userId,
				userDisplayName: userId,
				excludeCredentialIds: [],
			});

		const first = await issue("u1");
		const second = await issue("u2");
		// Replacing a user's own challenge does not evict someone else's.
		const replacement = await issue("u1");
		expect(challenges.take(first.challenge)).toBeUndefined();
		expect(challenges.take(second.challenge)).toMatchObject({ userId: "u2" });
		expect(challenges.take(replacement.challenge)).toMatchObject({ userId: "u1" });

		const one = await issue("u3");
		const two = await issue("u4");
		const three = await issue("u5");
		expect(challenges.take(one.challenge)).toBeUndefined();
		expect(challenges.take(two.challenge)).toMatchObject({ userId: "u4" });
		expect(challenges.take(three.challenge)).toMatchObject({ userId: "u5" });
	});
});
