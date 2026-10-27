import type { Kysely } from "kysely";

/**
 * Token quotas replace budgets (doc/agent-runtime.md#配额): one signed integer of remaining tokens per session.
 * Usage is charged after each response; a level whose quota is not above zero stops its run. No monetary cost.
 *
 * Existing token budgets become remaining quotas (`tokens - used`), so an overspent session starts negative.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema.alterTable("sessions").addColumn("quota_tokens", "bigint").execute();
	// biome-ignore lint/suspicious/noExplicitAny: migration backfill reads tables from the schema being migrated
	const d = db as Kysely<any>;
	const budgets = await d
		.selectFrom("rule_sets")
		.select(["scope_id", "budget"])
		.where("scope_type", "=", "session")
		.where("budget", "is not", null)
		.execute();
	const quotaOf = new Map<string, number>();
	for (const row of budgets) {
		try {
			const tokens = JSON.parse(row.budget)?.tokens;
			if (Number.isInteger(tokens)) quotaOf.set(row.scope_id, tokens);
		} catch {}
	}
	for (const [sessionId, tokens] of quotaOf) {
		const row = await d.selectFrom("sessions").select("used_tokens").where("id", "=", sessionId).executeTakeFirst();
		if (!row) continue;
		await d
			.updateTable("sessions")
			.set({ quota_tokens: tokens - Number(row.used_tokens) })
			.where("id", "=", sessionId)
			.execute();
	}
	await db.schema.alterTable("sessions").dropColumn("used_cost_microusd").execute();
	await db.schema.alterTable("rule_sets").dropColumn("budget").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.alterTable("sessions")
		.addColumn("used_cost_microusd", "bigint", (c) => c.notNull().defaultTo(0))
		.execute();
	await db.schema.alterTable("rule_sets").addColumn("budget", "text").execute();
	await db.schema.alterTable("sessions").dropColumn("quota_tokens").execute();
}
