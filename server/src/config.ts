import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parse } from "smol-toml";

export type DatabaseConfig = { driver: "sqlite"; path: string } | { driver: "postgres"; url: string };

export interface Config {
	listen: { host: string; port: number };
	database: DatabaseConfig;
	masterKeyFile: string;
	/** Built WebUI (web/dist); served at /. */
	webRoot: string;
}

export const DEFAULT_CONFIG_PATH = "/etc/crhs/crhs.toml";

export async function loadConfig(path: string): Promise<Config> {
	return parseConfig(await readFile(path, "utf8"));
}

export function parseConfig(text: string): Config {
	const raw = parse(text);
	rejectUnknown(raw, "", ["listen", "database", "master_key_file", "web_root"]);
	const listen = table(raw, "listen");
	const database = table(raw, "database");
	rejectUnknown(listen, "listen.", ["host", "port"]);
	rejectUnknown(database, "database.", ["driver", "path", "url"]);

	const driver = database.driver ?? "sqlite";
	let db: DatabaseConfig;
	if (driver === "sqlite") {
		db = { driver, path: str(database, "path", "database.path", "/var/lib/crhs/crhs.db") };
	} else if (driver === "postgres") {
		db = { driver, url: str(database, "url", "database.url") };
	} else {
		throw new Error(`database.driver must be "sqlite" or "postgres", got ${JSON.stringify(driver)}`);
	}

	const port = listen.port ?? 8080;
	if (typeof port !== "number" || !Number.isInteger(port) || port < 0 || port > 65535) {
		throw new Error("listen.port must be an integer between 0 and 65535");
	}

	return {
		listen: { host: str(listen, "host", "listen.host", "127.0.0.1"), port },
		database: db,
		masterKeyFile: str(raw, "master_key_file", "master_key_file", "/etc/crhs/master.key"),
		webRoot: str(raw, "web_root", "web_root", fileURLToPath(new URL("../../web/dist", import.meta.url))),
	};
}

/** Unknown keys are errors: a misplaced key (e.g. a top-level key written after a [table]) must not be ignored. */
function rejectUnknown(obj: Record<string, unknown>, prefix: string, known: string[]): void {
	for (const key of Object.keys(obj)) {
		if (!known.includes(key)) throw new Error(`unknown configuration key ${prefix}${key}`);
	}
}

function table(raw: Record<string, unknown>, key: string): Record<string, unknown> {
	const value = raw[key] ?? {};
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`[${key}] must be a table`);
	}
	return value as Record<string, unknown>;
}

function str(obj: Record<string, unknown>, key: string, name: string, fallback?: string): string {
	const value = obj[key] ?? fallback;
	if (typeof value !== "string" || value === "") {
		throw new Error(`${name} must be a non-empty string`);
	}
	return value;
}
