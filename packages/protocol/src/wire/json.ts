/**
 * JSON forms used by the database and Web API. The wire types keep sha256 as
 * bytes; JSON stores lowercase 64-character hex.
 */
import type { Command, Edit, Facts, InputRef, TaskSpec } from "./messages.ts";

export class JsonError extends Error {
	override name = "JsonError";
}

export interface JsonInputRef {
	size: number;
	sha256: string;
}

export type JsonCommand = { argv: string[] } | { shell: string };

export type JsonTaskSpec =
	| {
			kind: "exec";
			command: JsonCommand;
			env: Record<string, string>;
			cwd: string;
			stdin: JsonInputRef | null;
	  }
	| { kind: "file.read"; path: string; offset: number; limit: number }
	| {
			kind: "file.write";
			path: string;
			content: JsonInputRef;
			overwrite: boolean;
			mode: number;
			owner: string;
			group: string;
	  }
	| { kind: "file.edit"; path: string; edits: { oldText: string; newText: string }[] }
	| { kind: "file.stat"; path: string }
	| { kind: "file.list"; path: string; limit: number };

export interface JsonFacts {
	hostname: string;
	osId: string;
	osVersionId: string;
	osPrettyName: string;
	kernel: string;
	arch: string;
	initSystem: string;
	packageManagers: string[];
	privilegeTools: string[];
	notesPath: string;
	groups: string[];
	clockOffsetMs: number;
}

function bad(what: string, detail: string): never {
	throw new JsonError(`${what}: ${detail}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, what: string, keys: readonly string[]): Record<string, unknown> {
	if (!isRecord(value)) bad(what, "not an object");
	for (const key of keys) {
		if (!Object.hasOwn(value, key)) bad(what, `missing field ${JSON.stringify(key)}`);
	}
	for (const key of Object.keys(value)) {
		if (!keys.includes(key)) bad(what, `unexpected field ${JSON.stringify(key)}`);
	}
	return value;
}

function text(value: unknown, what: string): string {
	if (typeof value !== "string") bad(what, "not text");
	if (!value.isWellFormed()) bad(what, "not well-formed Unicode");
	return value;
}

function bool(value: unknown, what: string): boolean {
	if (typeof value !== "boolean") bad(what, "not a boolean");
	return value;
}

function uint(value: unknown, what: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		bad(what, "not a safe unsigned integer");
	}
	return value;
}

function int(value: unknown, what: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value)) bad(what, "not a safe integer");
	return value;
}

function texts(value: unknown, what: string): string[] {
	if (!Array.isArray(value)) bad(what, "not an array");
	return value.map((item, index) => text(item, `${what}[${index}]`));
}

function hexToBytes(value: unknown, what: string): Uint8Array {
	if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
		bad(what, "sha256 must be lowercase 64-character hex");
	}
	return Uint8Array.from(Buffer.from(value, "hex"));
}

function bytesToHex(value: Uint8Array, what: string): string {
	if (!(value instanceof Uint8Array) || value.length !== 32) bad(what, "sha256 must be 32 bytes");
	return Buffer.from(value).toString("hex");
}

function inputRefToJson(value: InputRef): JsonInputRef {
	return { size: value.size, sha256: bytesToHex(value.sha256, "sha256") };
}

function inputRefFromJson(value: unknown, what: string): InputRef {
	const object = record(value, what, ["size", "sha256"]);
	return { size: uint(object.size, `${what}.size`), sha256: hexToBytes(object.sha256, `${what}.sha256`) };
}

function editToJson(value: Edit): { oldText: string; newText: string } {
	return { oldText: value.oldText, newText: value.newText };
}

function editFromJson(value: unknown, what: string): Edit {
	const object = record(value, what, ["oldText", "newText"]);
	return { oldText: text(object.oldText, `${what}.oldText`), newText: text(object.newText, `${what}.newText`) };
}

function envToJson(value: Record<string, string>): Record<string, string> {
	return Object.fromEntries(
		Object.entries(value).map(([key, item]) => [key, text(item, `env[${JSON.stringify(key)}]`)]),
	);
}

function envFromJson(value: unknown, what: string): Record<string, string> {
	if (!isRecord(value)) bad(what, "not an object");
	return Object.fromEntries(
		Object.entries(value).map(([key, item]) => [key, text(item, `${what}[${JSON.stringify(key)}]`)]),
	);
}

function commandToJson(value: Command): JsonCommand {
	if ("argv" in value) {
		if (!Array.isArray(value.argv)) bad("command.argv", "not an array");
		return { argv: value.argv.map((item, index) => text(item, `command.argv[${index}]`)) };
	}
	return { shell: text(value.shell, "command.shell") };
}

function commandFromJson(value: unknown, what: string): Command {
	if (!isRecord(value)) bad(what, "not an object");
	const hasArgv = Object.hasOwn(value, "argv");
	const hasShell = Object.hasOwn(value, "shell");
	if (hasArgv === hasShell) bad(what, "expected exactly one of argv or shell");
	if (hasArgv) {
		record(value, what, ["argv"]);
		return { argv: texts(value.argv, `${what}.argv`) };
	}
	record(value, what, ["shell"]);
	return { shell: text(value.shell, `${what}.shell`) };
}

/** Convert a TaskSpec to its JSON form (sha256 as lowercase hex). */
export function taskSpecToJson(value: TaskSpec): JsonTaskSpec {
	switch (value.kind) {
		case "exec":
			return {
				kind: "exec",
				command: commandToJson(value.command),
				env: envToJson(value.env),
				cwd: text(value.cwd, "cwd"),
				stdin: value.stdin === null ? null : inputRefToJson(value.stdin),
			};
		case "file.read":
			return {
				kind: "file.read",
				path: text(value.path, "path"),
				offset: uint(value.offset, "offset"),
				limit: uint(value.limit, "limit"),
			};
		case "file.write":
			return {
				kind: "file.write",
				path: text(value.path, "path"),
				content: inputRefToJson(value.content),
				overwrite: bool(value.overwrite, "overwrite"),
				mode: uint(value.mode, "mode"),
				owner: text(value.owner, "owner"),
				group: text(value.group, "group"),
			};
		case "file.edit":
			return {
				kind: "file.edit",
				path: text(value.path, "path"),
				edits: value.edits.map(editToJson),
			};
		case "file.stat":
			return { kind: "file.stat", path: text(value.path, "path") };
		case "file.list":
			return { kind: "file.list", path: text(value.path, "path"), limit: uint(value.limit, "limit") };
	}
}

/** Strictly parse the JSON form of a TaskSpec. */
export function taskSpecFromJson(value: unknown): TaskSpec {
	if (!isRecord(value)) bad("task spec", "not an object");
	const kind = value.kind;
	if (typeof kind !== "string") bad("task spec", "missing kind");
	switch (kind) {
		case "exec": {
			const object = record(value, "task spec", ["kind", "command", "env", "cwd", "stdin"]);
			const stdin = object.stdin;
			return {
				kind: "exec",
				command: commandFromJson(object.command, "command"),
				env: envFromJson(object.env, "env"),
				cwd: text(object.cwd, "cwd"),
				stdin: stdin === null ? null : inputRefFromJson(stdin, "stdin"),
			};
		}
		case "file.read": {
			const object = record(value, "file.read", ["kind", "path", "offset", "limit"]);
			return {
				kind: "file.read",
				path: text(object.path, "path"),
				offset: uint(object.offset, "offset"),
				limit: uint(object.limit, "limit"),
			};
		}
		case "file.write": {
			const object = record(value, "file.write", ["kind", "path", "content", "overwrite", "mode", "owner", "group"]);
			return {
				kind: "file.write",
				path: text(object.path, "path"),
				content: inputRefFromJson(object.content, "content"),
				overwrite: bool(object.overwrite, "overwrite"),
				mode: uint(object.mode, "mode"),
				owner: text(object.owner, "owner"),
				group: text(object.group, "group"),
			};
		}
		case "file.edit": {
			const object = record(value, "file.edit", ["kind", "path", "edits"]);
			if (!Array.isArray(object.edits)) bad("edits", "not an array");
			return {
				kind: "file.edit",
				path: text(object.path, "path"),
				edits: object.edits.map((item, index) => editFromJson(item, `edits[${index}]`)),
			};
		}
		case "file.stat": {
			const object = record(value, "file.stat", ["kind", "path"]);
			return { kind: "file.stat", path: text(object.path, "path") };
		}
		case "file.list": {
			const object = record(value, "file.list", ["kind", "path", "limit"]);
			return { kind: "file.list", path: text(object.path, "path"), limit: uint(object.limit, "limit") };
		}
		default:
			bad("task spec", `unknown kind: ${kind}`);
	}
}

/** Convert Facts to JSON (already camelCase; numbers stay numbers). */
export function factsToJson(value: Facts): JsonFacts {
	return {
		hostname: text(value.hostname, "hostname"),
		osId: text(value.osId, "osId"),
		osVersionId: text(value.osVersionId, "osVersionId"),
		osPrettyName: text(value.osPrettyName, "osPrettyName"),
		kernel: text(value.kernel, "kernel"),
		arch: text(value.arch, "arch"),
		initSystem: text(value.initSystem, "initSystem"),
		packageManagers: texts(value.packageManagers, "packageManagers"),
		privilegeTools: texts(value.privilegeTools, "privilegeTools"),
		notesPath: text(value.notesPath, "notesPath"),
		groups: texts(value.groups, "groups"),
		clockOffsetMs: int(value.clockOffsetMs, "clockOffsetMs"),
	};
}

const FACTS_KEYS = [
	"hostname",
	"osId",
	"osVersionId",
	"osPrettyName",
	"kernel",
	"arch",
	"initSystem",
	"packageManagers",
	"privilegeTools",
	"notesPath",
	"groups",
	"clockOffsetMs",
] as const;

/** Strictly parse the JSON form of Facts. */
export function factsFromJson(value: unknown): Facts {
	const object = record(value, "facts", FACTS_KEYS);
	return {
		hostname: text(object.hostname, "hostname"),
		osId: text(object.osId, "osId"),
		osVersionId: text(object.osVersionId, "osVersionId"),
		osPrettyName: text(object.osPrettyName, "osPrettyName"),
		kernel: text(object.kernel, "kernel"),
		arch: text(object.arch, "arch"),
		initSystem: text(object.initSystem, "initSystem"),
		packageManagers: texts(object.packageManagers, "packageManagers"),
		privilegeTools: texts(object.privilegeTools, "privilegeTools"),
		notesPath: text(object.notesPath, "notesPath"),
		groups: texts(object.groups, "groups"),
		clockOffsetMs: int(object.clockOffsetMs, "clockOffsetMs"),
	};
}
