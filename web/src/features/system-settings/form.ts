import type { FieldPath, FieldValues, UseFormSetError } from "react-hook-form";
import { settingsFieldErrors } from "./api";

/** The shortest retention crhs accepts; a shorter window could race a durable tool call after a crash. */
export const MIN_RETENTION_MS = 24 * 60 * 60 * 1000;

const DURATION_UNITS: Record<string, number> = {
	ms: 1,
	s: 1_000,
	m: 60_000,
	h: 3_600_000,
	d: 86_400_000,
};

/**
 * crhs's duration syntax (`"60s"`, `"5m"`, `"1h30m"`, `"1d12h"`) in milliseconds, or
 * null when the text is not one. Mirrors the server's parser; the server validates again.
 */
export function durationMs(value: string): number | null {
	const text = value.trim();
	if (text === "") return null;
	let total = 0;
	let offset = 0;
	for (const match of text.matchAll(/(\d+)(ms|s|m|h|d)/g)) {
		if (match.index !== offset) return null;
		total += Number(match[1]) * (DURATION_UNITS[match[2] as string] as number);
		offset = match.index + match[0].length;
	}
	return offset === text.length ? total : null;
}

/** Whether `value` is a duration of at least one day, the retention minimum. */
export function isRetentionDuration(value: string): boolean {
	const ms = durationMs(value);
	return ms !== null && ms >= MIN_RETENTION_MS;
}

/** An absolute http(s) URL, the shape `publicUrl` accepts. */
export function isHttpUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return (url.protocol === "http:" || url.protocol === "https:") && value.trim() === value;
	} catch {
		return false;
	}
}

/** An HTTP header name, the shape `realIpHeader` accepts. */
export function isHeaderName(value: string): boolean {
	return /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(value);
}

/** An allowed WebAuthn origin: exactly `scheme://host[:port]`, without a path. */
export function isOrigin(value: string): boolean {
	try {
		return new URL(value).origin === value;
	} catch {
		return false;
	}
}

/**
 * Applies a settings validation failure to the matching form fields and returns the
 * error to show above the form: the whole error when it has no field to belong to
 * (or some of its fields are unknown), undefined when every message is inline.
 */
export function applyServerFieldErrors<T extends FieldValues>(
	error: unknown,
	setError: UseFormSetError<T>,
	fieldMap: Partial<Record<string, FieldPath<T>>>,
): unknown | undefined {
	const fields = settingsFieldErrors(error);
	const entries = Object.entries(fields);
	if (entries.length === 0) return error;
	let unmapped = false;
	for (const [key, message] of entries) {
		const field = fieldMap[key];
		if (field === undefined) {
			unmapped = true;
			continue;
		}
		setError(field, { type: "server", message });
	}
	return unmapped ? error : undefined;
}
