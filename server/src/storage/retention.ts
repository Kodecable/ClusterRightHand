import { GROUP_TERMINAL, TERMINAL } from "../cluster/types.ts";
import type { RetentionConfig } from "../config.ts";
import type { Db } from "./db.ts";

/** Rows selected and deleted per batch, so one statement never holds the database queue for long. */
export const RETENTION_BATCH_SIZE = 1000;

/**
 * Audit events keep the newest 16384 sequence numbers (a key distance, not a row count; gaps are fine). This
 * keeps the row holding max(seq), so SQLite's rowid-based seq (no AUTOINCREMENT) does not restart numbering if
 * every older row is deleted, and a large forward clock jump cannot wipe the whole log (doc/data-model.md#保留期).
 */
export const AUDIT_SEQ_FLOOR = 16_384;

/** How long after startup the first retention run waits, so it does not delay serving requests. */
const STARTUP_DELAY_MS = 5_000;
/** How often retention runs after that. */
const INTERVAL_MS = 60 * 60 * 1000;

export interface RetentionCounts {
	tasks: number;
	taskGroups: number;
	authorizations: number;
	auditEvents: number;
}

export interface RetentionOptions {
	/** Smaller batches for tests; production uses RETENTION_BATCH_SIZE. */
	batchSize?: number;
	/** Stops the sweep between batches, so shutdown does not wait out a long first run. */
	signal?: AbortSignal;
}

export interface RetentionSweep {
	/** Stops the timers and the run in progress, and resolves once that run has stopped. */
	stop(): Promise<void>;
}

/**
 * Deletes rows past their configured retention (doc/data-model.md#保留期). Each table is swept on its own: a
 * failure is logged and leaves that table's count at 0, so the other tables still run. Errors are never thrown:
 * a failed sweep must not take the server down or reject shutdown.
 */
export async function runRetention(
	db: Db,
	retention: RetentionConfig,
	now = new Date(),
	options: RetentionOptions = {},
): Promise<RetentionCounts> {
	const counts: RetentionCounts = { tasks: 0, taskGroups: 0, authorizations: 0, auditEvents: 0 };
	const batchSize = options.batchSize ?? RETENTION_BATCH_SIZE;
	const signal = options.signal;
	try {
		if (retention.tasksMs !== null) {
			const cutoff = cutoffIso(now, retention.tasksMs);
			counts.tasks = await deleteTable("tasks", () => deleteOldTasks(db, cutoff, batchSize, signal));
			counts.taskGroups = await deleteTable("task_groups", () => deleteOldTaskGroups(db, cutoff, batchSize, signal));
			counts.authorizations = await deleteTable("authorizations", () =>
				deleteExpiredAuthorizations(db, cutoff, batchSize, signal),
			);
		}
		if (retention.auditMs !== null) {
			const cutoff = cutoffIso(now, retention.auditMs);
			counts.auditEvents = await deleteTable("audit_events", () => deleteOldAuditEvents(db, cutoff, batchSize, signal));
		}
	} catch (err) {
		console.error("retention sweep failed:", err);
	}

	const total = counts.tasks + counts.taskGroups + counts.authorizations + counts.auditEvents;
	if (total > 0) {
		console.log(
			`retention: deleted ${counts.tasks} task(s), ${counts.taskGroups} task group(s), ` +
				`${counts.authorizations} authorization(s), ${counts.auditEvents} audit event(s)`,
		);
	}
	return counts;
}

/**
 * Runs retention once shortly after startup and then hourly, never overlapping itself. Shutdown calls stop(),
 * which clears the timers, aborts the run between batches and waits for it before the database is destroyed.
 */
export function startRetentionSweep(
	db: Db,
	retention: RetentionConfig,
	options: { startupDelayMs?: number; intervalMs?: number } = {},
): RetentionSweep {
	const abort = new AbortController();
	let running: Promise<void> | null = null;
	const tick = (): void => {
		// Skip a tick while the previous run is still going, or when stop() already aborted (a queued tick).
		if (running !== null || abort.signal.aborted) return;
		running = runRetention(db, retention, new Date(), { signal: abort.signal })
			.then(() => {})
			.catch((err: unknown) => console.error("retention sweep failed:", err))
			.finally(() => {
				running = null;
			});
	};
	const startup = setTimeout(tick, options.startupDelayMs ?? STARTUP_DELAY_MS);
	startup.unref();
	const interval = setInterval(tick, options.intervalMs ?? INTERVAL_MS);
	interval.unref();
	return {
		async stop(): Promise<void> {
			clearTimeout(startup);
			clearInterval(interval);
			abort.abort();
			await running;
		},
	};
}

function cutoffIso(now: Date, durationMs: number): string {
	return new Date(now.getTime() - durationMs).toISOString();
}

/** Runs one table's deletion in isolation; on failure it is logged and the count stays 0 for this run. */
async function deleteTable(table: string, remove: () => Promise<number>): Promise<number> {
	try {
		return await remove();
	} catch (err) {
		console.error(`retention: deleting ${table} failed:`, err);
		return 0;
	}
}

/**
 * Deletes in batches selected by key: at most `batchSize` rows are read, then deleted by those keys, until a
 * batch comes back short. Between full batches the loop yields so other users of the SQLite statement queue
 * (the whole process shares it) can run.
 */
async function deleteInBatches<T>(
	batchSize: number,
	signal: AbortSignal | undefined,
	select: (limit: number) => Promise<T[]>,
	remove: (rows: T[]) => Promise<number>,
): Promise<number> {
	let deleted = 0;
	while (!signal?.aborted) {
		const rows = await select(batchSize);
		if (rows.length === 0) break;
		const removed = await remove(rows);
		deleted += removed;
		// Another process may have deleted the rows between select and delete; stop instead of looping on them.
		if (removed === 0 || rows.length < batchSize) break;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	return deleted;
}

async function deleteOldTasks(
	db: Db,
	cutoff: string,
	batchSize: number,
	signal: AbortSignal | undefined,
): Promise<number> {
	return deleteInBatches<{ id: string }>(
		batchSize,
		signal,
		(limit) =>
			db
				.selectFrom("tasks")
				.select("id")
				// Non-terminal tasks and rows without finished_at are never deleted, however old they are.
				.where("state", "in", [...TERMINAL])
				.where("finished_at", "is not", null)
				.where("finished_at", "<", cutoff)
				.orderBy("finished_at")
				.limit(limit)
				.execute(),
		async (rows) => {
			const result = await db
				.deleteFrom("tasks")
				.where(
					"id",
					"in",
					rows.map((row) => row.id),
				)
				.executeTakeFirst();
			return Number(result.numDeletedRows);
		},
	);
}

async function deleteOldTaskGroups(
	db: Db,
	cutoff: string,
	batchSize: number,
	signal: AbortSignal | undefined,
): Promise<number> {
	return deleteInBatches<{ id: string }>(
		batchSize,
		signal,
		(limit) =>
			db
				.selectFrom("task_groups")
				.select("id")
				.where("state", "in", [...GROUP_TERMINAL])
				.where("finished_at", "is not", null)
				.where("finished_at", "<", cutoff)
				.orderBy("finished_at")
				.limit(limit)
				.execute(),
		async (rows) => {
			const result = await db
				.deleteFrom("task_groups")
				.where(
					"id",
					"in",
					rows.map((row) => row.id),
				)
				.executeTakeFirst();
			return Number(result.numDeletedRows);
		},
	);
}

async function deleteExpiredAuthorizations(
	db: Db,
	cutoff: string,
	batchSize: number,
	signal: AbortSignal | undefined,
): Promise<number> {
	return deleteInBatches<{ id: string }>(
		batchSize,
		signal,
		(limit) =>
			db
				.selectFrom("authorizations")
				.select("id")
				// Rows from before deadlines were mandatory (null) are left alone.
				.where("deadline", "is not", null)
				.where("deadline", "<", cutoff)
				.orderBy("deadline")
				.limit(limit)
				.execute(),
		async (rows) => {
			const result = await db
				.deleteFrom("authorizations")
				.where(
					"id",
					"in",
					rows.map((row) => row.id),
				)
				.executeTakeFirst();
			return Number(result.numDeletedRows);
		},
	);
}

async function deleteOldAuditEvents(
	db: Db,
	cutoff: string,
	batchSize: number,
	signal: AbortSignal | undefined,
): Promise<number> {
	if (signal?.aborted) return 0;
	// Once per run: max(seq) is the anchor for the floor. PostgreSQL returns bigint as a string.
	const maxRow = await db
		.selectFrom("audit_events")
		.select((eb) => eb.fn.max("seq").as("max_seq"))
		.executeTakeFirst();
	if (maxRow?.max_seq === null || maxRow?.max_seq === undefined) return 0;
	const floor = Number(maxRow.max_seq) - AUDIT_SEQ_FLOOR;
	if (floor <= 0) return 0;
	return deleteInBatches<{ seq: number }>(
		batchSize,
		signal,
		(limit) =>
			db
				.selectFrom("audit_events")
				.select("seq")
				.where("ts", "<", cutoff)
				.where("seq", "<=", floor)
				.orderBy("seq")
				.limit(limit)
				.execute(),
		async (rows) => {
			const result = await db
				.deleteFrom("audit_events")
				.where(
					"seq",
					"in",
					rows.map((row) => Number(row.seq)),
				)
				.executeTakeFirst();
			return Number(result.numDeletedRows);
		},
	);
}
