/**
 * Locale-aware formatting, bound to the currently active Lingui locale.
 *
 * All formatting goes through the native `Intl` API — the project does not ship
 * a date library (doc/design/webui.md "Frontend architecture"). The helpers are pure so they can be
 * unit-tested with an explicit locale.
 */

export type DateInput = string | number | Date | null | undefined;

/**
 * `Intl` constructors are expensive (they build the locale data for the
 * formatter), and a rendered list calls the helpers once per row and per
 * refresh tick. Formatters are pure for a locale + options pair, so they are
 * cached for the lifetime of the page; the key space is the two locales times
 * the handful of option sets below.
 */
const dateTimeFormats = new Map<string, Intl.DateTimeFormat>();
const relativeTimeFormats = new Map<string, Intl.RelativeTimeFormat>();
const numberFormats = new Map<string, Intl.NumberFormat>();

function dateTimeFormat(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
	const key = `${locale}|${JSON.stringify(options)}`;
	let formatter = dateTimeFormats.get(key);
	if (!formatter) {
		formatter = new Intl.DateTimeFormat(locale, options);
		dateTimeFormats.set(key, formatter);
	}
	return formatter;
}

function relativeTimeFormat(locale: string): Intl.RelativeTimeFormat {
	let formatter = relativeTimeFormats.get(locale);
	if (!formatter) {
		formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "short" });
		relativeTimeFormats.set(locale, formatter);
	}
	return formatter;
}

function numberFormat(locale: string, options: Intl.NumberFormatOptions | undefined): Intl.NumberFormat {
	const key = `${locale}|${JSON.stringify(options ?? {})}`;
	let formatter = numberFormats.get(key);
	if (!formatter) {
		formatter = new Intl.NumberFormat(locale, options);
		numberFormats.set(key, formatter);
	}
	return formatter;
}

function toDate(value: DateInput): Date | null {
	if (value === null || value === undefined || value === "") return null;
	const date = value instanceof Date ? value : new Date(value);
	return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Seconds precision in a compact, still locale-aware shape: "11/06/2026,
 * 01:23:45" in en, "2026/11/06 01:23:45" in zh-CN. Narrow enough for the
 * table's fixed time columns; no explicit `timeZone`, so it is the browser's.
 */
export function formatDateTimeSeconds(value: DateInput, locale: string): string {
	const date = toDate(value);
	if (!date) return "–";
	return dateTimeFormat(locale, {
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hourCycle: "h23",
	}).format(date);
}

/** A sortable local timestamp, e.g. "2026-11-03 09:00:00". */
export function formatDateTimeNumeric(value: DateInput): string {
	const date = toDate(value);
	if (!date) return "–";
	const parts = dateTimeFormat("en-CA", {
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hourCycle: "h23",
	}).formatToParts(date);
	const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === type)?.value ?? "";
	return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}:${part("second")}`;
}

/** The "3 minutes ago" style relative time. */
export function formatRelativeTime(value: DateInput, locale: string, now: number = Date.now()): string {
	const date = toDate(value);
	if (!date) return "–";
	const diffMs = date.getTime() - now;
	const abs = Math.abs(diffMs);
	const formatter = relativeTimeFormat(locale);
	if (abs < 45_000) return formatter.format(Math.round(diffMs / 1_000), "second");
	if (abs < 45 * 60_000) return formatter.format(Math.round(diffMs / 60_000), "minute");
	if (abs < 22 * 3_600_000) return formatter.format(Math.round(diffMs / 3_600_000), "hour");
	if (abs < 26 * 86_400_000) return formatter.format(Math.round(diffMs / 86_400_000), "day");
	if (abs < 320 * 86_400_000) return formatter.format(Math.round(diffMs / (30 * 86_400_000)), "month");
	return formatter.format(Math.round(diffMs / (365 * 86_400_000)), "year");
}

export function formatNumber(value: number, locale: string, options?: Intl.NumberFormatOptions): string {
	return numberFormat(locale, options).format(value);
}

/**
 * A token count with an auto unit: `1234 → "1.2K"`, `1500000 → "1.5M"` (doc/design/webui.md "Frontend architecture": the one
 * formatter every session counter uses). The number keeps the active locale; the unit is the same in both.
 */
export function formatTokens(value: number, locale: string): string {
	const tokens = Number.isFinite(value) ? value : 0;
	const scaled = (amount: number, unit: string) =>
		`${formatNumber(amount, locale, { maximumFractionDigits: 1 })}${unit}`;
	if (Math.abs(tokens) >= 1_000_000) return scaled(tokens / 1_000_000, "M");
	if (Math.abs(tokens) >= 1_000) return scaled(tokens / 1_000, "K");
	return formatNumber(tokens, locale);
}

/** A duration in seconds/milliseconds as "1h 02m 03s". */
export function formatDuration(ms: number, locale: string): string {
	if (!Number.isFinite(ms) || ms < 0) return "–";
	const totalSeconds = Math.round(ms / 1000);
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	const number = (n: number) => formatNumber(n, locale, { minimumIntegerDigits: 2, useGrouping: false });
	if (hours > 0) return `${formatNumber(hours, locale)}h ${number(minutes)}m`;
	if (minutes > 0) return `${formatNumber(minutes, locale)}m ${number(seconds)}s`;
	return `${formatNumber(seconds, locale)}s`;
}

/** Splits a comma- or whitespace-separated list, dropping empty entries and duplicates. */
export function parseList(text: string): string[] {
	const values = text
		.split(/[,\s]+/)
		.map((value) => value.trim())
		.filter((value) => value !== "");
	return [...new Set(values)];
}

/**
 * A byte count with a binary unit: "512 B", "1.5 KiB", "32 MiB". The number keeps the active
 * locale; the unit is the same in both (doc/design/webui.md "Frontend architecture").
 */
export function formatBytes(value: number, locale: string): string {
	const bytes = Number.isFinite(value) ? Math.max(0, value) : 0;
	const units = ["B", "KiB", "MiB", "GiB", "TiB"];
	let amount = bytes;
	let unit = 0;
	while (amount >= 1024 && unit < units.length - 1) {
		amount /= 1024;
		unit += 1;
	}
	return `${formatNumber(amount, locale, { maximumFractionDigits: unit === 0 ? 0 : 1 })} ${units[unit]}`;
}
