import { Hono } from "hono";
import { sql } from "kysely";
import type { Db } from "../storage/db.ts";
import { type AuthRoutesOptions, authRoutes } from "./auth-routes.ts";
import type { AppEnv } from "./context.ts";
import { csrfGuard, requireUser } from "./middleware.ts";
import { nodeRoutes } from "./node-routes.ts";
import { userRoutes } from "./user-routes.ts";

export interface AppOptions extends AuthRoutesOptions {
	/** Embedded in enrollment tokens so crha can pin crhs's identity key. */
	serverFingerprint?: string;
}

export function createApp(db: Db, options: AppOptions = {}): Hono<AppEnv> {
	const app = new Hono<AppEnv>();

	app.use("/api/*", csrfGuard);

	app.get("/api/health", async (c) => {
		await sql`select 1`.execute(db);
		return c.json({ status: "ok" });
	});

	app.route("/api/auth", authRoutes(db, options));

	app.use("/api/*", requireUser(db));
	app.route("/api", userRoutes(db));
	app.route("/api", nodeRoutes(db, options));

	return app;
}
