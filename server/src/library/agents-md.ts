/**
 * `AGENTS.md` at the root of a user's personal library: standing instructions included in a session's
 * system prompt (doc/design/library.md "AGENTS.md"). The file is read once, when the prompt is assembled at
 * the session's first request; a larger file is not read, only named, so the prompt never grows past the limit.
 */

import type { Db } from "../storage/db.ts";
import type { LibraryBackend } from "./backend.ts";
import { findLibraryFile } from "./files.ts";
import { findUserLibrary } from "./library.ts";

/** The most bytes of `AGENTS.md` the prompt includes; larger files are named instead. */
export const AGENTS_MD_MAX_BYTES = 32 * 1024;

/** The path of the owner's instructions: the personal library's root only. */
export const AGENTS_MD_PATH = "AGENTS.md";

/** What the loader found: the instructions, or the news that the file is too large to include. */
export type AgentsMdInput = { kind: "content"; text: string } | { kind: "too_large"; size: number };

/** The instructions section of the system prompt; empty when there are no instructions to include. */
export function agentsMdPromptSection(input: AgentsMdInput | undefined, libraryName: string): string {
	if (input === undefined) return "";
	if (input.kind === "too_large") {
		return (
			`User instructions: ${libraryName} holds AGENTS.md (${input.size} bytes), larger than the ` +
			`${AGENTS_MD_MAX_BYTES / 1024} KiB that is included here. Read it with read_file (library ${libraryName}, ` +
			"path AGENTS.md) before acting, and follow it."
		);
	}
	const text = input.text.trimEnd();
	if (text === "") return "";
	return (
		`User instructions: the user keeps standing instructions for you in ${libraryName} at AGENTS.md. Follow them; ` +
		"the tool guide above and the user's messages in this session take precedence when they conflict.\n" +
		`<user_instructions>\n${text}\n</user_instructions>`
	);
}

/** Reads at most `limit` bytes of an object; the caller has already bounded its size from the file row. */
async function readAtMost(backend: LibraryBackend, key: string, limit: number): Promise<Buffer> {
	const stream = backend.get(key);
	const parts: Buffer[] = [];
	let length = 0;
	try {
		for await (const chunk of stream) {
			const bytes = Buffer.from(chunk as Uint8Array);
			parts.push(bytes);
			length += bytes.length;
			if (length >= limit) break;
		}
	} finally {
		stream.destroy();
	}
	return Buffer.concat(parts, length).subarray(0, limit);
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * Reads the owner's `AGENTS.md` from their personal library (doc/design/library.md "AGENTS.md"). A missing
 * library or file and empty content yield undefined silently; invalid UTF-8, a NUL byte and a read error warn
 * and also yield undefined, since a session must not fail because its owner's instructions could not be read.
 */
export async function agentsMdForUser(
	db: Db,
	userId: string,
	backend: LibraryBackend | undefined,
): Promise<AgentsMdInput | undefined> {
	const library = await findUserLibrary(db, userId);
	if (!library) return undefined;
	const row = await findLibraryFile(db, library.row.id, AGENTS_MD_PATH);
	if (!row) return undefined;
	// The row's size decides without opening the object, so a huge file costs nothing to skip.
	if (row.size > AGENTS_MD_MAX_BYTES) return { kind: "too_large", size: row.size };
	if (!backend) {
		console.warn(`library: cannot read ${AGENTS_MD_PATH} of user ${userId}: this crhs has no library backend`);
		return undefined;
	}
	let bytes: Buffer;
	try {
		bytes = await readAtMost(backend, row.object_key, AGENTS_MD_MAX_BYTES);
	} catch (err) {
		console.warn(`library: could not read ${AGENTS_MD_PATH} of user ${userId}: ${errorMessage(err)}`);
		return undefined;
	}
	if (bytes.includes(0)) {
		console.warn(`library: leaving ${AGENTS_MD_PATH} of user ${userId} out of the prompt: it contains a NUL byte`);
		return undefined;
	}
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		console.warn(`library: leaving ${AGENTS_MD_PATH} of user ${userId} out of the prompt: it is not valid UTF-8`);
		return undefined;
	}
	text = text.trimEnd();
	if (text === "") return undefined;
	return { kind: "content", text };
}
