import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Storage } from "@earendil-works/pi-durable";
import { expect, it } from "vitest";
import { createStorageOpener, openAgentStorage } from "../src/storage/db.ts";

it("opens fresh storage after a failed open without closing the previous storage twice", async () => {
	let opens = 0;
	let closes = 0;
	const opener = createStorageOpener(async () => {
		opens++;
		if (opens === 2) throw new Error("database unavailable");
		return {
			storage: {} as Storage,
			close: async () => {
				closes++;
			},
		};
	});

	await opener.open();
	expect(closes).toBe(0);
	// The failed open closes the storage it replaced once, then leaves a no-op close behind.
	await expect(opener.open()).rejects.toThrow("database unavailable");
	expect(closes).toBe(1);
	await opener.open();
	expect(closes).toBe(1);
	// Closing the runtime's storage is idempotent too.
	await opener.close();
	await opener.close();
	expect(closes).toBe(2);
});

it("closes SQLite agent storage idempotently", async () => {
	const dir = await mkdtemp(join(tmpdir(), "crh-storage-opener-"));
	try {
		const opened = await openAgentStorage({ driver: "sqlite", path: join(dir, "agent.db") });
		await opened.close();
		await expect(opened.close()).resolves.toBeUndefined();
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
