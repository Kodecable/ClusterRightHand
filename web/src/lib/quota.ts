/**
 * Token quotas (doc/design/agent-runtime.md "Quota and token accounting").
 *
 * Classification lives in `@crh/api` so the chat replies and every WebUI surface agree. The parsing helpers
 * are pure, and the display text keeps one order everywhere: used first, never a negative remaining.
 */
import { type QuotaStatus, quotaStatus } from "@crh/api";
import type { I18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { formatNumber } from "@/lib/format";

export { type QuotaStatus, quotaStatus };

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

/**
 * The one quota line for a surface that can afford full numbers: "Used N · N left", "Used N · Unlimited",
 * or "Used up, over by N". The composer footer may use compact units for its label, but its title and every
 * other surface use this.
 */
export function quotaDetailText(i18n: I18n, status: QuotaStatus): string {
	const used = formatNumber(status.used, i18n.locale);
	if (status.kind === "exhausted") return i18n._(msg`Used up, over by ${formatNumber(status.over, i18n.locale)}`);
	if (status.kind === "unlimited") return i18n._(msg`Used ${used} · Unlimited`);
	return i18n._(msg`Used ${used} · ${formatNumber(status.remaining, i18n.locale)} left`);
}
