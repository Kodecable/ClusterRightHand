import {
	ModelPresetInputSchema,
	ModelPresetKindParamSchema,
	ModelPresetListResponseSchema,
	ModelPresetResponseSchema,
} from "@crh/api/schemas";
import { type ModelConfig, type ModelRef, parseModelRef } from "../agent/models.ts";
import type { AgentRuntime } from "../agent/runtime.ts";
import { userActor } from "../audit/audit.ts";
import { UserError } from "../util/errors.ts";
import { requireAdmin } from "./middleware.ts";
import { apiRouter, defineRoute, json } from "./openapi.ts";

const TAGS = ["Models"];

const listRoute = defineRoute({
	method: "get",
	path: "/model-presets",
	tags: TAGS,
	summary: "List the session, review and title presets with their default prompt and protocol (administrators)",
	agent: "allow",
	middleware: [requireAdmin],
	responses: { 200: { description: "The three presets", ...json(ModelPresetListResponseSchema) } },
});

const updateRoute = defineRoute({
	method: "put",
	path: "/model-presets/{kind}",
	tags: TAGS,
	summary: "Set a preset's model and/or custom system prompt; omitted fields stay, null clears (administrators)",
	agent: "deny", // the review preset is the Auto Review guardrail
	middleware: [requireAdmin],
	request: { params: ModelPresetKindParamSchema, body: { required: true, ...json(ModelPresetInputSchema) } },
	responses: { 200: { description: "The updated preset", ...json(ModelPresetResponseSchema) } },
});

export interface ModelPresetRoutesOptions {
	runtime: AgentRuntime;
	models: ModelConfig;
}

/** Model presets (doc/design/agent-runtime.md "Model presets"); administrators only. Expects requireUser. */
export function modelPresetRoutes(options: ModelPresetRoutesOptions) {
	const { runtime, models } = options;
	const app = apiRouter();

	app.openapi(listRoute, async (c) => {
		return c.json({ presets: runtime.modelPresets.list() }, 200);
	});

	/**
	 * `{ model?: ModelRef | null, systemPrompt?: string | null }`: omitted fields stay unchanged, null
	 * clears. The session preset never chooses a model; review and title models are resolved with their
	 * thinking level, which belongs in the model ref.
	 */
	app.openapi(updateRoute, async (c) => {
		const { kind } = c.req.valid("param");
		const body = c.req.valid("json");
		// Not a schema field: the old refusal names where the level belongs, which a first-problem message cannot.
		if (Object.hasOwn(body, "thinkingLevel")) throw new UserError("thinkingLevel belongs in model");
		const has = (key: "model" | "systemPrompt") => Object.hasOwn(body, key);
		let model: ModelRef | null | undefined;
		if (has("model")) {
			if (body.model === null) {
				model = null;
			} else if (kind === "session") {
				throw new UserError("the session preset does not choose a model");
			} else {
				model = models.resolveRef(parseModelRef(body.model));
			}
		}
		let systemPrompt: string | null | undefined;
		if (has("systemPrompt")) {
			const trimmed = typeof body.systemPrompt === "string" ? body.systemPrompt.trim() : null;
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
		return c.json({ preset }, 200);
	});

	return app;
}
