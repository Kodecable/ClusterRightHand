import type { Kysely } from "kysely";

/**
 * The authorization preset (Ask / Auto Review / Yolo) is a *rule preset*, and the model preset
 * added in the same decision is a different thing. Rename `rule_sets.preset` to `rule_preset` so the
 * column says which one it holds. The values, the default action and the added rules stay as they are;
 * both databases carry a column rename through in place, and no index or constraint names the column.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema.alterTable("rule_sets").renameColumn("preset", "rule_preset").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.alterTable("rule_sets").renameColumn("rule_preset", "preset").execute();
}
