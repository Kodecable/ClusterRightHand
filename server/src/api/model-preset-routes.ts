import { Hono } from "hono";
import { isModelPresetKind } from "../agent/model-presets.ts";
import { type ModelConfig, type ModelRef, parseModelRef } from "../agent/models.ts";
import type { AgentRuntime } from "../agent/runtime.ts";
import { userActor } from "../audit/audit.ts";
import { UserError } from "../util/errors.ts";
import { type AppEnv, jsonError, readJsonObject } from "./context.ts";
import { requireAdmin } from "./middleware.ts";

export interface ModelPresetRoutesOptions {
	runtime: AgentRuntime;
	models: ModelConfig;
}

/** Model presets (doc/design/agent-runtime.md "Model presets"); administrators only. Expects requireUser. */
export function modelPresetRoutes(options: ModelPresetRoutesOptions) {
	const { runtime, models } = options;
	const app = new Hono<AppEnv>();

	/** All three presets with their fixed default prompts and protocol texts (administrators only). */
	app.get("/model-presets", requireAdmin, async (c) => {
		return c.json({ presets: runtime.modelPresets.list() });
	});

	/**
	 * `{ model?: ModelRef | null, systemPrompt?: string | null }`: omitted fields stay unchanged, null
	 * clears. The session preset never chooses a model; review and title models are resolved with their
	 * thinking level, which belongs in the model ref.
	 */
	app.put("/model-presets/:kind", requireAdmin, async (c) => {
		const kind = c.req.param("kind");
		if (!isModelPresetKind(kind)) return jsonError(c, 400, "kind must be session, review or title");
		const body = await readJsonObject(c);
		if (!body) return jsonError(c, 400, "expected a JSON object");
		const has = (key: string) => Object.hasOwn(body, key);
		if (has("thinkingLevel")) throw new UserError("thinkingLevel belongs in model");
		let model: ModelRef | null | undefined;
		if (has("model")) {
			if (kind === "session") {
				if (body.model !== null) throw new UserError("the session preset does not choose a model");
				model = null;
			} else if (body.model === null) {
				model = null;
			} else {
				model = models.resolveRef(parseModelRef(body.model));
			}
		}
		let systemPrompt: string | null | undefined;
		if (has("systemPrompt")) {
			const value = body.systemPrompt;
			if (value !== null && typeof value !== "string") {
				throw new UserError("systemPrompt must be a string or null");
			}
			const trimmed = typeof value === "string" ? value.trim() : null;
			systemPrompt = trimmed === "" ? null : trimmed;
		}
		const preset = await runtime.modelPresets.update(kind, { model, systemPrompt });
		void c.get("audit").record({
			actor: userActor(c.get("user")),
			action: "settings.model_preset",
			target: { type: "settings", id: "model_preset" },
			detail: {
				kind,
				model: preset.model,
				system_prompt_chars: preset.systemPrompt?.length ?? 0,
			},
		});
		return c.json({ preset });
	});

	return app;
}
