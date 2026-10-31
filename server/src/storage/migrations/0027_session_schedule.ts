import type { Kysely } from "kysely";

/**
 * The session a schedule run created (doc/data-model.md#计划任务): null for every other session, and nulled
 * again when the schedule is deleted while the session stays. Indexed so the sessions list can filter by it.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.alterTable("sessions")
		.addColumn("schedule_id", "text", (c) => c.references("schedules.id").onDelete("set null"))
		.execute();
	await db.schema.createIndex("sessions_schedule_idx").on("sessions").column("schedule_id").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.alterTable("sessions").dropColumn("schedule_id").execute();
}
