/**
 * The user's signing credentials (doc/design/privilege.md "Signing methods"): SSH public keys and
 * Passkeys, each ownable only by the user who registered it. A registered credential is what lets the
 * authorization planner match this user to a node's `user` trust entries.
 */
import type { RegistrationResponseJSON } from "@simplewebauthn/server";
import { Hono } from "hono";
import { userActor } from "../audit/audit.ts";
import { DEFAULT_RP_NAME, type WebauthnConfig } from "../config.ts";
import {
	addSshSigningCredential,
	addWebauthnSigningCredential,
	deleteSigningCredential,
	listSigningCredentials,
	webauthnSigningCredentials,
} from "../privilege/signing-credentials.ts";
import { RegistrationChallenges, rpForRequest, verifyRegistration } from "../privilege/webauthn.ts";
import type { SettingsStore } from "../settings/settings.ts";
import type { Db } from "../storage/db.ts";
import { errorText } from "../util/errors.ts";
import { type AppEnv, jsonError, optionalString, readJsonObject } from "./context.ts";

export interface SigningCredentialRoutesOptions {
	/** `[webauthn]` fallback for tests; production passes `settings`. */
	webauthn?: WebauthnConfig;
	/** Runtime settings; when given they are read per request and take precedence. */
	settings?: SettingsStore;
	/** Shared by the routes and their tests to control challenge expiry. */
	challenges?: RegistrationChallenges;
}

/** Expects requireUser to have run. Every route works on the caller's own credentials only. */
export function signingCredentialRoutes(db: Db, options: SigningCredentialRoutesOptions = {}) {
	const app = new Hono<AppEnv>();
	const webauthn = (): WebauthnConfig =>
		options.settings?.current().webauthn ??
		options.webauthn ?? {
			rpId: null,
			rpName: DEFAULT_RP_NAME,
			origins: [],
		};
	const challenges = options.challenges ?? new RegistrationChallenges();

	app.get("/me/signing-credentials", async (c) =>
		c.json({ signingCredentials: await listSigningCredentials(db, c.get("user").userId) }),
	);

	app.post("/me/signing-credentials/ssh", async (c) => {
		const user = c.get("user");
		const body = await readJsonObject(c);
		const publicKey = body ? optionalString(body, "publicKey") : undefined;
		if (!publicKey) return jsonError(c, 400, "publicKey is required");
		const credential = await addSshSigningCredential(db, user.userId, {
			publicKey,
			name: optionalString(body as Record<string, unknown>, "name"),
		});
		void c.get("audit").record({
			actor: userActor(user),
			action: "signing_credential.added",
			target: { type: "signing_credential", id: credential.id },
			detail: { kind: "ssh", name: credential.name, fingerprint: credential.fingerprint },
		});
		return c.json({ signingCredential: credential }, 201);
	});

	/** Registration options for a new Passkey; the challenge is kept server-side and used once. */
	app.post("/me/signing-credentials/webauthn/options", async (c) => {
		const user = c.get("user");
		const rp = rpForRequest(webauthn(), c.req.header("origin"));
		const existing = await webauthnSigningCredentials(db, user.userId);
		const issued = await challenges.issue({
			rp,
			userId: user.userId,
			userName: user.username,
			userDisplayName: user.username,
			excludeCredentialIds: existing.map((credential) => credential.credentialId),
		});
		return c.json({ options: issued.options });
	});

	app.post("/me/signing-credentials/webauthn", async (c) => {
		const user = c.get("user");
		const body = await readJsonObject(c);
		const response = body?.response as RegistrationResponseJSON | undefined;
		if (!response || typeof response !== "object") return jsonError(c, 400, "response is required");
		let challenge: string;
		try {
			const clientData = JSON.parse(Buffer.from(response.response.clientDataJSON, "base64url").toString("utf8")) as {
				challenge?: unknown;
			};
			if (typeof clientData.challenge !== "string") throw new Error("clientDataJSON has no challenge");
			challenge = clientData.challenge;
		} catch (err) {
			return jsonError(c, 400, `clientDataJSON: ${errorText(err)}`);
		}
		const pending = challenges.take(challenge);
		if (!pending) return jsonError(c, 400, "unknown, already used or expired registration challenge");
		if (pending.userId !== user.userId) return jsonError(c, 400, "the registration belongs to another user");
		const origin = c.req.header("origin");
		if (origin !== undefined && !pending.rp.origins.includes(origin)) {
			return jsonError(c, 400, `origin ${origin} is not one the registration was started for`);
		}
		const verified = await verifyRegistration({ response, challenge, rp: pending.rp });
		const credential = await addWebauthnSigningCredential(db, user.userId, {
			name: optionalString(body as Record<string, unknown>, "name"),
			credentialId: verified.credentialId,
			coseKey: verified.coseKey,
			rpId: pending.rp.rpId,
			origins: pending.rp.origins,
		});
		void c.get("audit").record({
			actor: userActor(user),
			action: "signing_credential.added",
			target: { type: "signing_credential", id: credential.id },
			detail: {
				kind: "webauthn",
				name: credential.name,
				credential_id: credential.credentialId,
				rp_id: credential.rpId,
			},
		});
		return c.json({ signingCredential: credential }, 201);
	});

	app.delete("/me/signing-credentials/:id", async (c) => {
		const user = c.get("user");
		const credential = await deleteSigningCredential(db, user.userId, c.req.param("id"));
		void c.get("audit").record({
			actor: userActor(user),
			action: "signing_credential.removed",
			target: { type: "signing_credential", id: credential.id },
			detail: { kind: credential.kind, name: credential.name, fingerprint: credential.fingerprint },
		});
		return c.json({ ok: true });
	});

	return app;
}
