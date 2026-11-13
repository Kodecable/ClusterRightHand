import type { TaskSpec } from "@crh/protocol";
import type { SFTPWrapper } from "ssh2";
import { describe, expect, it } from "vitest";
import { FileTaskError, runSftpFileTask, type SftpTransfer } from "../src/cluster/ssh/file-task.ts";
import type { TransferWrite } from "../src/library/transfer-location.ts";

/**
 * file.pull over SFTP without a server (doc/design/library.md "File plane"): a fake wrapper over one
 * file whose reads can fail, and a fake crhs-side write that records whether it was discarded. A pull
 * that cannot commit must always discard the partial write it had already received.
 */

interface FakeWrite {
	transfer: SftpTransfer;
	writes: number;
	discarded: number;
	committed: boolean;
}

function fakeTransfer(onWrite?: () => void): FakeWrite {
	const state: FakeWrite = {
		transfer: undefined as unknown as SftpTransfer,
		writes: 0,
		discarded: 0,
		committed: false,
	};
	const write: TransferWrite = {
		async write() {
			state.writes += 1;
			onWrite?.();
		},
		async finish() {
			return { size: 0, sha256: "0".repeat(64) };
		},
		async commit() {
			state.committed = true;
		},
		async discard() {
			state.discarded += 1;
		},
	};
	state.transfer = {
		openRead: () => {
			throw new Error("a pull does not read");
		},
		openWrite: () => write,
	};
	return state;
}

/** One regular file whose `read` answers the calls: bytes read, or the error the read fails with. */
function fakeSftp(file: {
	path: string;
	size: number;
	read: (position: number, buf: Buffer) => number | Error;
}): SFTPWrapper {
	const stats = { mode: 0o100644, size: file.size, uid: 0, gid: 0, atime: 0, mtime: 0 };
	return {
		stat(path: string, cb: (err: Error | null, s?: unknown) => void) {
			if (path !== file.path) {
				cb(Object.assign(new Error("no such file"), { code: 2 }));
				return;
			}
			cb(null, stats);
		},
		open(_path: string, _flags: string, cb: (err: Error | null, handle?: Buffer) => void) {
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
			const result = file.read(position, buf.subarray(offset, offset + length));
			if (result instanceof Error) cb(result);
			else cb(null, result);
		},
		close(_handle: Buffer, cb: (err: Error | null) => void) {
			cb(null);
		},
	} as unknown as SFTPWrapper;
}

async function pull(
	wrapper: SFTPWrapper,
	transfer: SftpTransfer,
	maxBytes = 1024,
	signal?: AbortSignal,
): Promise<void> {
	const spec = {
		kind: "file.pull",
		path: "/srv/file",
		maxBytes,
		endpoint: { kind: "crhs", transferId: "transfer-1" },
	} as TaskSpec;
	await runSftpFileTask(wrapper, spec, undefined, () => {}, signal ?? new AbortController().signal, transfer);
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

describe("file.pull over SFTP", () => {
	it("discards the received bytes when a read fails", async () => {
		const fake = fakeTransfer();
		const wrapper = fakeSftp({
			path: "/srv/file",
			size: 8,
			read: (position, buf) => {
				if (position > 0) return new Error("read failed");
				buf.write("ok");
				return 2;
			},
		});
		expect(await failure(pull(wrapper, fake.transfer))).toBe("io_error");
		expect(fake.writes).toBe(1);
		expect(fake.discarded).toBe(1);
		expect(fake.committed).toBe(false);
	});

	it("discards the received bytes when the file grows past maxBytes", async () => {
		const fake = fakeTransfer();
		const wrapper = fakeSftp({
			path: "/srv/file",
			// The stat was under the limit; the first read already delivers more.
			size: 3,
			read: (_position, buf) => {
				buf.write("123456789");
				return 9;
			},
		});
		expect(await failure(pull(wrapper, fake.transfer, 5))).toBe("too_large");
		expect(fake.discarded).toBe(1);
		expect(fake.committed).toBe(false);
	});

	it("discards the received bytes when the task is cancelled", async () => {
		const abort = new AbortController();
		const fake = fakeTransfer(() => abort.abort());
		const wrapper = fakeSftp({
			path: "/srv/file",
			size: 8,
			read: (_position, buf) => {
				buf.write("abcd");
				return 4;
			},
		});
		expect(await failure(pull(wrapper, fake.transfer, 1024, abort.signal))).toBe("cancelled");
		expect(fake.writes).toBe(1);
		expect(fake.discarded).toBe(1);
		expect(fake.committed).toBe(false);
	});

	it("discards the write when the file cannot be opened", async () => {
		const fake = fakeTransfer();
		const wrapper = {
			stat(_path: string, cb: (err: Error | null, s?: unknown) => void) {
				cb(null, { mode: 0o100644, size: 8, uid: 0, gid: 0, atime: 0, mtime: 0 });
			},
			open(_path: string, _flags: string, cb: (err: Error | null) => void) {
				cb(Object.assign(new Error("permission denied"), { code: 3 }));
			},
		} as unknown as SFTPWrapper;
		expect(await failure(pull(wrapper, fake.transfer))).toBe("permission_denied");
		expect(fake.discarded).toBe(1);
		expect(fake.committed).toBe(false);
	});
});
