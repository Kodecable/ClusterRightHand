import { type Kysely, sql } from "kysely";

/**
 * What an MCP server last reported, kept on its extension row (doc/design/extensions.md "MCP connections"):
 * crhs connects only when it needs to and disconnects when idle, so the tool list, the server's own
 * description and the last refresh must outlive a connection and a restart. Each tool carries the
 * `tools_rev` at which its definition last changed, and an external call records the rev it was judged
 * at, so an approval never carries over to a changed tool.
 *
 * A built-in extension's description is a constant of crhs, so the copies the first migration stored are
 * cleared: they would hide a newer constant.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema.alterTable("extensions").addColumn("server_instructions", "text").execute();
	await db.schema.alterTable("extensions").addColumn("server_description", "text").execute();
	await db.schema.alterTable("extensions").addColumn("tools", "text").execute();
	await db.schema
		.alterTable("extensions")
		.addColumn("tools_rev", "integer", (c) => c.notNull().defaultTo(0))
		.execute();
	await db.schema.alterTable("extensions").addColumn("refreshed_at", "text").execute();
	await db.schema.alterTable("extensions").addColumn("refresh_error", "text").execute();
	await db.schema.alterTable("external_calls").addColumn("tool_rev", "integer").execute();
	await sql`update extensions set description = null where kind = 'builtin'`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.alterTable("external_calls").dropColumn("tool_rev").execute();
	for (const column of [
		"refresh_error",
		"refreshed_at",
		"tools_rev",
		"tools",
		"server_description",
		"server_instructions",
	]) {
		await db.schema.alterTable("extensions").dropColumn(column).execute();
	}
}
