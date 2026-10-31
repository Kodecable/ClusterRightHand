import type { TaskRequest } from "@/lib/api/types";
import { splitArgv } from "./argv";

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
	privileged: boolean;
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
	privileged: false,
};

function num(value: string, what: string): number | undefined {
	if (value.trim() === "") return undefined;
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${what} must be a non-negative integer`);
	return parsed;
}

/** Builds the POST body; throws an Error with a user-facing message on invalid input. */
export function buildTaskRequest(form: TaskForm): TaskRequest {
	const body: TaskRequest = { kind: form.kind, waitMs: 0 };
	if (form.privileged) body.privileged = true;
	const timeout = num(form.timeoutSec, "timeout");
	if (timeout !== undefined) body.timeoutMs = timeout * 1000;
	const need = (value: string, what: string) => {
		if (!value) throw new Error(`${what} is required`);
		return value;
	};
	switch (form.kind) {
		case "exec":
			if (form.execMode === "shell") body.shell = need(form.command.trim(), "command");
			else {
				const argv = splitArgv(form.command);
				if (argv.length === 0) throw new Error("command is required");
				body.argv = argv;
			}
			if (form.cwd) body.cwd = form.cwd;
			if (form.stdin) body.stdin = form.stdin;
			break;
		case "file.read":
		case "file.list": {
			body.path = need(form.path, "path");
			const offset = form.kind === "file.read" ? num(form.offset, "offset") : undefined;
			const limit = num(form.limit, "limit");
			if (offset !== undefined) body.offset = offset;
			if (limit !== undefined) body.limit = limit;
			break;
		}
		case "file.write":
			body.path = need(form.path, "path");
			body.content = form.content;
			body.overwrite = form.overwrite;
			break;
		case "file.edit":
			body.path = need(form.path, "path");
			body.edits = [{ oldText: need(form.oldText, "old text"), newText: form.newText }];
			break;
		case "file.stat":
			body.path = need(form.path, "path");
			break;
	}
	return body;
}
