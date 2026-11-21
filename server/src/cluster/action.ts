/**
 * The one structured action of a task (doc/design/webui.md "Shared components"): built from the task spec
 * once on the server and carried by the task view and by its approval request, so a task titled "/etc/x"
 * in the Tasks list cannot read "Write file /etc/x" in approvals. `summarize` derives the model-facing and
 * log text from the same action.
 */
import type { TaskAction } from "@crh/api";
import { type TaskSpec, taskSpecFromJson } from "@crh/protocol";
import { shellQuote } from "../util/shell-quote.ts";

/** Commands and paths stay one line; the command itself is capped as the model asks. */
const COMMAND_LIMIT = 300;

function clipCommand(command: string): string {
	const oneLine = command.replace(/[\r\n]+/g, " ").trim();
	return oneLine.length <= COMMAND_LIMIT ? oneLine : `${oneLine.slice(0, COMMAND_LIMIT - 1)}…`;
}

/** The command line of an exec spec: argv shell-quoted, or the shell string as written. */
export function execCommand(spec: Extract<TaskSpec, { kind: "exec" }>): string {
	return "argv" in spec.command ? spec.command.argv.map((arg) => shellQuote(arg)).join(" ") : spec.command.shell;
}

/** The structured action of a readable task spec. */
export function taskActionOfSpec(spec: TaskSpec): TaskAction {
	switch (spec.kind) {
		case "exec":
			return { type: "exec", command: clipCommand(execCommand(spec)) };
		case "file.read":
			return {
				type: "file",
				operation: "read",
				path: spec.path,
				lines: { start: spec.startLine, end: spec.startLine + spec.lineCount - 1 },
			};
		case "file.write":
			return { type: "file", operation: "write", path: spec.path };
		case "file.push":
			return { type: "file", operation: "push", path: spec.path };
		case "file.pull":
			return { type: "file", operation: "pull", path: spec.path };
		case "file.edit":
			return { type: "file", operation: "edit", path: spec.path };
		case "file.stat":
			return { type: "file", operation: "stat", path: spec.path };
		case "file.list":
			return { type: "file", operation: "list", path: spec.path };
		case "node.upgrade":
			return { type: "upgrade", version: spec.version, arch: spec.arch };
	}
}

/**
 * The action of a stored spec JSON, or undefined when it cannot be read. A row stored in an older JSON
 * shape (before a protocol field was added) still names its command or path, so the tolerant reader below
 * keeps such a task displayable instead of turning its title into its kind.
 */
export function taskActionOfJson(specJson: string | null): TaskAction | undefined {
	if (specJson === null) return undefined;
	let raw: unknown;
	try {
		raw = JSON.parse(specJson);
	} catch {
		return undefined;
	}
	try {
		return taskActionOfSpec(taskSpecFromJson(raw));
	} catch {
		return taskActionOfRawJson(raw);
	}
}

function taskActionOfRawJson(value: unknown): TaskAction | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const spec = value as Record<string, unknown>;
	if (spec.kind === "exec") {
		const command = spec.command;
		if (typeof command !== "object" || command === null) return undefined;
		const argv = (command as { argv?: unknown }).argv;
		const shell = (command as { shell?: unknown }).shell;
		if (Array.isArray(argv))
			return { type: "exec", command: clipCommand(argv.map((arg) => shellQuote(String(arg))).join(" ")) };
		if (typeof shell === "string") return { type: "exec", command: clipCommand(shell) };
		return undefined;
	}
	if (typeof spec.path !== "string") return undefined;
	const operation =
		spec.kind === "file.read" ||
		spec.kind === "file.write" ||
		spec.kind === "file.push" ||
		spec.kind === "file.pull" ||
		spec.kind === "file.edit" ||
		spec.kind === "file.stat" ||
		spec.kind === "file.list"
			? (spec.kind.slice("file.".length) as Extract<TaskAction, { type: "file" }>["operation"])
			: undefined;
	if (operation === undefined) return undefined;
	if (operation === "read" && typeof spec.startLine === "number" && typeof spec.lineCount === "number") {
		return {
			type: "file",
			operation,
			path: spec.path,
			lines: { start: spec.startLine, end: spec.startLine + spec.lineCount - 1 },
		};
	}
	return { type: "file", operation, path: spec.path };
}

/** The action and its display summary of a stored spec, parsed once; an unreadable row falls back. */
export function taskActionView(specJson: string | null, fallbackKind: string): { action: TaskAction; summary: string } {
	const action = taskActionOfJson(specJson);
	if (action === undefined) {
		return { action: { type: "exec", command: clipCommand(fallbackKind) }, summary: "" };
	}
	let spec: TaskSpec | undefined;
	try {
		spec = taskSpecFromJson(JSON.parse(specJson ?? "null"));
	} catch {
		spec = undefined;
	}
	return { action, summary: summarizeAction(action, spec) };
}

/** The action of a stored spec, with a displayable fallback for a row whose JSON cannot be read. */
export function taskActionFor(specJson: string | null, fallbackKind: string, fallbackSummary: string): TaskAction {
	return (
		taskActionOfJson(specJson) ?? {
			type: "exec",
			command: clipCommand(fallbackSummary || fallbackKind),
		}
	);
}

/**
 * The model-facing and log text of an action. It derives from the structured action; the transfer details
 * an approver needs (size, digest, byte cap) come from the spec because they are not part of the action line.
 */
export function summarizeAction(action: TaskAction, spec?: TaskSpec): string {
	switch (action.type) {
		case "exec":
			return action.command;
		case "file": {
			if (action.operation === "read" && action.lines !== undefined) {
				return `${action.path} (lines ${action.lines.start}-${action.lines.end})`;
			}
			// A transfer shows what an approver needs to bind: direction, path, size and digest, never
			// the content (doc/design/library.md "File plane").
			if (action.operation === "push" && spec?.kind === "file.push") {
				return `push ${action.path} (${spec.size} bytes, sha256 ${Buffer.from(spec.sha256).toString("hex")})`;
			}
			if (action.operation === "pull" && spec?.kind === "file.pull") {
				return `pull ${action.path} (at most ${spec.maxBytes} bytes)`;
			}
			return action.path;
		}
		case "upgrade":
			// The approver binds the binary by its hash, the same one the release's SHA256SUMS lists.
			if (spec?.kind === "node.upgrade") {
				return `upgrade crha to ${action.version} (${action.arch}, ${spec.size} bytes, sha256 ${Buffer.from(spec.sha256).toString("hex")})`;
			}
			return `upgrade crha to ${action.version} (${action.arch})`;
		case "api_request":
			return `${action.method} ${action.path}`;
		case "extension_tool":
			return `${action.extension}/${action.tool}`;
	}
}
