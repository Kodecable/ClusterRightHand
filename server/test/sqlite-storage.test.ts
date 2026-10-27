import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { registerStorageConformance } from "@earendil-works/pi-durable/testing";
import { describe, expect, it } from "vitest";

const context = BACKGROUND_CONTEXT;

registerStorageConformance({ describe, expect, it }, "SqliteStorage (pi_ prefix)", async (use) => {
	const dir = await mkdtemp(join(tmpdir(), "crh-durable-"));
	try {
		const storage = await openNodeSqliteStorage(join(dir, "durable.db"), { prefix: "pi_" });
		try {
			await use(storage);
		} finally {
			await storage.close(context);
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
