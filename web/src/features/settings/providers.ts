import type { I18n, MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import type { CustomApi, CustomModel, SessionIdConfig, ThinkingLevel } from "@/lib/api/types";

/**
 * Pure conversion and validation between the model provider form and the API
 * shape (doc/agent-runtime.md "模型配置" / "自定义提供方"). The form keeps
 * numbers and JSON as text because every field is user input; the API wants
 * typed values.
 */

/** Provider ids: lowercase letters, digits and dashes (the server accepts the same set). */
export const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** pi-ai's thinking levels, from "off" to "max" (mirrors server/src/agent/models.ts). */
export const THINKING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const satisfies readonly ThinkingLevel[];

/** The pi-ai thinking-parameter formats a Chat Completions model may ask for (mirrors the server). */
export const THINKING_FORMATS = [
	"openai",
	"openrouter",
	"deepseek",
	"together",
	"baseten",
	"zai",
	"qwen",
	"chat-template",
	"qwen-chat-template",
	"string-thinking",
	"ant-ling",
] as const;

export const CUSTOM_APIS = ["openai-completions", "openai-responses"] as const satisfies readonly CustomApi[];

/** The selected protocol names (doc/agent-runtime.md#自定义提供方). */
export type CustomApiValue = (typeof CUSTOM_APIS)[number];

export type ThinkingMode = "none" | "format" | "body";

/** One level of the format-mode map: omitted (default), a mapped string, or disabled (null). */
export type FormatLevelKind = "default" | "value" | "disabled";

export interface FormatLevelRow {
	kind: FormatLevelKind;
	value: string;
}

/** One model row of the provider form; everything is text until converted. */
export interface ModelRow {
	id: string;
	name: string;
	api: CustomApiValue;
	contextWindow: string;
	maxTokens: string;
	acceptImages: boolean;
	thinkingMode: ThinkingMode;
	/** Chat Completions only; "" means auto (pi-ai decides from the URL). */
	format: string;
	formatLevels: Record<ThinkingLevel, FormatLevelRow>;
	/** JSON text per level; empty means the level is not offered. */
	bodyLevels: Record<ThinkingLevel, string>;
	/** Advanced pi-ai options (JSON text). */
	compatText: string;
}

export interface HeaderRow {
	name: string;
	value: string;
}

export interface SessionIdRow {
	value: string;
}

export type ProviderFormErrorCode =
	| "provider-id-invalid"
	| "base-url-required"
	| "base-url-invalid"
	| "models-required"
	| "model-id-required"
	| "model-id-duplicate"
	| "context-window-invalid"
	| "max-tokens-invalid"
	| "level-value-required"
	| "level-invalid-json"
	| "level-not-object"
	| "compat-invalid-json"
	| "compat-not-object";

const MESSAGES: Record<ProviderFormErrorCode, MessageDescriptor> = {
	"provider-id-invalid": msg`A provider id is lowercase letters, digits and dashes.`,
	"base-url-required": msg`A base URL is required.`,
	"base-url-invalid": msg`The base URL must start with http:// or https://.`,
	"models-required": msg`List at least one model.`,
	"model-id-required": msg`Every model needs an id.`,
	"model-id-duplicate": msg`Model ids must be unique.`,
	"context-window-invalid": msg`Every model needs a context window of at least 1024 tokens.`,
	"max-tokens-invalid": msg`Every model needs a max output of at least 1 token.`,
	"level-value-required": msg`A mapped level value is required.`,
	"level-invalid-json": msg`Request body overrides must be valid JSON.`,
	"level-not-object": msg`Request body overrides must be a JSON object.`,
	"compat-invalid-json": msg`Compat must be valid JSON.`,
	"compat-not-object": msg`Compat must be a JSON object.`,
};

/** The translated text of a provider form error. */
export function providerErrorText(i18n: I18n, error: ProviderFormErrorCode): string {
	return i18n._(MESSAGES[error]);
}

function emptyFormatLevels(): Record<ThinkingLevel, FormatLevelRow> {
	return Object.fromEntries(THINKING_LEVELS.map((level) => [level, { kind: "default", value: "" }])) as Record<
		ThinkingLevel,
		FormatLevelRow
	>;
}

function emptyBodyLevels(): Record<ThinkingLevel, string> {
	return Object.fromEntries(THINKING_LEVELS.map((level) => [level, ""])) as Record<ThinkingLevel, string>;
}

/** A blank model row for the add dialog. */
export function emptyModelRow(): ModelRow {
	return {
		id: "",
		name: "",
		api: "openai-completions",
		contextWindow: "128000",
		maxTokens: "8192",
		acceptImages: false,
		thinkingMode: "none",
		format: "",
		formatLevels: emptyFormatLevels(),
		bodyLevels: emptyBodyLevels(),
		compatText: "",
	};
}

/** An API model as an editable row, keeping every stored value. */
export function modelToRow(model: CustomModel): ModelRow {
	const row = emptyModelRow();
	const thinking = model.thinking;
	return {
		...row,
		id: model.id,
		name: model.name ?? "",
		api: model.api,
		contextWindow: String(model.contextWindow),
		maxTokens: String(model.maxTokens),
		acceptImages: model.input.includes("image"),
		thinkingMode: thinking === undefined ? "none" : thinking.mode,
		format: thinking?.mode === "format" ? (thinking.format ?? "") : "",
		formatLevels: formatLevelsToRow(thinking?.mode === "format" ? thinking.levels : undefined),
		bodyLevels: bodyLevelsToRow(thinking?.mode === "body" ? thinking.levels : undefined),
		compatText: model.compat === undefined ? "" : JSON.stringify(model.compat, null, 2),
	};
}

function formatLevelsToRow(
	levels: Partial<Record<ThinkingLevel, string | null | Record<string, unknown>>> | undefined,
) {
	const values = emptyFormatLevels();
	if (levels === undefined) return values;
	for (const level of THINKING_LEVELS) {
		if (!Object.hasOwn(levels, level)) continue;
		const value = levels[level];
		values[level] = value === null ? { kind: "disabled", value: "" } : { kind: "value", value: String(value) };
	}
	return values;
}

function bodyLevelsToRow(levels: Partial<Record<ThinkingLevel, string | null | Record<string, unknown>>> | undefined) {
	const values = emptyBodyLevels();
	if (levels === undefined) return values;
	for (const level of THINKING_LEVELS) {
		if (!Object.hasOwn(levels, level)) continue;
		// Body levels are always objects (the server validates them), so a string here is only
		// reachable from a hand-edited catalog; showing it verbatim lets the user fix it.
		values[level] = JSON.stringify(levels[level], null, 2);
	}
	return values;
}

/** Where a model row fails validation; each key is a field of the model sheet. */
export interface ModelFormErrors {
	id?: ProviderFormErrorCode;
	contextWindow?: ProviderFormErrorCode;
	maxTokens?: ProviderFormErrorCode;
	formatLevels?: Partial<Record<ThinkingLevel, ProviderFormErrorCode>>;
	bodyLevels?: Partial<Record<ThinkingLevel, ProviderFormErrorCode>>;
	compat?: ProviderFormErrorCode;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseBodyLevel(text: string): { value: Record<string, unknown> } | { error: ProviderFormErrorCode } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { error: "level-invalid-json" };
	}
	if (!isPlainObject(parsed)) return { error: "level-not-object" };
	return { value: parsed };
}

function parseCompat(text: string): { value: Record<string, unknown> } | { error: ProviderFormErrorCode } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { error: "compat-invalid-json" };
	}
	if (!isPlainObject(parsed)) return { error: "compat-not-object" };
	return { value: parsed };
}

/**
 * The model row as the API shape. Returns every field error so the dialog can
 * mark all of them at once instead of only the first.
 */
export function rowToModel(row: ModelRow): { model: CustomModel } | { errors: ModelFormErrors } {
	const errors: ModelFormErrors = {};
	const id = row.id.trim();
	if (id === "") errors.id = "model-id-required";
	const contextWindow = Number(row.contextWindow);
	if (!Number.isInteger(contextWindow) || contextWindow < 1024) {
		errors.contextWindow = "context-window-invalid";
	}
	const maxTokens = Number(row.maxTokens);
	if (!Number.isInteger(maxTokens) || maxTokens < 1) errors.maxTokens = "max-tokens-invalid";

	let thinking: CustomModel["thinking"];
	if (row.thinkingMode === "format") {
		const levels: Partial<Record<ThinkingLevel, string | null>> = {};
		const levelErrors: Partial<Record<ThinkingLevel, ProviderFormErrorCode>> = {};
		for (const level of THINKING_LEVELS) {
			const entry = row.formatLevels[level];
			if (entry.kind === "default") continue;
			if (entry.kind === "disabled") {
				levels[level] = null;
				continue;
			}
			const value = entry.value.trim();
			if (value === "") {
				levelErrors[level] = "level-value-required";
				continue;
			}
			levels[level] = value;
		}
		if (Object.keys(levelErrors).length > 0) errors.formatLevels = levelErrors;
		thinking = {
			mode: "format",
			// Responses always sends reasoning.effort; the server rejects a format there.
			...(row.api === "openai-completions" && row.format !== "" ? { format: row.format } : {}),
			levels,
		};
	} else if (row.thinkingMode === "body") {
		const levels: Partial<Record<ThinkingLevel, Record<string, unknown>>> = {};
		const levelErrors: Partial<Record<ThinkingLevel, ProviderFormErrorCode>> = {};
		for (const level of THINKING_LEVELS) {
			const text = row.bodyLevels[level].trim();
			if (text === "") continue;
			const parsed = parseBodyLevel(text);
			if ("error" in parsed) levelErrors[level] = parsed.error;
			else levels[level] = parsed.value;
		}
		if (Object.keys(levelErrors).length > 0) errors.bodyLevels = levelErrors;
		thinking = { mode: "body", levels };
	}

	let compat: Record<string, unknown> | undefined;
	if (row.compatText.trim() !== "") {
		const parsed = parseCompat(row.compatText);
		if ("error" in parsed) errors.compat = parsed.error;
		else compat = parsed.value;
	}

	if (Object.keys(errors).length > 0) return { errors };
	const model: CustomModel = {
		id,
		...(row.name.trim() !== "" ? { name: row.name.trim() } : {}),
		api: row.api,
		contextWindow,
		maxTokens,
		input: row.acceptImages ? ["text", "image"] : ["text"],
		...(thinking !== undefined ? { thinking } : {}),
		...(compat !== undefined ? { compat } : {}),
	};
	return { model };
}

/** The form's model rows as the API shape (the provider dialog's last check). */
export function rowsToModels(rows: ModelRow[]): { models: CustomModel[] } | { error: ProviderFormErrorCode } {
	if (rows.length === 0) return { error: "models-required" };
	const models: CustomModel[] = [];
	const ids = new Set<string>();
	for (const row of rows) {
		const converted = rowToModel(row);
		if ("errors" in converted) return { error: firstModelError(converted.errors) };
		if (ids.has(converted.model.id)) return { error: "model-id-duplicate" };
		ids.add(converted.model.id);
		models.push(converted.model);
	}
	return { models };
}

function firstModelError(errors: ModelFormErrors): ProviderFormErrorCode {
	return (
		errors.id ??
		errors.contextWindow ??
		errors.maxTokens ??
		Object.values(errors.formatLevels ?? {})[0] ??
		Object.values(errors.bodyLevels ?? {})[0] ??
		errors.compat ??
		"model-id-required"
	);
}

/** Extra request headers as the API shape; empty rows are dropped and none means null. */
export function rowsToHeaders(rows: HeaderRow[]): Record<string, string> | null {
	const entries = rows
		.filter((row) => row.name.trim() !== "" || row.value !== "")
		.map((row) => [row.name.trim(), row.value] as const);
	return entries.length > 0 ? Object.fromEntries(entries) : null;
}

/** Session id header names and body paths as the API shape; none means null. */
export function rowsToSessionId(headers: SessionIdRow[], body: SessionIdRow[]): SessionIdConfig | null {
	const headerNames = headers.map((row) => row.value.trim()).filter((value) => value !== "");
	const bodyPaths = body.map((row) => row.value.trim()).filter((value) => value !== "");
	if (headerNames.length === 0 && bodyPaths.length === 0) return null;
	return {
		...(headerNames.length > 0 ? { headers: headerNames } : {}),
		...(bodyPaths.length > 0 ? { body: bodyPaths } : {}),
	};
}
