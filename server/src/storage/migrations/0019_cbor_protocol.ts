import { createHash } from "node:crypto";
import type { Kysely } from "kysely";

/**
 * M3.5 replaces protobuf JSON in the database with the CBOR wire JSON forms (doc/design/protocol.md "JSON storage forms"):
 * `tasks.spec`, `task_groups.spec` and `nodes.facts` are converted, `task_groups.kind` gets the wire tag, and
 * `tasks.attempt` carries the dispatch attempt. Rows that cannot be converted are left as they are.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.alterTable("tasks")
		.addColumn("attempt", "integer", (col) => col.notNull().defaultTo(1))
		.execute();
	await convertCborRows(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.alterTable("tasks").dropColumn("attempt").execute();
}

const EMPTY_SHA256 = createHash("sha256").digest("hex");

const WIRE_KIND: Record<string, string> = {
	exec: "exec",
	fileRead: "file.read",
	fileWrite: "file.write",
	fileEdit: "file.edit",
	fileStat: "file.stat",
	fileList: "file.list",
};

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bad(what: string, detail: string): never {
	throw new Error(`${what}: ${detail}`);
}

function object(value: unknown, what: string): Json {
	if (!isObject(value)) bad(what, "not an object");
	return value;
}

function requiredText(value: unknown, what: string): string {
	if (typeof value !== "string") bad(what, "not text");
	return value;
}

function optionalText(value: unknown, what: string): string {
	if (value === undefined || value === null) return "";
	if (typeof value !== "string") bad(what, "not text");
	return value;
}

function integer(value: unknown, what: string, fallback: number, unsigned: boolean): number {
	if (value === undefined || value === null) return fallback;
	const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
	if (!Number.isSafeInteger(parsed)) bad(what, "not a safe integer");
	if (unsigned && parsed < 0) bad(what, "negative");
	return parsed;
}

function boolean(value: unknown, what: string): boolean {
	if (value === undefined || value === null) return false;
	if (typeof value !== "boolean") bad(what, "not a boolean");
	return value;
}

function texts(value: unknown, what: string): string[] {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value)) bad(what, "not an array");
	return value.map((item, index) => requiredText(item, `${what}[${index}]`));
}

function env(value: unknown, what: string): Record<string, string> {
	if (value === undefined || value === null) return {};
	if (!isObject(value)) bad(what, "not an object");
	return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, requiredText(item, `${what}[${key}]`)]));
}

/** protobuf InputRef JSON: size as an int64 string, sha256 as base64. */
function inputRef(value: unknown, what: string): { size: number; sha256: string } {
	const ref = object(value, what);
	const bytes = Buffer.from(requiredText(ref.sha256, `${what}.sha256`), "base64");
	if (bytes.length !== 32) bad(`${what}.sha256`, "not 32 bytes");
	return { size: integer(ref.size, `${what}.size`, 0, true), sha256: bytes.toString("hex") };
}

const EMPTY_INPUT_REF = { size: 0, sha256: EMPTY_SHA256 };

/** protobuf TaskSpec JSON (one oneof field) to the wire JSON form. */
function convertSpec(value: unknown): Json {
	const raw = object(value, "task spec");
	const fields = Object.keys(raw);
	if (fields.length !== 1) throw new Error("task spec: expected exactly one kind");
	const field = fields[0] as string;
	const body = object(raw[field], field);
	switch (field) {
		case "exec": {
			// protobuf ExecSpec has argv/shell directly on the message; the wire form wraps them in command.
			const argv = texts(body.argv, "exec.argv");
			const stdin = body.stdin === undefined || body.stdin === null ? null : inputRef(body.stdin, "exec.stdin");
			return {
				kind: "exec",
				command: argv.length > 0 ? { argv } : { shell: optionalText(body.shell, "exec.shell") },
				env: env(body.env, "exec.env"),
				cwd: optionalText(body.cwd, "exec.cwd"),
				stdin,
			};
		}
		case "fileRead":
			return {
				kind: "file.read",
				path: requiredText(body.path, "file.read.path"),
				offset: integer(body.offset, "file.read.offset", 0, true),
				limit: integer(body.limit, "file.read.limit", 0, true),
			};
		case "fileWrite":
			return {
				kind: "file.write",
				path: requiredText(body.path, "file.write.path"),
				content:
					body.content === undefined || body.content === null
						? EMPTY_INPUT_REF
						: inputRef(body.content, "file.write.content"),
				overwrite: boolean(body.overwrite, "file.write.overwrite"),
				mode: integer(body.mode, "file.write.mode", 0, true),
				owner: optionalText(body.owner, "file.write.owner"),
				group: optionalText(body.group, "file.write.group"),
			};
		case "fileEdit": {
			const edits = body.edits === undefined || body.edits === null ? [] : body.edits;
			if (!Array.isArray(edits)) bad("file.edit.edits", "not an array");
			return {
				kind: "file.edit",
				path: requiredText(body.path, "file.edit.path"),
				edits: edits.map((item, index) => {
					const edit = object(item, `file.edit.edits[${index}]`);
					return {
						oldText: optionalText(edit.oldText, `file.edit.edits[${index}].oldText`),
						newText: optionalText(edit.newText, `file.edit.edits[${index}].newText`),
					};
				}),
			};
		}
		case "fileStat":
			return { kind: "file.stat", path: requiredText(body.path, "file.stat.path") };
		case "fileList":
			return {
				kind: "file.list",
				path: requiredText(body.path, "file.list.path"),
				limit: integer(body.limit, "file.list.limit", 0, true),
			};
		default:
			return bad("task spec", `unknown kind ${field}`);
	}
}

/** protobuf Facts JSON to the wire JSON form: all keys present, integers as numbers. */
function convertFacts(value: unknown): Json {
	const raw = object(value, "facts");
	return {
		hostname: optionalText(raw.hostname, "hostname"),
		osId: optionalText(raw.osId, "osId"),
		osVersionId: optionalText(raw.osVersionId, "osVersionId"),
		osPrettyName: optionalText(raw.osPrettyName, "osPrettyName"),
		kernel: optionalText(raw.kernel, "kernel"),
		arch: optionalText(raw.arch, "arch"),
		initSystem: optionalText(raw.initSystem, "initSystem"),
		packageManagers: texts(raw.packageManagers, "packageManagers"),
		privilegeTools: texts(raw.privilegeTools, "privilegeTools"),
		notesPath: optionalText(raw.notesPath, "notesPath"),
		groups: texts(raw.groups, "groups"),
		clockOffsetMs: integer(raw.clockOffsetMs, "clockOffsetMs", 0, false),
	};
}

/** Converts every stored protobuf-JSON row; a row that fails is left unchanged and logged. */
// biome-ignore lint/suspicious/noExplicitAny: migration reads the tables it is migrating
export async function convertCborRows(d: Kysely<any>): Promise<void> {
	const tasks = await d.selectFrom("tasks").select(["id", "spec"]).execute();
	for (const row of tasks) {
		try {
			const spec = convertSpec(JSON.parse(row.spec));
			await d
				.updateTable("tasks")
				.set({ spec: JSON.stringify(spec) })
				.where("id", "=", row.id)
				.execute();
		} catch (err) {
			console.warn(`0019_cbor_protocol: leaving task ${row.id} unchanged: ${message(err)}`);
		}
	}

	const groups = await d.selectFrom("task_groups").select(["id", "spec", "kind"]).execute();
	for (const row of groups) {
		try {
			const kind = WIRE_KIND[row.kind];
			if (kind === undefined) bad("task group kind", `unknown kind ${String(row.kind)}`);
			const set: { kind: string; spec?: string } = { kind };
			if (row.spec !== null && row.spec !== undefined) set.spec = JSON.stringify(convertSpec(JSON.parse(row.spec)));
			await d.updateTable("task_groups").set(set).where("id", "=", row.id).execute();
		} catch (err) {
			console.warn(`0019_cbor_protocol: leaving task group ${row.id} unchanged: ${message(err)}`);
		}
	}

	const nodes = await d.selectFrom("nodes").select(["id", "facts"]).execute();
	for (const row of nodes) {
		if (row.facts === null || row.facts === undefined) continue;
		try {
			const facts = convertFacts(JSON.parse(row.facts));
			await d
				.updateTable("nodes")
				.set({ facts: JSON.stringify(facts) })
				.where("id", "=", row.id)
				.execute();
		} catch (err) {
			console.warn(`0019_cbor_protocol: leaving node ${row.id} unchanged: ${message(err)}`);
		}
	}
}

function message(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
