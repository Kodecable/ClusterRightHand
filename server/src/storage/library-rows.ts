import type { LibraryLimits } from "@crh/api";
import { DEFAULT_GROUP_LIBRARY_LIMITS, DEFAULT_USER_LIBRARY_LIMITS } from "../config.ts";
import { newId } from "../util/id.ts";
import type { Db } from "./db.ts";

/**
 * Creates the library row of a user or user group in the same transaction as its owner
 * (doc/design/library.md "Libraries"). The limits are copied once; later changes to System settings do
 * not touch existing libraries.
 */
export async function insertLibrary(
	db: Db,
	ownerKind: "user" | "group",
	ownerId: string,
	limits: LibraryLimits,
): Promise<void> {
	await db
		.insertInto("libraries")
		.values({
			id: newId(),
			owner_kind: ownerKind,
			owner_id: ownerId,
			max_files: limits.files,
			max_file_bytes: limits.fileBytes,
			max_total_bytes: limits.totalBytes,
			used_files: 0,
			used_bytes: 0,
			created_at: new Date().toISOString(),
		})
		.execute();
}

/** The limits a new library of this kind starts with when the caller names none. */
export function defaultLibraryLimits(ownerKind: "user" | "group"): LibraryLimits {
	return ownerKind === "user" ? DEFAULT_USER_LIBRARY_LIMITS : DEFAULT_GROUP_LIBRARY_LIMITS;
}

/**
 * Whether `db` is already in a transaction. Kysely cannot nest transactions, so a service that must
 * create the owner and its library atomically opens one only when the caller has not.
 */
export function inTransaction(db: Db): boolean {
	return db.isTransaction;
}

/** Runs `fn` in a transaction unless the caller already supplied one. */
export function withTransaction<T>(db: Db, fn: (trx: Db) => Promise<T>): Promise<T> {
	return inTransaction(db) ? fn(db) : db.transaction().execute(fn);
}
