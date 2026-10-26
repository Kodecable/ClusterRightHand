import type { TaskView } from "./api.ts";

const TERMINAL = new Set(["exited", "failed", "rejected", "unknown"]);

export function isTerminal(state: string): boolean {
	return TERMINAL.has(state);
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export interface JoinedOutput {
	text: string;
	/** Bytes dropped between head and tail; 0 when nothing is missing. */
	omitted: number;
}

/**
 * Combines the stored head and tail of an output stream. `omitted > 0` means a gap sits between them;
 * the caller renders the marker. Overlapping head and tail (short outputs) are de-duplicated.
 */
export function joinOutput(
	head: string,
	tail: string,
	totalBytes: number,
): { before: string; after: string; omitted: number } {
	const h = enc.encode(head);
	if (tail === "" || tail === head) return { before: head, after: "", omitted: Math.max(0, totalBytes - h.length) };
	const t = enc.encode(tail);
	const gap = totalBytes - h.length - t.length;
	if (gap > 0) return { before: head, after: tail, omitted: gap };
	// Overlap: the tail's first -gap bytes were already in the head.
	return { before: head, after: dec.decode(t.slice(Math.min(t.length, -gap))), omitted: 0 };
}

export function outputText(head: string, tail: string, totalBytes: number): string {
	const j = joinOutput(head, tail, totalBytes);
	return j.omitted > 0 ? `${j.before}\n… ${j.omitted} bytes omitted …\n${j.after}` : j.before + j.after;
}

export function taskOutcome(t: TaskView): string {
	if (t.state === "exited") {
		if (t.timedOut) return "timed out";
		if (t.cancelled) return "cancelled";
		if (t.signal) return `signal ${t.signal}`;
		return `exit ${t.exitCode ?? "?"}`;
	}
	if (t.errorCode) return `${t.errorCode}${t.errorMessage ? `: ${t.errorMessage}` : ""}`;
	return t.state;
}

export function formatTime(iso: string | null): string {
	if (!iso) return "-";
	const d = new Date(iso);
	return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

/** Splits a command line into argv: whitespace separated, with single/double quotes and backslash escapes. */
export function splitArgv(line: string): string[] {
	const out: string[] = [];
	let cur = "";
	let quote: string | null = null;
	let has = false;
	for (let i = 0; i < line.length; i++) {
		const c = line[i] as string;
		if (quote) {
			if (c === quote) quote = null;
			else if (c === "\\" && quote === '"' && i + 1 < line.length) cur += line[++i];
			else cur += c;
		} else if (c === '"' || c === "'") {
			quote = c;
			has = true;
		} else if (c === "\\" && i + 1 < line.length) {
			cur += line[++i];
			has = true;
		} else if (/\s/.test(c)) {
			if (has || cur) out.push(cur);
			cur = "";
			has = false;
		} else {
			cur += c;
		}
	}
	if (has || cur) out.push(cur);
	return out;
}

export function osName(facts: Record<string, unknown> | null): string {
	const v = facts?.osPrettyName;
	return typeof v === "string" && v ? v : "-";
}

export function enrollCommand(origin: string, token: string): string {
	return `crha enroll ${origin} ${token}`;
}
