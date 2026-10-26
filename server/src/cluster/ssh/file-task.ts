import { randomBytes } from "node:crypto";
import { posix } from "node:path";
import type { FileEditSpec, FileListSpec, FileReadSpec, FileStatSpec, FileWriteSpec, TaskSpec } from "@crh/protocol";
import type { SFTPWrapper } from "ssh2";
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
	Sftp,
} from "./file-sftp.ts";

export { FileTaskError };

const DEFAULT_LIST_LIMIT = 500;
const MAX_LIST_LIMIT = 5000;
const CHUNK = 32 * 1024;
const WRITE_WINDOW = 16;

type Out = (data: Uint8Array) => void;

interface Ctx {
	sftp: Sftp;
	signal: AbortSignal;
}

function checkAborted(signal: AbortSignal): void {
	if (signal.aborted) {
		throw new FileTaskError("cancelled", "task cancelled");
	}
}

function writeJSON(stdout: Out, v: unknown): void {
	stdout(Buffer.from(JSON.stringify(v)));
}

/**
 * Runs a file.* task over SFTP with the same semantics, JSON output and error codes as crha's
 * client/internal/executor/file*.go. `stdout` receives the task's output stream.
 */
export async function runSftpFileTask(
	sftp: SFTPWrapper,
	spec: TaskSpec,
	input: Uint8Array | undefined,
	stdout: Out,
	signal: AbortSignal,
): Promise<void> {
	const ctx: Ctx = { sftp: new Sftp(sftp), signal };
	try {
		checkAborted(signal);
		const kind = spec.kind;
		switch (kind.case) {
			case "fileRead":
				return await fileRead(ctx, kind.value, stdout);
			case "fileWrite":
				return await fileWrite(ctx, kind.value, input, stdout);
			case "fileEdit":
				return await fileEdit(ctx, kind.value, stdout);
			case "fileStat":
				return await fileStat(ctx, kind.value, stdout);
			case "fileList":
				return await fileList(ctx, kind.value, stdout);
			default:
				throw new FileTaskError("invalid_spec", "not a file task");
		}
	} catch (e) {
		throw mapError(e, signal);
	}
}

async function fileRead(ctx: Ctx, s: FileReadSpec, stdout: Out): Promise<void> {
	checkPath(s.path);
	const { sftp, signal } = ctx;
	const st = await sftp.stat(s.path);
	if ((st.mode & S_IFMT) === S_IFDIR) {
		throw new FileTaskError("is_directory", `${s.path} is a directory`);
	}
	const handle = await sftp.open(s.path, "r");
	try {
		let pos = Number(s.offset);
		let remaining = s.limit > 0n ? Number(s.limit) : Number.POSITIVE_INFINITY;
		while (remaining > 0) {
			checkAborted(signal);
			const want = Math.min(CHUNK, remaining);
			const buf = Buffer.allocUnsafe(want);
			const n = await sftp.readAt(handle, buf, want, pos);
			if (n === 0) {
				break;
			}
			stdout(buf.subarray(0, n));
			pos += n;
			remaining -= n;
		}
	} finally {
		await sftp.close(handle).catch(() => {});
	}
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

async function fileWrite(ctx: Ctx, s: FileWriteSpec, input: Uint8Array | undefined, stdout: Out): Promise<void> {
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
	if (BigInt(data.length) !== s.content.size) {
		throw new FileTaskError("input_mismatch", `content does not match declared size/sha256 (got ${data.length} bytes)`);
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
	writeJSON(stdout, { bytes: data.length, created: !existing });
}

async function fileEdit(ctx: Ctx, s: FileEditSpec, stdout: Out): Promise<void> {
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
	writeJSON(stdout, { replacements: s.edits.length });
}

async function fileStat(ctx: Ctx, s: FileStatSpec, stdout: Out): Promise<void> {
	checkPath(s.path);
	const st = await ctx.sftp.lstat(s.path);
	const out: Record<string, unknown> = {
		gid: st.gid,
		group: "",
		mode: modeString(st.mode),
		mtime: mtimeString(st.mtime),
		owner: "",
		path: s.path,
		size: st.size,
		type: fileType(st.mode),
		uid: st.uid,
	};
	if ((st.mode & S_IFMT) === S_IFLNK) {
		out.link_target = await ctx.sftp.readlink(s.path);
	}
	writeJSON(stdout, out);
}

async function fileList(ctx: Ctx, s: FileListSpec, stdout: Out): Promise<void> {
	checkPath(s.path);
	let limit = s.limit === 0 ? DEFAULT_LIST_LIMIT : s.limit;
	limit = Math.min(limit, MAX_LIST_LIMIT);
	const st = await ctx.sftp.stat(s.path);
	if ((st.mode & S_IFMT) !== S_IFDIR) {
		throw new FileTaskError("not_a_directory", `${s.path} is not a directory`);
	}
	const all = (await ctx.sftp.readdir(s.path)).filter((e) => e.filename !== "." && e.filename !== "..");
	all.sort((a, b) => Buffer.compare(Buffer.from(a.filename), Buffer.from(b.filename)));
	const truncated = all.length > limit;
	const entries = all.slice(0, limit).map((e) => ({
		name: e.filename,
		type: fileType(e.attrs.mode),
		size: e.attrs.size,
		mode: modeString(e.attrs.mode),
		mtime: mtimeString(e.attrs.mtime),
	}));
	checkAborted(ctx.signal);
	writeJSON(stdout, { entries, truncated });
}
