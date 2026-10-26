import { Hono } from "hono";
import { sql } from "kysely";
import type { Db } from "../storage/db.ts";
import { type AuthRoutesOptions, authRoutes } from "./auth-routes.ts";
import type { AppEnv } from "./context.ts";
import { csrfGuard, requireUser } from "./middleware.ts";
import { userRoutes } from "./user-routes.ts";

export function createApp(db: Db, options: AuthRoutesOptions = {}): Hono<AppEnv> {
	const app = new Hono<AppEnv>();

	app.use("/api/*", csrfGuard);

	app.get("/api/health", async (c) => {
		await sql`select 1`.execute(db);
		return c.json({ status: "ok" });
	});

	app.route("/api/auth", authRoutes(db, options));

	app.use("/api/*", requireUser(db));
	app.route("/api", userRoutes(db));

	return app;
}
