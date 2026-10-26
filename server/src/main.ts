#!/usr/bin/env node
import { parseArgs } from "node:util";
import { serve } from "@hono/node-server";
import { createApp } from "./api/app.ts";
import { DEFAULT_CONFIG_PATH, loadConfig } from "./config.ts";
import { openDb } from "./storage/db.ts";
import { migrateToLatest } from "./storage/migrate.ts";

const { values } = parseArgs({ options: { config: { type: "string", short: "c", default: DEFAULT_CONFIG_PATH } } });

const config = await loadConfig(values.config);
const db = openDb(config.database);
await migrateToLatest(db);

const server = serve({ fetch: createApp(db).fetch, hostname: config.listen.host, port: config.listen.port }, (info) => {
	console.log(`crhs listening on http://${info.address}:${info.port}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.once(signal, () => {
		server.close();
		void db.destroy();
	});
}
