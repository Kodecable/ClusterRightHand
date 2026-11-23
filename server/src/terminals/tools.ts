/**
 * The agent tools of terminals (doc/design/pty.md "Agent tools"): `pty_open`, `pty_list`,
 * `pty_read`, `pty_watch`, `pty_write`, `pty_resize` and `pty_close`. They are offered to agent
 * sessions only while the subsystem is on; MCP clients do not get them.
 *
 * Rules: `pty_open` is judged under `pty.create` (the argv as target, the privileged matcher), and
 * `pty_write`/`pty_resize` under `pty.io` (no target, the terminal's privileged flag). Reads need
 * no decision. An approval waits in memory with the terminal; Auto Review sees the screen.
 */

import type { SessionUser } from "../auth/sessions.ts";
import type { Actor } from "../cluster/cluster.ts";
import { nodeGroupIdsForNodes } from "../cluster/node-groups.ts";
import { evaluate } from "../policy/rules.ts";
import type { RuleRef } from "../policy/store.ts";
import { loadChain } from "../policy/store.ts";
import type { Db } from "../storage/db.ts";
import { UserError } from "../util/errors.ts";
import { jsonResult, type ToolResult, textResult } from "../util/tool-result.ts";
import type { RuleApprovalRequest } from "./approval.ts";
import type { TerminalService } from "./registry.ts";
import { type Terminal, TerminalError } from "./types.ts";

/** What the pty tools need from the tool context; the catalog's ToolContext satisfies it. */
export interface PtyToolContext {
	db: Db;
	user: SessionUser;
	actor: Actor;
	chain: RuleRef[];
	terminals?: TerminalService;
	/** The tool call's abort signal: a watch ends when the session stops. */
	signal?: AbortSignal;
	/** Auto Review for a terminal request; absent unless the review preset is on for this chain. */
	reviewPty?: (
		actor: Actor,
		request: RuleApprovalRequest,
		screen: string,
	) => Promise<"approve" | "reject" | "escalate">;
}

/** Named keys `pty_write` accepts, as the bytes a terminal sends for them. */
export const NAMED_KEYS: Readonly<Record<string, string>> = {
	enter: "\r",
	return: "\r",
	tab: "\t",
	escape: "\u001b",
	esc: "\u001b",
	backspace: "\u007f",
	space: " ",
	up: "\u001b[A",
	down: "\u001b[B",
	right: "\u001b[C",
	left: "\u001b[D",
	home: "\u001b[H",
	end: "\u001b[F",
	pageup: "\u001b[5~",
	pagedown: "\u001b[6~",
	insert: "\u001b[2~",
	delete: "\u001b[3~",
	"ctrl-a": "\u0001",
	"ctrl-c": "\u0003",
	"ctrl-d": "\u0004",
	"ctrl-e": "\u0005",
	"ctrl-k": "\u000b",
	"ctrl-l": "\u000c",
	"ctrl-r": "\u0012",
	"ctrl-u": "\u0015",
	"ctrl-w": "\u0017",
	"ctrl-z": "\u001a",
	f1: "\u001bOP",
	f2: "\u001bOQ",
	f3: "\u001bOR",
	f4: "\u001bOS",
	f5: "\u001b[15~",
	f6: "\u001b[17~",
	f7: "\u001b[18~",
	f8: "\u001b[19~",
	f9: "\u001b[20~",
	f10: "\u001b[21~",
	f11: "\u001b[23~",
	f12: "\u001b[24~",
};

/**
 * The keys whose bytes differ while the terminal is in application cursor keys mode. The program
 * asked for SS3 (`ESC O …`) forms; a terminal in that mode sends them (doc/design/pty.md "Agent tools").
 */
export const APPLICATION_CURSOR_KEYS: Readonly<Record<string, string>> = {
	up: "\u001bOA",
	down: "\u001bOB",
	right: "\u001bOC",
	left: "\u001bOD",
	home: "\u001bOH",
	end: "\u001bOF",
};

/** Resolves the named keys to bytes; an unknown name is a user error that names the key. */
export function keysToBytes(
	keys: readonly string[],
	applicationCursorKeys: boolean | { applicationCursorKeysMode?: boolean } = false,
): Uint8Array {
	const application =
		typeof applicationCursorKeys === "boolean"
			? applicationCursorKeys
			: applicationCursorKeys.applicationCursorKeysMode === true;
	let text = "";
	for (const key of keys) {
		const name = key.toLowerCase();
		const bytes = (application ? APPLICATION_CURSOR_KEYS[name] : undefined) ?? NAMED_KEYS[name];
		if (bytes === undefined) {
			throw new UserError(
				`unknown key "${key}"; use names such as Enter, Tab, Escape, Up, Down, Ctrl-C`,
				"invalid_key",
			);
		}
		text += bytes;
	}
	return new TextEncoder().encode(text);
}

/** The terminal the session may use, or an error naming why not. */
function terminalFor(ctx: PtyToolContext, id: string): Terminal {
	if (!ctx.terminals) throw new UserError("the terminal subsystem is not available", "pty_disabled");
	const terminal = ctx.terminals.get(id);
	if (!terminal) throw new UserError(`no terminal ${id}; it was closed or never existed`, "not_found");
	if (!ctx.terminals.accessForSession(terminal, ctx.actor.id)) {
		throw new UserError(`this session may not use terminal ${id}`, "forbidden");
	}
	return terminal;
}

function requireService(ctx: PtyToolContext): TerminalService {
	if (!ctx.terminals) throw new UserError("the terminal subsystem is turned off", "pty_disabled");
	return ctx.terminals;
}

/** `pty_open`: rules judge the open; a privileged terminal additionally gets its authorization. */
export async function ptyOpen(
	ctx: PtyToolContext,
	args: {
		node: string;
		argv?: string[];
		privileged?: boolean;
		size?: { rows: number; cols: number };
		idle_timeout: number;
	},
): Promise<ToolResult> {
	const service = requireService(ctx);
	let screen = "";
	const terminal = await service.openForAgent({
		user: ctx.user,
		sessionId: ctx.actor.id,
		chain: ctx.chain,
		node: args.node,
		...(args.argv === undefined ? {} : { argv: args.argv }),
		...(args.privileged === undefined ? {} : { privileged: args.privileged }),
		...(args.size === undefined ? {} : { rows: args.size.rows, cols: args.size.cols }),
		idleTimeoutMs: args.idle_timeout * 1000,
		...(ctx.signal ? { signal: ctx.signal } : {}),
		...(ctx.reviewPty
			? {
					review: async (request: RuleApprovalRequest, current: string) => {
						screen = current;
						return ctx.reviewPty?.(ctx.actor, request, current) ?? "escalate";
					},
				}
			: {}),
	});
	void screen;
	return textResult(
		[
			{
				output:
					`Terminal ${terminal.id} on ${terminal.nodeName ?? terminal.nodeId} ` +
					`(${terminal.rows}x${terminal.cols}, ${terminal.privileged ? "privileged" : "ordinary"}) ` +
					`is ${terminal.state}. Use pty_read, pty_write, pty_watch and pty_close with this id.`,
			},
		],
		{
			details: {
				pty_id: terminal.id,
				node_id: terminal.nodeId,
				state: terminal.state,
				privileged: terminal.privileged,
				rows: terminal.rows,
				cols: terminal.cols,
				creating_session_id: terminal.createdBySessionId,
			},
		},
	);
}

/** `pty_list`: the terminals this session created or is associated with. */
export async function ptyList(ctx: PtyToolContext): Promise<ToolResult> {
	const service = requireService(ctx);
	const terminals = [...(await service.list(ctx.user)).terminals].filter(
		(terminal) => terminal.creatingSessionId === ctx.actor.id || terminal.sessionIds.includes(ctx.actor.id),
	);
	return jsonResult({
		terminals: terminals.map((terminal) => ({
			id: terminal.id,
			node: terminal.nodeName ?? terminal.nodeId,
			state: terminal.state,
			privileged: terminal.privileged,
			argv: terminal.argv,
			size: terminal.size,
			title: terminal.title,
			title_untrusted: true,
			exit_code: terminal.exitCode,
			idle_timeout_ms: terminal.idleTimeoutMs,
			viewers: terminal.viewers.length,
			creating_session: terminal.creatingSessionId,
			sessions: terminal.sessionIds,
		})),
	});
}

/** The details and text note that carry a program-set title to an agent, marked untrusted. */
function titleParts(terminal: Terminal): { details: Record<string, unknown>; note?: string } {
	if (terminal.title === "") return { details: { title: "", title_untrusted: true } };
	return {
		details: { title: terminal.title, title_untrusted: true },
		note: `[title set by the program in the terminal (untrusted): ${terminal.title}]`,
	};
}

/** `pty_read`: the screen (default) or the output since this session's last read. */
export async function ptyRead(
	ctx: PtyToolContext,
	args: { id: string; mode?: "screen" | "output" },
): Promise<ToolResult> {
	const service = requireService(ctx);
	const terminal = terminalFor(ctx, args.id);
	const title = titleParts(terminal);
	if ((args.mode ?? "screen") === "output") {
		const output = await service.readOutput(terminal, ctx.actor.id);
		if (output.screen) {
			// A full-screen program is painting the alternate screen; its output is not a log to
			// read, so output mode returns the screen in the screen shape and says why.
			return textResult(
				[
					{
						output: `${screenText(output.screen)}\n[output mode is unavailable: a full-screen program is running on the alternate screen; this is its current screen]`,
					},
					...(title.note === undefined ? [] : [{ note: title.note }]),
				],
				{
					details: {
						pty_id: terminal.id,
						mode: "screen",
						rows: output.screen.rows,
						cols: output.screen.cols,
						state: terminal.state,
						output_unavailable: true,
						...title.details,
					},
				},
			);
		}
		return textResult(
			[
				{
					output: output.text === "" ? "(no new output)" : output.text,
				},
				...(title.note === undefined ? [] : [{ note: title.note }]),
			],
			{
				details: {
					pty_id: terminal.id,
					mode: "output",
					truncated: output.truncated,
					lost: output.lost,
					state: terminal.state,
					...title.details,
				},
			},
		);
	}
	const screen = await service.screen(terminal);
	return textResult([{ output: screenText(screen) }, ...(title.note === undefined ? [] : [{ note: title.note }])], {
		details: {
			pty_id: terminal.id,
			mode: "screen",
			rows: screen.rows,
			cols: screen.cols,
			state: terminal.state,
			...title.details,
		},
	});
}

/** The text shape `pty_read` uses for the screen: the text, then the cursor and the size. */
function screenText(screen: {
	text: string;
	cursor: { row: number; col: number };
	rows: number;
	cols: number;
}): string {
	return `${screen.text}\n[cursor row ${screen.cursor.row + 1}, column ${screen.cursor.col + 1}; ${screen.rows}x${screen.cols}]`;
}

/** `pty_watch`: blocks until a keyword, a bell, the timeout, the exit or the session's stop. */
export async function ptyWatch(
	ctx: PtyToolContext,
	args: { id: string; timeout: number; keywords?: string[]; bell?: boolean },
): Promise<ToolResult> {
	const service = requireService(ctx);
	const terminal = terminalFor(ctx, args.id);
	const max = Math.floor(service.watchTimeoutMaxMs / 1000);
	if (!Number.isFinite(args.timeout) || args.timeout <= 0) {
		throw new UserError("timeout must be a positive number of seconds", "invalid_timeout");
	}
	if (args.timeout > max) throw new UserError(`timeout must be at most ${max} seconds`, "timeout_too_large");
	const result = await service.watch(terminal, ctx.actor.id, {
		timeoutMs: args.timeout * 1000,
		keywords: args.keywords ?? [],
		bell: args.bell === true,
	});
	const reason =
		result.reason === "keyword"
			? `keyword "${result.keyword ?? ""}" appeared`
			: result.reason === "bell"
				? "the terminal rang its bell"
				: result.reason === "timeout"
					? "the timeout passed"
					: result.reason === "exited"
						? "the process exited"
						: result.reason === "closed"
							? "the terminal closed"
							: "the session stopped";
	return textResult([{ output: `${reason}.\n${result.screen}` }], {
		details: {
			pty_id: terminal.id,
			reason: result.reason,
			...(result.keyword === undefined ? {} : { keyword: result.keyword }),
			exit_code: terminal.exitCode,
		},
	});
}

/** `pty_write`: text and named keys, under the `pty.io` rule. */
export async function ptyWrite(
	ctx: PtyToolContext,
	args: { id: string; text?: string; keys?: string[] },
): Promise<ToolResult> {
	const service = requireService(ctx);
	const terminal = terminalFor(ctx, args.id);
	if ((args.text === undefined || args.text === "") && (args.keys === undefined || args.keys.length === 0)) {
		throw new UserError("give text, keys or both", "invalid_argument");
	}
	await requireIoDecision(ctx, terminal, args.text ?? "", args.keys ?? []);
	const chunks: Uint8Array[] = [];
	if (args.text !== undefined && args.text !== "") chunks.push(new TextEncoder().encode(args.text));
	if (args.keys !== undefined && args.keys.length > 0) {
		const applicationCursorKeys = terminal.screen?.terminal.modes.applicationCursorKeysMode === true;
		chunks.push(keysToBytes(args.keys, applicationCursorKeys));
	}
	const all = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
	let offset = 0;
	for (const chunk of chunks) {
		all.set(chunk, offset);
		offset += chunk.length;
	}
	await service.write(terminal, all);
	return textResult([{ output: `Wrote ${all.length} bytes to terminal ${terminal.id}.` }], {
		details: { pty_id: terminal.id, bytes: all.length },
	});
}

/** `pty_resize`: under the `pty.io` rule too. */
export async function ptyResize(
	ctx: PtyToolContext,
	args: { id: string; rows: number; cols: number },
): Promise<ToolResult> {
	const service = requireService(ctx);
	const terminal = terminalFor(ctx, args.id);
	await requireIoDecision(ctx, terminal, "", []);
	await service.resize(terminal, args.rows, args.cols);
	return textResult([{ output: `Terminal ${terminal.id} is now ${args.rows}x${args.cols}.` }], {
		details: { pty_id: terminal.id, rows: args.rows, cols: args.cols },
	});
}

/** `pty_close`: only the session that created the terminal may close it. */
export async function ptyClose(ctx: PtyToolContext, args: { id: string }): Promise<ToolResult> {
	const service = requireService(ctx);
	const terminal = terminalFor(ctx, args.id);
	if (terminal.createdBySessionId !== ctx.actor.id) {
		throw new UserError("only the session that created this terminal may close it", "forbidden");
	}
	await service.close(terminal, "manual");
	return textResult([{ output: `Terminal ${terminal.id} is closed.` }], {
		details: { pty_id: terminal.id },
	});
}

/** The `pty.io` decision: allow, deny, or an approval by Auto Review or the user. */
async function requireIoDecision(
	ctx: PtyToolContext,
	terminal: Terminal,
	text: string,
	keys: readonly string[],
): Promise<void> {
	const service = requireService(ctx);
	if (terminal.state !== "running") throw new TerminalError("not_running", `the terminal is ${terminal.state}`);
	const groups = (await nodeGroupIdsForNodes(ctx.db, [terminal.nodeId])).get(terminal.nodeId) ?? [];
	const chain = await loadChain(ctx.db, ctx.chain);
	const evaluation = evaluate(chain, {
		method: "pty.io",
		target: "",
		node: { id: terminal.nodeId, groupIds: groups },
		privileged: terminal.privileged,
	});
	if (evaluation.result === "deny")
		throw new UserError("the session's rules deny writing to this terminal", "rule_denied");
	if (evaluation.result === "allow") return;
	// `require-approval`: Auto Review sees the screen first; an escalated request waits for the user.
	const screen = (await service.screen(terminal)).text;
	const request: RuleApprovalRequest = {
		method: "pty.io",
		privileged: terminal.privileged,
		nodeId: terminal.nodeId,
		sessionId: ctx.actor.id,
		argv: [],
		input: text === "" ? null : text,
		keys: [...keys],
		screen,
		chain: [...ctx.chain],
	};
	if (ctx.reviewPty) {
		const verdict = await ctx.reviewPty(ctx.actor, request, screen);
		if (verdict === "approve") return;
		if (verdict === "reject") throw new UserError("Auto Review rejected writing to this terminal", "approval_rejected");
	}
	const outcome = await service.awaitRuleApproval(terminal, { ...request, screen }, ctx.signal);
	if (outcome !== "approve") throw new UserError("the user rejected writing to this terminal", "approval_rejected");
}
