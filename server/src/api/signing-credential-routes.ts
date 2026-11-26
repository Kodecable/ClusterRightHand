/**
 * The user's signing credentials (doc/design/privilege.md "Signing methods"): SSH public keys and
 * Passkeys, each ownable only by the user who registered it. A registered credential is what lets the
 * authorization planner match this user to a node's `user` trust entries.
 */
import {
	IdParamSchema,
	OkResponseSchema,
	SigningCredentialRenameBodySchema,
	SigningCredentialResponseSchema,
	SigningCredentialsResponseSchema,
	SshSigningChallengeResponseSchema,
	SshSigningCredentialBodySchema,
	WebauthnOptionsResponseSchema,
	WebauthnSigningCredentialBodySchema,
} from "@crh/api/schemas";
import type { RegistrationResponseJSON } from "@simplewebauthn/server";
import { HTTPException } from "hono/http-exception";
import { userActor } from "../audit/audit.ts";
import { DEFAULT_RP_NAME, type WebauthnConfig } from "../config.ts";
import {
	addSshSigningCredential,
	addWebauthnSigningCredential,
	deleteSigningCredential,
	listSigningCredentials,
	renameSigningCredential,
	SshRegistrationChallenges,
	verifySshRegistration,
	webauthnSigningCredentials,
} from "../privilege/signing-credentials.ts";
import { RegistrationChallenges, rpForRequest, verifyRegistration } from "../privilege/webauthn.ts";
import type { SettingsStore } from "../settings/settings.ts";
import type { Db } from "../storage/db.ts";
import { errorText, UserError } from "../util/errors.ts";
import { apiRouter, defineRoute, json } from "./openapi.ts";

const TAGS = ["Signing credentials"];

const listRoute = defineRoute({
	method: "get",
	path: "/me/signing-credentials",
	tags: TAGS,
	summary: "List the caller's own signing credentials",
	agent: "allow", // the caller's own credentials, public keys only
	responses: { 200: { description: "The caller's credentials", ...json(SigningCredentialsResponseSchema) } },
});

const sshChallengeRoute = defineRoute({
	method: "post",
	path: "/me/signing-credentials/ssh/challenge",
	tags: TAGS,
	summary: "Start an SSH signing-credential registration and return the challenge to sign",
	agent: "deny",
	responses: { 200: { description: "The challenge and its expiry", ...json(SshSigningChallengeResponseSchema) } },
});

const addSshRoute = defineRoute({
	method: "post",
	path: "/me/signing-credentials/ssh",
	tags: TAGS,
	summary: "Register an SSH signing credential with a signature over a challenge",
	agent: "deny",
	request: { body: { required: true, ...json(SshSigningCredentialBodySchema) } },
	responses: { 201: { description: "The registered credential", ...json(SigningCredentialResponseSchema) } },
});

const webauthnOptionsRoute = defineRoute({
	method: "post",
	path: "/me/signing-credentials/webauthn/options",
	tags: TAGS,
	summary: "Start a Passkey registration and return the options for the browser",
	agent: "deny",
	responses: { 200: { description: "The creation options", ...json(WebauthnOptionsResponseSchema) } },
});

const addWebauthnRoute = defineRoute({
	method: "post",
	path: "/me/signing-credentials/webauthn",
	tags: TAGS,
	summary: "Finish a Passkey registration with the authenticator's response",
	agent: "deny",
	request: { body: { required: true, ...json(WebauthnSigningCredentialBodySchema) } },
	responses: { 201: { description: "The registered credential", ...json(SigningCredentialResponseSchema) } },
});

const deleteRoute = defineRoute({
	method: "delete",
	path: "/me/signing-credentials/{id}",
	tags: TAGS,
	summary: "Delete one of the caller's signing credentials",
	agent: "deny",
	request: { params: IdParamSchema },
	responses: { 200: { description: "Deleted", ...json(OkResponseSchema) } },
});

const renameRoute = defineRoute({
	method: "patch",
	path: "/me/signing-credentials/{id}",
	tags: TAGS,
	summary: "Rename one of the caller's signing credentials",
	agent: "deny",
	request: { params: IdParamSchema, body: { required: true, ...json(SigningCredentialRenameBodySchema) } },
	responses: { 200: { description: "The renamed credential", ...json(SigningCredentialResponseSchema) } },
});

export interface SigningCredentialRoutesOptions {
	/** `[webauthn]` fallback for tests; production passes `settings`. */
	webauthn?: WebauthnConfig;
	/** Runtime settings; when given they are read per request and take precedence. */
	settings?: SettingsStore;
	/** Shared by the routes and their tests to control challenge expiry. */
	challenges?: RegistrationChallenges;
	/** `[SshRegistrationChallenges]` override for tests; production keeps one store. */
	sshChallenges?: SshRegistrationChallenges;
	/** The stable identity of this crhs installation, named in every SSH registration challenge. */
	serverIdentity?: string;
}

/** Expects requireUser to have run. Every route works on the caller's own credentials only. */
export function signingCredentialRoutes(db: Db, options: SigningCredentialRoutesOptions = {}) {
	const app = apiRouter();
	const webauthn = (): WebauthnConfig =>
		options.settings?.current().webauthn ??
		options.webauthn ?? {
			rpId: null,
			rpName: DEFAULT_RP_NAME,
			origins: [],
		};
	const challenges = options.challenges ?? new RegistrationChallenges();
	const sshChallenges = options.sshChallenges ?? new SshRegistrationChallenges();

	app.openapi(listRoute, async (c) =>
		c.json({ signingCredentials: await listSigningCredentials(db, c.get("user").userId) }, 200),
	);

	app.openapi(sshChallengeRoute, async (c) => {
		const user = c.get("user");
		if (!options.serverIdentity) {
			throw new HTTPException(503, { message: "the server identity is not configured" });
		}
		const issued = sshChallenges.issue({ userId: user.userId, serverIdentity: options.serverIdentity });
		return c.json({ challenge: issued.challenge, expiresAt: new Date(issued.expiresAt).toISOString() }, 200);
	});

	app.openapi(addSshRoute, async (c) => {
		const user = c.get("user");
		const body = c.req.valid("json");
		// Consumed before verification: a failed attempt must not leave a challenge to guess against.
		const pending = sshChallenges.takeForUser(user.userId);
		if (!pending) throw new UserError("no pending SSH registration challenge; request one first");
		const verified = verifySshRegistration(body.signature, pending.bytes);
		const credential = await addSshSigningCredential(db, user.userId, {
			publicKey: verified.publicKey,
			name: body.name,
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
	app.openapi(webauthnOptionsRoute, async (c) => {
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
		return c.json({ options: issued.options }, 200);
	});

	app.openapi(addWebauthnRoute, async (c) => {
		const user = c.get("user");
		const body = c.req.valid("json");
		const response = body.response as unknown as RegistrationResponseJSON;
		let challenge: string;
		try {
			const clientData = JSON.parse(Buffer.from(response.response.clientDataJSON, "base64url").toString("utf8")) as {
				challenge?: unknown;
			};
			if (typeof clientData.challenge !== "string") throw new Error("clientDataJSON has no challenge");
			challenge = clientData.challenge;
		} catch (err) {
			throw new UserError(`clientDataJSON: ${errorText(err)}`);
		}
		const pending = challenges.take(challenge);
		if (!pending) throw new UserError("unknown, already used or expired registration challenge");
		if (pending.userId !== user.userId) throw new UserError("the registration belongs to another user");
		const origin = c.req.header("origin");
		if (origin !== undefined && !pending.rp.origins.includes(origin)) {
			throw new UserError(`origin ${origin} is not one the registration was started for`);
		}
		const verified = await verifyRegistration({ response, challenge, rp: pending.rp });
		const credential = await addWebauthnSigningCredential(db, user.userId, {
			name: body.name,
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

	app.openapi(renameRoute, async (c) => {
		const user = c.get("user");
		const { id } = c.req.valid("param");
		const { name } = c.req.valid("json");
		const { before, after } = await renameSigningCredential(db, user.userId, id, name);
		void c.get("audit").record({
			actor: userActor(user),
			action: "signing_credential.renamed",
			target: { type: "signing_credential", id },
			detail: { kind: after.kind, old_name: before.name, new_name: after.name },
		});
		return c.json({ signingCredential: after }, 200);
	});

	app.openapi(deleteRoute, async (c) => {
		const user = c.get("user");
		const { id } = c.req.valid("param");
		const credential = await deleteSigningCredential(db, user.userId, id);
		void c.get("audit").record({
			actor: userActor(user),
			action: "signing_credential.removed",
			target: { type: "signing_credential", id: credential.id },
			detail: { kind: credential.kind, name: credential.name, fingerprint: credential.fingerprint },
		});
		return c.json({ ok: true as const }, 200);
	});

	return app;
}
