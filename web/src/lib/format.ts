/**
 * Locale-aware formatting, bound to the currently active Lingui locale.
 *
 * All formatting goes through the native `Intl` API — the project does not ship
 * a date library (doc/webui.md "技术栈"). The helpers are pure so they can be
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

/** A short date and time, e.g. "Oct 31, 20:08". */
export function formatDateTime(value: DateInput, locale: string): string {
	const date = toDate(value);
	if (!date) return "–";
	return dateTimeFormat(locale, {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	}).format(date);
}

/** A full date, e.g. "Oct 31, 2026". */
export function formatDate(value: DateInput, locale: string): string {
	const date = toDate(value);
	if (!date) return "–";
	return dateTimeFormat(locale, { year: "numeric", month: "short", day: "numeric" }).format(date);
}

/** Seconds precision, e.g. "Oct 31, 2026, 20:08:29". */
export function formatDateTimeSeconds(value: DateInput, locale: string): string {
	const date = toDate(value);
	if (!date) return "–";
	return dateTimeFormat(locale, {
		year: "numeric",
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	}).format(date);
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

/** A byte count with binary units; uses `Intl` for the number part. */
export function formatBytes(bytes: number, locale: string): string {
	if (!Number.isFinite(bytes) || bytes < 0) return "–";
	const units = ["B", "KiB", "MiB", "GiB", "TiB"];
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	const digits = unit === 0 || value >= 100 ? 0 : 1;
	return `${formatNumber(value, locale, { maximumFractionDigits: digits })} ${units[unit]}`;
}

/** The clock time of a day, for schedules and run histories. */
export function formatTime(value: DateInput, locale: string): string {
	const date = toDate(value);
	if (!date) return "–";
	return dateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(date);
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
