import type { Operation, Rule, TaskView } from "./api.ts";

const TERMINAL = new Set(["exited", "failed", "rejected", "unknown", "denied"]);

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

/** How a task's kept output is shown: full head/tail, one combined tail, or only the node's file. */
export type BatchOutput =
	| { kind: "full" }
	| { kind: "tail"; text: string; bytes: number }
	| { kind: "status"; file: string | null };

/** Interprets the head/tail fields by the task's output mode (doc/execution-plane.md#输出). */
export function batchOutput(
	t: Pick<TaskView, "outputMode" | "stdoutTail" | "stdoutBytes" | "stderrBytes" | "outputFile">,
): BatchOutput {
	if (t.outputMode === "text") return { kind: "tail", text: t.stdoutTail, bytes: t.stdoutBytes + t.stderrBytes };
	if (t.outputMode === "status") return { kind: "status", file: t.outputFile };
	return { kind: "full" };
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

/** Splits a comma/whitespace separated list, dropping empties and duplicates. */
export function parseList(s: string): string[] {
	return [...new Set(s.split(/[\s,]+/).filter(Boolean))];
}

/** Batch targets: checked node names, plus free-text groups ("web" or "group:web") and raw targets. */
export function buildTargets(nodeNames: string[], extra: string): string[] {
	return [...new Set([...nodeNames, ...parseList(extra)])];
}

/** The task's origin: the user it acted for (resolved via the directory), else the actor. */
export function taskActor(t: TaskView, userName: (id: string) => string | undefined): string {
	if (t.onBehalfOfUserId) return userName(t.onBehalfOfUserId) ?? t.onBehalfOfUserId;
	return `${t.actorType} ${t.actorId}`;
}

/** POSIX single quoting as the server renders command lines: plain words stay bare. */
export function shellQuote(s: string): string {
	return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`;
}

/** The allow rule offered by "Approve and always allow", from the operation the server reports. */
export function alwaysRule(
	op: Operation | null | undefined,
	nodes: string[],
	mode: "exact" | "prefix",
): Rule | undefined {
	if (!op) return undefined;
	return { action: "allow", method: op.method, nodes, [mode]: op.target };
}

export function actorLabel(type: string, id: string, tokenNames: Map<string, string>): string {
	return type === "api_token" ? `API token ${tokenNames.get(id) ?? id}` : `${type} ${id}`;
}

export function tokenStatus(t: { revokedAt: string | null; expiresAt: string | null }, now = Date.now()) {
	if (t.revokedAt) return "revoked";
	if (t.expiresAt && new Date(t.expiresAt).getTime() <= now) return "expired";
	return "active";
}

export function mcpCommand(origin: string, token: string): string {
	return `claude mcp add --transport http crh ${origin}/mcp --header "Authorization: Bearer ${token}"`;
}
