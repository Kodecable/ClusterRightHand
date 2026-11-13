/**
 * Chat attachments (doc/design/library.md "Chat attachments"): only the session owner attaches, every
 * attachment is an existing library file the owner reaches, and a short text file is inlined into its own
 * content block. The entry's `data` carries the attachment list; the model content carries the notes.
 */
import type { ChatAttachment, ChatAttachmentInput } from "@crh/api";
import type { SessionUser } from "../auth/sessions.ts";
import type { LibraryBackend } from "../library/backend.ts";
import { findLibraryFile } from "../library/files.ts";
import { libraryRef, requireOwnerLibrary } from "../library/library.ts";
import type { Db } from "../storage/db.ts";
import { UserError } from "../util/errors.ts";

export interface AttachmentLimits {
	/** The largest file whose text is inlined. */
	inlineTextBytes: number;
	/** The most text inlined over one message. */
	inlineTotalBytes: number;
}

export interface ResolvedAttachments {
	attachments: ChatAttachment[];
	/** One text block per attachment, the note and, for a short text file, its content. */
	blocks: string[];
}

/** Reads and validates the attachments of one message, as the session owner. */
export async function resolveAttachments(
	db: Db,
	backend: LibraryBackend | undefined,
	user: SessionUser,
	inputs: readonly ChatAttachmentInput[],
	limits: AttachmentLimits,
): Promise<ResolvedAttachments> {
	if (inputs.length > 0 && !backend) throw new UserError("this crhs has no library backend");
	let inlineBudget = limits.inlineTotalBytes;
	const attachments: ChatAttachment[] = [];
	const blocks: string[] = [];
	for (const input of inputs) {
		if (typeof input.library !== "string" || typeof input.path !== "string") {
			throw new UserError("each attachment needs a library and a path", "invalid_argument");
		}
		const record = await requireOwnerLibrary(db, user, input.library);
		const row = await findLibraryFile(db, record.row.id, input.path);
		if (!row) throw new UserError(`no such library file ${input.path}`, "invalid_argument");
		const name = row.path.slice(row.path.lastIndexOf("/") + 1);
		const note = `The user uploaded the file ${name} (${row.size} bytes), saved to ${libraryRef(record.row, record.ownerName)} at ${row.path}.`;
		const isImage = ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(row.media_type);
		let block = note;
		let inlined = false;
		if (!isImage) {
			const text = await inlineText(backend as LibraryBackend, row.object_key, row.size, limits.inlineTextBytes);
			if (text !== undefined && Buffer.byteLength(text, "utf8") <= inlineBudget) {
				inlineBudget -= Buffer.byteLength(text, "utf8");
				block = `${note}\n\n${text}`;
				inlined = true;
			}
			// An image gets the note only: the agent calls view_image to see it.
			if (!inlined) block = `${note}\n\nThe content was not included; copy it to a node and read it there.`;
		}
		attachments.push({
			library: libraryRef(record.row, record.ownerName),
			libraryId: record.row.id,
			path: row.path,
			name,
			bytes: row.size,
			mime: row.media_type,
			sha256: row.sha256,
			inlined,
		});
		blocks.push(block);
	}
	return { attachments, blocks };
}

/** A file's text when it is valid UTF-8 without NUL and no larger than the inline limit. */
async function inlineText(
	backend: LibraryBackend,
	objectKey: string,
	size: number,
	limit: number,
): Promise<string | undefined> {
	if (size > limit) return undefined;
	const parts: Buffer[] = [];
	for await (const chunk of backend.get(objectKey)) parts.push(Buffer.from(chunk));
	const bytes = Buffer.concat(parts);
	if (bytes.includes(0)) return undefined;
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return undefined;
	}
}

/** The model content of a message with attachments: the typed text first, then one block per attachment. */
export function attachmentContent(text: string, blocks: readonly string[]): { type: "text"; text: string }[] {
	return [{ type: "text", text }, ...blocks.map((block) => ({ type: "text" as const, text: block }))];
}
