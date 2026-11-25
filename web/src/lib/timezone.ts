/**
 * Timezone display helpers for the Metrics tab (doc/design/webui.md "Node pages"): crhs stores and sends
 * instants only, and the WebUI is the one place that turns them into the browser's local time. A local
 * time is always followed by the zone it is in, named as the browser's own locale names it ("UTC+8",
 * "SGT", "EST"), so a reader is never left guessing whose clock a time is on.
 */
import { type DateInput, formatDateTimeSeconds } from "@/lib/format";

const pad = (value: number): string => String(value).padStart(2, "0");

/**
 * The zone name `Intl` reports, with the "GMT" forms rewritten to "UTC": "GMT+8" → "UTC+8",
 * "GMT+08:00" → "UTC+08:00", "GMT" → "UTC". Real abbreviations ("SGT", "EST", "CET") stay as they are,
 * because they are what the browser's locale chose to show.
 */
export function zoneLabelFromName(name: string): string {
	if (name === "GMT") return "UTC";
	const match = /^GMT([+-]\d{1,2}(?::\d{2})?)$/.exec(name);
	return match ? `UTC${match[1]}` : name;
}

/** The browser's zone at `date`, as the locale names it, with the UTC rewrite applied. */
export function zoneLabel(locale: string, date: Date = new Date()): string {
	const name = new Intl.DateTimeFormat(locale, { timeZoneName: "short" })
		.formatToParts(date)
		.find((part) => part.type === "timeZoneName")?.value;
	return name === undefined ? "" : zoneLabelFromName(name);
}

/** A local date and time followed by its zone, e.g. "2026/11/25 18:30:00 UTC+8". */
export function formatZonedDateTime(value: DateInput, locale: string): string {
	const date = value instanceof Date ? value : new Date(value ?? Number.NaN);
	if (Number.isNaN(date.getTime())) return "–";
	return `${formatDateTimeSeconds(date, locale)} ${zoneLabel(locale, date)}`;
}

/**
 * A `datetime-local` input value for an instant, in the browser's zone: "YYYY-MM-DDTHH:mm". The control
 * has no zone of its own, so the surrounding label names the zone the value is read in.
 */
export function localDateTimeValue(value: Date | number = Date.now()): string {
	const date = value instanceof Date ? value : new Date(value);
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * The UTC instant a `datetime-local` value means in the browser's zone, as an ISO 8601 string, or
 * undefined when the field is empty or malformed. The conversion is the WebUI's job, so crhs never sees a
 * local time or a timezone (`Date` reads the value as local time, which is exactly what the control means).
 */
export function localDateTimeToIso(value: string): string | undefined {
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return undefined;
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}
