/**
 * Task specs as crhs stores them (doc/protocol.md#json-形式服务端存储): the JSON form on a row, the
 * short description the UI and the audits show, and the input ref filled in from the bytes sent.
 */
import { createHash } from "node:crypto";
import { type InputRef, type TaskSpec, taskSpecFromJson } from "@crh/protocol";
import { type Method, operationOf } from "../policy/rules.ts";
import { UserError } from "../util/errors.ts";
import { shellQuote } from "../util/shell-quote.ts";

/**
 * The ref of an empty input. file.write always carries one; callers set it and createTask overwrites it
 * from the input actually sent (doc/protocol.md#json-形式服务端存储).
 */
export const EMPTY_INPUT_REF: InputRef = { size: 0, sha256: createHash("sha256").update(new Uint8Array(0)).digest() };

/** Returns a copy with the input ref filled in from the bytes actually sent (doc/protocol.md#json-形式服务端存储). */
export function withInputRef(spec: TaskSpec, ref: { size: number; sha256: Uint8Array } | undefined): TaskSpec {
	const inputRef: InputRef | undefined = ref ? { size: ref.size, sha256: ref.sha256 } : undefined;
	switch (spec.kind) {
		case "exec":
			return { ...spec, stdin: inputRef ?? null };
		case "file.write":
			return { ...spec, content: inputRef ?? EMPTY_INPUT_REF };
		default:
			if (inputRef) throw new Error(`${spec.kind} takes no input`);
			return spec;
	}
}

/** A stored spec; migration 0019 may have left one unreadable, which is a client error on approval. */
export function specFromRow(specJson: string | null, what: string): TaskSpec {
	try {
		return taskSpecFromJson(JSON.parse(specJson ?? "null"));
	} catch (err) {
		throw new UserError(
			`the ${what}'s stored spec cannot be read: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

export function operationOfJson(specJson: string): { method: Method; target: string } | null {
	try {
		return operationOf(taskSpecFromJson(JSON.parse(specJson)));
	} catch {
		return null;
	}
}

/** Spec JSON (doc/protocol.md#json-形式服务端存储) to a short description. */
export function summarize(specJson: string): string {
	try {
		const spec = JSON.parse(specJson) as {
			kind?: unknown;
			command?: { argv?: unknown; shell?: unknown };
			path?: unknown;
			startLine?: unknown;
			lineCount?: unknown;
		};
		if (spec.kind === "exec") {
			const command = spec.command ?? {};
			if (Array.isArray(command.argv)) return command.argv.map((arg) => shellQuote(String(arg))).join(" ");
			if (typeof command.shell === "string") return command.shell;
			return "";
		}
		// A read names the lines it asks for, so an approver sees the range and not just the path.
		if (spec.kind === "file.read" && typeof spec.startLine === "number" && typeof spec.lineCount === "number") {
			return `${String(spec.path)} (lines ${spec.startLine}-${spec.startLine + spec.lineCount - 1})`;
		}
		if (typeof spec.path === "string") return spec.path;
	} catch {}
	return "";
}
