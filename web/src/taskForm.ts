import type { TaskRequest } from "./api.ts";
import { splitArgv } from "./lib.ts";

export const KINDS = ["exec", "file.read", "file.write", "file.edit", "file.stat", "file.list"] as const;
export type Kind = (typeof KINDS)[number];

export interface TaskForm {
	kind: Kind;
	execMode: "shell" | "argv";
	command: string;
	cwd: string;
	stdin: string;
	path: string;
	offset: string;
	limit: string;
	content: string;
	overwrite: boolean;
	oldText: string;
	newText: string;
	timeoutSec: string;
}

export const emptyForm: TaskForm = {
	kind: "exec",
	execMode: "shell",
	command: "",
	cwd: "",
	stdin: "",
	path: "",
	offset: "",
	limit: "",
	content: "",
	overwrite: false,
	oldText: "",
	newText: "",
	timeoutSec: "",
};

function num(s: string, what: string): number | undefined {
	if (s.trim() === "") return undefined;
	const n = Number(s);
	if (!Number.isSafeInteger(n) || n < 0) throw new Error(`${what} must be a non-negative integer`);
	return n;
}

/** Builds the POST body; throws an Error with a user-facing message on invalid input. */
export function buildTaskRequest(f: TaskForm): TaskRequest {
	const body: TaskRequest = { kind: f.kind, waitMs: 0 };
	const timeout = num(f.timeoutSec, "timeout");
	if (timeout !== undefined) body.timeoutMs = timeout * 1000;
	const need = (v: string, what: string) => {
		if (!v) throw new Error(`${what} is required`);
		return v;
	};
	switch (f.kind) {
		case "exec":
			if (f.execMode === "shell") body.shell = need(f.command.trim(), "command");
			else {
				const argv = splitArgv(f.command);
				if (argv.length === 0) throw new Error("command is required");
				body.argv = argv;
			}
			if (f.cwd) body.cwd = f.cwd;
			if (f.stdin) body.stdin = f.stdin;
			break;
		case "file.read":
		case "file.list": {
			body.path = need(f.path, "path");
			const offset = f.kind === "file.read" ? num(f.offset, "offset") : undefined;
			const limit = num(f.limit, "limit");
			if (offset !== undefined) body.offset = offset;
			if (limit !== undefined) body.limit = limit;
			break;
		}
		case "file.write":
			body.path = need(f.path, "path");
			body.content = f.content;
			body.overwrite = f.overwrite;
			break;
		case "file.edit":
			body.path = need(f.path, "path");
			body.edits = [{ oldText: need(f.oldText, "old text"), newText: f.newText }];
			break;
		case "file.stat":
			body.path = need(f.path, "path");
			break;
	}
	return body;
}
