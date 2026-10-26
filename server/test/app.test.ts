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
