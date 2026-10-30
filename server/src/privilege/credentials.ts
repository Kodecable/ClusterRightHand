/**
 * The owner's registered signing credentials (doc/m4.md#crhs-侧数据 `user_credentials`): the SSH keys
 * and Passkeys a user signs privileged tasks with. The planner only considers the user trust entries
 * that match a credential of the task's owner, and submissions are only accepted from them.
 */
import type { Selectable } from "kysely";
import type { Db } from "../storage/db.ts";
import type { UserCredentialsTable } from "../storage/schema.ts";
import { NotFoundError, UserError } from "../users/service.ts";
import { newId } from "../util/id.ts";
import type { OwnerCredentials } from "./planner.ts";
import { authorizedKeyLine, parseAuthorizedKey, sshFingerprint } from "./sshsig.ts";
import type { StoredWebauthnCredential } from "./webauthn.ts";

export type CredentialKind = UserCredentialsTable["kind"];

/** One credential as the API shows it. */
export interface CredentialView {
	id: string;
	kind: CredentialKind;
	name: string;
	createdAt: string;
	/** ssh: the authorized_keys line; webauthn: the COSE public key, base64. */
	publicKey: string;
	/** ssh only: the OpenSSH `SHA256:…` fingerprint a TrustSummary reports. */
	fingerprint: string | null;
	/** webauthn only. */
	credentialId: string | null;
	rpId: string | null;
	origins: string[];
}

export function credentialView(row: Selectable<UserCredentialsTable>): CredentialView {
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

export async function listCredentials(db: Db, userId: string): Promise<CredentialView[]> {
	const rows = await db
		.selectFrom("user_credentials")
		.selectAll()
		.where("user_id", "=", userId)
		.orderBy("created_at")
		.orderBy("id")
		.execute();
	return rows.map(credentialView);
}

/** The fingerprints and credential ids of the owner's credentials, as the planner matches trust entries. */
export async function ownerCredentials(db: Db, userId: string | null | undefined): Promise<OwnerCredentials> {
	if (!userId) return { sshKeyFingerprints: [], webauthnCredentialIds: [] };
	const rows = await db
		.selectFrom("user_credentials")
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

export interface AddSshCredentialInput {
	name?: string;
	/** One authorized_keys line: `type base64 [comment]`. */
	publicKey: string;
}

/**
 * Registers an SSH public key. Only the four key types of doc/privilege.md#签名方式 are accepted, the
 * blob must really be of the named type, and the `SHA256:` fingerprint is what a node's TrustSummary
 * reports, so the owner can be matched to its trust entries.
 */
export async function addSshCredential(db: Db, userId: string, input: AddSshCredentialInput): Promise<CredentialView> {
	let parsed: ReturnType<typeof parseAuthorizedKey>;
	try {
		parsed = parseAuthorizedKey(input.publicKey);
	} catch (err) {
		throw new UserError(err instanceof Error ? err.message : String(err));
	}
	const fingerprint = sshFingerprint(parsed.blob);
	const taken = await db
		.selectFrom("user_credentials")
		.select("id")
		.where("user_id", "=", userId)
		.where("fingerprint", "=", fingerprint)
		.executeTakeFirst();
	if (taken) throw new UserError("this SSH key is already registered");
	const name = (input.name ?? "").trim() || `ssh-${fingerprint.slice("SHA256:".length, "SHA256:".length + 8)}`;
	const row: Selectable<UserCredentialsTable> = {
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
	await db.insertInto("user_credentials").values(row).execute();
	return credentialView(row);
}

export interface AddWebauthnCredentialInput {
	name?: string;
	credentialId: string;
	coseKey: Uint8Array;
	rpId: string;
	origins: string[];
}

/** Registers a Passkey that a completed registration has already verified. */
export async function addWebauthnCredential(
	db: Db,
	userId: string,
	input: AddWebauthnCredentialInput,
): Promise<CredentialView> {
	const taken = await db
		.selectFrom("user_credentials")
		.select("id")
		.where("user_id", "=", userId)
		.where("credential_id", "=", input.credentialId)
		.executeTakeFirst();
	if (taken) throw new UserError("this Passkey is already registered");
	const name = (input.name ?? "").trim() || `passkey-${input.credentialId.slice(0, 8)}`;
	const row: Selectable<UserCredentialsTable> = {
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
	await db.insertInto("user_credentials").values(row).execute();
	return credentialView(row);
}

/** Deletes one of the user's own credentials; another user's credential is a 404. */
export async function deleteCredential(db: Db, userId: string, id: string): Promise<CredentialView> {
	const row = await db
		.selectFrom("user_credentials")
		.selectAll()
		.where("id", "=", id)
		.where("user_id", "=", userId)
		.executeTakeFirst();
	if (!row) throw new NotFoundError("no such credential");
	await db.deleteFrom("user_credentials").where("id", "=", id).where("user_id", "=", userId).execute();
	return credentialView(row);
}

/** The user's WebAuthn credentials, with the key material needed to verify an assertion. */
export async function webauthnCredentials(
	db: Db,
	userId: string,
): Promise<(StoredWebauthnCredential & { name: string })[]> {
	const rows = await db
		.selectFrom("user_credentials")
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
