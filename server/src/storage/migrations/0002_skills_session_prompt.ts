import type { Kysely } from "kysely";

/**
 * The skills of each library (doc/design/library.md "Skills"): one row per `skills/<name>/SKILL.md`, written in
 * the same transaction as the file row, with what its frontmatter says or why it is not a skill.
 *
 * `sessions.system_prompt` is a session's system prompt, assembled at its first model request and used for
 * every later one (doc/design/agent-runtime.md "Session system prompt").
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.createTable("library_skills")
		.addColumn("library_id", "text", (c) => c.notNull().references("libraries.id").onDelete("cascade"))
		.addColumn("path", "text", (c) => c.notNull())
		.addColumn("sha256", "text", (c) => c.notNull())
		.addColumn("name", "text")
		.addColumn("description", "text")
		.addColumn("invalid", "text")
		.addUniqueConstraint("library_skills_library_path_unique", ["library_id", "path"])
		.execute();
	await db.schema.alterTable("sessions").addColumn("system_prompt", "text").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.alterTable("sessions").dropColumn("system_prompt").execute();
	await db.schema.dropTable("library_skills").execute();
}
