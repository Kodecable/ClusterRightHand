/**
 * JSON forms used by the database and Web API. The wire types keep sha256 as
 * bytes; JSON stores lowercase 64-character hex.
 */
import type {
	Command,
	Edit,
	Facts,
	FileListEntry,
	InputRef,
	Shells,
	TaskResult,
	TaskSpec,
	TransferEndpoint,
} from "./messages.ts";

export class JsonError extends Error {
	override name = "JsonError";
}

export interface JsonInputRef {
	size: number;
	sha256: string;
}

export type JsonCommand = { argv: string[] } | { shell: string };

/** The JSON form of a transfer endpoint (doc/design/protocol.md "Data connections"). */
export type JsonTransferEndpoint = { kind: "crhs"; transferId: string };

export type JsonTaskSpec =
	| {
			kind: "exec";
			command: JsonCommand;
			env: Record<string, string>;
			cwd: string;
			stdin: JsonInputRef | null;
	  }
	| { kind: "file.read"; path: string; startLine: number; lineCount: number }
	| {
			kind: "file.write";
			path: string;
			content: JsonInputRef;
			overwrite: boolean;
			mode: number;
			owner: string;
			group: string;
			createParentDirs: boolean;
	  }
	| {
			kind: "file.push";
			path: string;
			size: number;
			sha256: string;
			overwrite: boolean;
			mode: number;
			owner: string;
			group: string;
			createParentDirs: boolean;
			endpoint: JsonTransferEndpoint;
	  }
	| { kind: "file.pull"; path: string; maxBytes: number; endpoint: JsonTransferEndpoint }
	| { kind: "file.edit"; path: string; edits: { oldText: string; newText: string }[] }
	| { kind: "file.stat"; path: string }
	| { kind: "file.list"; path: string; limit: number };

/** The JSON form of one `file.list` entry (doc/design/protocol.md "Task results"). */
export interface JsonFileListEntry {
	name: string;
	type: string;
	size: number;
	mode: string;
	mtime: string;
}

/**
 * The JSON form of a TaskResult, as stored on the task row and served by the Web API. The camelCase
 * fields are the wire fields; a nullable one is null rather than absent.
 */
export type JsonTaskResult =
	| { kind: "file.read"; from: number; to: number; eof: boolean; total: number | null; tooLong: boolean }
	| {
			kind: "file.stat";
			path: string;
			type: string;
			size: number;
			mode: string;
			uid: number;
			gid: number;
			owner: string;
			group: string;
			mtime: string;
			linkTarget: string | null;
	  }
	| { kind: "file.list"; entries: JsonFileListEntry[]; truncated: boolean }
	| { kind: "file.write"; bytes: number; created: boolean }
	| { kind: "file.edit"; replacements: number }
	| { kind: "file.pull"; size: number; sha256: string };

/**
 * The JSON form of Facts: the camelCase fields that are present (doc/design/protocol.md "Events"). Every key
 * is optional because a stored row may be partial: an SSH node keeps only its shells, and a row
 * written before a fact existed lacks it.
 */
export type JsonFacts = Partial<Facts>;

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
		Object.entries(value).map(([key, item]) => [text(key, "env key"), text(item, `env[${JSON.stringify(key)}]`)]),
	);
}

function envFromJson(value: unknown, what: string): Record<string, string> {
	if (!isRecord(value)) bad(what, "not an object");
	return Object.fromEntries(
		Object.entries(value).map(([key, item]) => [
			text(key, `${what} key`),
			text(item, `${what}[${JSON.stringify(key)}]`),
		]),
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

function transferEndpointToJson(value: TransferEndpoint): JsonTransferEndpoint {
	if (value.kind !== "crhs") bad("endpoint", `unknown kind: ${value.kind}`);
	return { kind: "crhs", transferId: text(value.transferId, "endpoint.transferId") };
}

function transferEndpointFromJson(value: unknown, what: string): TransferEndpoint {
	const object = record(value, what, ["kind", "transferId"]);
	if (object.kind !== "crhs") bad(what, `unknown kind: ${String(object.kind)}`);
	return { kind: "crhs", transferId: text(object.transferId, `${what}.transferId`) };
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
				startLine: uint(value.startLine, "startLine"),
				lineCount: uint(value.lineCount, "lineCount"),
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
				createParentDirs: bool(value.createParentDirs, "createParentDirs"),
			};
		case "file.push":
			return {
				kind: "file.push",
				path: text(value.path, "path"),
				size: uint(value.size, "size"),
				sha256: bytesToHex(value.sha256, "sha256"),
				overwrite: bool(value.overwrite, "overwrite"),
				mode: uint(value.mode, "mode"),
				owner: text(value.owner, "owner"),
				group: text(value.group, "group"),
				createParentDirs: bool(value.createParentDirs, "createParentDirs"),
				endpoint: transferEndpointToJson(value.endpoint),
			};
		case "file.pull":
			return {
				kind: "file.pull",
				path: text(value.path, "path"),
				maxBytes: uint(value.maxBytes, "maxBytes"),
				endpoint: transferEndpointToJson(value.endpoint),
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
			const object = record(value, "file.read", ["kind", "path", "startLine", "lineCount"]);
			return {
				kind: "file.read",
				path: text(object.path, "path"),
				startLine: uint(object.startLine, "startLine"),
				lineCount: uint(object.lineCount, "lineCount"),
			};
		}
		case "file.write": {
			const object = record(value, "file.write", [
				"kind",
				"path",
				"content",
				"overwrite",
				"mode",
				"owner",
				"group",
				"createParentDirs",
			]);
			return {
				kind: "file.write",
				path: text(object.path, "path"),
				content: inputRefFromJson(object.content, "content"),
				overwrite: bool(object.overwrite, "overwrite"),
				mode: uint(object.mode, "mode"),
				owner: text(object.owner, "owner"),
				group: text(object.group, "group"),
				createParentDirs: bool(object.createParentDirs, "createParentDirs"),
			};
		}
		case "file.push": {
			const object = record(value, "file.push", [
				"kind",
				"path",
				"size",
				"sha256",
				"overwrite",
				"mode",
				"owner",
				"group",
				"createParentDirs",
				"endpoint",
			]);
			return {
				kind: "file.push",
				path: text(object.path, "path"),
				size: uint(object.size, "size"),
				sha256: hexToBytes(object.sha256, "sha256"),
				overwrite: bool(object.overwrite, "overwrite"),
				mode: uint(object.mode, "mode"),
				owner: text(object.owner, "owner"),
				group: text(object.group, "group"),
				createParentDirs: bool(object.createParentDirs, "createParentDirs"),
				endpoint: transferEndpointFromJson(object.endpoint, "endpoint"),
			};
		}
		case "file.pull": {
			const object = record(value, "file.pull", ["kind", "path", "maxBytes", "endpoint"]);
			return {
				kind: "file.pull",
				path: text(object.path, "path"),
				maxBytes: uint(object.maxBytes, "maxBytes"),
				endpoint: transferEndpointFromJson(object.endpoint, "endpoint"),
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

function listEntryToJson(value: FileListEntry): JsonFileListEntry {
	return {
		name: text(value.name, "entry.name"),
		type: text(value.type, "entry.type"),
		size: int(value.size, "entry.size"),
		mode: text(value.mode, "entry.mode"),
		mtime: text(value.mtime, "entry.mtime"),
	};
}

function listEntryFromJson(value: unknown, what: string): FileListEntry {
	const object = record(value, what, ["name", "type", "size", "mode", "mtime"]);
	return {
		name: text(object.name, `${what}.name`),
		type: text(object.type, `${what}.type`),
		size: int(object.size, `${what}.size`),
		mode: text(object.mode, `${what}.mode`),
		mtime: text(object.mtime, `${what}.mtime`),
	};
}

/** Convert a TaskResult to its JSON form (stored on the task row, served by the Web API). */
export function taskResultToJson(value: TaskResult): JsonTaskResult {
	switch (value.kind) {
		case "file.read":
			return {
				kind: "file.read",
				from: uint(value.from, "from"),
				to: uint(value.to, "to"),
				eof: bool(value.eof, "eof"),
				total: value.total === null ? null : uint(value.total, "total"),
				tooLong: bool(value.tooLong, "tooLong"),
			};
		case "file.stat":
			return {
				kind: "file.stat",
				path: text(value.path, "path"),
				type: text(value.type, "type"),
				size: int(value.size, "size"),
				mode: text(value.mode, "mode"),
				uid: int(value.uid, "uid"),
				gid: int(value.gid, "gid"),
				owner: text(value.owner, "owner"),
				group: text(value.group, "group"),
				mtime: text(value.mtime, "mtime"),
				linkTarget: value.linkTarget === null ? null : text(value.linkTarget, "linkTarget"),
			};
		case "file.list":
			return {
				kind: "file.list",
				entries: value.entries.map(listEntryToJson),
				truncated: bool(value.truncated, "truncated"),
			};
		case "file.write":
			return { kind: "file.write", bytes: uint(value.bytes, "bytes"), created: bool(value.created, "created") };
		case "file.edit":
			return { kind: "file.edit", replacements: uint(value.replacements, "replacements") };
		case "file.pull":
			return { kind: "file.pull", size: uint(value.size, "size"), sha256: bytesToHex(value.sha256, "sha256") };
	}
}

/** Strictly parse the JSON form of a TaskResult. */
export function taskResultFromJson(value: unknown): TaskResult {
	if (!isRecord(value)) bad("task result", "not an object");
	const kind = value.kind;
	if (typeof kind !== "string") bad("task result", "missing kind");
	switch (kind) {
		case "file.read": {
			const object = record(value, "file.read result", ["kind", "from", "to", "eof", "total", "tooLong"]);
			return {
				kind: "file.read",
				from: uint(object.from, "from"),
				to: uint(object.to, "to"),
				eof: bool(object.eof, "eof"),
				total: object.total === null ? null : uint(object.total, "total"),
				tooLong: bool(object.tooLong, "tooLong"),
			};
		}
		case "file.stat": {
			const object = record(value, "file.stat result", [
				"kind",
				"path",
				"type",
				"size",
				"mode",
				"uid",
				"gid",
				"owner",
				"group",
				"mtime",
				"linkTarget",
			]);
			return {
				kind: "file.stat",
				path: text(object.path, "path"),
				type: text(object.type, "type"),
				size: int(object.size, "size"),
				mode: text(object.mode, "mode"),
				uid: int(object.uid, "uid"),
				gid: int(object.gid, "gid"),
				owner: text(object.owner, "owner"),
				group: text(object.group, "group"),
				mtime: text(object.mtime, "mtime"),
				linkTarget: object.linkTarget === null ? null : text(object.linkTarget, "linkTarget"),
			};
		}
		case "file.list": {
			const object = record(value, "file.list result", ["kind", "entries", "truncated"]);
			if (!Array.isArray(object.entries)) bad("entries", "not an array");
			return {
				kind: "file.list",
				entries: object.entries.map((item, index) => listEntryFromJson(item, `entries[${index}]`)),
				truncated: bool(object.truncated, "truncated"),
			};
		}
		case "file.write": {
			const object = record(value, "file.write result", ["kind", "bytes", "created"]);
			return { kind: "file.write", bytes: uint(object.bytes, "bytes"), created: bool(object.created, "created") };
		}
		case "file.edit": {
			const object = record(value, "file.edit result", ["kind", "replacements"]);
			return { kind: "file.edit", replacements: uint(object.replacements, "replacements") };
		}
		case "file.pull": {
			const object = record(value, "file.pull result", ["kind", "size", "sha256"]);
			return { kind: "file.pull", size: uint(object.size, "size"), sha256: hexToBytes(object.sha256, "sha256") };
		}
		default:
			bad("task result", `unknown kind: ${kind}`);
	}
}

function shellsToJson(value: Shells): Shells {
	const out: Shells = { sh: text(value.sh, "shells.sh") };
	if (value.bash !== undefined) out.bash = value.bash === null ? null : text(value.bash, "shells.bash");
	return out;
}

function shellsFromJson(value: unknown): Shells {
	if (!isRecord(value)) bad("shells", "not an object");
	const out: Shells = { sh: text(value.sh, "shells.sh") };
	if (Object.hasOwn(value, "bash")) out.bash = value.bash === null ? null : text(value.bash, "shells.bash");
	return out;
}

/** Convert Facts to the camelCase JSON form stored on the node row; absent facts stay absent. */
export function factsToJson(value: Facts): JsonFacts {
	const out: JsonFacts = {
		hostname: text(value.hostname, "hostname"),
	};
	if (value.osId !== undefined) out.osId = text(value.osId, "osId");
	if (value.osVersionId !== undefined) out.osVersionId = text(value.osVersionId, "osVersionId");
	if (value.osPrettyName !== undefined) out.osPrettyName = text(value.osPrettyName, "osPrettyName");
	if (value.kernel !== undefined) out.kernel = text(value.kernel, "kernel");
	if (value.arch !== undefined) out.arch = text(value.arch, "arch");
	if (value.initSystem !== undefined) out.initSystem = text(value.initSystem, "initSystem");
	if (value.packageManagers !== undefined) out.packageManagers = texts(value.packageManagers, "packageManagers");
	if (value.privilegeTools !== undefined) out.privilegeTools = texts(value.privilegeTools, "privilegeTools");
	if (value.notesPath !== undefined) out.notesPath = text(value.notesPath, "notesPath");
	if (value.clockOffsetMs !== undefined) out.clockOffsetMs = int(value.clockOffsetMs, "clockOffsetMs");
	if (value.shells !== undefined) out.shells = shellsToJson(value.shells);
	return out;
}

/**
 * Parse the JSON form of Facts as stored on a node row. Every key is optional (see JsonFacts), so a
 * partial row reads as the facts it has instead of failing the record; a key that is present is type
 * checked. Unknown keys are ignored, as on the wire: facts grow by adding keys (doc/design/protocol.md).
 */
export function factsFromJson(value: unknown): JsonFacts {
	if (!isRecord(value)) bad("facts", "not an object");
	const out: JsonFacts = {};
	if (Object.hasOwn(value, "hostname")) out.hostname = text(value.hostname, "hostname");
	if (Object.hasOwn(value, "osId")) out.osId = text(value.osId, "osId");
	if (Object.hasOwn(value, "osVersionId")) out.osVersionId = text(value.osVersionId, "osVersionId");
	if (Object.hasOwn(value, "osPrettyName")) out.osPrettyName = text(value.osPrettyName, "osPrettyName");
	if (Object.hasOwn(value, "kernel")) out.kernel = text(value.kernel, "kernel");
	if (Object.hasOwn(value, "arch")) out.arch = text(value.arch, "arch");
	if (Object.hasOwn(value, "initSystem")) out.initSystem = text(value.initSystem, "initSystem");
	if (Object.hasOwn(value, "packageManagers")) out.packageManagers = texts(value.packageManagers, "packageManagers");
	if (Object.hasOwn(value, "privilegeTools")) out.privilegeTools = texts(value.privilegeTools, "privilegeTools");
	if (Object.hasOwn(value, "notesPath")) out.notesPath = text(value.notesPath, "notesPath");
	if (Object.hasOwn(value, "clockOffsetMs")) out.clockOffsetMs = int(value.clockOffsetMs, "clockOffsetMs");
	if (Object.hasOwn(value, "shells") && value.shells !== null) out.shells = shellsFromJson(value.shells);
	return out;
}
