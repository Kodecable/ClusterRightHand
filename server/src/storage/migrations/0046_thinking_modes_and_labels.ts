import type { Kysely } from "kysely";

/**
 * Thinking modes become `standard` / `custom` (formerly `format` / `body`). The custom model JSON is
 * rewritten in place; per-level display names are a new optional `labels` key and need no rewrite. An
 * old format level stored as null (the removed "disabled" choice) stays valid: it hides the level just
 * like an empty label does, and the UI shows it as an empty display name.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await rewriteModes(db, { standard: "format", custom: "body" }, { standard: "standard", custom: "custom" });
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await rewriteModes(db, { standard: "standard", custom: "custom" }, { standard: "format", custom: "body" });
}

/** Renames `thinking.mode` in every custom provider's model list; unreadable rows are left untouched. */
async function rewriteModes(
	db: Kysely<unknown>,
	source: { standard: string; custom: string },
	target: { standard: string; custom: string },
): Promise<void> {
	// biome-ignore lint/suspicious/noExplicitAny: the migration reads and writes model_providers
	const d = db as Kysely<any>;
	const rows: { id: string; models: string | null }[] = await d
		.selectFrom("model_providers")
		.select(["id", "models"])
		.where("kind", "=", "custom")
		.execute();
	for (const row of rows) {
		if (row.models === null) continue;
		const models = rewriteModels(row.models, source, target);
		if (models === row.models) continue;
		await d.updateTable("model_providers").set({ models }).where("id", "=", row.id).execute();
	}
}

/** The raw JSON when nothing changed, so a row with no old modes is not rewritten. */
function rewriteModels(
	raw: string,
	source: { standard: string; custom: string },
	target: { standard: string; custom: string },
): string {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return raw;
	}
	if (!Array.isArray(parsed)) return raw;
	let changed = false;
	const models = parsed.map((entry) => {
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return entry;
		const model = { ...(entry as Record<string, unknown>) };
		const thinking = model.thinking;
		if (typeof thinking !== "object" || thinking === null || Array.isArray(thinking)) return entry;
		const config = { ...(thinking as Record<string, unknown>) };
		if (config.mode === source.standard) {
			config.mode = target.standard;
			changed = true;
		} else if (config.mode === source.custom) {
			config.mode = target.custom;
			changed = true;
		}
		model.thinking = config;
		return model;
	});
	return changed ? JSON.stringify(models) : raw;
}
