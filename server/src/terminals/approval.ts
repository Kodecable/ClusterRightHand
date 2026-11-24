/**
 * The rule approvals of the terminal subsystem (doc/design/pty.md "Rules"): an agent's `pty_open`,
 * `pty_write` or `pty_resize` judged `require-approval` waits in memory with the terminal until the
 * user answers or Auto Review does. The always-allow candidates are built here from the request and
 * the session's rule chain root, in the same shape every other approval surface uses, and only when
 * appending one to the root would end the approval (doc/design/access-control.md "Approvals").
 */
import type { ApprovalAlwaysAllow, PtyApproval, Rule } from "@crh/api";
import { alwaysRuleLifts } from "../approvals/always-allow.ts";
import type { RuleRef } from "../policy/store.ts";
import type { Db } from "../storage/db.ts";
import { newId } from "../util/id.ts";
import { shellQuote } from "../util/shell-quote.ts";
import type { ApprovalOutcome, TerminalApproval } from "./types.ts";

/** The request one approval waits on. */
export interface RuleApprovalRequest {
	method: "pty.create" | "pty.io";
	privileged: boolean;
	nodeId: string;
	/** The session whose tool call asked; its root is the request's source. */
	sessionId: string;
	/** pty.create: the argv the terminal would run. */
	argv: string[];
	/** pty.io: the text the agent would type. */
	input: string | null;
	/** pty.io: the named keys the agent would send. */
	keys: string[];
	/** The screen at the time of the request, clipped. */
	screen: string;
	/** The whole rule chain that judged the request: an "always allow" rule is appended to its root. */
	chain: RuleRef[];
	attempt?: number;
}

/** The argv rendered canonically, as rules and authorizations match it; an empty argv renders as "". */
export function canonicalArgv(argv: readonly string[]): string {
	return argv.map((arg) => shellQuote(arg)).join(" ");
}

/** The stored approval view of a request, with the always-allow candidates its page renders. */
export function approvalView(request: RuleApprovalRequest, alwaysAllow: ApprovalAlwaysAllow[]): PtyApproval {
	return {
		id: newId(),
		method: request.method,
		privileged: request.privileged,
		argv: [...request.argv],
		input: request.input === null ? null : clip(request.input, 2000),
		keys: [...request.keys],
		createdAt: new Date().toISOString(),
		...(request.attempt === undefined ? {} : { attempt: request.attempt }),
		alwaysAllow,
	};
}

/** An in-memory approval with its settlement callback and the rule chain it belongs to. */
export interface PendingApproval extends TerminalApproval {
	readonly chain: RuleRef[];
}

/** Creates the approval the terminal stores; the caller resolves it through `resolve`. */
export function pendingApproval(
	request: RuleApprovalRequest,
	alwaysAllow: ApprovalAlwaysAllow[],
	resolve: (outcome: ApprovalOutcome) => void,
): PendingApproval {
	return {
		...approvalView(request, alwaysAllow),
		sessionId: request.sessionId,
		chain: [...request.chain],
		resolve,
	};
}

/** The operation an always rule is tested against: the argv for pty.create, the untargeted pty.io. */
export function approvalOperation(request: { method: "pty.create" | "pty.io"; argv: readonly string[] }): {
	method: "pty.create" | "pty.io";
	target: string;
} {
	return { method: request.method, target: request.method === "pty.create" ? canonicalArgv(request.argv) : "" };
}

/**
 * The "always allow" candidates of one request that would end it: on pty.create, the argv as an exact
 * target; on pty.io, `allow pty.io` for that node and privileged flag (the method has no target). A
 * candidate a lower level or a stricter root rule would still hold is left out.
 */
export async function alwaysAllowCandidates(db: Db, request: RuleApprovalRequest): Promise<ApprovalAlwaysAllow[]> {
	const rule: Rule = {
		action: "allow",
		method: request.method,
		nodes: [request.nodeId],
		privileged: request.privileged,
		...(request.method === "pty.create" ? { exact: canonicalArgv(request.argv) } : {}),
	};
	const candidate: ApprovalAlwaysAllow = {
		option: request.method === "pty.create" ? "exact" : "request",
		rule,
	};
	const lifts = await alwaysRuleLifts(
		db,
		request.chain,
		approvalOperation(request),
		request.privileged,
		[request.nodeId],
		rule,
	);
	return lifts ? [candidate] : [];
}

/** Clips a string to `max` characters, marking the cut. */
export function clip(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
