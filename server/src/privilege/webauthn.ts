/**
 * Passkey (WebAuthn) registration and assertion checks (doc/design/privilege.md "Signing methods").
 *
 * crhs only verifies that a credential belongs to a user and that an assertion over an authorization
 * payload is genuine; crha verifies the same assertion again against its own trust entry, including
 * `require_uv`. The checks here are deliberately as strict as crha's: credential id, webauthn.get,
 * challenge bytes, origin, cross-origin, rpIdHash, user presence and the COSE signature. A
 * `require_uv` flag is reported, never enforced here, exactly as crha does at its step 7.
 */
import { createHash } from "node:crypto";
import { AUTH_NAMESPACE } from "@crh/protocol";
import {
	type AuthenticationResponseJSON,
	generateRegistrationOptions,
	type PublicKeyCredentialCreationOptionsJSON,
	type RegistrationResponseJSON,
	verifyAuthenticationResponse,
	verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type { WebauthnConfig } from "../config.ts";
import { errorText } from "../util/errors.ts";

/** The COSE algorithms crhs registers (doc/design/privilege.md "Signing methods"): ES256, EdDSA/Ed25519, RS256. */
export const SUPPORTED_ALGORITHM_IDS: readonly number[] = [-7, -8, -257];

/** How long a registration challenge stays valid. */
export const REGISTRATION_CHALLENGE_TTL_MS = 5 * 60 * 1000;

/** The most pending registration challenges kept across all users; the oldest is evicted first. */
export const MAX_PENDING_REGISTRATIONS = 10_000;

/** A WebAuthn problem with the request; the API reports it as a 400. */
export class WebauthnError extends Error {
	override name = "WebauthnError";
}

/** The relying party a credential is registered for and an assertion must name. */
export interface WebauthnRp {
	rpId: string;
	rpName: string;
	/** The exact origins accepted; crha checks its trust entry's own list again. */
	origins: string[];
}

/**
 * The RP settings for a browser request. With `[webauthn]` configured in crhs.toml they are fixed;
 * otherwise the RP ID is the hostname of the request's Origin header and exactly that origin is
 * accepted. The derived form is what the code documents as the "unset" case: it keeps a single-host
 * deployment working without configuration, and never trusts an origin other than the one the
 * browser reported.
 */
export function rpForRequest(config: WebauthnConfig, originHeader: string | undefined): WebauthnRp {
	if (config.rpId !== null) {
		const rp = { rpId: config.rpId, rpName: config.rpName, origins: [...config.origins] };
		if (originHeader !== undefined && !rp.origins.includes(originHeader)) {
			throw new WebauthnError(`origin ${originHeader} is not one of webauthn.origins`);
		}
		return rp;
	}
	if (originHeader === undefined) {
		throw new WebauthnError("the WebAuthn relying party is not configured and the request has no Origin header");
	}
	let url: URL;
	try {
		url = new URL(originHeader);
	} catch {
		throw new WebauthnError(`the request's Origin header ${JSON.stringify(originHeader)} is not a URL`);
	}
	if (url.origin !== originHeader) {
		throw new WebauthnError(`the request's Origin header ${JSON.stringify(originHeader)} is not an origin`);
	}
	return { rpId: url.hostname, rpName: config.rpName, origins: [url.origin] };
}

/** challenge = SHA-256("crh-auth-v1\0" ‖ payload) (doc/design/protocol.md "Authorization object"). */
export function webauthnChallenge(payload: Uint8Array): Uint8Array {
	return Uint8Array.from(createHash("sha256").update(`${AUTH_NAMESPACE}\0`).update(payload).digest());
}

export interface IssuedRegistration {
	options: PublicKeyCredentialCreationOptionsJSON;
	/** base64url of the challenge; the single-use server-side record is keyed by it. */
	challenge: string;
}

interface PendingRegistration {
	rp: WebauthnRp;
	userId: string;
	expiresAt: number;
}

/**
 * Server-side, single-use registration challenges. They live in memory only: a crhs restart just makes
 * the user start the registration again, and nothing secret is kept in them.
 *
 * A user has at most one pending challenge: issuing a new one replaces the previous, so a logged-in user
 * cannot grow the store one request at a time. Across all users at most `maxPending` challenges are kept;
 * issuing beyond that evicts the oldest challenge first.
 */
export class RegistrationChallenges {
	readonly #pending = new Map<string, PendingRegistration>();
	readonly #byUser = new Map<string, string>();
	readonly #now: () => number;
	readonly #maxPending: number;

	constructor(now: () => number = Date.now, maxPending: number = MAX_PENDING_REGISTRATIONS) {
		this.#now = now;
		this.#maxPending = Math.max(1, maxPending);
	}

	/** Creates the creation options and remembers the challenge for `ttlMs`. */
	async issue(input: {
		rp: WebauthnRp;
		userId: string;
		userName: string;
		userDisplayName: string;
		excludeCredentialIds: readonly string[];
		ttlMs?: number;
	}): Promise<IssuedRegistration> {
		const options = await generateRegistrationOptions({
			rpName: input.rp.rpName,
			rpID: input.rp.rpId,
			userName: input.userName,
			userDisplayName: input.userDisplayName,
			userID: Buffer.from(input.userId, "utf8"),
			excludeCredentials: input.excludeCredentialIds.map((id) => ({ id })),
			supportedAlgorithmIDs: [...SUPPORTED_ALGORITHM_IDS],
			authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
		});
		const challenge = options.challenge;
		this.#prune();
		// The new challenge replaces this user's previous one, so it needs no extra global slot.
		const previous = this.#byUser.get(input.userId);
		if (previous !== undefined) this.#pending.delete(previous);
		while (this.#pending.size >= this.#maxPending) this.#evictOldest();
		this.#pending.set(challenge, {
			rp: input.rp,
			userId: input.userId,
			expiresAt: this.#now() + (input.ttlMs ?? REGISTRATION_CHALLENGE_TTL_MS),
		});
		this.#byUser.set(input.userId, challenge);
		return { options, challenge };
	}

	/** Consumes a challenge; undefined when it is unknown, already used or expired. */
	take(challenge: string): PendingRegistration | undefined {
		const pending = this.#pending.get(challenge);
		if (!pending) return undefined;
		this.#pending.delete(challenge);
		if (this.#byUser.get(pending.userId) === challenge) this.#byUser.delete(pending.userId);
		return pending.expiresAt >= this.#now() ? pending : undefined;
	}

	#prune(): void {
		const now = this.#now();
		for (const [challenge, pending] of this.#pending) {
			if (pending.expiresAt >= now) continue;
			this.#pending.delete(challenge);
			if (this.#byUser.get(pending.userId) === challenge) this.#byUser.delete(pending.userId);
		}
	}

	#evictOldest(): void {
		const oldest = this.#pending.entries().next();
		if (oldest.done) return;
		const [challenge, pending] = oldest.value;
		this.#pending.delete(challenge);
		if (this.#byUser.get(pending.userId) === challenge) this.#byUser.delete(pending.userId);
	}
}

export interface VerifiedRegistration {
	/** base64url credential id, as TrustSummary's webauthn key carries it. */
	credentialId: string;
	/** The COSE public key bytes, stored verbatim for the trust snippet. */
	coseKey: Uint8Array;
	userVerified: boolean;
}

/**
 * Verifies an attestation against the challenge the server issued and returns the credential to store.
 * Only the three algorithms crha can verify are accepted, so no registered credential can be one the
 * privileged mode would have to reject.
 */
export async function verifyRegistration(input: {
	response: RegistrationResponseJSON;
	challenge: string;
	rp: WebauthnRp;
}): Promise<VerifiedRegistration> {
	let result: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
	try {
		result = await verifyRegistrationResponse({
			response: input.response,
			expectedChallenge: input.challenge,
			expectedOrigin: input.rp.origins,
			expectedRPID: input.rp.rpId,
			supportedAlgorithmIDs: [...SUPPORTED_ALGORITHM_IDS],
			// UV is a trust-entry decision (require_uv), like the FIDO flags of an sk-* SSH key.
			requireUserVerification: false,
		});
	} catch (err) {
		throw new WebauthnError(errorText(err));
	}
	if (!result.verified) throw new WebauthnError("the registration response did not verify");
	const credential = result.registrationInfo.credential;
	return {
		credentialId: credential.id,
		coseKey: Uint8Array.from(credential.publicKey),
		userVerified: result.registrationInfo.userVerified,
	};
}

/** A stored WebAuthn credential, as user_credentials keeps it. */
export interface StoredWebauthnCredential {
	credentialId: string;
	coseKey: Uint8Array;
	rpId: string;
	origins: string[];
}

export interface VerifiedAssertion {
	/** The UV flag of the authenticator data; a trust entry's require_uv enforces it later. */
	userVerified: boolean;
}

/**
 * Verifies one assertion over the authorization payload. The browser's `credential` must be one of the
 * user's stored credentials; the returned signature is what the Authorization carries.
 */
export async function verifyAssertion(input: {
	credential: StoredWebauthnCredential;
	payload: Uint8Array;
	response: AuthenticationResponseJSON;
}): Promise<VerifiedAssertion> {
	if (input.response.id !== input.credential.credentialId) {
		throw new WebauthnError("the assertion is for another credential");
	}
	// crha's checks on clientDataJSON, repeated here so crhs accepts exactly the same assertions:
	// type, crossOrigin, origin and the challenge *bytes*. The library compares the challenge as a
	// string and ignores crossOrigin when topOrigin is absent, both of which would widen the set.
	const clientDataRaw = decodeBase64url(input.response.response.clientDataJSON);
	if (!clientDataRaw) throw new WebauthnError("clientDataJSON is not base64url");
	const clientData = checkClientData(Buffer.from(clientDataRaw).toString("utf8"), input.payload);
	if (!input.credential.origins.includes(clientData.origin)) {
		throw new WebauthnError(`origin ${clientData.origin} is not one the credential was registered for`);
	}
	try {
		const result = await verifyAuthenticationResponse({
			response: input.response,
			// The challenge was compared as bytes above; crha uses the bytes too.
			expectedChallenge: () => true,
			expectedOrigin: clientData.origin,
			expectedRPID: input.credential.rpId,
			// The counter is ignored on purpose (doc/design/privilege.md "Signing methods"): synced passkeys keep it at 0
			// and replay is prevented by the used list on the node. Passing 0 skips the library's counter
			// comparison, matching crha's verifier.
			credential: {
				id: input.credential.credentialId,
				publicKey: Uint8Array.from(input.credential.coseKey),
				counter: 0,
			},
			requireUserVerification: false,
		});
		if (!result.verified) throw new WebauthnError("the assertion did not verify");
		return { userVerified: result.authenticationInfo.userVerified };
	} catch (err) {
		if (err instanceof WebauthnError) throw err;
		throw new WebauthnError(errorText(err));
	}
}

/** The parts of clientDataJSON crha checks, with the challenge decoded and compared as bytes. */
function checkClientData(json: string, payload: Uint8Array): { type: string; origin: string } {
	let value: unknown;
	try {
		value = JSON.parse(json);
	} catch {
		throw new WebauthnError("clientDataJSON is not valid JSON");
	}
	if (typeof value !== "object" || value === null) throw new WebauthnError("clientDataJSON is not an object");
	const clientData = value as { type?: unknown; challenge?: unknown; origin?: unknown; crossOrigin?: unknown };
	if (clientData.type !== "webauthn.get") throw new WebauthnError(`clientDataJSON type is not webauthn.get`);
	if (clientData.crossOrigin === true) throw new WebauthnError("crossOrigin is not allowed");
	if (typeof clientData.origin !== "string") throw new WebauthnError("clientDataJSON has no origin");
	if (typeof clientData.challenge !== "string") throw new WebauthnError("clientDataJSON has no challenge");
	const challenge = decodeBase64url(clientData.challenge);
	if (challenge === null) throw new WebauthnError("clientDataJSON challenge is not base64url without padding");
	const expected = webauthnChallenge(payload);
	if (challenge.length !== expected.length || !Buffer.from(challenge).equals(Buffer.from(expected))) {
		throw new WebauthnError("clientDataJSON challenge does not match the authorization payload");
	}
	return { type: clientData.type, origin: clientData.origin };
}

/** Strict base64url (no padding), like Go's `base64.RawURLEncoding`; null when it is not. */
function decodeBase64url(value: string): Uint8Array | null {
	if (!/^[A-Za-z0-9_-]*$/.test(value)) return null;
	const bytes = Uint8Array.from(Buffer.from(value, "base64url"));
	return Buffer.from(bytes).toString("base64url") === value ? bytes : null;
}
