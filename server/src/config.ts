import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parse } from "smol-toml";

export type DatabaseConfig = { driver: "sqlite"; path: string } | { driver: "postgres"; url: string };

/** WebAuthn relying-party settings (doc/privilege.md#签名方式); empty values mean "derive per request". */
export interface WebauthnConfig {
	/** The RP ID a Passkey is registered for; null derives it from the request's Origin hostname. */
	rpId: string | null;
	rpName: string;
	/** The origins a registration or assertion may come from; empty derives the request's Origin. */
	origins: string[];
}

export interface Config {
	listen: { host: string; port: number };
	database: DatabaseConfig;
	masterKeyFile: string;
	/** Built WebUI (web/dist); served at /. */
	webRoot: string;
	/** Warn when a node's clock differs from crhs by more than this; 0 disables (doc/privilege.md#时钟). */
	clockWarnMs: number;
	/** Passkey registration settings. */
	webauthn: WebauthnConfig;
}

export const DEFAULT_CONFIG_PATH = "/etc/crhs/crhs.toml";
/** crhs warns when a node's clock differs by more than 60 s (doc/privilege.md#时钟). */
export const DEFAULT_CLOCK_WARN_MS = 60_000;
export const DEFAULT_RP_NAME = "ClusterRightHand";

const DURATION_UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };

/**
 * A TOML duration such as "60s", "5m" or "1h30m" (the units crha's Go `time.ParseDuration` uses, without
 * fractions). The value must be a string: a bare number would be read as seconds by some and as
 * milliseconds by others.
 */
export function parseDurationMs(value: unknown, name: string): number {
	if (typeof value !== "string" || value.trim() === "") {
		throw new Error(`${name} must be a duration string such as "60s" or "5m"`);
	}
	const text = value.trim();
	let total = 0;
	let offset = 0;
	for (const match of text.matchAll(/(\d+)(ms|s|m|h)/g)) {
		if (match.index !== offset) break;
		total += Number(match[1]) * (DURATION_UNITS[match[2] as string] as number);
		offset = match.index + match[0].length;
	}
	if (offset !== text.length) throw new Error(`${name} must be a duration such as "60s" or "5m", got ${value}`);
	return total;
}

export async function loadConfig(path: string): Promise<Config> {
	return parseConfig(await readFile(path, "utf8"));
}

export function parseConfig(text: string): Config {
	const raw = parse(text);
	rejectUnknown(raw, "", ["listen", "database", "master_key_file", "web_root", "clock_warn", "webauthn"]);
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

	const clockWarn =
		raw.clock_warn === undefined ? DEFAULT_CLOCK_WARN_MS : parseDurationMs(raw.clock_warn, "clock_warn");

	return {
		listen: { host: str(listen, "host", "listen.host", "127.0.0.1"), port },
		database: db,
		masterKeyFile: str(raw, "master_key_file", "master_key_file", "/etc/crhs/master.key"),
		webRoot: str(raw, "web_root", "web_root", fileURLToPath(new URL("../../web/dist", import.meta.url))),
		clockWarnMs: clockWarn,
		webauthn: webauthnConfig(raw),
	};
}

/** `[webauthn]`: rp_id and origins go together; both absent means "derive from the request's Origin". */
function webauthnConfig(raw: Record<string, unknown>): WebauthnConfig {
	const table_ = table(raw, "webauthn");
	rejectUnknown(table_, "webauthn.", ["rp_id", "rp_name", "origins"]);
	const rpName = table_.rp_name ?? DEFAULT_RP_NAME;
	if (typeof rpName !== "string" || rpName === "") throw new Error("webauthn.rp_name must be a non-empty string");
	const rpId = table_.rp_id;
	const origins = table_.origins;
	if ((rpId === undefined) !== (origins === undefined)) {
		throw new Error("webauthn.rp_id and webauthn.origins must be set together");
	}
	if (rpId === undefined) return { rpId: null, rpName, origins: [] };
	if (typeof rpId !== "string" || rpId === "" || rpId.includes("/")) {
		throw new Error("webauthn.rp_id must be a non-empty hostname such as crh.example.com");
	}
	if (!Array.isArray(origins) || origins.length === 0 || origins.some((o) => typeof o !== "string" || o === "")) {
		throw new Error("webauthn.origins must be a non-empty array of origin URLs");
	}
	for (const origin of origins as string[]) {
		let parsed: URL;
		try {
			parsed = new URL(origin);
		} catch {
			throw new Error(`webauthn.origins: ${JSON.stringify(origin)} is not an absolute URL`);
		}
		if (parsed.origin !== origin) {
			throw new Error(`webauthn.origins: ${JSON.stringify(origin)} must be an origin (scheme://host[:port])`);
		}
	}
	return { rpId, rpName, origins: [...(origins as string[])] };
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
