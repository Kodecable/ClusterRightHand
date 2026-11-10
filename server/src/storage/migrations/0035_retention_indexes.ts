import type { Kysely } from "kysely";

/**
 * Indexes for the retention sweep (storage/retention.ts, doc/design/data-model.md "Retention"): it deletes old terminal
 * tasks and task groups by `finished_at`, and audit events by `ts` behind a sequence floor. Authorizations
 * already have `authorizations_deadline_idx` from 0022.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema.createIndex("tasks_finished_at_idx").on("tasks").column("finished_at").execute();
	await db.schema.createIndex("task_groups_finished_at_idx").on("task_groups").column("finished_at").execute();
	await db.schema.createIndex("audit_events_ts_idx").on("audit_events").column("ts").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.dropIndex("audit_events_ts_idx").execute();
	await db.schema.dropIndex("task_groups_finished_at_idx").execute();
	await db.schema.dropIndex("tasks_finished_at_idx").execute();
}
