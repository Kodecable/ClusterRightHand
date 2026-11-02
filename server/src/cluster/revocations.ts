/**
 * Pushed revocations (doc/privilege.md#吊销, doc/protocol.md#新增命令和事件11可选): crhs sends every
 * revoked authorization of the node's organization after an `ok` trust report and again when a user
 * revokes one. `revocations.add` is idempotent; the privileged mode prunes expired rows.
 */
import { encode as encodeCbor, MAX_FRAME_BYTES, type Revocation, revocationsAddCodec } from "@crh/protocol";
import type { Selectable } from "kysely";
import type { Db } from "../storage/db.ts";
import type { AuthorizationsTable } from "../storage/schema.ts";
import { NotFoundError } from "../users/service.ts";

/**
 * How long a revocation is resent past its authorization's deadline. crha keeps revocation records
 * for the same margin, which covers a clock that stepped back: the node accepts an authorization
 * until its deadline plus the clock skew (doc/privilege.md#吊销).
 */
export const REVOCATION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** The revocation entry of an authorization row. */
export function revocationOf(row: Pick<AuthorizationsTable, "id" | "deadline">): Revocation {
	return {
		authorizationId: Uint8Array.from(Buffer.from(row.id, "hex")),
		deadlineMs: row.deadline === null ? null : new Date(row.deadline).getTime(),
	};
}

/**
 * Revoked authorizations of an organization that crha may still accept, oldest first: everything
 * without a deadline, and everything whose deadline is less than the retention margin in the past.
 */
export async function listRevocations(db: Db, orgId: string, now = Date.now()): Promise<Revocation[]> {
	const rows = await db
		.selectFrom("authorizations")
		.select(["id", "deadline"])
		.where("org_id", "=", orgId)
		.where("revoked_at", "is not", null)
		.orderBy("created_at")
		.execute();
	return rows
		.map(revocationOf)
		.filter((entry) => entry.deadlineMs === null || entry.deadlineMs + REVOCATION_RETENTION_MS >= now);
}

/** Marks an authorization revoked; returns the row and whether this call changed it. */
export async function revokeAuthorizationRow(
	db: Db,
	id: string,
	now = new Date(),
): Promise<{ row: Selectable<AuthorizationsTable>; changed: boolean }> {
	const row = await db.selectFrom("authorizations").selectAll().where("id", "=", id).executeTakeFirst();
	if (!row) throw new NotFoundError("no such authorization");
	if (row.revoked_at !== null) return { row, changed: false };
	const revokedAt = now.toISOString();
	await db.updateTable("authorizations").set({ revoked_at: revokedAt }).where("id", "=", id).execute();
	return { row: { ...row, revoked_at: revokedAt }, changed: true };
}

/**
 * Splits entries into frames well under MAX_FRAME_BYTES. There is at least one entry per batch (a
 * single entry is far smaller than a frame), and the small margin covers the frame header.
 *
 * The largest fitting prefix is found by binary search. Encoding the growing candidate after every
 * entry would be quadratic, and a node's revocation list can hold thousands of entries.
 */
export function batchRevocations(entries: readonly Revocation[], maxBodyBytes = MAX_FRAME_BYTES - 512): Revocation[][] {
	const batches: Revocation[][] = [];
	let start = 0;
	while (start < entries.length) {
		let low = start + 1;
		let high = entries.length;
		let best = low;
		while (low <= high) {
			const middle = (low + high) >> 1;
			const encoded = encodeCbor(revocationsAddCodec.encode({ entries: entries.slice(start, middle) })).length;
			if (encoded <= maxBodyBytes) {
				best = middle;
				low = middle + 1;
			} else {
				high = middle - 1;
			}
		}
		batches.push(entries.slice(start, best));
		start = best;
	}
	return batches;
}
