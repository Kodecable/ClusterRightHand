import { Hono } from "hono";
import { sql } from "kysely";
import type { Cluster } from "../cluster/cluster.ts";
import { TaskGroups } from "../cluster/task-groups.ts";
import type { MasterKey } from "../keys/master-key.ts";
import type { Db } from "../storage/db.ts";
import { type AuthRoutesOptions, authRoutes } from "./auth-routes.ts";
import type { AppEnv } from "./context.ts";
import { csrfGuard, requireUser } from "./middleware.ts";
import { nodeRoutes } from "./node-routes.ts";
import { sshRoutes } from "./ssh-routes.ts";
import { taskRoutes } from "./task-routes.ts";
import { userRoutes } from "./user-routes.ts";

export interface AppOptions extends AuthRoutesOptions {
	/** Embedded in enrollment tokens so crha can pin crhs's identity key. */
	serverFingerprint?: string;
	/** crhs's Noise static public key, served to `crha enroll`. */
	serverPublicKey?: Uint8Array;
	cluster?: Cluster;
	taskGroups?: TaskGroups;
	/** Needed for SSH credentials and nodes. */
	masterKey?: MasterKey;
}

export function createApp(db: Db, options: AppOptions = {}): Hono<AppEnv> {
	const app = new Hono<AppEnv>();

	app.use("/api/*", csrfGuard);

	app.get("/api/health", async (c) => {
		await sql`select 1`.execute(db);
		return c.json({ status: "ok" });
	});

	// Public: crha fetches this during enrollment and checks it against the token's fingerprint.
	app.get("/agent/identity", (c) => {
		if (!options.serverPublicKey) return c.json({ error: "not configured" }, 503);
		return c.json({
			publicKey: Buffer.from(options.serverPublicKey).toString("base64"),
			fingerprint: options.serverFingerprint,
		});
	});

	app.route("/api/auth", authRoutes(db, options));

	app.use("/api/*", requireUser(db));
	app.route("/api", userRoutes(db));
	app.route("/api", nodeRoutes(db, options));
	if (options.masterKey) app.route("/api", sshRoutes(db, options.masterKey));
	if (options.cluster) {
		app.route("/api", taskRoutes(db, options.cluster, options.taskGroups ?? new TaskGroups(db, options.cluster)));
	}

	return app;
}
