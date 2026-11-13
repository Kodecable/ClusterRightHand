import { createHash, randomBytes } from "node:crypto";
import { posix } from "node:path";
import type { Readable } from "node:stream";
import {
	FILE_LIST_MAX_BYTES,
	FILE_READ_MAX_BYTES,
	type FileListEntry,
	type FileReadResult,
	type FileStatResult,
	type TaskResult,
	type TaskSpec,
} from "@crh/protocol";
import type { SFTPWrapper } from "ssh2";
import type { TransferWrite } from "../../library/transfer-location.ts";
import { applyEdits, detectLineEnding, MAX_EDIT_SIZE, normalizeToLF, toBytesString, UTF8_BOM } from "./file-edit.ts";
import {
	checkPath,
	FileTaskError,
	fileType,
	mapError,
	modeString,
	mtimeString,
	S_IFDIR,
	S_IFLNK,
	S_IFMT,
	S_IFREG,
	Sftp,
} from "./file-sftp.ts";

export { FileTaskError };

const DEFAULT_LIST_LIMIT = 500;
const MAX_LIST_LIMIT = 5000;
const CHUNK = 32 * 1024;
const WRITE_WINDOW = 16;

type Out = (data: Uint8Array) => void;

type FileReadSpec = Extract<TaskSpec, { kind: "file.read" }>;
type FileWriteSpec = Extract<TaskSpec, { kind: "file.write" }>;
type FilePushSpec = Extract<TaskSpec, { kind: "file.push" }>;
type FilePullSpec = Extract<TaskSpec, { kind: "file.pull" }>;
type FileEditSpec = Extract<TaskSpec, { kind: "file.edit" }>;
type FileStatSpec = Extract<TaskSpec, { kind: "file.stat" }>;
type FileListSpec = Extract<TaskSpec, { kind: "file.list" }>;

/** The crhs-side location of an SSH transfer: SFTP streams directly from or to it. */
export interface SftpTransfer {
	openRead(): Readable;
	openWrite(): TransferWrite;
}

interface Ctx {
	sftp: Sftp;
	signal: AbortSignal;
}

function checkAborted(signal: AbortSignal): void {
	if (signal.aborted) {
		throw new FileTaskError("cancelled", "task cancelled");
	}
}

/**
 * Runs a file.* task over SFTP with the same semantics, output and error codes as crha's
 * client/internal/executor/file*.go. `stdout` receives the task's text output (the page of a
 * file.read); the task's structured result is returned, never written to a stream
 * (doc/design/protocol.md "Task results").
 */
export async function runSftpFileTask(
	sftp: SFTPWrapper,
	spec: TaskSpec,
	input: Uint8Array | undefined,
	stdout: Out,
	signal: AbortSignal,
	transfer?: SftpTransfer,
): Promise<TaskResult | null> {
	const ctx: Ctx = { sftp: new Sftp(sftp), signal };
	try {
		checkAborted(signal);
		switch (spec.kind) {
			case "file.read":
				return await fileRead(ctx, spec, stdout);
			case "file.write":
				return await fileWrite(ctx, spec, input);
			case "file.push":
				return await filePush(ctx, spec, transfer);
			case "file.pull":
				return await filePull(ctx, spec, transfer);
			case "file.edit":
				return await fileEdit(ctx, spec);
			case "file.stat":
				return await fileStat(ctx, spec);
			case "file.list":
				return await fileList(ctx, spec);
			default:
				throw new FileTaskError("invalid_spec", "not a file task");
		}
	} catch (e) {
		throw mapError(e, signal);
	}
}

async function fileRead(ctx: Ctx, s: FileReadSpec, stdout: Out): Promise<TaskResult> {
	checkPath(s.path);
	if (s.startLine < 1 || s.lineCount < 1) {
		throw new FileTaskError("invalid_spec", "startLine and lineCount must be at least 1");
	}
	const { sftp, signal } = ctx;
	const st = await sftp.stat(s.path);
	if ((st.mode & S_IFMT) === S_IFDIR) {
		throw new FileTaskError("is_directory", `${s.path} is a directory`);
	}
	const result: FileReadResult = { from: 0, to: 0, eof: false, total: null, tooLong: false };
	const handle = await sftp.open(s.path, "r");
	try {
		let pos = 0;
		let line = 1;
		let pageLines = 0;
		let written = 0;
		let part: Buffer = Buffer.alloc(0);
		let done = false;
		// TODO: detect changes by mtime and cache a line index per open handle, so a deep page does not re-read the file from the start.
		// Stream from the first byte and stop as soon as the page is complete: only a page that reaches
		// the end reads the whole file (doc/design/execution.md "SFTP file operations").
		while (!done) {
			checkAborted(signal);
			const chunk = Buffer.allocUnsafe(CHUNK);
			const n = await sftp.readAt(handle, chunk, CHUNK, pos);
			if (n === 0) {
				// The file ends here: at a line boundary, or inside a last line without a newline.
				result.eof = true;
				if (part.length > 0) {
					stdout(part);
					if (pageLines === 0) result.from = line;
					result.to = line;
					result.total = line;
				} else {
					result.total = line - 1;
				}
				break;
			}
			pos += n;
			const data = chunk.subarray(0, n);
			let start = 0;
			while (start < n) {
				const nl = data.indexOf(0x0a, start);
				const end = nl < 0 ? n : nl + 1;
				if (line >= s.startLine) {
					// The page keeps whole lines only: a line that would pass the byte cap ends it.
					if (written + part.length + (end - start) > FILE_READ_MAX_BYTES) {
						if (pageLines === 0) result.tooLong = true;
						done = true;
						break;
					}
					part = Buffer.concat([part, data.subarray(start, end)]);
				}
				if (nl < 0) break; // the line goes on in the next chunk
				if (line >= s.startLine) {
					stdout(part);
					written += part.length;
					if (pageLines === 0) result.from = line;
					result.to = line;
					pageLines++;
					part = Buffer.alloc(0);
				}
				// Where the line's newline ends, to tell whether it was the file's last byte.
				const lineEnd = pos - n + end;
				line++;
				start = end;
				if (pageLines >= s.lineCount) {
					if (lineEnd >= st.size) {
						result.eof = true;
						result.total = result.to;
					}
					done = true;
					break;
				}
			}
		}
	} finally {
		await sftp.close(handle).catch(() => {});
	}
	return { kind: "file.read", ...result };
}

interface TempFile {
	handle: Buffer;
	name: string;
	closed: boolean;
}

async function createTemp(sftp: Sftp, path: string): Promise<TempFile> {
	const dir = posix.dirname(path);
	const base = posix.basename(path);
	for (let i = 0; i < 10; i++) {
		const name = posix.join(dir, `.${base}.crh-${randomBytes(6).toString("hex")}`);
		try {
			return { handle: await sftp.open(name, "wx", 0o600), name, closed: false };
		} catch (e) {
			if (i < 9 && (await sftp.lstatOpt(name).catch(() => undefined))) {
				continue;
			}
			throw e;
		}
	}
	throw new FileTaskError("io_error", `cannot create temporary file in ${dir}`);
}

async function discard(sftp: Sftp, tmp: TempFile): Promise<void> {
	if (!tmp.closed) {
		tmp.closed = true;
		await sftp.close(tmp.handle).catch(() => {});
	}
	await sftp.unlink(tmp.name).catch(() => {});
}

async function writeAll(ctx: Ctx, tmp: TempFile, data: Uint8Array): Promise<void> {
	const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
	let pos = 0;
	while (pos < buf.length) {
		checkAborted(ctx.signal);
		const batch: Promise<void>[] = [];
		for (let i = 0; i < WRITE_WINDOW && pos < buf.length; i++) {
			const chunk = buf.subarray(pos, Math.min(pos + CHUNK, buf.length));
			batch.push(ctx.sftp.writeAt(tmp.handle, chunk, pos));
			pos += chunk.length;
		}
		await Promise.all(batch);
	}
}

/** Closes the temp file and moves it over (or, with noReplace, to a not-yet-existing) path. */
async function publish(sftp: Sftp, tmp: TempFile, path: string, noReplace: boolean): Promise<void> {
	tmp.closed = true;
	await sftp.close(tmp.handle);
	if (noReplace) {
		const exists = () => new FileTaskError("exists", `${path} already exists`);
		if (await sftp.lstatOpt(path)) {
			throw exists();
		}
		try {
			await sftp.rename(tmp.name, path);
		} catch (e) {
			// SFTPv3 rename fails on an existing target, often with a generic failure.
			if (await sftp.lstatOpt(path).catch(() => undefined)) {
				throw exists();
			}
			throw e;
		}
		return;
	}
	if (await sftp.posixRename(tmp.name, path)) {
		return;
	}
	// No posix-rename extension: not atomic, but the best SFTPv3 allows.
	await sftp.unlink(path).catch(() => {});
	await sftp.rename(tmp.name, path);
}

/** Creates every missing parent directory of `path`, 0755 before the remote umask, like mkdir -p. */
async function makeParentDirs(sftp: Sftp, path: string, signal: AbortSignal): Promise<void> {
	const dir = posix.dirname(path);
	if (dir === "/" || dir === ".") return;
	let prefix = "";
	for (const part of dir.split("/").filter(Boolean)) {
		checkAborted(signal);
		prefix += `/${part}`;
		const st = await sftp.lstatOpt(prefix);
		if (st !== undefined) {
			if ((st.mode & S_IFMT) !== S_IFDIR) {
				throw new FileTaskError("not_found", `${path}: ${prefix} is not a directory`);
			}
			continue;
		}
		try {
			await sftp.mkdir(prefix, 0o755);
		} catch (e) {
			// mkdir -p: another writer may have created it since the lstat.
			const now = await sftp.lstatOpt(prefix).catch(() => undefined);
			if (now === undefined || (now.mode & S_IFMT) !== S_IFDIR) throw e;
		}
	}
}

async function fileWrite(ctx: Ctx, s: FileWriteSpec, input: Uint8Array | undefined): Promise<TaskResult> {
	const { sftp } = ctx;
	const path = s.path;
	checkPath(path);
	if (!s.content) {
		throw new FileTaskError("invalid_spec", "content is required");
	}
	if (s.owner !== "" || s.group !== "") {
		throw new FileTaskError("invalid_spec", "owner/group are not supported on SSH nodes");
	}
	const data = input ?? new Uint8Array(0);
	const existing = await sftp.lstatOpt(path);
	if (existing && (existing.mode & S_IFMT) === S_IFDIR) {
		throw new FileTaskError("is_directory", `${path} is a directory`);
	}
	if (data.length !== s.content.size) {
		throw new FileTaskError("input_mismatch", `content does not match declared size/sha256 (got ${data.length} bytes)`);
	}
	if (s.createParentDirs) {
		// mkdir -p, with the new directories 0755 before the remote umask. SFTP cannot set an
		// owner/group by name, so like the file itself they belong to the SSH user.
		await makeParentDirs(sftp, path, ctx.signal);
	}
	const tmp = await createTemp(sftp, path);
	let ok = false;
	try {
		await writeAll(ctx, tmp, data);
		let mode = 0o644;
		if (s.mode !== 0) {
			mode = s.mode & 0o7777;
		} else if (existing) {
			mode = existing.mode & 0o7777;
		}
		if (existing) {
			// Best effort: only root can usually do this.
			await sftp.fchown(tmp.handle, existing.uid, existing.gid).catch(() => {});
		}
		await sftp.fchmod(tmp.handle, mode);
		checkAborted(ctx.signal);
		await publish(sftp, tmp, path, !s.overwrite);
		ok = true;
	} finally {
		if (!ok) {
			await discard(sftp, tmp);
		}
	}
	return { kind: "file.write", bytes: data.length, created: !existing };
}

async function filePush(ctx: Ctx, s: FilePushSpec, transfer: SftpTransfer | undefined): Promise<TaskResult | null> {
	const { sftp } = ctx;
	const path = s.path;
	checkPath(path);
	if (!transfer) throw new FileTaskError("invalid_spec", "the transfer location is missing");
	if (s.owner !== "" || s.group !== "") {
		throw new FileTaskError("invalid_spec", "owner/group are not supported on SSH nodes");
	}
	const existing = await sftp.lstatOpt(path);
	if (existing && (existing.mode & S_IFMT) === S_IFDIR) {
		throw new FileTaskError("is_directory", `${path} is a directory`);
	}
	if (s.createParentDirs) {
		// Same mkdir -p as file.write: the new directories are 0755 before the remote umask and belong to
		// the SSH user, like the file itself (SFTP cannot set an owner by name).
		await makeParentDirs(sftp, path, ctx.signal);
	}
	const tmp = await createTemp(sftp, path);
	const hash = createHash("sha256");
	let size = 0;
	let ok = false;
	try {
		for await (const chunk of transfer.openRead()) {
			const data = Buffer.from(chunk as Buffer);
			checkAborted(ctx.signal);
			size += data.length;
			hash.update(data);
			if (size > s.size) throw new FileTaskError("input_mismatch", `content is longer than ${s.size} bytes`);
			await writeAll(ctx, tmp, data);
		}
		const sha256 = hash.digest("hex");
		if (size !== s.size || sha256 !== Buffer.from(s.sha256).toString("hex")) {
			throw new FileTaskError("input_mismatch", `content does not match declared size/sha256 (got ${size} bytes)`);
		}
		let mode = 0o644;
		if (s.mode !== 0) {
			mode = s.mode & 0o7777;
		} else if (existing) {
			mode = existing.mode & 0o7777;
		}
		if (existing) await sftp.fchown(tmp.handle, existing.uid, existing.gid).catch(() => {});
		await sftp.fchmod(tmp.handle, mode);
		checkAborted(ctx.signal);
		await publish(sftp, tmp, path, !s.overwrite);
		ok = true;
	} finally {
		if (!ok) await discard(sftp, tmp);
	}
	// A push reports nothing structured (doc/design/library.md "File plane").
	return null;
}

async function filePull(ctx: Ctx, s: FilePullSpec, transfer: SftpTransfer | undefined): Promise<TaskResult> {
	const { sftp } = ctx;
	const path = s.path;
	checkPath(path);
	if (!transfer) throw new FileTaskError("invalid_spec", "the transfer location is missing");
	const st = await sftp.stat(path);
	if ((st.mode & S_IFMT) !== S_IFREG) {
		throw new FileTaskError("not_regular_file", `${path} is not a regular file`);
	}
	if (st.size > s.maxBytes) {
		throw new FileTaskError("too_large", `${path} is ${st.size} bytes, the destination accepts at most ${s.maxBytes}`);
	}
	const write = transfer.openWrite();
	const hash = createHash("sha256");
	let size = 0;
	let ok = false;
	let handle: Buffer | undefined;
	try {
		handle = await sftp.open(path, "r");
		for (;;) {
			checkAborted(ctx.signal);
			const buf = Buffer.allocUnsafe(CHUNK);
			const n = await sftp.readAt(handle, buf, CHUNK, size);
			if (n === 0) break;
			const data = buf.subarray(0, n);
			size += n;
			if (size > s.maxBytes) {
				throw new FileTaskError("too_large", `${path} grew past the destination's limit of ${s.maxBytes} bytes`);
			}
			hash.update(data);
			await write.write(data);
		}
		const sha256 = hash.digest("hex");
		await write.finish();
		await write.commit({ size, sha256 });
		ok = true;
		return { kind: "file.pull", size, sha256: Uint8Array.from(Buffer.from(sha256, "hex")) };
	} finally {
		if (handle !== undefined) await sftp.close(handle).catch(() => {});
		if (!ok) await write.discard();
	}
}

async function fileEdit(ctx: Ctx, s: FileEditSpec): Promise<TaskResult> {
	const { sftp } = ctx;
	const path = s.path;
	checkPath(path);
	if (s.edits.length === 0) {
		throw new FileTaskError("invalid_spec", "edits must not be empty");
	}
	const st = await sftp.stat(path);
	if ((st.mode & S_IFMT) === S_IFDIR) {
		throw new FileTaskError("is_directory", `${path} is a directory`);
	}
	if (st.size > MAX_EDIT_SIZE) {
		throw new FileTaskError("too_large", `${path} is ${st.size} bytes, limit is ${MAX_EDIT_SIZE}`);
	}
	const chunks: Buffer[] = [];
	let total = 0;
	const handle = await sftp.open(path, "r");
	try {
		for (;;) {
			checkAborted(ctx.signal);
			const buf = Buffer.allocUnsafe(CHUNK);
			const n = await sftp.readAt(handle, buf, CHUNK, total);
			if (n === 0) {
				break;
			}
			chunks.push(buf.subarray(0, n));
			total += n;
			if (total > MAX_EDIT_SIZE) {
				throw new FileTaskError("too_large", `${path} exceeds ${MAX_EDIT_SIZE} bytes`);
			}
		}
	} finally {
		await sftp.close(handle).catch(() => {});
	}
	let raw = Buffer.concat(chunks);
	let bom: Buffer = Buffer.alloc(0);
	if (raw.subarray(0, 3).equals(UTF8_BOM)) {
		bom = UTF8_BOM;
		raw = raw.subarray(3);
	}
	const text = raw.toString("latin1");
	const ending = detectLineEnding(text);
	let out = applyEdits(
		normalizeToLF(text),
		s.edits.map((e) => ({ oldText: toBytesString(e.oldText), newText: toBytesString(e.newText) })),
		path,
	);
	if (ending === "\r\n") {
		out = out.replaceAll("\n", "\r\n");
	}
	const result = Buffer.concat([bom, Buffer.from(out, "latin1")]);

	const tmp = await createTemp(sftp, path);
	let ok = false;
	try {
		await writeAll(ctx, tmp, result);
		await sftp.fchown(tmp.handle, st.uid, st.gid).catch(() => {});
		await sftp.fchmod(tmp.handle, st.mode & 0o7777);
		checkAborted(ctx.signal);
		await publish(sftp, tmp, path, false);
		ok = true;
	} finally {
		if (!ok) {
			await discard(sftp, tmp);
		}
	}
	return { kind: "file.edit", replacements: s.edits.length };
}

async function fileStat(ctx: Ctx, s: FileStatSpec): Promise<TaskResult> {
	checkPath(s.path);
	const st = await ctx.sftp.lstat(s.path);
	const result: FileStatResult = {
		path: s.path,
		type: fileType(st.mode),
		size: st.size,
		mode: modeString(st.mode),
		uid: st.uid,
		gid: st.gid,
		owner: "",
		group: "",
		mtime: mtimeString(st.mtime),
		linkTarget: null,
	};
	if ((st.mode & S_IFMT) === S_IFLNK) {
		result.linkTarget = await ctx.sftp.readlink(s.path);
	}
	return { kind: "file.stat", ...result };
}

async function fileList(ctx: Ctx, s: FileListSpec): Promise<TaskResult> {
	checkPath(s.path);
	let limit = s.limit === 0 ? DEFAULT_LIST_LIMIT : s.limit;
	limit = Math.min(limit, MAX_LIST_LIMIT);
	const st = await ctx.sftp.stat(s.path);
	if ((st.mode & S_IFMT) !== S_IFDIR) {
		throw new FileTaskError("not_a_directory", `${s.path} is not a directory`);
	}
	const all = (await ctx.sftp.readdir(s.path)).filter((e) => e.filename !== "." && e.filename !== "..");
	all.sort((a, b) => Buffer.compare(Buffer.from(a.filename), Buffer.from(b.filename)));
	let truncated = all.length > limit;
	const entries: FileListEntry[] = [];
	let used = 0;
	for (const e of all.slice(0, limit)) {
		const entry: FileListEntry = {
			name: e.filename,
			type: fileType(e.attrs.mode),
			size: e.attrs.size,
			mode: modeString(e.attrs.mode),
			mtime: mtimeString(e.attrs.mtime),
		};
		// The result travels in one task.exit frame: stop before it could outgrow it
		// (doc/design/protocol.md "Task results").
		const size = listEntrySize(entry);
		if (used + size > FILE_LIST_MAX_BYTES) {
			truncated = true;
			break;
		}
		used += size;
		entries.push(entry);
	}
	checkAborted(ctx.signal);
	return { kind: "file.list", entries, truncated };
}

/** A safe upper bound of the encoded size of one list entry: its fields plus the CBOR overhead. */
function listEntrySize(e: FileListEntry): number {
	return e.name.length + e.type.length + e.mode.length + e.mtime.length + 24;
}
