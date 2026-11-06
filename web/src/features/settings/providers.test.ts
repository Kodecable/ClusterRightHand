import { describe, expect, test } from "vitest";
import type { CustomModel } from "@/lib/api/types";
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
			acceptImages: true,
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

	test("format mode omits auto, maps levels and keeps a disabled level as null", () => {
		const row: ModelRow = {
			...emptyModelRow(),
			id: "m1",
			thinkingMode: "format",
			formatLevels: {
				...emptyModelRow().formatLevels,
				low: { kind: "value", value: " low " },
				xhigh: { kind: "disabled", value: "ignored" },
			},
		};
		expect(converted(row).thinking).toEqual({ mode: "format", levels: { low: "low", xhigh: null } });
		expect(converted({ ...row, format: "deepseek" }).thinking).toEqual({
			mode: "format",
			format: "deepseek",
			levels: { low: "low", xhigh: null },
		});
		// Responses always sends reasoning.effort, so the server rejects a format there.
		expect(converted({ ...row, api: "openai-responses", format: "deepseek" }).thinking).toEqual({
			mode: "format",
			levels: { low: "low", xhigh: null },
		});
	});

	test("format mode requires a value for a mapped level", () => {
		const row: ModelRow = {
			...emptyModelRow(),
			id: "m1",
			thinkingMode: "format",
			formatLevels: {
				...emptyModelRow().formatLevels,
				medium: { kind: "value", value: "  " },
			},
		};
		expect(errors(row).formatLevels).toEqual({ medium: "level-value-required" });
	});

	test("body mode parses each listed level and rejects non-object JSON", () => {
		const row: ModelRow = {
			...emptyModelRow(),
			id: "m1",
			thinkingMode: "body",
			bodyLevels: {
				...emptyModelRow().bodyLevels,
				off: '{"thinking":{"type":"disabled"}}',
				high: '  {"reasoning":{"effort":"high"}}  ',
			},
		};
		expect(converted(row).thinking).toEqual({
			mode: "body",
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
	test("round-trips every stored value of a format-thinking model", () => {
		const stored: CustomModel = {
			id: "chat-model",
			name: "Chat Model",
			api: "openai-completions",
			contextWindow: 128_000,
			maxTokens: 8_192,
			input: ["text"],
			thinking: { mode: "format", format: "deepseek", levels: { low: "low", xhigh: null } },
			compat: { maxTokensField: "max_completion_tokens" },
		};
		expect(converted(modelToRow(stored))).toEqual(stored);
	});

	test("round-trips every stored value of a body-thinking model", () => {
		const stored: CustomModel = {
			id: "resp-model",
			api: "openai-responses",
			contextWindow: 200_000,
			maxTokens: 16_000,
			input: ["text", "image"],
			thinking: {
				mode: "body",
				levels: {
					off: { thinking: { type: "disabled" } },
					high: { reasoning: { effort: "high" } },
				},
			},
		};
		expect(converted(modelToRow(stored))).toEqual(stored);
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
		expect(row.acceptImages).toBe(false);
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
