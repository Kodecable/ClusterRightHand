/**
 * The library orphan sweep (doc/design/library.md "Metadata and objects"): objects no row references,
 * left by a crash between the object write and its commit. At startup and hourly; only objects older
 * than one hour are deleted, so an upload that is still in flight is never swept.
 */
import type { Db } from "../storage/db.ts";
import type { LibraryBackend } from "./backend.ts";

/** Objects younger than this are left alone. */
export const ORPHAN_MIN_AGE_MS = 60 * 60 * 1000;
const INTERVAL_MS = 60 * 60 * 1000;

/** Deletes unreferenced objects older than `minAgeMs`; returns how many were deleted. */
export async function sweepLibraryOrphans(
	db: Db,
	backend: LibraryBackend,
	now = Date.now(),
	minAgeMs = ORPHAN_MIN_AGE_MS,
): Promise<number> {
	const referenced = new Set(
		(await db.selectFrom("library_files").select("object_key").where("backend", "=", backend.kind).execute()).map(
			(row) => row.object_key,
		),
	);
	let deleted = 0;
	for await (const object of backend.list()) {
		if (referenced.has(object.key)) continue;
		// Without a date the object's age is unknown; deleting it could hit an upload in flight.
		if (object.lastModified === undefined || now - object.lastModified < minAgeMs) continue;
		await backend.delete(object.key);
		deleted += 1;
	}
	if (deleted > 0) console.log(`library: deleted ${deleted} orphaned object(s)`);
	return deleted;
}

export interface LibrarySweep {
	/** Stops the timer and resolves once a run in progress has stopped. */
	stop(): Promise<void>;
}

/** Runs once at startup and then hourly, never overlapping itself. */
export function startLibrarySweep(
	db: Db,
	backend: LibraryBackend,
	options: { intervalMs?: number } = {},
): LibrarySweep {
	let running: Promise<void> | null = null;
	let stopped = false;
	const tick = (): void => {
		if (stopped || running !== null) return;
		running = sweepLibraryOrphans(db, backend)
			.then(() => {})
			.catch((err: unknown) => console.error("library orphan sweep failed:", err))
			.finally(() => {
				running = null;
			});
	};
	void tick();
	const interval = setInterval(tick, options.intervalMs ?? INTERVAL_MS);
	interval.unref();
	return {
		async stop(): Promise<void> {
			stopped = true;
			clearInterval(interval);
			await running;
		},
	};
}
