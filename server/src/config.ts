import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parse } from "smol-toml";

export type DatabaseConfig = { driver: "sqlite"; path: string } | { driver: "postgres"; url: string };

/** How long rows are kept before the retention sweep deletes them; null keeps them forever (doc/design/data-model.md "Retention"). */
export interface RetentionConfig {
	/** Terminal tasks, terminal task groups and expired authorizations. */
	tasksMs: number | null;
	/** Audit events. */
	auditMs: number | null;
	/** Terminal durable agent tasks (pi_tasks); see storage/retention.ts. */
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

/** Login security settings (doc/guide/reference/crhs-config.md and doc/design/access-control.md). */
export interface AuthConfig {
	/** Argon2id computations allowed to run at once; peak memory is roughly this times 64 MiB. */
	argon2Concurrency: number;
	/** Argon2id computations allowed to wait; when full a request fails with 503 `hash_busy`. */
	argon2Queue: number;
	/** Whether password login requires a Cap proof-of-work challenge. */
	captcha: "cap" | "none";
}

export interface ListenConfig {
	host: string;
	port: number;
	/** A header such as X-Forwarded-For whose first non-empty element is the client address; null = direct. */
	realIpHeader: string | null;
}

export interface Config {
	listen: ListenConfig;
	database: DatabaseConfig;
	masterKeyFile: string;
	/** Built WebUI (web/dist); served at /. */
	webRoot: string;
	/** Warn when a node's clock differs from crhs by more than this; 0 disables (doc/design/privilege.md "Clock"). */
	clockWarnMs: number;
	/** Passkey registration settings. */
	webauthn: WebauthnConfig;
	/** When the retention sweep deletes old rows. */
	retention: RetentionConfig;
	/** Login hashing and proof-of-work settings. */
	auth: AuthConfig;
}

export const DEFAULT_CONFIG_PATH = "/etc/crhs/crhs.toml";
/** crhs warns when a node's clock differs by more than 60 s (doc/design/privilege.md "Clock"). */
export const DEFAULT_CLOCK_WARN_MS = 60_000;
export const DEFAULT_RP_NAME = "ClusterRightHand";
/** Two Argon2id hashes at once fit the default libuv threadpool (doc/guide/reference/crhs-config.md). */
export const DEFAULT_ARGON2_CONCURRENCY = 2;
export const DEFAULT_ARGON2_QUEUE = 32;
export const DEFAULT_CAPTCHA = "cap";
/** Tasks, task groups and authorizations are kept for 90 days by default. */
export const DEFAULT_RETENTION_TASKS_MS = 90 * 24 * 60 * 60 * 1000;
/** Audit events are kept for 180 days by default. */
export const DEFAULT_RETENTION_AUDIT_MS = 180 * 24 * 60 * 60 * 1000;
/** Terminal durable agent tasks are kept for 7 days by default: after that they are only bookkeeping. */
export const DEFAULT_RETENTION_PI_TASKS_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * The shortest retention (doc/design/data-model.md "Retention"): a durable tool call that reruns after a crash reattaches
 * to its cluster task by id (cluster/task-dispatch.ts createTask), so deleting the row too soon could dispatch
 * the command a second time.
 */
export const MIN_RETENTION_MS = 24 * 60 * 60 * 1000;

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

export async function loadConfig(path: string): Promise<Config> {
	return parseConfig(await readFile(path, "utf8"));
}

export function parseConfig(text: string): Config {
	const raw = parse(text);
	rejectUnknown(raw, "", [
		"listen",
		"database",
		"master_key_file",
		"web_root",
		"clock_warn",
		"webauthn",
		"retention",
		"auth",
	]);
	const listen = table(raw, "listen");
	const database = table(raw, "database");
	rejectUnknown(listen, "listen.", ["host", "port", "real_ip_header"]);
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
		listen: {
			host: str(listen, "host", "listen.host", "127.0.0.1"),
			port,
			realIpHeader: headerName(listen.real_ip_header, "listen.real_ip_header"),
		},
		database: db,
		masterKeyFile: str(raw, "master_key_file", "master_key_file", "/etc/crhs/master.key"),
		webRoot: str(raw, "web_root", "web_root", fileURLToPath(new URL("../../web/dist", import.meta.url))),
		clockWarnMs: clockWarn,
		webauthn: webauthnConfig(raw),
		retention: retentionConfig(raw),
		auth: authConfig(raw),
	};
}

/** `[auth]`: the Argon2id concurrency gate and whether password login needs a Cap proof of work. */
function authConfig(raw: Record<string, unknown>): AuthConfig {
	const table_ = table(raw, "auth");
	rejectUnknown(table_, "auth.", ["argon2_concurrency", "argon2_queue", "captcha"]);
	const captcha = table_.captcha ?? DEFAULT_CAPTCHA;
	if (captcha !== "cap" && captcha !== "none") {
		throw new Error('auth.captcha must be "cap" or "none"');
	}
	return {
		argon2Concurrency: integer(table_.argon2_concurrency, "auth.argon2_concurrency", DEFAULT_ARGON2_CONCURRENCY, 1),
		argon2Queue: integer(table_.argon2_queue, "auth.argon2_queue", DEFAULT_ARGON2_QUEUE, 0),
		captcha,
	};
}

function integer(value: unknown, name: string, fallback: number, minimum: number): number {
	const number = value ?? fallback;
	if (typeof number !== "number" || !Number.isSafeInteger(number) || number < minimum) {
		throw new Error(`${name} must be an integer >= ${minimum}`);
	}
	return number;
}

/** An HTTP header name (RFC 9110 token); null when the key is absent. */
function headerName(value: unknown, name: string): string | null {
	if (value === undefined) return null;
	if (typeof value !== "string" || !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(value)) {
		throw new Error(`${name} must be an HTTP header name such as "X-Forwarded-For"`);
	}
	return value;
}

/** `[retention]`: a duration or "off" (null, keep forever); the default applies when the key is absent. */
function retentionConfig(raw: Record<string, unknown>): RetentionConfig {
	const table_ = table(raw, "retention");
	rejectUnknown(table_, "retention.", ["tasks", "audit", "pi_tasks"]);
	return {
		tasksMs: retentionDuration(table_.tasks, "retention.tasks", DEFAULT_RETENTION_TASKS_MS),
		auditMs: retentionDuration(table_.audit, "retention.audit", DEFAULT_RETENTION_AUDIT_MS),
		piTasksMs: retentionDuration(table_.pi_tasks, "retention.pi_tasks", DEFAULT_RETENTION_PI_TASKS_MS),
	};
}

function retentionDuration(value: unknown, name: string, fallback: number): number | null {
	if (value === undefined) return fallback;
	if (value === "off") return null;
	const ms = parseDurationMs(value, name);
	if (ms < MIN_RETENTION_MS) {
		throw new Error(
			`${name} must be "off" or at least "1d": a shorter window could delete a task whose durable tool call reruns after a crash`,
		);
	}
	return ms;
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
