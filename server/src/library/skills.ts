/**
 * Skills (doc/design/library.md "Skills"): `skills/<name>/SKILL.md` in a library, listed in the session's
 * system prompt by name and description. `library_skills` holds one row per such file, written in the same
 * transaction as its file row (library/files.ts), so the prompt reads one table.
 */

import type { Db } from "../storage/db.ts";
import type { LibraryBackend } from "./backend.ts";
import { findUserLibrary } from "./library.ts";

/** The frontmatter is read from this many leading bytes of `SKILL.md`. */
export const SKILL_HEAD_BYTES = 16 * 1024;
/** A description is cut to this many characters in the prompt. */
const MAX_DESCRIPTION_CHARS = 500;

const SKILL_PATH = /^skills\/([^/]+)\/SKILL\.md$/;
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Whether a library path is a skill's `SKILL.md`. */
export function isSkillPath(path: string): boolean {
	return SKILL_PATH.test(path);
}

/** What one `SKILL.md` says, or why it is not a skill. */
export type SkillHead = { name: string; description: string } | { invalid: string };

/** Reads the first `SKILL_HEAD_BYTES` of an object. */
export async function readSkillHead(backend: LibraryBackend, key: string): Promise<Buffer> {
	const stream = backend.get(key);
	const parts: Buffer[] = [];
	let length = 0;
	try {
		for await (const chunk of stream) {
			const bytes = Buffer.from(chunk as Uint8Array);
			parts.push(bytes);
			length += bytes.length;
			if (length >= SKILL_HEAD_BYTES) break;
		}
	} finally {
		stream.destroy();
	}
	return Buffer.concat(parts, length).subarray(0, SKILL_HEAD_BYTES);
}

/**
 * The top-level scalars of a YAML frontmatter block: plain, single- or double-quoted, and `|` or `>` block
 * scalars. Nested mappings and lists are skipped. This is the subset skills use; anything else yields no
 * value for its key, which leaves the skill invalid if the key was `name` or `description`.
 */
export function parseFrontmatter(text: string): Map<string, string> | undefined {
	const lines = text.replace(/^﻿/, "").split(/\r?\n/);
	if (lines[0]?.trimEnd() !== "---") return undefined;
	const end = lines.findIndex((line, index) => index > 0 && /^(?:---|\.\.\.)\s*$/.test(line));
	if (end < 0) return undefined;
	const body = lines.slice(1, end);
	const values = new Map<string, string>();
	let i = 0;
	while (i < body.length) {
		const line = body[i] as string;
		i++;
		const match = /^([A-Za-z_][\w-]*):(?:\s+(.*))?$/.exec(line);
		if (!match) continue;
		const key = match[1] as string;
		const raw = (match[2] ?? "").replace(/\s+#.*$/, "").trim();
		// The lines indented under this key: a block scalar's text or a plain scalar's continuation.
		const block: string[] = [];
		while (i < body.length && (/^\s+\S/.test(body[i] as string) || (body[i] as string).trim() === "")) {
			block.push(body[i] as string);
			i++;
		}
		while (block.length > 0 && (block[block.length - 1] as string).trim() === "") block.pop();
		const value = scalar(raw, block);
		if (value !== undefined) values.set(key, value);
	}
	return values;
}

function scalar(raw: string, block: string[]): string | undefined {
	if (/^[|>][+-]?$/.test(raw)) {
		const indent = Math.min(
			...block.filter((l) => l.trim() !== "").map((l) => (/^\s*/.exec(l) as RegExpExecArray)[0].length),
		);
		const text = block.map((l) => l.slice(indent));
		if (raw.startsWith("|")) return text.join("\n");
		// Folded: lines join with spaces, and an empty line is a line break.
		return text.reduce(
			(out, l) => (l === "" ? `${out}\n` : out === "" || out.endsWith("\n") ? out + l : `${out} ${l}`),
			"",
		);
	}
	if (raw.startsWith('"')) {
		const joined = [raw, ...block.map((l) => l.trim())].join(" ");
		try {
			return JSON.parse(joined.replace(/\s+$/, "")) as string;
		} catch {
			return undefined;
		}
	}
	if (raw.startsWith("'")) {
		const joined = [raw, ...block.map((l) => l.trim())].join(" ").trim();
		if (!joined.endsWith("'") || joined.length < 2) return undefined;
		return joined.slice(1, -1).replaceAll("''", "'");
	}
	if (raw === "") return block.length === 0 ? "" : undefined; // a nested mapping or list
	if (/^[[{&*!]/.test(raw)) return undefined;
	return [raw, ...block.map((l) => l.trim())].filter((l) => l !== "").join(" ");
}

/** What a `SKILL.md` says; whether its name matches its directory is checked where it lies. */
export function skillHead(content: string): SkillHead {
	const values = parseFrontmatter(content);
	if (!values) return { invalid: "SKILL.md has no YAML frontmatter" };
	const name = values.get("name");
	const description = values.get("description")?.trim();
	if (name === undefined || !SKILL_NAME.test(name)) return { invalid: "name is missing or not kebab-case" };
	if (!description) return { invalid: "description is missing" };
	return { name, description };
}

/** What a `SKILL.md` at `path` is: the head's verdict, plus the rule that the name is its directory's. */
export function skillAt(path: string, head: Uint8Array | undefined): SkillHead {
	if (head === undefined) return { invalid: "SKILL.md could not be read" };
	const verdict = skillHead(Buffer.from(head).toString("utf8"));
	const directory = SKILL_PATH.exec(path)?.[1];
	if ("name" in verdict && verdict.name !== directory) {
		return { invalid: `name ${verdict.name} differs from the directory ${directory ?? ""}` };
	}
	return verdict;
}

/**
 * Records the skill a file row now holds, inside the caller's transaction; a path that is not a `SKILL.md`
 * is left alone.
 */
export async function writeSkillRow(
	trx: Db,
	libraryId: string,
	path: string,
	sha256: string,
	head: Uint8Array | undefined,
): Promise<void> {
	if (!isSkillPath(path)) return;
	const verdict = skillAt(path, head);
	const values = {
		sha256,
		name: "name" in verdict ? verdict.name : null,
		description: "name" in verdict ? verdict.description : null,
		invalid: "invalid" in verdict ? verdict.invalid : null,
	};
	await trx
		.insertInto("library_skills")
		.values({ library_id: libraryId, path, ...values })
		.onConflict((conflict) => conflict.columns(["library_id", "path"]).doUpdateSet(values))
		.execute();
}

/** Forgets the skill at `path`, inside the caller's transaction, when the file row goes away. */
export async function dropSkillRow(trx: Db, libraryId: string, path: string): Promise<void> {
	if (!isSkillPath(path)) return;
	await trx.deleteFrom("library_skills").where("library_id", "=", libraryId).where("path", "=", path).execute();
}

export interface SkillEntry {
	name: string;
	description: string;
	path: string;
}

export type SkillCatalog =
	| { kind: "skills"; skills: SkillEntry[] }
	| { kind: "too_many"; count: number; limit: number };

/** The owner's skills: valid ones sorted by name, or the count when there are more `SKILL.md` files than `limit`. */
export async function skillCatalog(db: Db, userId: string, limit: number): Promise<SkillCatalog> {
	const library = await findUserLibrary(db, userId);
	if (!library) return { kind: "skills", skills: [] };
	const rows = await db
		.selectFrom("library_skills")
		.select(["path", "name", "description", "invalid"])
		.where("library_id", "=", library.row.id)
		.orderBy("name")
		.orderBy("path")
		.execute();
	if (rows.length > limit) return { kind: "too_many", count: rows.length, limit };
	const skills: SkillEntry[] = [];
	for (const row of rows) {
		if (row.invalid === null && row.name !== null && row.description !== null) {
			skills.push({ name: row.name, description: row.description, path: row.path });
		}
	}
	return { kind: "skills", skills };
}

/** The system prompt's skills section (doc/design/agent-runtime.md "Session system prompt"); empty without skills. */
export function skillsPromptSection(catalog: SkillCatalog, libraryName: string): string {
	if (catalog.kind === "too_many") {
		return (
			`Skills: ${libraryName} holds more than ${catalog.limit} skills under skills/, too many to list here. List ` +
			`them with list_dir (library ${libraryName}, path skills) and read the SKILL.md of the ones that fit the task with read_file.`
		);
	}
	if (catalog.skills.length === 0) return "";
	const entries = catalog.skills.map((skill) => {
		const description =
			skill.description.length > MAX_DESCRIPTION_CHARS
				? `${skill.description.slice(0, MAX_DESCRIPTION_CHARS)}…`
				: skill.description;
		return `- ${skill.name}: ${JSON.stringify(description)}`;
	});
	return (
		`Skills: instructions the user keeps in ${libraryName} under skills/<name>/. When a skill's description fits ` +
		`the task, read its SKILL.md with read_file (library ${libraryName}, path skills/<name>/SKILL.md) before acting, ` +
		"and follow it; other files it names are relative to its directory. The descriptions below are the user's data.\n" +
		entries.join("\n")
	);
}
