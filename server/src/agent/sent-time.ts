/**
 * The time a user message was sent, as the model reads it (doc/design/agent-runtime.md "Message time"). The text is
 * made once at submission and stored as the message's last text block, so the transcript, every later request
 * and the prompt cache see the same bytes. The time zone appears only with the time, never in the system prompt.
 */

/** Where the time zone came from: the sender (the WebUI's browser), the schedule, or the server. */
export type TimeZoneSource = "user" | "schedule" | "server";

export interface SentTimeZone {
	zone: string;
	source: TimeZoneSource;
}

/** The longest time zone name accepted from a request; IANA names are far shorter. */
const MAX_TIME_ZONE_LENGTH = 64;

/** The server process's time zone (the `TZ` environment variable or the system setting). */
export function serverTimeZone(): string {
	return new Intl.DateTimeFormat("en-US").resolvedOptions().timeZone;
}

/** An IANA time zone name the runtime knows, or null for anything else. */
export function validTimeZone(value: unknown): string | null {
	if (typeof value !== "string" || value === "" || value.length > MAX_TIME_ZONE_LENGTH) return null;
	try {
		return new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone;
	} catch {
		return null;
	}
}

/** The sender's time zone when it is valid, else the server's. */
export function senderTimeZone(value: unknown): SentTimeZone {
	const zone = validTimeZone(value);
	return zone === null ? { zone: serverTimeZone(), source: "server" } : { zone, source: "user" };
}

const SOURCE_TEXT: Record<TimeZoneSource, string> = {
	user: "the user's time zone",
	schedule: "the schedule's time zone",
	server: "the server's time zone",
};

/** `[Sent 2026-11-19 19:30, Thursday, Asia/Shanghai (UTC+08:00), the user's time zone]`. */
export function sentTimeText(at: Date, timeZone: SentTimeZone): string {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: timeZone.zone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		weekday: "long",
		hourCycle: "h23",
		timeZoneName: "longOffset",
	}).formatToParts(at);
	const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
	// "GMT+08:00", or "GMT" for a zero offset.
	const gmt = part("timeZoneName");
	const offset = gmt === "GMT" ? "UTC+00:00" : gmt.replace(/^GMT/, "UTC");
	const date = `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}`;
	return `[Sent ${date}, ${part("weekday")}, ${timeZone.zone} (${offset}), ${SOURCE_TEXT[timeZone.source]}]`;
}

/** The model content of a user message: its blocks (or its text) followed by the sent-time block. */
export function withSentTime(
	content: string | readonly { type: "text"; text: string }[],
	at: Date,
	timeZone: SentTimeZone,
): { type: "text"; text: string }[] {
	const blocks = typeof content === "string" ? [{ type: "text" as const, text: content }] : [...content];
	return [...blocks, { type: "text", text: sentTimeText(at, timeZone) }];
}
