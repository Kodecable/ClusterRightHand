import { describe, expect, it } from "vitest";
import { createApp } from "../src/api/app.ts";
import { openDb } from "../src/storage/db.ts";

describe("api", () => {
	it("reports health", async () => {
		const db = openDb({ driver: "sqlite", path: ":memory:" });
		try {
			const res = await createApp(db).request("/api/health");
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ status: "ok" });
		} finally {
			await db.destroy();
		}
	});
});

describe("web root", () => {
	it("serves files, falls back to index.html, and keeps /api and /agent out of the fallback", async () => {
		const { mkdtemp, writeFile, mkdir } = await import("node:fs/promises");
		const { join } = await import("node:path");
		const { tmpdir } = await import("node:os");
		const root = await mkdtemp(join(tmpdir(), "crh-web-"));
		await writeFile(join(root, "index.html"), "<html>shell</html>");
		await mkdir(join(root, "assets"));
		await writeFile(join(root, "assets", "a.js"), "console.log(1)");
		const db = openDb({ driver: "sqlite", path: ":memory:" });
		try {
			const app = createApp(db, { webRoot: root });
			expect(await (await app.request("/")).text()).toContain("shell");
			expect(await (await app.request("/nodes/x")).text()).toContain("shell");
			expect(await (await app.request("/assets/a.js")).text()).toContain("console.log");
			expect((await app.request("/api/unknown")).status).toBe(401);
			expect((await app.request("/agent/unknown")).status).toBe(404);
		} finally {
			await db.destroy();
		}
	});
});
