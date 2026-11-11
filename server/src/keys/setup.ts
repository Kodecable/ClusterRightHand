import { rm } from "node:fs/promises";
import type { Db } from "../storage/db.ts";
import { type KeyExport, verifyKeyExportAgainstDb } from "./export.ts";
import { bindMasterKey, MasterKey, writeMasterKeyFile } from "./master-key.ts";

/**
 * Writes the key file first and only then binds the database to it. The file is created exclusively, so a
 * failure to write (an existing file, a missing directory) leaves the database untouched. If binding fails,
 * the file written here is removed again: a database bound to a key whose file was never saved could no
 * longer start with the real key file (doc/design/protocol.md "Key export").
 */
async function writeFileThenBind(path: string, key: MasterKey, db: Db): Promise<void> {
	await writeMasterKeyFile(path, key);
	try {
		await bindMasterKey(db, key);
	} catch (err) {
		await rm(path, { force: true }).catch((cleanupError: unknown) => {
			console.error(`crhs: could not remove ${path} after the database refused the new master key:`, cleanupError);
		});
		throw err;
	}
}

/** `crhs keys init`: generate a key, save it, then record its id in the database. */
export async function initMasterKey(path: string, db: Db): Promise<MasterKey> {
	const key = MasterKey.generate();
	await writeFileThenBind(path, key, db);
	return key;
}

/**
 * `crhs keys import`: check an export against the database, save its master key, then bind the database.
 * An existing key file is never replaced, and a failed bind removes the file written here.
 */
export async function restoreMasterKey(path: string, db: Db, data: KeyExport): Promise<MasterKey> {
	const key = await verifyKeyExportAgainstDb(db, data);
	await writeFileThenBind(path, key, db);
	return key;
}
