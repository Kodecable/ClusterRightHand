import { posix } from "node:path";
import type { FileEntryWithStats, SFTPWrapper, Stats } from "ssh2";

/** A file task failure, reported like crha's executor.Error (same codes). */
export class FileTaskError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.code = code;
	}
}

// SFTP status codes (draft-ietf-secsh-filexfer-02).
const SFTP_EOF = 1;
const SFTP_NO_SUCH_FILE = 2;
const SFTP_PERMISSION_DENIED = 3;

export const S_IFMT = 0o170000;
export const S_IFREG = 0o100000;
export const S_IFDIR = 0o040000;
export const S_IFLNK = 0o120000;

/** Converts any failure into a FileTaskError with the executor's code vocabulary. */
export function mapError(err: unknown, signal?: AbortSignal): FileTaskError {
	if (err instanceof FileTaskError) {
		return err;
	}
	if (signal?.aborted) {
		return new FileTaskError("cancelled", "task cancelled");
	}
	const message = err instanceof Error ? err.message : String(err);
	const code = (err as { code?: unknown } | null)?.code;
	if (code === SFTP_NO_SUCH_FILE) {
		return new FileTaskError("not_found", message);
	}
	if (code === SFTP_PERMISSION_DENIED) {
		return new FileTaskError("permission_denied", message);
	}
	return new FileTaskError("io_error", message);
}

/** Absolute and clean, like Go's filepath.IsAbs && filepath.Clean(p) == p. */
export function checkPath(p: string): void {
	const clean = p === "/" || (p.startsWith("/") && !p.endsWith("/") && posix.normalize(p) === p);
	if (!clean) {
		throw new FileTaskError("invalid_spec", `path must be absolute and clean: ${JSON.stringify(p)}`);
	}
}

export function modeString(mode: number): string {
	return (mode & 0o777).toString(8).padStart(4, "0");
}

export function fileType(mode: number): string {
	switch (mode & S_IFMT) {
		case S_IFREG:
			return "file";
		case S_IFDIR:
			return "dir";
		case S_IFLNK:
			return "symlink";
		default:
			return "other";
	}
}

/** Matches Go's time.RFC3339Nano for whole seconds (no fractional part). */
export function mtimeString(seconds: number): string {
	return new Date(seconds * 1000).toISOString().replace(".000Z", "Z");
}

/** Promise-based view of the SFTP calls the file tasks use. */
export class Sftp {
	readonly raw: SFTPWrapper;

	constructor(raw: SFTPWrapper) {
		this.raw = raw;
	}

	private call<T>(fn: (cb: (err: Error | null | undefined, value: T) => void) => void): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			try {
				fn((err, value) => (err ? reject(err) : resolve(value)));
			} catch (e) {
				reject(e);
			}
		});
	}

	stat(path: string): Promise<Stats> {
		return this.call((cb) => this.raw.stat(path, cb));
	}

	lstat(path: string): Promise<Stats> {
		return this.call((cb) => this.raw.lstat(path, cb));
	}

	/** lstat that maps a missing file to undefined. */
	async lstatOpt(path: string): Promise<Stats | undefined> {
		try {
			return await this.lstat(path);
		} catch (e) {
			if ((e as { code?: unknown }).code === SFTP_NO_SUCH_FILE) {
				return undefined;
			}
			throw e;
		}
	}

	readlink(path: string): Promise<string> {
		return this.call((cb) => this.raw.readlink(path, cb));
	}

	readdir(path: string): Promise<FileEntryWithStats[]> {
		return this.call((cb) => this.raw.readdir(path, cb));
	}

	open(path: string, flags: "r" | "wx", mode?: number): Promise<Buffer> {
		if (mode === undefined) {
			return this.call((cb) => this.raw.open(path, flags, cb));
		}
		return this.call((cb) => this.raw.open(path, flags, mode, cb));
	}

	async close(handle: Buffer): Promise<void> {
		await this.call<void>((cb) => this.raw.close(handle, cb as (e?: Error | null) => void));
	}

	fstat(handle: Buffer): Promise<Stats> {
		return this.call((cb) => this.raw.fstat(handle, cb));
	}

	async fchmod(handle: Buffer, mode: number): Promise<void> {
		await this.call<void>((cb) => this.raw.fchmod(handle, mode, cb as (e?: Error | null) => void));
	}

	async fchown(handle: Buffer, uid: number, gid: number): Promise<void> {
		await this.call<void>((cb) => this.raw.fsetstat(handle, { uid, gid }, cb as (e?: Error | null) => void));
	}

	async unlink(path: string): Promise<void> {
		await this.call<void>((cb) => this.raw.unlink(path, cb as (e?: Error | null) => void));
	}

	async rename(from: string, to: string): Promise<void> {
		await this.call<void>((cb) => this.raw.rename(from, to, cb as (e?: Error | null) => void));
	}

	/** posix-rename@openssh.com; resolves false when the server lacks the extension. */
	async posixRename(from: string, to: string): Promise<boolean> {
		try {
			await this.call<void>((cb) => this.raw.ext_openssh_rename(from, to, cb as (e?: Error | null) => void));
			return true;
		} catch (e) {
			if (e instanceof Error && e.message.includes("does not support")) {
				return false;
			}
			throw e;
		}
	}

	/** Creates one directory; the mode is subject to the remote umask, like mkdir(2) (D114). */
	async mkdir(path: string, mode: number): Promise<void> {
		await this.call<void>((cb) => this.raw.mkdir(path, { mode }, cb as (e?: Error | null) => void));
	}

	/** Reads up to len bytes at position; returns the bytes read (0 at EOF). */
	async readAt(handle: Buffer, buf: Buffer, len: number, position: number): Promise<number> {
		try {
			return await this.call<number>((cb) => this.raw.read(handle, buf, 0, len, position, (err, n) => cb(err, n)));
		} catch (e) {
			if ((e as { code?: unknown }).code === SFTP_EOF) {
				return 0;
			}
			throw e;
		}
	}

	writeAt(handle: Buffer, data: Buffer, position: number): Promise<void> {
		return this.call<void>((cb) =>
			this.raw.write(handle, data, 0, data.length, position, cb as (e?: Error | null) => void),
		);
	}
}
