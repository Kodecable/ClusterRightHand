import { Hono } from "hono";
import { sql } from "kysely";
import type { Db } from "../storage/db.ts";

export function createApp(db: Db): Hono {
	const app = new Hono();

	app.get("/api/health", async (c) => {
		await sql`select 1`.execute(db);
		return c.json({ status: "ok" });
	});

	return app;
}
