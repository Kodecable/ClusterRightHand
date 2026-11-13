import type { Kysely } from "kysely";

/**
 * Task purposes and the image cache (doc/design/execution.md "Task purpose",
 * doc/design/library.md "Image cache").
 *
 * `tasks.purpose` and `task_groups.purpose` are null for ordinary work. Only the dedicated endpoints
 * of a feature set one, so the task list can leave them out.
 *
 * `image_cache` indexes the bytes of `view_image` results that live in the library backend's cache
 * area; the row is the source of truth for an object's size and last use.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema.alterTable("tasks").addColumn("purpose", "text").execute();
	await db.schema.alterTable("task_groups").addColumn("purpose", "text").execute();
	await db.schema.createIndex("tasks_purpose_idx").on("tasks").column("purpose").execute();
	await db.schema.createIndex("task_groups_purpose_idx").on("task_groups").column("purpose").execute();

	await db.schema
		.createTable("image_cache")
		.addColumn("sha256", "text", (c) => c.primaryKey())
		.addColumn("bytes", "integer", (c) => c.notNull())
		.addColumn("mime", "text", (c) => c.notNull())
		.addColumn("last_used_at", "text", (c) => c.notNull())
		.execute();
	await db.schema.createIndex("image_cache_last_used_idx").on("image_cache").column("last_used_at").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.dropTable("image_cache").execute();
	await db.schema.dropIndex("task_groups_purpose_idx").execute();
	await db.schema.dropIndex("tasks_purpose_idx").execute();
	await db.schema.alterTable("task_groups").dropColumn("purpose").execute();
	await db.schema.alterTable("tasks").dropColumn("purpose").execute();
}
