/**
 * The owner's registered signing credentials (doc/design/privilege.md "Server-side authorization" `signing_credentials`): the SSH keys
 * and Passkeys a user signs privileged tasks with. The planner only considers the user trust entries
 * that match a credential of the task's owner, and submissions are only accepted from them.
 */
import type { SigningCredentialView } from "@crh/api";
import type { Selectable } from "kysely";
import type { Db } from "../storage/db.ts";
import type { SigningCredentialsTable } from "../storage/schema.ts";
import { NotFoundError, UserError } from "../util/errors.ts";
import { newId } from "../util/id.ts";
import type { OwnerSigningCredentials } from "./planner.ts";
import { authorizedKeyLine, parseAuthorizedKey, sshFingerprint } from "./sshsig.ts";
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
