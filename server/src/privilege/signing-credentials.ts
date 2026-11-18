/**
 * The owner's registered signing credentials (doc/design/privilege.md "Server-side authorization" `signing_credentials`): the SSH keys
 * and Passkeys a user signs privileged tasks with. The planner only considers the user trust entries
 * that match a credential of the task's owner, and submissions are only accepted from them.
 */
import { randomBytes } from "node:crypto";
import type { SigningCredentialView } from "@crh/api";
import type { Selectable } from "kysely";
import type { Db } from "../storage/db.ts";
import type { SigningCredentialsTable } from "../storage/schema.ts";
import { NotFoundError, UserError } from "../util/errors.ts";
import { newId } from "../util/id.ts";
import type { OwnerSigningCredentials } from "./planner.ts";
import {
	authorizedKeyLine,
	decodeSshsigText,
	parseAuthorizedKey,
	REGISTER_NAMESPACE,
	sshFingerprint,
	sshsigKeyLine,
	verifySshsig,
} from "./sshsig.ts";
import type { StoredWebauthnCredential } from "./webauthn.ts";

export type SigningCredentialKind = SigningCredentialsTable["kind"];

export type { SigningCredentialView };

export function signingCredentialView(row: Selectable<SigningCredentialsTable>): SigningCredentialView {
	return {
		id: row.id,
		kind: row.kind,
		name: row.name,
		createdAt: row.created_at,
		publicKey: row.public_key,
		fingerprint: row.fingerprint,
		credentialId: row.credential_id,
		rpId: row.rp_id,
		origins: parseOrigins(row.origins),
	};
}

function parseOrigins(json: string | null): string[] {
	if (!json) return [];
	try {
		const value = JSON.parse(json) as unknown;
		return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
	} catch {
		return [];
	}
}

export async function listSigningCredentials(db: Db, userId: string): Promise<SigningCredentialView[]> {
	const rows = await db
		.selectFrom("signing_credentials")
		.selectAll()
		.where("user_id", "=", userId)
		.orderBy("created_at")
		.orderBy("id")
		.execute();
	return rows.map(signingCredentialView);
}

/** The fingerprints and credential ids of the owner's credentials, as the planner matches trust entries. */
export async function ownerSigningCredentials(
	db: Db,
	userId: string | null | undefined,
): Promise<OwnerSigningCredentials> {
	if (!userId) return { sshKeyFingerprints: [], webauthnCredentialIds: [] };
	const rows = await db
		.selectFrom("signing_credentials")
		.select(["kind", "fingerprint", "credential_id"])
		.where("user_id", "=", userId)
		.execute();
	return {
		sshKeyFingerprints: rows.flatMap((row) => (row.kind === "ssh" && row.fingerprint ? [row.fingerprint] : [])),
		webauthnCredentialIds: rows.flatMap((row) =>
			row.kind === "webauthn" && row.credential_id ? [row.credential_id] : [],
		),
	};
}

/** How long an SSH registration challenge stays valid. */
export const SSH_REGISTRATION_CHALLENGE_TTL_MS = 10 * 60 * 1000;

/** The most pending SSH registration challenges kept across all users; the oldest is evicted first. */
export const MAX_PENDING_SSH_REGISTRATIONS = 10_000;

/**
 * The exact bytes an SSH signing-credential registration signs. The namespace keeps a registration
 * signature from ever verifying as an authorization, and the user and server lines keep a challenge
 * from one user or installation from being replayed at another.
 */
export function sshRegistrationChallengeBytes(input: {
	userId: string;
	serverIdentity: string;
	nonce: Uint8Array;
}): Uint8Array {
	const nonce = Buffer.from(input.nonce).toString("base64url");
	return Uint8Array.from(
		Buffer.from(
			`${REGISTER_NAMESPACE}\nuser:${input.userId}\nserver:${input.serverIdentity}\nnonce:${nonce}\n`,
			"utf8",
		),
	);
}

export interface IssuedSshRegistration {
	/** base64url of the exact bytes the user signs. */
	challenge: string;
	/** When the registration must be submitted. */
	expiresAt: number;
}

interface PendingSshRegistration {
	challenge: string;
	bytes: Uint8Array;
	userId: string;
	expiresAt: number;
}

/**
 * Server-side, single-use SSH registration challenges. They live in memory only, like the WebAuthn
 * challenges: a crhs restart just makes the user request a new one, and nothing secret is kept. A
 * user has at most one pending challenge (issuing replaces it), and across all users at most
 * `maxPending` are kept, evicting the oldest first.
 */
export class SshRegistrationChallenges {
	readonly #pending = new Map<string, PendingSshRegistration>();
	readonly #byUser = new Map<string, string>();
	readonly #now: () => number;
	readonly #maxPending: number;

	constructor(now: () => number = Date.now, maxPending: number = MAX_PENDING_SSH_REGISTRATIONS) {
		this.#now = now;
		this.#maxPending = Math.max(1, maxPending);
	}

	/** Creates a challenge for the user, replacing any pending one. */
	issue(input: { userId: string; serverIdentity: string; ttlMs?: number }): IssuedSshRegistration {
		const nonce = randomBytes(32);
		const bytes = sshRegistrationChallengeBytes({
			userId: input.userId,
			serverIdentity: input.serverIdentity,
			nonce,
		});
		const challenge = Buffer.from(bytes).toString("base64url");
		const expiresAt = this.#now() + (input.ttlMs ?? SSH_REGISTRATION_CHALLENGE_TTL_MS);
		this.#prune();
		// The new challenge replaces this user's previous one, so it needs no extra global slot.
		const previous = this.#byUser.get(input.userId);
		if (previous !== undefined) this.#pending.delete(previous);
		while (this.#pending.size >= this.#maxPending) this.#evictOldest();
		this.#pending.set(challenge, { challenge, bytes, userId: input.userId, expiresAt });
		this.#byUser.set(input.userId, challenge);
		return { challenge, expiresAt };
	}

	/**
	 * Consumes the user's pending challenge. It is consumed on every verification attempt, valid or
	 * not, so a signature cannot be guessed against one challenge.
	 */
	takeForUser(userId: string): { challenge: string; bytes: Uint8Array; expiresAt: number } | undefined {
		const challenge = this.#byUser.get(userId);
		if (challenge === undefined) return undefined;
		const pending = this.#take(challenge);
		return pending === undefined ? undefined : { challenge, bytes: pending.bytes, expiresAt: pending.expiresAt };
	}

	#take(challenge: string): PendingSshRegistration | undefined {
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

export interface VerifiedSshRegistration {
	/** The authorized_keys line of the key embedded in the signature. */
	publicKey: string;
	fingerprint: string;
}

/**
 * Verifies a registration signature over the challenge and returns the public key it carries. The
 * key is never taken from the request body: the SSHSIG names it and OpenSSH's signature proves the
 * user holds the private key.
 */
export function verifySshRegistration(signature: string, challenge: Uint8Array): VerifiedSshRegistration {
	let blob: Uint8Array;
	try {
		blob = decodeSshsigText(signature);
	} catch (err) {
		throw new UserError(err instanceof Error ? err.message : String(err));
	}
	const publicKey = sshsigKeyLine(blob);
	if (!publicKey) throw new UserError("the signature does not carry a supported SSH public key");
	const result = verifySshsig(publicKey, challenge, blob, { namespace: REGISTER_NAMESPACE });
	if (!result.valid) throw new UserError(`the registration signature does not verify: ${result.reason}`);
	let parsed: ReturnType<typeof parseAuthorizedKey>;
	try {
		parsed = parseAuthorizedKey(publicKey);
	} catch (err) {
		throw new UserError(err instanceof Error ? err.message : String(err));
	}
	return { publicKey: authorizedKeyLine(parsed.keyType, parsed.blob), fingerprint: sshFingerprint(parsed.blob) };
}

export interface AddSshCredentialInput {
	name?: string;
	/** One authorized_keys line: `type base64 [comment]`. */
	publicKey: string;
}

/**
 * Registers an SSH public key. Only the four key types of doc/design/privilege.md "Signing methods" are accepted, the
 * blob must really be of the named type, and the `SHA256:` fingerprint is what a node's TrustSummary
 * reports, so the owner can be matched to its trust entries.
 */
export async function addSshSigningCredential(
	db: Db,
	userId: string,
	input: AddSshCredentialInput,
): Promise<SigningCredentialView> {
	let parsed: ReturnType<typeof parseAuthorizedKey>;
	try {
		parsed = parseAuthorizedKey(input.publicKey);
	} catch (err) {
		throw new UserError(err instanceof Error ? err.message : String(err));
	}
	const fingerprint = sshFingerprint(parsed.blob);
	const taken = await db
		.selectFrom("signing_credentials")
		.select("id")
		.where("user_id", "=", userId)
		.where("fingerprint", "=", fingerprint)
		.executeTakeFirst();
	if (taken) throw new UserError("this SSH key is already registered");
	const name = (input.name ?? "").trim() || `ssh-${fingerprint.slice("SHA256:".length, "SHA256:".length + 8)}`;
	const row: Selectable<SigningCredentialsTable> = {
		id: newId(),
		user_id: userId,
		kind: "ssh",
		name,
		public_key: authorizedKeyLine(parsed.keyType, parsed.blob),
		fingerprint,
		credential_id: null,
		rp_id: null,
		origins: null,
		created_at: new Date().toISOString(),
	};
	await db.insertInto("signing_credentials").values(row).execute();
	return signingCredentialView(row);
}

export interface AddWebauthnCredentialInput {
	name?: string;
	credentialId: string;
	coseKey: Uint8Array;
	rpId: string;
	origins: string[];
}

/** Registers a Passkey that a completed registration has already verified. */
export async function addWebauthnSigningCredential(
	db: Db,
	userId: string,
	input: AddWebauthnCredentialInput,
): Promise<SigningCredentialView> {
	const taken = await db
		.selectFrom("signing_credentials")
		.select("id")
		.where("user_id", "=", userId)
		.where("credential_id", "=", input.credentialId)
		.executeTakeFirst();
	if (taken) throw new UserError("this Passkey is already registered");
	const name = (input.name ?? "").trim() || `passkey-${input.credentialId.slice(0, 8)}`;
	const row: Selectable<SigningCredentialsTable> = {
		id: newId(),
		user_id: userId,
		kind: "webauthn",
		name,
		public_key: Buffer.from(input.coseKey).toString("base64"),
		fingerprint: null,
		credential_id: input.credentialId,
		rp_id: input.rpId,
		origins: JSON.stringify(input.origins),
		created_at: new Date().toISOString(),
	};
	await db.insertInto("signing_credentials").values(row).execute();
	return signingCredentialView(row);
}

/** Deletes one of the user's own credentials; another user's credential is a 404. */
export async function deleteSigningCredential(db: Db, userId: string, id: string): Promise<SigningCredentialView> {
	const row = await db
		.selectFrom("signing_credentials")
		.selectAll()
		.where("id", "=", id)
		.where("user_id", "=", userId)
		.executeTakeFirst();
	if (!row) throw new NotFoundError("no such credential");
	await db.deleteFrom("signing_credentials").where("id", "=", id).where("user_id", "=", userId).execute();
	return signingCredentialView(row);
}

/** The user's WebAuthn credentials, with the key material needed to verify an assertion. */
export async function webauthnSigningCredentials(
	db: Db,
	userId: string,
): Promise<(StoredWebauthnCredential & { name: string })[]> {
	const rows = await db
		.selectFrom("signing_credentials")
		.selectAll()
		.where("user_id", "=", userId)
		.where("kind", "=", "webauthn")
		.orderBy("created_at")
		.execute();
	return rows.map((row) => ({
		name: row.name,
		credentialId: row.credential_id as string,
		coseKey: Uint8Array.from(Buffer.from(row.public_key, "base64")),
		rpId: row.rp_id ?? "",
		origins: parseOrigins(row.origins),
	}));
}
