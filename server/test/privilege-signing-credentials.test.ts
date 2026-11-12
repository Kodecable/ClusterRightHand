import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Audit } from "../src/audit/audit.ts";
import { RegistrationChallenges } from "../src/privilege/webauthn.ts";
import type { Db } from "../src/storage/db.ts";
import { createUser } from "../src/users/service.ts";
import { type App, call, login, makeApp } from "./helpers/api.ts";
import { createSshKey, SoftwareAuthenticator } from "./helpers/authenticator.ts";
import { openTestDb } from "./helpers/db.ts";

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
		app = makeApp(db, undefined, { webauthn: WEBAUTHN, audit });
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

	it("adds, lists and deletes an SSH key of every supported type", async () => {
		const types = [
			"ssh-ed25519",
			"sk-ssh-ed25519@openssh.com",
			"ecdsa-sha2-nistp256",
			"sk-ecdsa-sha2-nistp256@openssh.com",
		] as const;
		let firstKey = createSshKey("ssh-ed25519");
		for (const type of types) {
			const key = createSshKey(type);
			if (type === "ssh-ed25519") firstKey = key;
			const res = await call(app, "/api/me/signing-credentials/ssh", {
				cookie,
				body: { publicKey: key.line, name: type },
			});
			expect(res.status).toBe(201);
			const { signingCredential } = (await res.json()) as { signingCredential: Record<string, unknown> };
			expect(signingCredential).toMatchObject({ kind: "ssh", name: type, fingerprint: key.fingerprint });
			expect(signingCredential.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
		}
		const listed = (await (await call(app, "/api/me/signing-credentials", { cookie })).json()) as {
			signingCredentials: { id: string; name: string }[];
		};
		expect(listed.signingCredentials).toHaveLength(4);

		// The same key again, an unsupported type and a blob of another type are all refused.
		const duplicate = await call(app, "/api/me/signing-credentials/ssh", {
			cookie,
			body: { publicKey: firstKey.line },
		});
		expect(duplicate.status).toBe(400);
		expect(((await duplicate.json()) as { error: string }).error).toMatch(/already registered/);
		const unsupported = await call(app, "/api/me/signing-credentials/ssh", {
			cookie,
			body: { publicKey: "ssh-rsa AAAAB3NzaC1yc2EAAAA= me" },
		});
		expect(unsupported.status).toBe(400);
		expect(((await unsupported.json()) as { error: string }).error).toMatch(/unsupported key type/);
		const mismatched = await call(app, "/api/me/signing-credentials/ssh", {
			cookie,
			body: { publicKey: `ssh-ed25519 ${Buffer.from("not a key").toString("base64")}` },
		});
		expect(mismatched.status).toBe(400);

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
		expect(after.signingCredentials).toHaveLength(3);

		await audit.flush();
		expect(await auditRows("signing_credential.added")).toHaveLength(4);
		expect(await auditRows("signing_credential.removed")).toHaveLength(1);
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
