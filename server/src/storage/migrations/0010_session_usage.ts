import type { Kysely } from "kysely";

// What each session has spent, including its subagents (doc/agent-runtime.md#预算).
const COLUMNS = ["used_tokens", "used_cost_microusd"];

export async function up(db: Kysely<unknown>): Promise<void> {
	for (const c of COLUMNS) {
		await db.schema
			.alterTable("sessions")
			.addColumn(c, "bigint", (col) => col.notNull().defaultTo(0))
			.execute();
	}
}

export async function down(db: Kysely<unknown>): Promise<void> {
	for (const c of COLUMNS) await db.schema.alterTable("sessions").dropColumn(c).execute();
}
