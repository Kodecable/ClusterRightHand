import { encodeFrame, MAX_FRAME_BYTES, type TaskResult, type TaskSpec } from "@crh/protocol";
import type { SFTPWrapper } from "ssh2";
import { describe, expect, it } from "vitest";
import { runSftpFileTask } from "../src/cluster/ssh/file-task.ts";

/**
 * file.list over SFTP without a server: a fake directory whose entries the node lists. The entries
 * and the truncation flag are the task's result, never JSON on a stream, and a listing of a huge
 * directory stays inside one task.exit frame (doc/design/protocol.md "Task results").
 */

interface DirEntry {
	filename: string;
	attrs: { mode: number; uid: number; gid: number; size: number; atime: number; mtime: number };
}

function fakeDirectory(files: { name: string; mode?: number; size?: number }[]): {
	wrapper: SFTPWrapper;
	entries: DirEntry[];
} {
	const entries: DirEntry[] = files.map((f) => ({
		filename: f.name,
		attrs: { mode: f.mode ?? 0o100644, uid: 1000, gid: 1000, size: f.size ?? 0, atime: 0, mtime: 1_700_000_000 },
	}));
	const dirStats = { mode: 0o040755, size: 0, uid: 1000, gid: 1000, atime: 0, mtime: 1_700_000_000 };
	const wrapper = {
		stat(path: string, cb: (err: Error | null, s?: unknown) => void) {
			if (path !== "/srv/dir") {
				cb(Object.assign(new Error("no such file"), { code: 2 }));
				return;
			}
			cb(null, dirStats);
		},
		readdir(path: string, cb: (err: Error | null, list?: unknown[]) => void) {
			if (path !== "/srv/dir") {
				cb(Object.assign(new Error("no such file"), { code: 2 }));
				return;
			}
			cb(null, entries);
		},
	} as unknown as SFTPWrapper;
	return { wrapper, entries };
}

async function list(
	value: { limit?: number } = {},
	files: { name: string; mode?: number; size?: number }[] = [
		{ name: "a.txt", size: 3 },
		{ name: "sub", mode: 0o040755 },
		{ name: "link", mode: 0o120777 },
	],
): Promise<{ result: TaskResult; stdout: Buffer }> {
	const { wrapper } = fakeDirectory(files);
	const spec = { kind: "file.list", path: "/srv/dir", limit: value.limit ?? 0 } as TaskSpec;
	const out: Uint8Array[] = [];
	const result = (await runSftpFileTask(
		wrapper,
		spec,
		undefined,
		(d) => out.push(Buffer.from(d)),
		new AbortController().signal,
	)) as TaskResult;
	return { result, stdout: Buffer.concat(out) };
}

describe("file.list over SFTP", () => {
	it("returns the entries as the task result, with no output on stdout", async () => {
		const { result, stdout } = await list();
		expect(stdout.length).toBe(0);
		expect(result).toMatchObject({
			kind: "file.list",
			truncated: false,
			// The listing is sorted by name.
			entries: [
				{ name: "a.txt", type: "file", size: 3, mode: "0644" },
				{ name: "link", type: "symlink", mode: "0777" },
				{ name: "sub", type: "dir", mode: "0755" },
			],
		});
	});

	it("stops at the requested limit", async () => {
		const { result } = await list({ limit: 2 });
		if (result.kind !== "file.list") throw new Error(`result is ${result.kind}`);
		expect(result.truncated).toBe(true);
		expect(result.entries.map((e) => e.name)).toEqual(["a.txt", "link"]);
	});

	it("keeps the entries of a huge directory inside one task.exit frame", async () => {
		const files = Array.from({ length: 2000 }, (_, i) => ({
			name: `${String(i).padStart(4, "0")}-${"x".repeat(200)}`,
		}));
		const { result } = await list({ limit: 5000 }, files);
		if (result.kind !== "file.list") throw new Error(`result is ${result.kind}`);
		expect(result.truncated).toBe(true);
		expect(result.entries.length).toBeGreaterThan(0);
		expect(result.entries.length).toBeLessThan(2000);
		// The whole exit the result travels in must still be one frame.
		const frame = encodeFrame({
			kind: "event",
			name: "task.exit",
			body: {
				taskId: "t-list",
				outcome: { kind: "code", value: 0 },
				timedOut: false,
				cancelled: false,
				outputEnd: 0,
				outputFile: "",
				outputLines: 0,
				result,
			},
		});
		expect(frame.length).toBeLessThanOrEqual(MAX_FRAME_BYTES);
	});
});
