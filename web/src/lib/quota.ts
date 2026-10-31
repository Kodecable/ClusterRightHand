/**
 * Token quotas (doc/agent-runtime.md#配额, D92).
 *
 * The parsing helpers are pure so the quota card and the session page share
 * exactly one validation rule. Display text lives in the components (Lingui).
 */

/** Validation failures; the UI translates them with Lingui. */
export type QuotaError = "whole-number" | "too-large" | "positive-required";

/** A token amount a user typed in a quota field; an empty field means unlimited. */
export type QuotaInput = { quota: number | null } | { error: QuotaError };

export function parseQuotaInput(text: string): QuotaInput {
	const trimmed = text.trim();
	if (trimmed === "") return { quota: null };
	if (!/^\d+$/.test(trimmed)) return { error: "whole-number" };
	const quota = Number(trimmed);
	if (!Number.isSafeInteger(quota)) return { error: "too-large" };
	return { quota };
}

/** What a grant field must hold: a positive number of tokens to add. */
export function parseGrantInput(text: string): { tokens: number } | { error: QuotaError } {
	const parsed = parseQuotaInput(text);
	if ("error" in parsed) return parsed;
	if (parsed.quota === null || parsed.quota <= 0) return { error: "positive-required" };
	return { tokens: parsed.quota };
}

export interface QuotaStatus {
	kind: "unlimited" | "remaining" | "exhausted";
	/** Remaining tokens when positive, 0 otherwise. */
	remaining: number;
	/** How many tokens the level is over budget (0 unless exhausted below zero). */
	over: number;
	used: number;
}

/** Remaining quota against what the session and its subagents have used. */
export function quotaStatus(quota: number | null, used: number): QuotaStatus {
	if (quota === null) return { kind: "unlimited", remaining: 0, over: 0, used };
	if (quota <= 0) return { kind: "exhausted", remaining: 0, over: Math.abs(quota), used };
	return { kind: "remaining", remaining: quota, over: 0, used };
}
