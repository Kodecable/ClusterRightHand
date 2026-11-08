import type { TaskRequest } from "@crh/api";
import type { I18n, MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
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

/**
 * Validation failures of the task form, as codes. The pure builder returns
 * codes (not English sentences) and components translate them with Lingui.
 */
export type TaskFormErrorCode =
	| "command-required"
	| "timeout-invalid"
	| "path-required"
	| "offset-invalid"
	| "limit-invalid"
	| "old-text-required";

export class TaskFormError extends Error {
	readonly code: TaskFormErrorCode;

	constructor(code: TaskFormErrorCode) {
		super(code);
		this.name = "TaskFormError";
		this.code = code;
	}
}

const MESSAGES: Record<TaskFormErrorCode, MessageDescriptor> = {
	"command-required": msg`A command is required.`,
	"timeout-invalid": msg`The timeout must be a non-negative whole number of seconds.`,
	"path-required": msg`A path is required.`,
	"offset-invalid": msg`The start line must be a whole number of at least 1.`,
	"limit-invalid": msg`The limit must be a non-negative whole number.`,
	"old-text-required": msg`The text to replace is required.`,
};

/** The translated text of a `TaskFormError`; other errors are shown verbatim. */
export function taskFormErrorText(i18n: I18n, error: unknown): string {
	if (error instanceof TaskFormError) return i18n._(MESSAGES[error.code]);
	return error instanceof Error ? error.message : String(error);
}

function num(value: string, code: TaskFormErrorCode): number | undefined {
	if (value.trim() === "") return undefined;
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 0) throw new TaskFormError(code);
	return parsed;
}

function need(value: string, code: TaskFormErrorCode): string {
	if (!value) throw new TaskFormError(code);
	return value;
}

/** Builds the POST body; throws a `TaskFormError` with a code on invalid input. */
export function buildTaskRequest(form: TaskForm): TaskRequest {
	const body: TaskRequest = { kind: form.kind, waitMs: 0 };
	if (form.privileged) body.privileged = true;
	const timeout = num(form.timeoutSec, "timeout-invalid");
	if (timeout !== undefined) body.timeoutMs = timeout * 1000;
	switch (form.kind) {
		case "exec":
			if (form.execMode === "shell") body.shell = need(form.command.trim(), "command-required");
			else {
				const argv = splitArgv(form.command);
				if (argv.length === 0) throw new TaskFormError("command-required");
				body.argv = argv;
			}
			if (form.cwd) body.cwd = form.cwd;
			if (form.stdin) body.stdin = form.stdin;
			break;
		case "file.read": {
			body.path = need(form.path, "path-required");
			// Lines, 1-based: the node pages by line so the tool needs no byte cursor.
			const startLine = num(form.offset, "offset-invalid");
			const lineCount = num(form.limit, "limit-invalid");
			if (startLine === 0) throw new TaskFormError("offset-invalid");
			if (startLine !== undefined) body.startLine = startLine;
			if (lineCount !== undefined) body.lineCount = lineCount;
			break;
		}
		case "file.list": {
			body.path = need(form.path, "path-required");
			const limit = num(form.limit, "limit-invalid");
			if (limit !== undefined) body.limit = limit;
			break;
		}
		case "file.write":
			body.path = need(form.path, "path-required");
			body.content = form.content;
			body.overwrite = form.overwrite;
			break;
		case "file.edit":
			body.path = need(form.path, "path-required");
			body.edits = [{ oldText: need(form.oldText, "old-text-required"), newText: form.newText }];
			break;
		case "file.stat":
			body.path = need(form.path, "path-required");
			break;
	}
	return body;
}
