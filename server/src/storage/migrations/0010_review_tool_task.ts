import type { Kysely } from "kysely";

/**
 * The durable tool task behind the tool call that created a task, task group or external call
 * (doc/design/access-control.md "Auto Review").
 *
 * `source_call_id` held the model's tool-call id, which a provider may reuse across responses, so the reviewer
 * could read a different call than the one that made the request. `source_tool_task` holds the id of the
 * pi-durable tool task of that call; the task's input names the assistant entry and the call id, which pick
 * exactly one call from the transcript. The old values are model ids and cannot be converted, so they are
 * dropped with the column.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema.alterTable("tasks").addColumn("source_tool_task", "text").execute();
	await db.schema.alterTable("tasks").dropColumn("source_call_id").execute();
	await db.schema.alterTable("task_groups").addColumn("source_tool_task", "text").execute();
	await db.schema.alterTable("task_groups").dropColumn("source_call_id").execute();
	await db.schema.alterTable("external_calls").addColumn("source_tool_task", "text").execute();
	await db.schema.alterTable("external_calls").dropColumn("source_call_id").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.alterTable("external_calls").addColumn("source_call_id", "text").execute();
	await db.schema.alterTable("external_calls").dropColumn("source_tool_task").execute();
	await db.schema.alterTable("task_groups").addColumn("source_call_id", "text").execute();
	await db.schema.alterTable("task_groups").dropColumn("source_tool_task").execute();
	await db.schema.alterTable("tasks").addColumn("source_call_id", "text").execute();
	await db.schema.alterTable("tasks").dropColumn("source_tool_task").execute();
}
