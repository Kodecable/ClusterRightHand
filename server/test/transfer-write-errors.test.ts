/**
 * A write stream opens its file asynchronously. Between two writes an fs error (ENOSPC, EIO, EACCES)
 * is emitted with nobody waiting, and without a listener Node throws it as an uncaught exception.
 * The staging write and the push staging path must turn it into a rejection instead.
 */
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openTransferLocation, stageFile } from "../src/library/transfer-location.ts";

// The failure is produced with a directory the process may not write to; root ignores the mode.
const canDenyWrites = process.platform !== "win32" && process.getuid?.() !== 0;

describe.skipIf(!canDenyWrites)("staging write stream errors", () => {
	let root: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "crhs-write-error-"));
	});

	afterEach(async () => {
		await chmod(root, 0o700).catch(() => {});
		await rm(root, { recursive: true, force: true });
	});

	it("surfaces a staging write error emitted between writes as a rejection", async () => {
		await chmod(root, 0o500);
		const write = openTransferLocation(
			{ root, db: undefined as never },
			{ kind: "staging", path: "file", size: null, sha256: null },
		).openWrite();
		await write.write(Buffer.alloc(16));
		// Let the asynchronous open fail while nothing is waiting for a stream event.
		await new Promise((resolve) => setTimeout(resolve, 50));
		await expect(write.finish()).rejects.toMatchObject({ code: "EACCES" });
		await write.discard();
	});

	it("surfaces a push staging write error as a rejection", async () => {
		await chmod(root, 0o500);
		async function* slow(): AsyncGenerator<Buffer> {
			yield Buffer.from("first");
			await new Promise((resolve) => setTimeout(resolve, 50));
			yield Buffer.from("second");
		}
		await expect(stageFile(root, Readable.from(slow()))).rejects.toMatchObject({ code: "EACCES" });
	});
});
