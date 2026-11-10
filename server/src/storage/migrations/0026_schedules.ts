import type { Kysely } from "kysely";

/**
 * Schedules (doc/design/scheduling.md): one kind only, a cron that creates a new session owned by the schedule's
 * owner and submits a fixed prompt. The rule set lives in `rule_sets` (scope_type = "schedule"); the runs are
 * in `schedule_runs` so a crash between firing and submitting neither loses nor duplicates one.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.createTable("schedules")
		.addColumn("id", "text", (c) => c.primaryKey())
		.addColumn("org_id", "text", (c) => c.notNull().references("orgs.id"))
		.addColumn("owner_user_id", "text", (c) => c.notNull().references("users.id"))
		.addColumn("name", "text", (c) => c.notNull())
		// The user message every run submits to its new session.
		.addColumn("prompt", "text", (c) => c.notNull())
		// JSON { provider, modelId, thinkingLevel? }
		.addColumn("model", "text", (c) => c.notNull())
		// The new session's root quota; null means unlimited (doc/design/scheduling.md "Rules and quotas").
		.addColumn("token_budget", "bigint")
		.addColumn("cron", "text", (c) => c.notNull())
		.addColumn("timezone", "text", (c) => c.notNull())
		.addColumn("catch_up", "integer", (c) => c.notNull())
		.addColumn("enabled", "integer", (c) => c.notNull())
		.addColumn("next_run_at", "text")
		.addColumn("created_at", "text", (c) => c.notNull())
		.addColumn("updated_at", "text", (c) => c.notNull())
		.execute();
	await db.schema.createIndex("schedules_owner_idx").on("schedules").columns(["owner_user_id", "created_at"]).execute();
	// The scheduler's wake-up query: the earliest next run among enabled schedules.
	await db.schema.createIndex("schedules_due_idx").on("schedules").columns(["enabled", "next_run_at"]).execute();

	await db.schema
		.createTable("schedule_runs")
		.addColumn("id", "text", (c) => c.primaryKey())
		.addColumn("schedule_id", "text", (c) => c.notNull().references("schedules.id").onDelete("cascade"))
		.addColumn("fire_time", "text", (c) => c.notNull())
		.addColumn("manual", "integer", (c) => c.notNull())
		// pending | running | succeeded | failed | preempted
		.addColumn("status", "text", (c) => c.notNull())
		// Derived from the run id; null until the run started (doc/design/scheduling.md "Triggering and submission").
		.addColumn("session_id", "text")
		.addColumn("reason", "text")
		.addColumn("created_at", "text", (c) => c.notNull())
		.addColumn("started_at", "text")
		.addColumn("finished_at", "text")
		.execute();
	// Firing twice for the same time is impossible, even across a restart (doc/design/scheduling.md "Triggering and submission").
	await db.schema
		.createIndex("schedule_runs_fire_idx")
		.on("schedule_runs")
		.columns(["schedule_id", "fire_time"])
		.unique()
		.execute();
	await db.schema
		.createIndex("schedule_runs_schedule_idx")
		.on("schedule_runs")
		.columns(["schedule_id", "fire_time"])
		.execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.dropTable("schedule_runs").execute();
	await db.schema.dropTable("schedules").execute();
}
