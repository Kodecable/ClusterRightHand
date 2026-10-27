import type { Kysely } from "kysely";

/** One generic waiting state: `active` / `awaiting` / `stopped` (doc/agent-runtime.md#subagent). */
export async function up(db: Kysely<unknown>): Promise<void> {
	// biome-ignore lint/suspicious/noExplicitAny: data migration on the sessions table
	const d = db as Kysely<any>;
	await d.updateTable("sessions").set({ state: "awaiting" }).where("state", "=", "awaiting_quota").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	// biome-ignore lint/suspicious/noExplicitAny: data migration on the sessions table
	const d = db as Kysely<any>;
	await d.updateTable("sessions").set({ state: "awaiting_quota" }).where("state", "=", "awaiting").execute();
}
