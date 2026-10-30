/**
 * The user's signing credentials (doc/m4.md M4.4, doc/privilege.md#签名方式): SSH public keys and
 * Passkeys, each ownable only by the user who registered it. A registered credential is what lets the
 * authorization planner match this user to a node's `user` trust entries.
 */
import type { RegistrationResponseJSON } from "@simplewebauthn/server";
import { Hono } from "hono";
import { userActor } from "../audit/audit.ts";
import type { WebauthnConfig } from "../config.ts";
import {
	addSshCredential,
	addWebauthnCredential,
	deleteCredential,
	listCredentials,
	webauthnCredentials,
} from "../privilege/credentials.ts";
import { RegistrationChallenges, rpForRequest, verifyRegistration, WebauthnError } from "../privilege/webauthn.ts";
import type { Db } from "../storage/db.ts";
import { NotFoundError, UserError } from "../users/service.ts";
import { type AppEnv, jsonError, optionalString, readJsonObject } from "./context.ts";

export interface CredentialRoutesOptions {
	/** `[webauthn]` from crhs.toml; unset means the RP follows the request's Origin. */
	webauthn?: WebauthnConfig;
	/** Shared by the routes and their tests to control challenge expiry. */
	challenges?: RegistrationChallenges;
}

/** Expects requireUser to have run. Every route works on the caller's own credentials only. */
export function credentialRoutes(db: Db, options: CredentialRoutesOptions = {}) {
	const app = new Hono<AppEnv>();
	const webauthn = options.webauthn ?? { rpId: null, rpName: "ClusterRightHand", origins: [] };
	const challenges = options.challenges ?? new RegistrationChallenges();

	app.onError((err, c) => {
		if (err instanceof NotFoundError) return jsonError(c, 404, err.message);
		if (err instanceof UserError || err instanceof WebauthnError || err instanceof TypeError) {
			return jsonError(c, 400, err.message);
		}
		throw err;
	});

	app.get("/me/credentials", async (c) => c.json({ credentials: await listCredentials(db, c.get("user").userId) }));

	app.post("/me/credentials/ssh", async (c) => {
		const user = c.get("user");
		const body = await readJsonObject(c);
		const publicKey = body ? optionalString(body, "publicKey") : undefined;
		if (!publicKey) return jsonError(c, 400, "publicKey is required");
		const credential = await addSshCredential(db, user.userId, {
			publicKey,
			name: optionalString(body as Record<string, unknown>, "name"),
		});
		void c.get("audit").record({
			actor: userActor(user),
			action: "credential.added",
			target: { type: "credential", id: credential.id },
			detail: { kind: "ssh", name: credential.name, fingerprint: credential.fingerprint },
		});
		return c.json({ credential }, 201);
	});

	/** Registration options for a new Passkey; the challenge is kept server-side and used once. */
	app.post("/me/credentials/webauthn/options", async (c) => {
		const user = c.get("user");
		const rp = rpForRequest(webauthn, c.req.header("origin"));
		const existing = await webauthnCredentials(db, user.userId);
		const issued = await challenges.issue({
			rp,
			userId: user.userId,
			userName: user.username,
			userDisplayName: user.username,
			excludeCredentialIds: existing.map((credential) => credential.credentialId),
		});
		return c.json({ options: issued.options });
	});

	app.post("/me/credentials/webauthn", async (c) => {
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
			return jsonError(c, 400, `clientDataJSON: ${err instanceof Error ? err.message : String(err)}`);
		}
		const pending = challenges.take(challenge);
		if (!pending) return jsonError(c, 400, "unknown, already used or expired registration challenge");
		if (pending.userId !== user.userId) return jsonError(c, 400, "the registration belongs to another user");
		const origin = c.req.header("origin");
		if (origin !== undefined && !pending.rp.origins.includes(origin)) {
			return jsonError(c, 400, `origin ${origin} is not one the registration was started for`);
		}
		const verified = await verifyRegistration({ response, challenge, rp: pending.rp });
		const credential = await addWebauthnCredential(db, user.userId, {
			name: optionalString(body as Record<string, unknown>, "name"),
			credentialId: verified.credentialId,
			coseKey: verified.coseKey,
			rpId: pending.rp.rpId,
			origins: pending.rp.origins,
		});
		void c.get("audit").record({
			actor: userActor(user),
			action: "credential.added",
			target: { type: "credential", id: credential.id },
			detail: {
				kind: "webauthn",
				name: credential.name,
				credential_id: credential.credentialId,
				rp_id: credential.rpId,
			},
		});
		return c.json({ credential }, 201);
	});

	app.delete("/me/credentials/:id", async (c) => {
		const user = c.get("user");
		const credential = await deleteCredential(db, user.userId, c.req.param("id"));
		void c.get("audit").record({
			actor: userActor(user),
			action: "credential.removed",
			target: { type: "credential", id: credential.id },
			detail: { kind: credential.kind, name: credential.name, fingerprint: credential.fingerprint },
		});
		return c.json({ ok: true });
	});

	return app;
}
