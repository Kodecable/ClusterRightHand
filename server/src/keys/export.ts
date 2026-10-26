import { armor, Decrypter, Encrypter } from "age-encryption";
import type { Db } from "../storage/db.ts";
import { boundMasterKeyId, KeyError, MasterKey } from "./master-key.ts";

/** Secret kinds that are server keys and therefore part of a key export. */
export const EXPORTED_SECRET_KINDS = ["server_identity_key", "authorization_signing_key"] as const;

export interface KeyExport {
	format: "crh-keys";
	version: 1;
	created_at: string;
	master_key: string;
	master_key_id: string;
	/** Decrypted server keys, so the export is usable even without the database. */
	keys: { id: string; kind: string; created_at: string; value: string }[];
}

export async function buildKeyExport(db: Db, masterKey: MasterKey, now = new Date()): Promise<KeyExport> {
	const rows = await db
		.selectFrom("secrets")
		.selectAll()
		.where("kind", "in", [...EXPORTED_SECRET_KINDS])
		.orderBy("created_at")
		.execute();
	return {
		format: "crh-keys",
		version: 1,
		created_at: now.toISOString(),
		master_key: masterKey.toBase64(),
		master_key_id: masterKey.id,
		keys: rows.map((r) => ({
			id: r.id,
			kind: r.kind,
			created_at: r.created_at,
			value: masterKey.decrypt(r.ciphertext, secretAad(r.id, r.kind)).toString("base64"),
		})),
	};
}

/** Associated data that binds a secret's ciphertext to its row. */
export function secretAad(id: string, kind: string): string {
	return `crh-secret\0${id}\0${kind}`;
}

/** Returns an ASCII-armored age file encrypted with a passphrase (decryptable with the standard `age -d`). */
export async function encryptKeyExport(data: KeyExport, passphrase: string, workFactor?: number): Promise<string> {
	if (passphrase.length === 0) throw new KeyError("passphrase must not be empty");
	const e = new Encrypter();
	e.setPassphrase(passphrase);
	if (workFactor !== undefined) e.setScryptWorkFactor(workFactor);
	return armor.encode(await e.encrypt(`${JSON.stringify(data, null, 2)}\n`));
}

export async function decryptKeyExport(file: string, passphrase: string): Promise<KeyExport> {
	const d = new Decrypter();
	d.addPassphrase(passphrase);
	let text: string;
	try {
		text = await d.decrypt(armor.decode(file), "text");
	} catch (err) {
		throw new KeyError(`cannot decrypt key export: ${(err as Error).message}`);
	}
	const data = JSON.parse(text) as Partial<KeyExport>;
	if (data.format !== "crh-keys" || data.version !== 1 || typeof data.master_key !== "string") {
		throw new KeyError("not a crhs key export");
	}
	const key = new MasterKey(Buffer.from(data.master_key, "base64"));
	if (key.id !== data.master_key_id) throw new KeyError("key export is inconsistent (master key id mismatch)");
	return data as KeyExport;
}

/**
 * Checks an export against a database before restoring it: the database must have been encrypted with the
 * exported master key, and every exported server key must still be present and identical.
 */
export async function verifyKeyExportAgainstDb(db: Db, data: KeyExport): Promise<MasterKey> {
	const key = new MasterKey(Buffer.from(data.master_key, "base64"));
	const bound = await boundMasterKeyId(db);
	if (bound !== undefined && bound !== key.id) {
		throw new KeyError("this key export does not belong to the database (master key id mismatch)");
	}
	for (const k of data.keys) {
		const row = await db.selectFrom("secrets").selectAll().where("id", "=", k.id).executeTakeFirst();
		if (!row) throw new KeyError(`key ${k.id} (${k.kind}) from the export is missing in the database`);
		if (key.decrypt(row.ciphertext, secretAad(row.id, row.kind)).toString("base64") !== k.value) {
			throw new KeyError(`key ${k.id} (${k.kind}) differs between the export and the database`);
		}
	}
	return key;
}
