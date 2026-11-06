import type { Kysely } from "kysely";

/**
 * D116: model presets are per organization and per kind — session, auto review and title generation.
 * Each row optionally names a model (JSON `ModelRef`) and a custom system prompt; the protocol text
 * is fixed in code. The old global `server_meta.review_model` key becomes the review preset of the
 * default organization (the first one created), and the key is removed.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.createTable("model_presets")
		.addColumn("org_id", "text", (c) => c.notNull().references("orgs.id"))
		.addColumn("kind", "text", (c) => c.notNull())
		.addColumn("model", "text")
		.addColumn("system_prompt", "text")
		.addColumn("updated_at", "text", (c) => c.notNull())
		.addPrimaryKeyConstraint("model_presets_pk", ["org_id", "kind"])
		.execute();

	// biome-ignore lint/suspicious/noExplicitAny: the migration reads and writes server_meta and orgs
	const d = db as Kysely<any>;
	const meta = await d.selectFrom("server_meta").select("value").where("key", "=", "review_model").executeTakeFirst();
	if (meta) {
		const org = await d.selectFrom("orgs").select("id").orderBy("created_at").executeTakeFirst();
		if (org) {
			await d
				.insertInto("model_presets")
				.values({
					org_id: org.id,
					kind: "review",
					model: meta.value,
					system_prompt: null,
					updated_at: new Date().toISOString(),
				})
				.execute();
		}
		await d.deleteFrom("server_meta").where("key", "=", "review_model").execute();
	}
}

export async function down(db: Kysely<unknown>): Promise<void> {
	// biome-ignore lint/suspicious/noExplicitAny: the migration reads and writes server_meta and orgs
	const d = db as Kysely<any>;
	const org = await d.selectFrom("orgs").select("id").orderBy("created_at").executeTakeFirst();
	const review = org
		? await d
				.selectFrom("model_presets")
				.select("model")
				.where("org_id", "=", org.id)
				.where("kind", "=", "review")
				.executeTakeFirst()
		: undefined;
	if (review?.model) {
		await d.deleteFrom("server_meta").where("key", "=", "review_model").execute();
		await d.insertInto("server_meta").values({ key: "review_model", value: review.model }).execute();
	}
	await db.schema.dropTable("model_presets").execute();
}
