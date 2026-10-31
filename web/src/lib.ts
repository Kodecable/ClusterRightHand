import type { CredentialView, Operation, Rule, TaskView } from "./api.ts";

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

/**
 * The line under a status-mode result that has no output file. A task that ran has its output only on the
 * node (or nowhere, for SSH); a task that never ran has no output to explain.
 */
export function statusOutputNote(t: Pick<TaskView, "state" | "exitCode" | "signal">): string {
	if (!isTerminal(t.state)) return "the full output stays on the node until the task exits.";
	if (t.exitCode === null && t.signal === null) return "no output was kept.";
	return "no output is kept (SSH nodes keep no output).";
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

/**
 * What the approvals page and the header count as pending: the requests this user must approve, the
 * tasks and task groups waiting for its signature, and roots whose token quota is used up. A group
 * waiting for a signature is one entry, not one per member task (doc/privilege.md).
 */
interface PendingLists {
	tasks: readonly unknown[];
	taskGroups: readonly unknown[];
	authorizations: { tasks: readonly unknown[]; taskGroups: readonly unknown[] };
	quotas: readonly unknown[];
}

export function pendingCount(data: PendingLists | undefined): number {
	if (!data) return 0;
	return (
		data.tasks.length +
		data.taskGroups.length +
		data.authorizations.tasks.length +
		data.authorizations.taskGroups.length +
		data.quotas.length
	);
}

/** A token amount a user typed in a quota field; an empty field means unlimited (doc/agent-runtime.md#配额). */
export type QuotaInput = { quota: number | null } | { error: string };

export function parseQuotaInput(text: string): QuotaInput {
	const trimmed = text.trim();
	if (trimmed === "") return { quota: null };
	if (!/^\d+$/.test(trimmed)) return { error: "enter a whole number of tokens, or leave it empty for unlimited" };
	const quota = Number(trimmed);
	if (!Number.isSafeInteger(quota)) return { error: "that number is too large" };
	return { quota };
}

/** One line for a session's remaining quota against what it has used (doc/agent-runtime.md#配额). */
export function quotaSummary(quota: number | null, used: number): string {
	const spent = `${used.toLocaleString("en-US")} used`;
	if (quota === null) return `unlimited quota · ${spent}`;
	if (quota <= 0) return `quota used up (${Math.abs(quota).toLocaleString("en-US")} over) · ${spent}`;
	return `${quota.toLocaleString("en-US")} tokens left · ${spent}`;
}

/** What a grant field must hold: a positive number of tokens to add. */
export function parseGrantInput(text: string): { tokens: number } | { error: string } {
	const parsed = parseQuotaInput(text);
	if ("error" in parsed) return parsed;
	if (parsed.quota === null || parsed.quota <= 0) return { error: "enter a positive number of tokens to add" };
	return { tokens: parsed.quota };
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

/**
 * The allow rule offered by "Approve and always allow", from the operation the server reports. It carries
 * the task's `privileged` value, so that allowing a privileged call does not also allow ordinary ones
 * (doc/access-control.md#规则).
 */
export function alwaysRule(
	op: Operation | null | undefined,
	nodes: string[],
	mode: "exact" | "prefix",
	privileged: boolean,
): Rule | undefined {
	if (!op) return undefined;
	return { action: "allow", method: op.method, nodes, privileged, [mode]: op.target };
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

/** A TOML basic string; the only characters that need escaping are the quote and the backslash. */
export function tomlString(value: string): string {
	return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/** Standard base64 to the unpadded base64url the node's trust config uses for COSE keys. */
function toBase64url(base64: string): string {
	return base64.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/**
 * The `[[trust]]` block for a node's privileged.toml that trusts crhs's signing key
 * (doc/privilege.md#信任配置). The allow/deny lists are examples: the operator narrows them to what
 * crhs may do on that node, and denying `/etc/crha/` keeps crhs out of the trust configuration.
 */
export function trustSnippet(authorizedKey: string): string {
	return [
		"[[trust]]",
		'name          = "crhs"',
		'role          = "crhs"',
		'format        = "sshsig"',
		`key           = ${tomlString(authorizedKey)}`,
		'kinds         = ["execute", "cosign"]',
		"require_exact = true",
		'max_ttl       = "5m"',
		"",
		"# Allow the commands crhs may authorize on this node.",
		"allow = [",
		'\t{ method = "exec", prefix = "systemctl restart " },',
		'\t{ method = "file.read", prefix = "/var/log/" },',
		"]",
		"",
		"# crhs must not be able to change this node's privileged configuration.",
		"deny = [",
		'\t{ method = "file.write", prefix = "/etc/crha/" },',
		"]",
		"",
	].join("\n");
}

/**
 * The `[[trust]]` block for an SSH key or Passkey the user registered (doc/privilege.md#信任配置,
 * doc/m4.md M4.4). The allow and deny lists are examples to narrow: the owner edits them on the node
 * before the credential can authorize anything. `require_uv` and `max_ttl` are commented out because
 * they are policy choices, not defaults.
 */
export function credentialTrustSnippet(credential: CredentialView): string {
	const lines = ["[[trust]]", `name          = ${tomlString(credential.name)}`, 'role          = "user"'];
	if (credential.kind === "ssh") {
		lines.push('format        = "sshsig"', `key           = ${tomlString(credential.publicKey)}`);
	} else {
		lines.push(
			'format        = "webauthn"',
			`rp_id         = ${tomlString(credential.rpId ?? "")}`,
			`origins       = [${credential.origins.map(tomlString).join(", ")}]`,
			`credential_id = ${tomlString(credential.credentialId ?? "")}`,
			`key           = ${tomlString(`cose:${toBase64url(credential.publicKey)}`)}`,
		);
	}
	lines.push(
		'kinds         = ["execute"]',
		"",
		credential.kind === "ssh"
			? "# Require user verification (a FIDO touch with PIN); only sk-* SSH keys can assert it."
			: "# Require user verification (a PIN or biometrics) for this credential.",
		"# require_uv = true",
		"# Longest lifetime a signature of this credential may have; omit for no limit.",
		'# max_ttl   = "24h"',
		"",
		"# What this credential may authorize on this node: narrow it before trusting the key.",
		"allow = [",
		'\t{ method = "exec", prefix = "systemctl restart " },',
		"]",
		"deny = [",
		'\t{ method = "file.write", prefix = "/etc/crha/" },',
		"]",
		"",
	);
	return lines.join("\n");
}
