import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { LibraryLimits } from "@crh/api";
import { parse } from "smol-toml";

// Set by the bundled build (scripts/build-crhs.ts), whose own tree holds web/ next to crhs.mjs.
declare const __CRH_BUNDLED__: boolean | undefined;

export type DatabaseConfig = { driver: "sqlite"; path: string } | { driver: "postgres"; url: string };

/** How long rows are kept before the retention sweep deletes them; null keeps them forever (doc/design/data-model.md "Retention"). */
export interface RetentionConfig {
	/** Terminal tasks, terminal task groups and expired authorizations. */
	tasksMs: number | null;
	/** Audit events. */
	auditMs: number | null;
	/** Terminal durable agent tasks (pi_tasks); see retention/retention.ts. */
	piTasksMs: number | null;
}

/** WebAuthn relying-party settings (doc/design/privilege.md "Signing methods"); empty values mean "derive per request". */
export interface WebauthnConfig {
	/** The RP ID a Passkey is registered for; null derives it from the request's Origin hostname. */
	rpId: string | null;
	rpName: string;
	/** The origins a registration or assertion may come from; empty derives the request's Origin. */
	origins: string[];
}

/** The library object store (doc/design/library.md "Backends") configured in crhs.toml's `[library]`. */
export type LibraryConfig =
	| { backend: "local" }
	| { backend: "webdav"; url: string; username: string; password: string };

/** Login security settings (doc/guide/reference/crhs-config.md and doc/design/access-control.md). */
export interface AuthConfig {
	/** Argon2id computations allowed to run at once; peak memory is roughly this times 64 MiB. */
	argon2Concurrency: number;
	/** Argon2id computations allowed to wait; when full a request fails with 503 `hash_busy`. */
	argon2Queue: number;
	/** Whether password login requires a Cap proof-of-work challenge. */
	captcha: "cap" | "none";
}

/** Model catalogue settings, which must be known before the WebUI can list a custom provider's models. */
export interface ModelsConfig {
	/** Whether crhs may download https://models.dev/api.json into its data directory (doc/design/agent-runtime.md "Custom providers"). */
	catalogDownload: boolean;
}

/** The listen address, which must be known before the database is open. */
export interface ListenConfig {
	host: string;
	port: number;
}

/**
 * The settings crhs.toml holds: what is needed before the database or HTTP is up. The other settings
 * live in the database as System settings (doc/guide/reference/crhs-config.md).
 */
export interface Config {
	listen: ListenConfig;
	database: DatabaseConfig;
	masterKeyFile: string;
	/** Where library objects are stored (doc/design/library.md "Backends"). */
	library: LibraryConfig;
	/** Model catalogue settings (doc/design/agent-runtime.md "Custom providers"). */
	models: ModelsConfig;
	/** Built WebUI: web/ next to a bundled crhs.mjs, web/dist next to the server source otherwise. */
	webRoot: string;
}

export const DEFAULT_CONFIG_PATH = "/etc/crhs/crhs.toml";
/** crhs warns when a node's clock differs by more than 60 s (doc/design/privilege.md "Clock"). */
export const DEFAULT_CLOCK_WARN_MS = 60_000;
export const DEFAULT_RP_NAME = "ClusterRightHand";
/** Two Argon2id hashes at once fit the default libuv threadpool (doc/guide/reference/crhs-config.md). */
export const DEFAULT_ARGON2_CONCURRENCY = 2;
export const DEFAULT_ARGON2_QUEUE = 32;
export const DEFAULT_CAPTCHA = "cap";
/** crhs downloads the models.dev catalogue once a day unless crhs.toml turns it off. */
export const DEFAULT_CATALOG_DOWNLOAD = true;
/** Tasks, task groups and authorizations are kept for 90 days by default. */
export const DEFAULT_RETENTION_TASKS_MS = 90 * 24 * 60 * 60 * 1000;
/** Audit events are kept for 180 days by default. */
export const DEFAULT_RETENTION_AUDIT_MS = 180 * 24 * 60 * 60 * 1000;
/** Terminal durable agent tasks are kept for 7 days by default: after that they are only bookkeeping. */
export const DEFAULT_RETENTION_PI_TASKS_MS = 7 * 24 * 60 * 60 * 1000;
/** The default limits of a new user library: 256 files, 32 MiB each, 256 MiB in total. */
export const DEFAULT_USER_LIBRARY_LIMITS: LibraryLimits = {
	files: 256,
	fileBytes: 32 * 1024 * 1024,
	totalBytes: 256 * 1024 * 1024,
};

/** The default limits of a new user group library: 0 allows nothing until an administrator raises them. */
export const DEFAULT_GROUP_LIBRARY_LIMITS: LibraryLimits = { files: 0, fileBytes: 0, totalBytes: 0 };

/**
 * The shortest retention (doc/design/data-model.md "Retention"): a durable tool call that reruns after a crash reattaches
 * to its cluster task by id (cluster/task-dispatch.ts createTask), so deleting the row too soon could dispatch
 * the command a second time.
 */
export const MIN_RETENTION_MS = 24 * 60 * 60 * 1000;

/** The top-level keys crhs.toml may carry. */
const TOP_LEVEL_KEYS = ["listen", "database", "master_key_file", "web_root", "library", "models"] as const;

const DURATION_UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/**
 * A TOML duration such as "60s", "5m", "1h30m" or "1d12h" (the units crha's Go `time.ParseDuration` uses,
 * without fractions). The value must be a string: a bare number would be read as seconds by some and as
 * milliseconds by others.
 */
export function parseDurationMs(value: unknown, name: string): number {
	if (typeof value !== "string" || value.trim() === "") {
		throw new Error(`${name} must be a duration string such as "60s", "5m" or "1d"`);
	}
	const text = value.trim();
	let total = 0;
	let offset = 0;
	for (const match of text.matchAll(/(\d+)(ms|s|m|h|d)/g)) {
		if (match.index !== offset) break;
		total += Number(match[1]) * (DURATION_UNITS[match[2] as string] as number);
		offset = match.index + match[0].length;
	}
	if (offset !== text.length) throw new Error(`${name} must be a duration such as "60s", "5m" or "1d", got ${value}`);
	return total;
}

/** Reads and validates the file. */
export async function loadConfig(path: string): Promise<Config> {
	return parseConfig(await readFile(path, "utf8"));
}

/** The built WebUI's default directory; the bundle carries it next to crhs.mjs. */
function defaultWebRoot(): string {
	if (typeof __CRH_BUNDLED__ !== "undefined" && __CRH_BUNDLED__) {
		return fileURLToPath(new URL("./web", import.meta.url));
	}
	return fileURLToPath(new URL("../../web/dist", import.meta.url));
}

export function parseConfig(text: string): Config {
	const raw = parse(text);
	rejectUnknown(raw, "", [...TOP_LEVEL_KEYS]);
	const listen = table(raw, "listen");
	const database = table(raw, "database");
	rejectUnknown(listen, "listen.", ["host", "port"]);
	rejectUnknown(database, "database.", ["driver", "path", "url"]);
	const library = parseLibraryConfig(table(raw, "library"));
	const models = parseModelsConfig(table(raw, "models"));

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
		listen: {
			host: str(listen, "host", "listen.host", "127.0.0.1"),
			port,
		},
		database: db,
		library,
		models,
		masterKeyFile: str(raw, "master_key_file", "master_key_file", "/etc/crhs/master.key"),
		webRoot: str(raw, "web_root", "web_root", defaultWebRoot()),
	};
}

/**
 * An HTTP header name (RFC 9110 token); null when the setting is unset. Throws when the value is
 * present but not a header name.
 */
export function parseHeaderName(value: unknown, name: string): string | null {
	if (value === undefined || value === null) return null;
	if (typeof value !== "string" || !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(value)) {
		throw new Error(`${name} must be an HTTP header name such as "X-Forwarded-For"`);
	}
	return value;
}

/**
 * The public base URL for links crhs generates (`public_url`), without a trailing slash; null when
 * unset. It must be an absolute http(s) URL without a query or fragment; a path prefix is allowed.
 */
export function parsePublicUrl(value: unknown): string | null {
	if (value === undefined || value === null) return null;
	if (typeof value !== "string" || value === "") {
		throw new Error('public_url must be an absolute http(s) URL such as "https://crh.example.com"');
	}
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error(`public_url: ${JSON.stringify(value)} is not an absolute URL`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error(`public_url must use http or https, got ${JSON.stringify(url.protocol.slice(0, -1))}`);
	}
	if (url.search !== "" || url.hash !== "" || /[?#]/.test(value)) {
		throw new Error("public_url must not have a query or fragment");
	}
	return url.toString().replace(/\/+$/, "");
}

/** A retention duration ("1d12h") or "off" (null, keep forever); at least one day. */
export function parseRetentionDuration(value: unknown, name: string): number | null {
	if (value === "off") return null;
	const ms = parseDurationMs(value, name);
	if (ms < MIN_RETENTION_MS) {
		throw new Error(
			`${name} must be "off" or at least "1d": a shorter window could delete a task whose durable tool call reruns after a crash`,
		);
	}
	return ms;
}

/** An Argon2id concurrency or queue limit: an integer at least `minimum`. */
export function parseInteger(value: unknown, name: string, minimum: number): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
		throw new Error(`${name} must be an integer >= ${minimum}`);
	}
	return value;
}

export function parseCaptcha(value: unknown): "cap" | "none" {
	if (value !== "cap" && value !== "none") throw new Error('auth.captcha must be "cap" or "none"');
	return value;
}

/** A WebAuthn relying-party id: a non-empty hostname such as crh.example.com (no scheme or path). */
export function parseRpId(value: unknown): string {
	if (typeof value !== "string" || value === "" || value.includes("/")) {
		throw new Error("webauthn.rp_id must be a non-empty hostname such as crh.example.com");
	}
	return value;
}

export function parseRpName(value: unknown): string {
	if (typeof value !== "string" || value === "") throw new Error("webauthn.rp_name must be a non-empty string");
	return value;
}

/** The accepted origins, each exactly `scheme://host[:port]` without a path or default port. */
export function parseOrigins(value: unknown): string[] {
	if (
		!Array.isArray(value) ||
		value.length === 0 ||
		value.some((origin) => typeof origin !== "string" || origin === "")
	) {
		throw new Error("webauthn.origins must be a non-empty array of origin URLs");
	}
	for (const origin of value as string[]) {
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
	return [...(value as string[])];
}

/**
 * `[webauthn]`/`System settings` values. rpId null/absent and origins empty/absent mean "derive from
 * the request's Origin"; one without the other is an error.
 */
export function validateWebauthn(rpId: unknown, rpName: unknown, origins: unknown): WebauthnConfig {
	const rpUnset = rpId === undefined || rpId === null;
	const originsUnset = origins === undefined || (Array.isArray(origins) && origins.length === 0);
	if (rpUnset !== originsUnset) {
		throw new Error("webauthn.rp_id and webauthn.origins must be set together");
	}
	const name = rpName === undefined ? DEFAULT_RP_NAME : parseRpName(rpName);
	if (rpUnset) return { rpId: null, rpName: name, origins: [] };
	return { rpId: parseRpId(rpId), rpName: name, origins: parseOrigins(origins) };
}

/** `[auth]`/`System settings` values; absent fields take their defaults. */
export function validateAuth(captcha: unknown, argon2Concurrency: unknown, argon2Queue: unknown): AuthConfig {
	return {
		captcha: captcha === undefined ? DEFAULT_CAPTCHA : parseCaptcha(captcha),
		argon2Concurrency:
			argon2Concurrency === undefined
				? DEFAULT_ARGON2_CONCURRENCY
				: parseInteger(argon2Concurrency, "auth.argon2_concurrency", 1),
		argon2Queue: argon2Queue === undefined ? DEFAULT_ARGON2_QUEUE : parseInteger(argon2Queue, "auth.argon2_queue", 0),
	};
}

/** `[models]`: whether the models.dev catalogue may be downloaded (doc/design/agent-runtime.md "Custom providers"). */
function parseModelsConfig(raw: Record<string, unknown>): ModelsConfig {
	rejectUnknown(raw, "models.", ["catalog_download"]);
	if (raw.catalog_download !== undefined && typeof raw.catalog_download !== "boolean") {
		throw new Error("models.catalog_download must be true or false");
	}
	return { catalogDownload: raw.catalog_download ?? DEFAULT_CATALOG_DOWNLOAD };
}

/** `[library]`: the object backend; local is the default and needs no other key. */
function parseLibraryConfig(raw: Record<string, unknown>): LibraryConfig {
	rejectUnknown(raw, "library.", ["backend", "url", "username", "password"]);
	const backend = raw.backend ?? "local";
	if (backend === "local") {
		if (raw.url !== undefined || raw.username !== undefined || raw.password !== undefined) {
			throw new Error("library.url, library.username and library.password belong to the webdav backend");
		}
		return { backend: "local" };
	}
	if (backend !== "webdav") {
		throw new Error('library.backend must be "local" or "webdav"');
	}
	const url = str(raw, "url", "library.url");
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error("library.url must be an absolute http(s) URL");
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error("library.url must be an absolute http(s) URL");
	}
	return {
		backend: "webdav",
		url,
		username: str(raw, "username", "library.username"),
		password: str(raw, "password", "library.password"),
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
