import { FILE_READ_MAX_BYTES, type FileReadResult, type TaskResult, type TaskSpec } from "@crh/protocol";
import type { SFTPWrapper } from "ssh2";
import { describe, expect, it } from "vitest";
import { FileTaskError, runSftpFileTask } from "../src/cluster/ssh/file-task.ts";

/**
 * file.read over SFTP without a server: a fake wrapper over one in-memory file, which also records
 * how much it was asked to read. The page streams from the start and stops when it is complete, so a
 * short page of a long file reads far less than the file (doc/design/execution.md "SFTP file operations").
 */
interface FakeSftp {
	wrapper: SFTPWrapper;
	bytesRead: number;
	requests: number;
}

function fakeSftp(file: { path: string; content: Buffer; mode?: number; missing?: boolean }): FakeSftp {
	const fake: FakeSftp = {
		wrapper: undefined as unknown as SFTPWrapper,
		bytesRead: 0,
		requests: 0,
	};
	const stats = {
		mode: file.mode ?? 0o100644,
		size: file.content.length,
		uid: 0,
		gid: 0,
		atime: 0,
		mtime: 0,
	};
	fake.wrapper = {
		stat(path: string, cb: (err: Error | null, s?: unknown) => void) {
			if (file.missing || path !== file.path) {
				cb(Object.assign(new Error("no such file"), { code: 2 }));
				return;
			}
			cb(null, stats);
		},
		open(path: string, _flags: string, cb: (err: Error | null, handle?: Buffer) => void) {
			if (file.missing || path !== file.path) {
				cb(Object.assign(new Error("no such file"), { code: 2 }));
				return;
			}
			cb(null, Buffer.from([1]));
		},
		read(
			_handle: Buffer,
			buf: Buffer,
			offset: number,
			length: number,
			position: number,
			cb: (err: Error | null, n?: number) => void,
		) {
			const n = Math.max(0, Math.min(length, file.content.length - position));
			file.content.copy(buf, offset, position, position + n);
			fake.bytesRead += n;
			fake.requests += 1;
			cb(null, n);
		},
		close(_handle: Buffer, cb: (err: Error | null) => void) {
			cb(null);
		},
	} as unknown as SFTPWrapper;
	return fake;
}

async function readPage(
	content: string,
	value: { startLine?: number; lineCount?: number } = {},
): Promise<{ page: string; result: FileReadResult; sftp: FakeSftp }> {
	const path = "/srv/f";
	const fake = fakeSftp({ path, content: Buffer.from(content) });
	const spec = {
		kind: "file.read",
		path,
		startLine: value.startLine ?? 1,
		lineCount: value.lineCount ?? 2000,
	} as TaskSpec;
	const out: Uint8Array[] = [];
	const task: TaskResult = await runSftpFileTask(
		fake.wrapper,
		spec,
		undefined,
		(d) => out.push(Buffer.from(d)),
		new AbortController().signal,
	);
	if (task.kind !== "file.read") throw new Error(`task result is ${task.kind}, want file.read`);
	return { page: Buffer.concat(out).toString(), result: task, sftp: fake };
}

async function failure(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
	} catch (e) {
		expect(e).toBeInstanceOf(FileTaskError);
		return (e as FileTaskError).code;
	}
	return "";
}

describe("file.read over SFTP", () => {
	it("pages by lines", async () => {
		const { page, result } = await readPage("one\ntwo\nthree\nfour\n", { startLine: 2, lineCount: 2 });
		expect(page).toBe("two\nthree\n");
		expect(result).toEqual({ kind: "file.read", from: 2, to: 3, eof: false, total: null, tooLong: false });
	});

	it("reports the end of the file and its line count", async () => {
		const { page, result } = await readPage("one\ntwo\nthree\n", { startLine: 2, lineCount: 10 });
		expect(page).toBe("two\nthree\n");
		expect(result).toEqual({ kind: "file.read", from: 2, to: 3, eof: true, total: 3, tooLong: false });
	});

	it("knows the end of the file when a page ends exactly on it", async () => {
		const { page, result } = await readPage("one\ntwo\n", { startLine: 1, lineCount: 2 });
		expect(page).toBe("one\ntwo\n");
		expect(result).toEqual({ kind: "file.read", from: 1, to: 2, eof: true, total: 2, tooLong: false });
	});

	it("reports a line count for a start line past the end", async () => {
		const { page, result } = await readPage("one\ntwo\n", { startLine: 9, lineCount: 1 });
		expect(page).toBe("");
		expect(result).toEqual({ kind: "file.read", from: 0, to: 0, eof: true, total: 2, tooLong: false });
	});

	it("keeps a last line without a newline", async () => {
		const { page, result } = await readPage("one\ntwo", { startLine: 2, lineCount: 1 });
		expect(page).toBe("two");
		expect(result).toEqual({ kind: "file.read", from: 2, to: 2, eof: true, total: 2, tooLong: false });
	});

	it("counts CRLF lines at their newline", async () => {
		const { page, result } = await readPage("one\r\ntwo\r\n", { startLine: 2, lineCount: 1 });
		expect(page).toBe("two\r\n");
		expect(result).toEqual({ kind: "file.read", from: 2, to: 2, eof: true, total: 2, tooLong: false });
	});

	it("stops a page at the byte cap and keeps whole lines", async () => {
		const line = `${"x".repeat(999)}\n`;
		const { page, result } = await readPage(line.repeat(60));
		expect(Buffer.byteLength(page)).toBe(51 * 1000);
		expect(result).toEqual({ kind: "file.read", from: 1, to: 51, eof: false, total: null, tooLong: false });
	});

	it("reports a first line that does not fit the byte cap", async () => {
		const { page, result } = await readPage(`${"x".repeat(FILE_READ_MAX_BYTES)}\n`);
		expect(page).toBe("");
		expect(result).toEqual({ kind: "file.read", from: 0, to: 0, eof: false, total: null, tooLong: true });
	});

	it("reads only as far as the page needs", async () => {
		const content = Array.from({ length: 2000 }, (_, i) => `${String(i).padStart(999, "0")}\n`).join("");
		const { page, result, sftp } = await readPage(content, { lineCount: 2 });
		expect(page.split("\n").length).toBe(3); // two lines and the empty end of the split
		expect(result).toEqual({ kind: "file.read", from: 1, to: 2, eof: false, total: null, tooLong: false });
		expect(sftp.bytesRead).toBe(32 * 1024); // one chunk: the page was complete before the file was
	});

	it("fails on a directory or a missing file", async () => {
		const dir = fakeSftp({ path: "/srv", content: Buffer.alloc(0), mode: 0o040755 });
		const spec = { kind: "file.read", path: "/srv", startLine: 1, lineCount: 1 } as TaskSpec;
		expect(await failure(runSftpFileTask(dir.wrapper, spec, undefined, () => {}, new AbortController().signal))).toBe(
			"is_directory",
		);

		const missing = fakeSftp({ path: "/srv/f", content: Buffer.alloc(0), missing: true });
		expect(
			await failure(runSftpFileTask(missing.wrapper, spec, undefined, () => {}, new AbortController().signal)),
		).toBe("not_found");
	});

	it("rejects a line range outside the protocol", async () => {
		await expect(readPage("x\n", { startLine: 0 })).rejects.toMatchObject({ code: "invalid_spec" });
		await expect(readPage("x\n", { lineCount: 0 })).rejects.toMatchObject({ code: "invalid_spec" });
	});
});
