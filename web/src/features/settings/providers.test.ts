import type { CustomModel } from "@crh/api";
import { describe, expect, test } from "vitest";
import {
	emptyModelRow,
	type ModelRow,
	modelToRow,
	rowsToHeaders,
	rowsToModels,
	rowsToSessionId,
	rowToModel,
} from "./providers";

/** The converted model, failing the test when the row has field errors. */
function converted(row: ModelRow): CustomModel {
	const result = rowToModel(row);
	if ("errors" in result) throw new Error(`unexpected errors: ${JSON.stringify(result.errors)}`);
	return result.model;
}

/** The field errors of a row that must not convert. */
function errors(row: ModelRow) {
	const result = rowToModel(row);
	if ("model" in result) throw new Error("expected the row to fail conversion");
	return result.errors;
}

describe("rowToModel", () => {
	test("trims the id and name and keeps numbers and image support", () => {
		const row: ModelRow = {
			...emptyModelRow(),
			id: "  m1 ",
			name: " Model One ",
			contextWindow: "200000",
			maxTokens: "16000",
			imageUnderstanding: true,
		};
		expect(converted(row)).toEqual({
			id: "m1",
			name: "Model One",
			api: "openai-completions",
			contextWindow: 200_000,
			maxTokens: 16_000,
			input: ["text", "image"],
		});
	});

	test("reports every invalid field instead of only the first", () => {
		const row: ModelRow = {
			...emptyModelRow(),
			id: "  ",
			contextWindow: "1000",
			maxTokens: "0",
		};
		expect(errors(row)).toEqual({
			id: "model-id-required",
			contextWindow: "context-window-invalid",
			maxTokens: "max-tokens-invalid",
		});
	});

	test("standard mode omits auto and maps the levels with values", () => {
		const row: ModelRow = {
			...emptyModelRow(),
			id: "m1",
			thinkingMode: "standard",
			formatLevels: {
				...emptyModelRow().formatLevels,
				low: { kind: "value", value: " low " },
			},
		};
		expect(converted(row).thinking).toEqual({ mode: "standard", levels: { low: "low" } });
		expect(converted({ ...row, format: "deepseek" }).thinking).toEqual({
			mode: "standard",
			format: "deepseek",
			levels: { low: "low" },
		});
		// Responses always sends reasoning.effort, so the server rejects a format there.
		expect(converted({ ...row, api: "openai-responses", format: "deepseek" }).thinking).toEqual({
			mode: "standard",
			levels: { low: "low" },
		});
	});

	test("display names are omitted at their default, kept when renamed and empty when hidden", () => {
		const row: ModelRow = {
			...emptyModelRow(),
			id: "m1",
			thinkingMode: "standard",
			labels: {
				...emptyModelRow().labels,
				high: "Fast",
				low: "",
				medium: " medium ",
			},
		};
		// `medium` equals its id and `off`/others keep their ids: only two labels are stored.
		expect(converted(row).thinking).toEqual({
			mode: "standard",
			levels: {},
			labels: { high: "Fast", low: "" },
		});
		// Off may be renamed but never hidden.
		const hiddenOff = { ...row, labels: { ...row.labels, off: "  " } };
		expect(errors(hiddenOff).labels).toEqual({ off: "off-level-hidden" });
	});

	test("xhigh and max are hidden by default and offered by a non-empty display name", () => {
		const row: ModelRow = { ...emptyModelRow(), id: "m1", thinkingMode: "standard" };
		// Both start empty, with the level id only as the placeholder.
		expect(row.labels.xhigh).toBe("");
		expect(row.labels.max).toBe("");
		expect(row.labels.minimal).toBe("minimal");
		expect(row.labels.high).toBe("high");
		expect(row.labels.off).toBe("off");
		// Left untouched, they add no label and no mapping.
		expect(converted(row).thinking).toEqual({ mode: "standard", levels: {} });
		// Typing the level id (or any name) is the offer marker pi-ai is missing.
		expect(converted({ ...row, labels: { ...row.labels, xhigh: "xhigh", max: "Extreme" } }).thinking).toEqual({
			mode: "standard",
			levels: {},
			labels: { xhigh: "xhigh", max: "Extreme" },
		});
		// Clearing a name that a mapping offers keeps the explicit hide.
		const mapped: ModelRow = {
			...row,
			formatLevels: { ...row.formatLevels, xhigh: { kind: "value", value: "xhigh" } },
		};
		expect(converted(mapped).thinking).toEqual({
			mode: "standard",
			levels: { xhigh: "xhigh" },
			labels: { xhigh: "" },
		});
		// The default name of a mapped level is omitted; the mapping alone offers it.
		expect(converted({ ...mapped, labels: { ...mapped.labels, xhigh: "xhigh" } }).thinking).toEqual({
			mode: "standard",
			levels: { xhigh: "xhigh" },
		});
	});

	test("a hidden off level in another mode does not block a model without thinking", () => {
		const row: ModelRow = {
			...emptyModelRow(),
			id: "m1",
			thinkingMode: "none",
			labels: { ...emptyModelRow().labels, off: "" },
		};
		expect(converted(row)).not.toHaveProperty("thinking");
	});

	test("standard mode requires a value for a mapped level", () => {
		const row: ModelRow = {
			...emptyModelRow(),
			id: "m1",
			thinkingMode: "standard",
			formatLevels: {
				...emptyModelRow().formatLevels,
				medium: { kind: "value", value: "  " },
			},
		};
		expect(errors(row).formatLevels).toEqual({ medium: "level-value-required" });
	});

	test("custom mode parses each listed level and rejects non-object JSON", () => {
		const row: ModelRow = {
			...emptyModelRow(),
			id: "m1",
			thinkingMode: "custom",
			bodyLevels: {
				...emptyModelRow().bodyLevels,
				off: '{"thinking":{"type":"disabled"}}',
				high: '  {"reasoning":{"effort":"high"}}  ',
			},
		};
		expect(converted(row).thinking).toEqual({
			mode: "custom",
			levels: {
				off: { thinking: { type: "disabled" } },
				high: { reasoning: { effort: "high" } },
			},
		});

		expect(errors({ ...row, bodyLevels: { ...row.bodyLevels, minimal: "{" } }).bodyLevels).toEqual({
			minimal: "level-invalid-json",
		});
		expect(errors({ ...row, bodyLevels: { ...row.bodyLevels, minimal: "null" } }).bodyLevels).toEqual({
			minimal: "level-not-object",
		});
		expect(errors({ ...row, bodyLevels: { ...row.bodyLevels, minimal: "[]" } }).bodyLevels).toEqual({
			minimal: "level-not-object",
		});
	});

	test("compat is omitted when blank and must be a JSON object otherwise", () => {
		const row: ModelRow = { ...emptyModelRow(), id: "m1" };
		expect(converted(row)).not.toHaveProperty("compat");
		expect(converted({ ...row, compatText: "  " })).not.toHaveProperty("compat");
		expect(converted({ ...row, compatText: '{"maxTokensField":"max_completion_tokens"}' }).compat).toEqual({
			maxTokensField: "max_completion_tokens",
		});
		expect(errors({ ...row, compatText: "{" }).compat).toBe("compat-invalid-json");
		expect(errors({ ...row, compatText: "[]" }).compat).toBe("compat-not-object");
	});
});

describe("modelToRow", () => {
	test("round-trips every stored value of a standard-thinking model", () => {
		const stored: CustomModel = {
			id: "chat-model",
			name: "Chat Model",
			api: "openai-completions",
			contextWindow: 128_000,
			maxTokens: 8_192,
			input: ["text"],
			thinking: {
				mode: "standard",
				format: "deepseek",
				levels: { low: "low" },
				labels: { off: "None", high: "Fast" },
			},
			compat: { maxTokensField: "max_completion_tokens" },
		};
		expect(converted(modelToRow(stored))).toEqual(stored);
	});

	test("round-trips every stored value of a custom-thinking model", () => {
		const stored: CustomModel = {
			id: "resp-model",
			api: "openai-responses",
			contextWindow: 200_000,
			maxTokens: 16_000,
			input: ["text", "image"],
			thinking: {
				mode: "custom",
				levels: {
					off: { thinking: { type: "disabled" } },
					high: { reasoning: { effort: "high" } },
				},
				labels: { high: "Deep" },
			},
		};
		expect(converted(modelToRow(stored))).toEqual(stored);
	});

	test("prefills xhigh and max only when the stored config offers them", () => {
		const mapped = modelToRow({
			id: "mapped",
			api: "openai-completions",
			contextWindow: 128_000,
			maxTokens: 8_192,
			input: ["text"],
			thinking: { mode: "standard", levels: { xhigh: "xhigh", low: "low" } },
		});
		expect(mapped.labels.xhigh).toBe("xhigh");
		expect(mapped.labels.max).toBe("");
		expect(mapped.formatLevels.xhigh).toEqual({ kind: "value", value: "xhigh" });
		// Saving the untouched row keeps the stored shape and leaves the invisible max row alone.
		expect(converted(mapped).thinking).toEqual({ mode: "standard", levels: { xhigh: "xhigh", low: "low" } });

		const named = modelToRow({
			id: "named",
			api: "openai-completions",
			contextWindow: 128_000,
			maxTokens: 8_192,
			input: ["text"],
			thinking: { mode: "standard", levels: {}, labels: { xhigh: "Extreme" } },
		});
		expect(named.labels.xhigh).toBe("Extreme");
		expect(named.labels.max).toBe("");
		expect(converted(named).thinking).toEqual({
			mode: "standard",
			levels: {},
			labels: { xhigh: "Extreme" },
		});

		const plain = modelToRow({
			id: "plain",
			api: "openai-completions",
			contextWindow: 128_000,
			maxTokens: 8_192,
			input: ["text"],
		});
		expect(plain.labels.xhigh).toBe("");
		expect(plain.labels.max).toBe("");
	});

	test("shows a stored standard null as an empty display name and hides it on save", () => {
		const row = modelToRow({
			id: "chat-model",
			api: "openai-completions",
			contextWindow: 128_000,
			maxTokens: 8_192,
			input: ["text"],
			thinking: { mode: "standard", levels: { low: "low", xhigh: null }, labels: { xhigh: "Extreme" } },
		});
		expect(row.labels.xhigh).toBe("");
		expect(row.formatLevels.xhigh).toEqual({ kind: "default", value: "" });
		// The level was already hidden (null), so saving keeps the shape minimal: no label.
		expect(converted(row).thinking).toEqual({
			mode: "standard",
			levels: { low: "low" },
		});
	});

	test("turns a model without thinking or compat into an empty sheet", () => {
		const row = modelToRow({
			id: "plain",
			api: "openai-completions",
			contextWindow: 64_000,
			maxTokens: 4_096,
			input: ["text"],
		});
		expect(row.thinkingMode).toBe("none");
		expect(row.format).toBe("");
		expect(row.compatText).toBe("");
		expect(row.imageUnderstanding).toBe(false);
	});
});

describe("rowsToModels", () => {
	test("requires at least one model and unique ids", () => {
		expect(rowsToModels([])).toEqual({ error: "models-required" });
		const row = { ...emptyModelRow(), id: "same" };
		expect(rowsToModels([row, row])).toEqual({ error: "model-id-duplicate" });
	});

	test("converts a valid list in order", () => {
		const first = { ...emptyModelRow(), id: "a" };
		const second = { ...emptyModelRow(), id: "b" };
		const result = rowsToModels([first, second]);
		expect("models" in result && result.models.map((model) => model.id)).toEqual(["a", "b"]);
	});
});

describe("request headers and session id fields", () => {
	test("drops empty header rows and keeps empty values", () => {
		expect(rowsToHeaders([])).toBeNull();
		expect(rowsToHeaders([{ name: "", value: "" }])).toBeNull();
		expect(rowsToHeaders([{ name: " x-gateway ", value: "edge" }])).toEqual({ "x-gateway": "edge" });
		expect(rowsToHeaders([{ name: "x-empty", value: "" }])).toEqual({ "x-empty": "" });
	});

	test("trims session id fields and reports none as null", () => {
		expect(rowsToSessionId([], [])).toBeNull();
		expect(rowsToSessionId([{ value: " " }], [{ value: "" }])).toBeNull();
		expect(
			rowsToSessionId([{ value: " x-opencode-session " }, { value: "" }], [{ value: "metadata.session_id" }]),
		).toEqual({ headers: ["x-opencode-session"], body: ["metadata.session_id"] });
	});
});
