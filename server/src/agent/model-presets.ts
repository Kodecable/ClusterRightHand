import type { Db } from "../storage/db.ts";
import type { ModelPresetKind } from "../storage/schema.ts";
import { defaultOrgId } from "../users/service.ts";
import { DEFAULT_SESSION_PROMPT, SESSION_TOOL_GUIDE } from "./extension.ts";
import type { ModelRef } from "./models.ts";
import { DEFAULT_REVIEW_PROMPT, REVIEW_PROTOCOL } from "./review.ts";

/**
 * The model presets (D116, doc/agent-runtime.md#模型预设): one row per organization and kind, holding the
 * optional model and the optional custom system prompt. The protocol text is fixed in code and always
 * appended. `AgentRuntime` loads the cache at startup; a write reloads it, and the prompt sections read
 * the cached values synchronously, so a change takes effect on the next model request.
 *
 * There is one organization today: the cache holds the default organization's rows.
 */

export const MODEL_PRESET_KINDS: readonly ModelPresetKind[] = ["session", "review", "title"];

/** The title preset's default prompt; the next stage generates titles with it (doc/agent-runtime.md#标题生成). */
export const DEFAULT_TITLE_PROMPT = "Write a short title for this conversation that captures what it is about.";

/** The title protocol: fixed and appended to the title system prompt. */
export const TITLE_PROTOCOL =
	"Reply with the title only, on one line, at most 60 characters, in the language of the user's message, without quotes.";

/** One preset's stored half: what an administrator may change. */
export interface StoredModelPreset {
	model: ModelRef | null;
	systemPrompt: string | null;
}

/** What the API returns for one kind. */
export interface ModelPresetView extends StoredModelPreset {
	kind: ModelPresetKind;
	defaultPrompt: string;
	protocol: string;
}

/** The fixed prompt and protocol of each kind, for the API's read-only view. */
const TEXTS: Record<ModelPresetKind, { defaultPrompt: string; protocol: string }> = {
	session: { defaultPrompt: DEFAULT_SESSION_PROMPT, protocol: SESSION_TOOL_GUIDE },
	review: { defaultPrompt: DEFAULT_REVIEW_PROMPT, protocol: REVIEW_PROTOCOL },
	title: { defaultPrompt: DEFAULT_TITLE_PROMPT, protocol: TITLE_PROTOCOL },
};

export function isModelPresetKind(value: string): value is ModelPresetKind {
	return (MODEL_PRESET_KINDS as readonly string[]).includes(value);
}

/** Reads a stored JSON ref, ignoring a malformed one (the rows are only written by the API). */
function parseRef(raw: string | null): ModelRef | null {
	if (!raw) return null;
	try {
		const value = JSON.parse(raw) as { provider?: unknown; modelId?: unknown; thinkingLevel?: unknown };
		if (typeof value.provider !== "string" || typeof value.modelId !== "string") return null;
		return {
			provider: value.provider,
			modelId: value.modelId,
			...(typeof value.thinkingLevel === "string"
				? { thinkingLevel: value.thinkingLevel as ModelRef["thinkingLevel"] }
				: {}),
		};
	} catch {
		return null;
	}
}

export class ModelPresets {
	readonly #db: Db;
	#orgId: string | null = null;
	#cache = new Map<ModelPresetKind, StoredModelPreset>();

	constructor(db: Db) {
		this.#db = db;
	}

	/** Loads the default organization's rows into memory; called at startup and after every write. */
	async load(): Promise<void> {
		const orgId = await defaultOrgId(this.#db);
		const rows = await this.#db.selectFrom("model_presets").selectAll().where("org_id", "=", orgId).execute();
		const cache = new Map<ModelPresetKind, StoredModelPreset>();
		for (const row of rows) {
			cache.set(row.kind, {
				model: parseRef(row.model),
				systemPrompt: row.system_prompt,
			});
		}
		this.#orgId = orgId;
		this.#cache = cache;
	}

	/** The cached preset; absent rows are the defaults (no model, no custom prompt). */
	get(kind: ModelPresetKind): StoredModelPreset {
		return this.#cache.get(kind) ?? { model: null, systemPrompt: null };
	}

	/** All three presets with their fixed texts, as the API returns them. */
	list(): ModelPresetView[] {
		return MODEL_PRESET_KINDS.map((kind) => this.#view(kind));
	}

	#view(kind: ModelPresetKind): ModelPresetView {
		const stored = this.get(kind);
		return { kind, ...stored, ...TEXTS[kind] };
	}

	/**
	 * Writes one preset and reloads the cache. An omitted field stays unchanged; `null` clears it.
	 * The caller has already validated the model and normalized the prompt.
	 */
	async update(
		kind: ModelPresetKind,
		input: { model?: ModelRef | null; systemPrompt?: string | null },
	): Promise<ModelPresetView> {
		if (this.#orgId === null) await this.load();
		const orgId = this.#orgId as string;
		const current = this.get(kind);
		const model = input.model === undefined ? current.model : input.model;
		const systemPrompt = input.systemPrompt === undefined ? current.systemPrompt : input.systemPrompt;
		const now = new Date().toISOString();
		const existing = await this.#db
			.selectFrom("model_presets")
			.select("kind")
			.where("org_id", "=", orgId)
			.where("kind", "=", kind)
			.executeTakeFirst();
		const values = {
			model: model === null ? null : JSON.stringify(model),
			system_prompt: systemPrompt,
			updated_at: now,
		};
		if (existing) {
			await this.#db
				.updateTable("model_presets")
				.set(values)
				.where("org_id", "=", orgId)
				.where("kind", "=", kind)
				.execute();
		} else {
			await this.#db
				.insertInto("model_presets")
				.values({ org_id: orgId, kind, ...values })
				.execute();
		}
		await this.load();
		return this.#view(kind);
	}
}
