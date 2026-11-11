import { sql } from "kysely";
import { GROUP_TERMINAL, TERMINAL } from "../cluster/types.ts";
import type { RetentionConfig } from "../config.ts";
import type { Db } from "./db.ts";

/** Rows selected and deleted per batch, so one statement never holds the database queue for long. */
export const RETENTION_BATCH_SIZE = 1000;

/**
 * Audit events keep the newest 16384 sequence numbers (a key distance, not a row count; gaps are fine). This
 * keeps the row holding max(seq), so SQLite's rowid-based seq (no AUTOINCREMENT) does not restart numbering if
 * every older row is deleted, and a large forward clock jump cannot wipe the whole log (doc/design/data-model.md "Retention").
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
	piTasks: number;
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
 * Deletes rows past their configured retention (doc/design/data-model.md "Retention"). Each table is swept on its own: a
 * failure is logged and leaves that table's count at 0, so the other tables still run. Errors are never thrown:
 * a failed sweep must not take the server down or reject shutdown.
 */
export async function runRetention(
	db: Db,
	retention: RetentionConfig,
	now = new Date(),
	options: RetentionOptions = {},
): Promise<RetentionCounts> {
	const counts: RetentionCounts = { tasks: 0, taskGroups: 0, authorizations: 0, auditEvents: 0, piTasks: 0 };
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
		if (retention.piTasksMs !== null) {
			const cutoff = now.getTime() - retention.piTasksMs;
			counts.piTasks = await deleteTable("pi_tasks", () => deleteOldPiTasks(db, cutoff, batchSize, signal));
		}
	} catch (err) {
		console.error("retention sweep failed:", err);
	}

	const total = counts.tasks + counts.taskGroups + counts.authorizations + counts.auditEvents + counts.piTasks;
	if (total > 0) {
		console.log(
			`retention: deleted ${counts.tasks} task(s), ${counts.taskGroups} task group(s), ` +
				`${counts.authorizations} authorization(s), ${counts.auditEvents} audit event(s), ` +
				`${counts.piTasks} durable task(s)`,
		);
	}
	return counts;
}

/**
 * Runs retention once shortly after startup and then hourly, never overlapping itself. The retention
 * values may be a getter, so the sweep reads System settings at each run and a change applies without
 * a restart. Shutdown calls stop(), which clears the timers, aborts the run between batches and waits
 * for it before the database is destroyed.
 */
export function startRetentionSweep(
	db: Db,
	retention: RetentionConfig | (() => RetentionConfig),
	/** `run` exists for tests, which replace it so the scheduler runs without a database. */
	options: { startupDelayMs?: number; intervalMs?: number; run?: typeof runRetention } = {},
): RetentionSweep {
	const abort = new AbortController();
	const run = options.run ?? runRetention;
	const current = () => (typeof retention === "function" ? retention() : retention);
	let running: Promise<void> | null = null;
	const tick = (): void => {
		// Skip a tick while the previous run is still going, or when stop() already aborted (a queued tick).
		if (running !== null || abort.signal.aborted) return;
		running = run(db, current(), new Date(), { signal: abort.signal })
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

/** pi-durable's tables share crhs's database and use the `pi_` prefix (storage/db.ts openAgentStorage). */
const PI_TASKS = "pi_tasks";
const PI_CONVERSATIONS = "pi_conversations";
const PI_DOCUMENTS = "pi_documents";
const PI_DOCUMENT_REVISIONS = "pi_document_revisions";

/** Only the fields this sweep reads from a durable task record; everything else is opaque. */
interface PiTaskRecord {
	readonly owner?: unknown;
	readonly endedAt?: unknown;
	readonly state?: { readonly status?: unknown; readonly on?: unknown };
}

interface PiTaskRow {
	/** SQLite returns a number, PostgreSQL bigint a string. */
	readonly id: number | string;
	readonly record: string;
}

/**
 * Deletes terminal pi-durable tasks older than the cutoff, with the documents scoped to them.
 *
 * This writes outside pi-durable's storage contract: pi-durable has no deletion API, and only this sweep
 * deletes these rows. It is therefore deliberately conservative and relies on these invariants of pi-durable
 * 1.4.0 (re-check all of them when pi-durable is upgraded, or use an official API if one appears):
 *
 * - Restart recovery and the task graph only scan LIVE_STATUSES (pending, running, waiting, sleeping,
 *   completing), so deleting a terminal row cannot remove work; `completing` is live and never deleted here.
 * - Owners of live work are never terminal: a terminal task cannot create a task or a conversation, and
 *   `owner`, waiting `state.on` and `pi_conversations.owner_task_id` are immutable once written. Protecting
 *   the owners and wait targets of every non-terminal task (built before the scan) is thus enough.
 * - `waitForTask(id)` rejects for a missing id, and crhs only waits on ids it just obtained
 *   (agent/runtime-submissions.ts); the 1-day config floor is long after any such wait could still be open.
 * - Terminal records are final, and `endedAt` is stamped once when the task becomes terminal.
 * - Task-scoped documents are retired when their task becomes terminal, and the only reader left is that
 *   task's own settlement, so deleting them with a long-terminal task leaves no live reader.
 *
 * Unlike the other sweeps, a batch with nothing to delete is normal: terminal rows that are recent, protected
 * or lack `endedAt` stay in place, and the keyset scan continues past them. The batch transaction deletes the
 * tasks' revisions and documents before the tasks; a failure rolls the whole batch back and the table's count
 * stays 0 for this run.
 */
async function deleteOldPiTasks(
	db: Db,
	cutoff: number,
	batchSize: number,
	signal: AbortSignal | undefined,
): Promise<number> {
	if (signal?.aborted) return 0;
	const protectedIds = await protectedPiTaskIds(db);
	let deleted = 0;
	// pi-durable mints positive ids, so 0 is below every row and lets the keyset start at the first one.
	let lastId = 0;
	while (!signal?.aborted) {
		const rows = (
			await sql<PiTaskRow>`
				select id, record from ${sql.table(PI_TASKS)}
				where status = 'terminal' and id > ${lastId}
				order by id
				limit ${batchSize}`.execute(db)
		).rows;
		if (rows.length === 0) break;
		// The rows are ordered by id, so the last one advances the cursor even when none of them is deleted.
		const batchLastId = Number(rows.at(-1)?.id);
		if (!Number.isSafeInteger(batchLastId)) break;

		const selected: number[] = [];
		for (const row of rows) {
			const id = piId(row.id);
			if (id === undefined || protectedIds.has(id)) continue;
			// A record that does not parse cannot prove when it ended: keep it rather than guess.
			let record: PiTaskRecord;
			try {
				record = JSON.parse(row.record) as PiTaskRecord;
			} catch {
				continue;
			}
			const endedAt = record.endedAt;
			if (typeof endedAt !== "number" || !Number.isFinite(endedAt) || endedAt >= cutoff) continue;
			selected.push(id);
		}
		if (selected.length > 0) deleted += await deletePiTasksBatch(db, selected);
		lastId = batchLastId;
		if (rows.length < batchSize) break;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	return deleted;
}

/**
 * Builds the ids that must survive this run: every non-terminal task's owner and waiting targets, plus the
 * task that owns each conversation. A live record that does not parse fails the step, which is the safe answer:
 * without it the sweep cannot know what that task references.
 */
async function protectedPiTaskIds(db: Db): Promise<Set<number>> {
	const ids = new Set<number>();
	const live = (
		await sql<PiTaskRow>`
			select id, record from ${sql.table(PI_TASKS)} where status <> 'terminal'`.execute(db)
	).rows;
	for (const row of live) {
		const record = JSON.parse(row.record) as PiTaskRecord;
		const owner = piId(record.owner);
		if (owner !== undefined) ids.add(owner);
		if (record.state?.status === "waiting" && Array.isArray(record.state.on)) {
			for (const target of record.state.on) {
				const id = piId(target);
				if (id !== undefined) ids.add(id);
			}
		}
	}
	const owners = (
		await sql<{ owner_task_id: number | string | null }>`
			select owner_task_id from ${sql.table(PI_CONVERSATIONS)} where owner_task_id is not null`.execute(db)
	).rows;
	for (const row of owners) {
		const id = piId(row.owner_task_id);
		if (id !== undefined) ids.add(id);
	}
	return ids;
}

/** Deletes one batch atomically: task-scoped document revisions, their documents, then the tasks. */
async function deletePiTasksBatch(db: Db, ids: number[]): Promise<number> {
	return db.transaction().execute(async (trx) => {
		const documents = (
			await sql<{ id: number | string }>`
				select id from ${sql.table(PI_DOCUMENTS)}
				where scope_kind = 'task' and owner_id in (${sql.join(ids)})`.execute(trx)
		).rows;
		const documentIds = documents.flatMap((row) => {
			const id = piId(row.id);
			return id === undefined ? [] : [id];
		});
		if (documentIds.length > 0) {
			await sql`
				delete from ${sql.table(PI_DOCUMENT_REVISIONS)} where document_id in (${sql.join(documentIds)})`.execute(trx);
			await sql`delete from ${sql.table(PI_DOCUMENTS)} where id in (${sql.join(documentIds)})`.execute(trx);
		}
		const result = await sql`delete from ${sql.table(PI_TASKS)} where id in (${sql.join(ids)})`.execute(trx);
		return Number(result.numAffectedRows ?? 0);
	});
}

/** Normalizes a durable id (PostgreSQL returns bigint as a string) and rejects non-integer values. */
function piId(value: unknown): number | undefined {
	if (typeof value !== "number" && typeof value !== "string") return undefined;
	const id = Number(value);
	return Number.isSafeInteger(id) && id >= 0 ? id : undefined;
}
