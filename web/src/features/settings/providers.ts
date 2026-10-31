import type { I18n, MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import type { CompatibleModel } from "@/lib/api/types";

/**
 * Pure validation of the model provider form (doc/agent-runtime.md "模型"):
 * the rows and the headers textarea are user input, the API wants typed
 * values. Error codes are translated by the page.
 */

/** Provider ids: lowercase letters, digits and dashes (the server accepts the same set). */
export const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface ModelRow {
	id: string;
	contextWindow: string;
	maxTokens: string;
	reasoning: boolean;
}

export type ProviderFormErrorCode =
	| "provider-id-invalid"
	| "base-url-required"
	| "base-url-invalid"
	| "models-required"
	| "model-id-required"
	| "context-window-invalid"
	| "max-tokens-invalid"
	| "headers-invalid-json"
	| "headers-not-object"
	| "headers-value-not-string";

const MESSAGES: Record<ProviderFormErrorCode, MessageDescriptor> = {
	"provider-id-invalid": msg`A provider id is lowercase letters, digits and dashes.`,
	"base-url-required": msg`A base URL is required.`,
	"base-url-invalid": msg`The base URL must start with http:// or https://.`,
	"models-required": msg`List at least one model.`,
	"model-id-required": msg`Every model needs an id.`,
	"context-window-invalid": msg`Every model needs a context window of at least 1024 tokens.`,
	"max-tokens-invalid": msg`Every model needs a max output of at least 1 token.`,
	"headers-invalid-json": msg`Request headers must be valid JSON.`,
	"headers-not-object": msg`Request headers must be a JSON object.`,
	"headers-value-not-string": msg`Every request header value must be a string.`,
};

/** The translated text of a provider form error. */
export function providerErrorText(i18n: I18n, error: ProviderFormErrorCode): string {
	return i18n._(MESSAGES[error]);
}

/** The form's model rows as the API shape. */
export function rowsToModels(rows: ModelRow[]): { models: CompatibleModel[] } | { error: ProviderFormErrorCode } {
	if (rows.length === 0) return { error: "models-required" };
	const models: CompatibleModel[] = [];
	for (const row of rows) {
		const id = row.id.trim();
		if (id === "") return { error: "model-id-required" };
		const contextWindow = Number(row.contextWindow);
		if (!Number.isInteger(contextWindow) || contextWindow < 1024) {
			return { error: "context-window-invalid" };
		}
		const maxTokens = Number(row.maxTokens);
		if (!Number.isInteger(maxTokens) || maxTokens < 1) return { error: "max-tokens-invalid" };
		models.push({
			id,
			contextWindow,
			maxTokens,
			...(row.reasoning ? { reasoning: true } : {}),
		});
	}
	return { models };
}

/**
 * `{}` or an empty textarea clears the headers; credentials belong in the API
 * key field, not here. Values must be strings so the server can forward them
 * unchanged.
 */
export function parseHeaders(
	text: string,
): { headers: Record<string, string> | null } | { error: ProviderFormErrorCode } {
	if (text.trim() === "") return { headers: null };
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return { error: "headers-invalid-json" };
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return { error: "headers-not-object" };
	}
	const entries = Object.entries(value);
	if (entries.some(([, headerValue]) => typeof headerValue !== "string")) {
		return { error: "headers-value-not-string" };
	}
	return { headers: Object.fromEntries(entries) as Record<string, string> };
}
