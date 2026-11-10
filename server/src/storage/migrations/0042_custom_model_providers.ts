import type { Kysely } from "kysely";

/**
 * Model providers are either Pi built-in (`builtin`) or `custom`. The old
 * `openai-compatible` kind becomes `custom`; every model of such a provider gets an explicit
 * protocol (`openai-completions`) and input modalities (`["text"]`), and its old `reasoning`
 * flag becomes the thinking configuration (format mode with an empty level map, i.e. pi-ai's
 * `reasoning: true` with no level overrides). Providers also gain `session_id`, the request
 * headers and body paths that carry the crh session id.
 *
 * Built-in rows are untouched; they never carry models, headers or a session id.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	// biome-ignore lint/suspicious/noExplicitAny: the migration reads and writes model_providers
	const d = db as Kysely<any>;
	await db.schema.alterTable("model_providers").addColumn("session_id", "text").execute();
	const rows: { id: string; kind: string; models: string | null }[] = await d
		.selectFrom("model_providers")
		.select(["id", "kind", "models"])
		.execute();
	for (const row of rows) {
		if (row.kind !== "openai-compatible") continue;
		await d
			.updateTable("model_providers")
			.set({
				kind: "custom",
				models: row.models === null ? null : upgradeModels(row.models),
			})
			.where("id", "=", row.id)
			.execute();
	}
}

/** The old `reasoning: true` becomes a format-mode thinking block with no level mapping. */
function upgradeModels(raw: string): string {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		// An unreadable list is kept as it is; the provider row is still renamed.
		return raw;
	}
	if (!Array.isArray(parsed)) return raw;
	const models = parsed.map((entry) => {
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return entry;
		const model = { ...(entry as Record<string, unknown>) };
		const reasoning = model.reasoning === true;
		delete model.reasoning;
		model.api = "openai-completions";
		model.input = ["text"];
		if (reasoning) model.thinking = { mode: "format", levels: {} };
		return model;
	});
	return JSON.stringify(models);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	// biome-ignore lint/suspicious/noExplicitAny: the migration reads and writes model_providers
	const d = db as Kysely<any>;
	const rows: { id: string; models: string | null }[] = await d
		.selectFrom("model_providers")
		.select(["id", "models"])
		.where("kind", "=", "custom")
		.execute();
	for (const row of rows) {
		await d
			.updateTable("model_providers")
			.set({ kind: "openai-compatible", models: row.models === null ? null : downgradeModels(row.models) })
			.where("id", "=", row.id)
			.execute();
	}
	await db.schema.alterTable("model_providers").dropColumn("session_id").execute();
}

/** Best effort: a configured thinking block becomes the old boolean; protocol and input go away. */
function downgradeModels(raw: string): string {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return raw;
	}
	if (!Array.isArray(parsed)) return raw;
	const models = parsed.map((entry) => {
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return entry;
		const model = { ...(entry as Record<string, unknown>) };
		const reasoning = model.thinking !== undefined;
		delete model.api;
		delete model.input;
		delete model.thinking;
		// Every thinking block allowed thinking; the old shape only had the boolean.
		if (reasoning) model.reasoning = true;
		return model;
	});
	return JSON.stringify(models);
}
