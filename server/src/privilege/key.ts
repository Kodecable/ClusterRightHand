/**
 * crhs's authorization signing keys (doc/design/privilege.md "Authorization signing key"): a list of
 * ed25519 keys, each generated when it is added and stored encrypted in `secrets` with the master key
 * exactly like the Noise identity, and the SSHSIG signers built on node:crypto. The newest key comes
 * first; a node's cached trust report decides which of them crhs may use for that node.
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from "node:crypto";
import type { TrustEntry } from "@crh/protocol";
import { secretAad } from "../keys/export.ts";
import type { MasterKey } from "../keys/master-key.ts";
import type { Db } from "../storage/db.ts";
import { defaultOrgId } from "../users/service.ts";
import { NotFoundError, UserError } from "../util/errors.ts";
import { newId } from "../util/id.ts";
import { authorizedKeyLine, ed25519PublicBlob, signSshsig, sshFingerprint } from "./sshsig.ts";

/** The `secrets.kind` of the keys (crhs keys export lists it). */
export const AUTHORIZATION_SIGNING_KEY_KIND = "authorization_signing_key";
/** The authorized_keys comment of the public key. */
export const AUTHORIZATION_SIGNING_KEY_COMMENT = "crhs-signing";
/**
 * The `server_meta` flag that says the first key has existed: with it, an empty key list is an explicit
 * deletion rather than a first start (doc/design/privilege.md "Authorization signing key").
 */
const INITIALIZED_META_KEY = "authorization_signing_keys_initialized";

/** What crhs needs from a node's trust report to pick a signing key. */
export type SigningKeyKind = "execute" | "cosign";

export interface AuthorizationSigningKey {
	/** The `secrets` row id; the signing keys API addresses a key by it. */
	readonly id: string;
	readonly createdAt: string;
	readonly publicKey: KeyObject;
	/** SSH wire-format ed25519 public key blob (what the fingerprint hashes). */
	readonly publicKeyBlob: Uint8Array;
	/** `ssh-ed25519 <base64> crhs-signing`, to paste into a node's privileged.toml trust entry. */
	readonly authorizedKey: string;
	/** OpenSSH `SHA256:…` fingerprint, matching TrustSummary's TrustKey fingerprint. */
	readonly fingerprint: string;
	/** SSHSIG (binary, unarmored) over the payload bytes, namespace crh-auth-v1, sha512. */
	sign(payload: Uint8Array): Uint8Array;
}

function publicParts(publicKey: KeyObject): { publicKeyBlob: Uint8Array; authorizedKey: string; fingerprint: string } {
	const publicKeyBlob = ed25519PublicBlob(publicKey);
	return {
		publicKeyBlob,
		authorizedKey: authorizedKeyLine("ssh-ed25519", publicKeyBlob, AUTHORIZATION_SIGNING_KEY_COMMENT),
		fingerprint: sshFingerprint(publicKeyBlob),
	};
}

/** The OpenSSH fingerprint of an ed25519 private key (for an exported key's audit record, without the key). */
export function signingKeyFingerprint(privateKey: KeyObject): string {
	return publicParts(createPublicKey(privateKey)).fingerprint;
}

/** Builds the public surface of one key; the private key is never stored beyond the signer closure. */
function signingKey(parts: { id: string; createdAt: string }, privateKey: KeyObject): AuthorizationSigningKey {
	const publicKey = createPublicKey(privateKey);
	const publicPart = publicParts(publicKey);
	return {
		...parts,
		publicKey,
		...publicPart,
		sign: (payload) => signSshsig(privateKey, publicPart.publicKeyBlob, payload),
	};
}

async function initialized(db: Db): Promise<boolean> {
	const row = await db
		.selectFrom("server_meta")
		.select("value")
		.where("key", "=", INITIALIZED_META_KEY)
		.executeTakeFirst();
	return row !== undefined;
}

/** Records that the first key existed, so deleting every key is not mistaken for a first start. */
async function markInitialized(db: Db): Promise<void> {
	await db
		.insertInto("server_meta")
		.values({ key: INITIALIZED_META_KEY, value: "1" })
		.onConflict((conflict) => conflict.column("key").doNothing())
		.execute();
}

/**
 * The live key set, newest first (doc/design/privilege.md "Authorization signing key"). Loading it creates the first
 * key when the database has never had one; add and delete update the list and the database together, so a
 * running crhs picks up a new key without a restart. A process holds one instance, shared by the cluster
 * and the API.
 */
export class AuthorizationSigningKeyStore {
	readonly #db: Db | undefined;
	readonly #masterKey: MasterKey | undefined;
	#keys: AuthorizationSigningKey[];

	private constructor(db: Db | undefined, masterKey: MasterKey | undefined, keys: AuthorizationSigningKey[]) {
		this.#db = db;
		this.#masterKey = masterKey;
		this.#keys = keys;
	}

	/** A fixed set for a caller that supplies a single key instead of the store (tests and the soak run). */
	static fromKey(key: AuthorizationSigningKey | undefined): AuthorizationSigningKeyStore {
		return new AuthorizationSigningKeyStore(undefined, undefined, key ? [key] : []);
	}

	/** The set read by `loadAuthorizationSigningKeys`; it can add and delete keys through `db` and `masterKey`. */
	static fromLoaded(db: Db, masterKey: MasterKey, keys: AuthorizationSigningKey[]): AuthorizationSigningKeyStore {
		return new AuthorizationSigningKeyStore(db, masterKey, keys);
	}

	/** The keys, newest first; empty after an administrator deleted the last one. */
	get keys(): readonly AuthorizationSigningKey[] {
		return this.#keys;
	}

	/** The key crhs signs with by default: the newest, or undefined when there is none. */
	get newest(): AuthorizationSigningKey | undefined {
		return this.#keys[0];
	}

	/** Fingerprints newest first, the order the planner uses to pick a node's key. */
	get fingerprints(): readonly string[] {
		return this.#keys.map((key) => key.fingerprint);
	}

	get(id: string): AuthorizationSigningKey | undefined {
		return this.#keys.find((key) => key.id === id);
	}

	byFingerprint(fingerprint: string): AuthorizationSigningKey | undefined {
		return this.#keys.find((key) => key.fingerprint === fingerprint);
	}

	/** Adds a newly generated key; it becomes the newest and the one planning prefers. */
	async add(): Promise<AuthorizationSigningKey> {
		if (!this.#db || !this.#masterKey) throw new UserError("signing keys are not configured");
		const privateKey = generateKeyPairSync("ed25519").privateKey;
		const id = newId();
		const createdAt = new Date().toISOString();
		await this.#db
			.insertInto("secrets")
			.values({
				id,
				org_id: await defaultOrgId(this.#db),
				kind: AUTHORIZATION_SIGNING_KEY_KIND,
				ciphertext: this.#masterKey.encrypt(
					privateKey.export({ format: "der", type: "pkcs8" }),
					secretAad(id, AUTHORIZATION_SIGNING_KEY_KIND),
				),
				created_at: createdAt,
			})
			.execute();
		const key = signingKey({ id, createdAt }, privateKey);
		// The row is stored: use the key at once, even if recording the first-key flag fails.
		this.#keys = [key, ...this.#keys];
		await markInitialized(this.#db);
		return key;
	}

	/** Deletes one key; the caller has already checked what still trusts it. */
	async delete(id: string): Promise<AuthorizationSigningKey> {
		if (!this.#db) throw new UserError("signing keys are not configured");
		const key = this.get(id);
		if (!key) throw new NotFoundError("no such signing key");
		const result = await this.#db
			.deleteFrom("secrets")
			.where("id", "=", id)
			.where("kind", "=", AUTHORIZATION_SIGNING_KEY_KIND)
			.executeTakeFirst();
		if (result.numDeletedRows === 0n) throw new NotFoundError("no such signing key");
		// Stop using it before the bookkeeping write: a deleted key must never sign, even if that write fails.
		this.#keys = this.#keys.filter((candidate) => candidate.id !== id);
		// A database that had keys keeps its marker, but writing it again is harmless and covers a row
		// deleted before the first load recorded one.
		await markInitialized(this.#db);
		return key;
	}

	/** The startup line: the count and the newest fingerprint, or that there is none. */
	describe(): string {
		const newest = this.newest;
		return newest ? `signing keys: ${this.#keys.length}, newest ${newest.fingerprint}` : "no signing key";
	}
}

/** Loads every stored key, newest first; creates the first one when the database never had a key. */
export async function loadAuthorizationSigningKeys(
	db: Db,
	masterKey: MasterKey,
): Promise<AuthorizationSigningKeyStore> {
	const rows = await db
		.selectFrom("secrets")
		.select(["id", "ciphertext", "created_at"])
		.where("kind", "=", AUTHORIZATION_SIGNING_KEY_KIND)
		.orderBy("created_at", "desc")
		.orderBy("id", "desc")
		.execute();
	const keys = rows.map((row) =>
		signingKey(
			{ id: row.id, createdAt: row.created_at },
			createPrivateKey({
				key: masterKey.decrypt(row.ciphertext, secretAad(row.id, AUTHORIZATION_SIGNING_KEY_KIND)),
				format: "der",
				type: "pkcs8",
			}),
		),
	);
	const store = AuthorizationSigningKeyStore.fromLoaded(db, masterKey, keys);
	// Zero keys are allowed only after an explicit delete: without the flag this is a first start.
	if (rows.length > 0 || (await initialized(db))) {
		if (rows.length > 0) await markInitialized(db);
		return store;
	}
	await store.add();
	return store;
}

/** The newest key, creating the first one on a fresh database; for callers that need exactly one key. */
export async function loadAuthorizationSigningKey(db: Db, masterKey: MasterKey): Promise<AuthorizationSigningKey> {
	const keys = await loadAuthorizationSigningKeys(db, masterKey);
	const newest = keys.newest;
	if (!newest) throw new UserError("crhs has no authorization signing key");
	return newest;
}

/**
 * The first trust entry per key: crha maps a signature to the first entry with its key, so later entries
 * repeating the key never take part in a decision (doc/design/privilege.md "Validation flow" step 3).
 */
export function firstTrustEntriesByKey(trust: readonly TrustEntry[]): Map<string, TrustEntry> {
	const entries = new Map<string, TrustEntry>();
	for (const entry of trust) {
		if (entry.key.kind !== "sshsig") continue;
		if (!entries.has(entry.key.fingerprint)) entries.set(entry.key.fingerprint, entry);
	}
	return entries;
}

/**
 * The newest key a node trusts with `kind` (doc/design/privilege.md "Authorization signing key"): `execute` to
 * authorize a task alone, `cosign` to confirm the owner's authorization. No result means the node has no
 * usable crhs entry, and crhs behaves as if it had no key for that node.
 */
export function trustedSigningKey(
	keys: readonly AuthorizationSigningKey[],
	trust: readonly TrustEntry[],
	kind: SigningKeyKind,
): AuthorizationSigningKey | undefined {
	const entries = firstTrustEntriesByKey(trust);
	for (const key of keys) {
		const entry = entries.get(key.fingerprint);
		if (entry?.role === "crhs" && entry.kinds.includes(kind)) return key;
	}
	return undefined;
}
