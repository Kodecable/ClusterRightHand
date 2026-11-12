import type { SystemSettings, SystemSettingsRetention } from "@crh/api";
import { configureHashGate } from "../auth/hash-gate.ts";
import type { AuthConfig, FileSettings, RetentionConfig, WebauthnConfig } from "../config.ts";
import {
	DEFAULT_ARGON2_CONCURRENCY,
	DEFAULT_ARGON2_QUEUE,
	DEFAULT_CAPTCHA,
	DEFAULT_RP_NAME,
	parseCaptcha,
	parseDurationMs,
	parseHeaderName,
	parseInteger,
	parseOrigins,
	parsePublicUrl,
	parseRetentionDuration,
	parseRpId,
	parseRpName,
	validateAuth,
	validateWebauthn,
} from "../config.ts";
import type { Db } from "../storage/db.ts";
import { defaultOrgId } from "../storage/org.ts";

/**
 * The low-frequency runtime settings administrators edit in System settings
 * (doc/guide/reference/crhs-config.md). One in-memory object is loaded at startup from the `settings`
 * table (or the defaults) and replaced atomically on every successful write; consumers read
 * `current()` at use time, never a value captured at startup.
 */
export interface RuntimeSettings {
	publicUrl: string | null;
	clockWarnMs: number;
	retention: RetentionConfig;
	webauthn: WebauthnConfig;
	auth: AuthConfig;
	realIpHeader: string | null;
}

/** The keys stored in the `settings` table; each row holds one validated value as JSON. */
export const SETTING_KEYS = [
	"public_url",
	"clock_warn",
	"retention.tasks",
	"retention.audit",
	"retention.pi_tasks",
	"webauthn.rp_id",
	"webauthn.rp_name",
	"webauthn.origins",
	"auth.captcha",
	"auth.argon2_concurrency",
	"auth.argon2_queue",
	"listen.real_ip_header",
] as const;

export type SettingKey = (typeof SETTING_KEYS)[number];

const SETTING_KEY_SET: ReadonlySet<string> = new Set(SETTING_KEYS);

export function isSettingKey(value: string): value is SettingKey {
	return SETTING_KEY_SET.has(value);
}

/** The defaults from config.ts, in the API form the WebUI shows. */
export const DEFAULT_SYSTEM_SETTINGS: SystemSettings = {
	publicUrl: null,
	clockWarn: "60s",
	retention: { tasks: "90d", audit: "180d", piTasks: "7d" },
	webauthn: { rpId: null, rpName: DEFAULT_RP_NAME, origins: [] },
	auth: { captcha: DEFAULT_CAPTCHA, argon2Concurrency: DEFAULT_ARGON2_CONCURRENCY, argon2Queue: DEFAULT_ARGON2_QUEUE },
	realIpHeader: null,
};

/** A copy of the defaults, safe for a caller to modify. */
export function defaultSystemSettings(): SystemSettings {
	return structuredClone(DEFAULT_SYSTEM_SETTINGS);
}

type SettingValues = Partial<Record<SettingKey, unknown>>;

/** The defaults as one flat map keyed like the `settings` table's rows. */
function defaultsByKey(): Record<SettingKey, unknown> {
	return {
		public_url: DEFAULT_SYSTEM_SETTINGS.publicUrl,
		clock_warn: DEFAULT_SYSTEM_SETTINGS.clockWarn,
		"retention.tasks": DEFAULT_SYSTEM_SETTINGS.retention.tasks,
		"retention.audit": DEFAULT_SYSTEM_SETTINGS.retention.audit,
		"retention.pi_tasks": DEFAULT_SYSTEM_SETTINGS.retention.piTasks,
		"webauthn.rp_id": DEFAULT_SYSTEM_SETTINGS.webauthn.rpId,
		"webauthn.rp_name": DEFAULT_SYSTEM_SETTINGS.webauthn.rpName,
		"webauthn.origins": [...DEFAULT_SYSTEM_SETTINGS.webauthn.origins],
		"auth.captcha": DEFAULT_SYSTEM_SETTINGS.auth.captcha,
		"auth.argon2_concurrency": DEFAULT_SYSTEM_SETTINGS.auth.argon2Concurrency,
		"auth.argon2_queue": DEFAULT_SYSTEM_SETTINGS.auth.argon2Queue,
		"listen.real_ip_header": DEFAULT_SYSTEM_SETTINGS.realIpHeader,
	};
}

/** The API form as one flat map keyed like the `settings` table's rows. */
function flatten(settings: SystemSettings): Record<SettingKey, unknown> {
	return {
		public_url: settings.publicUrl,
		clock_warn: settings.clockWarn,
		"retention.tasks": settings.retention.tasks,
		"retention.audit": settings.retention.audit,
		"retention.pi_tasks": settings.retention.piTasks,
		"webauthn.rp_id": settings.webauthn.rpId,
		"webauthn.rp_name": settings.webauthn.rpName,
		"webauthn.origins": [...settings.webauthn.origins],
		"auth.captcha": settings.auth.captcha,
		"auth.argon2_concurrency": settings.auth.argon2Concurrency,
		"auth.argon2_queue": settings.auth.argon2Queue,
		"listen.real_ip_header": settings.realIpHeader,
	};
}

function unflatten(values: Record<SettingKey, unknown>): SystemSettings {
	const retention: SystemSettingsRetention = {
		tasks: values["retention.tasks"] as string,
		audit: values["retention.audit"] as string,
		piTasks: values["retention.pi_tasks"] as string,
	};
	return {
		publicUrl: values.public_url as string | null,
		clockWarn: values.clock_warn as string,
		retention,
		webauthn: {
			rpId: values["webauthn.rp_id"] as string | null,
			rpName: values["webauthn.rp_name"] as string,
			origins: [...(values["webauthn.origins"] as string[])],
		},
		auth: {
			captcha: values["auth.captcha"] as "cap" | "none",
			argon2Concurrency: values["auth.argon2_concurrency"] as number,
			argon2Queue: values["auth.argon2_queue"] as number,
		},
		realIpHeader: values["listen.real_ip_header"] as string | null,
	};
}

/**
 * Validates one stored or patched value with the parser crhs.toml used, returning it in stored form.
 * A `null` is kept for the three nullable settings; webauthn.origins allows an empty list (unset).
 */
export function parseSettingValue(key: SettingKey, value: unknown): unknown {
	switch (key) {
		case "public_url":
			return parsePublicUrl(value);
		case "clock_warn": {
			parseDurationMs(value, "clock_warn");
			return (value as string).trim();
		}
		case "retention.tasks":
			parseRetentionDuration(value, "retention.tasks");
			return (value as string).trim();
		case "retention.audit":
			parseRetentionDuration(value, "retention.audit");
			return (value as string).trim();
		case "retention.pi_tasks":
			parseRetentionDuration(value, "retention.pi_tasks");
			return (value as string).trim();
		case "webauthn.rp_id":
			return value === null ? null : parseRpId(value);
		case "webauthn.rp_name":
			return parseRpName(value);
		case "webauthn.origins":
			return Array.isArray(value) && value.length === 0 ? [] : parseOrigins(value);
		case "auth.captcha":
			return parseCaptcha(value);
		case "auth.argon2_concurrency":
			return parseInteger(value, "auth.argon2_concurrency", 1);
		case "auth.argon2_queue":
			return parseInteger(value, "auth.argon2_queue", 0);
		case "listen.real_ip_header":
			return parseHeaderName(value, "listen.real_ip_header");
	}
}

/** The flat stored form of the file settings an old crhs.toml still holds. */
export function fileSettingsToValues(moved: FileSettings): SettingValues {
	const values: SettingValues = {};
	if (moved.publicUrl !== undefined) values.public_url = moved.publicUrl;
	if (moved.clockWarn !== undefined) values.clock_warn = moved.clockWarn;
	if (moved.retention?.tasks !== undefined) values["retention.tasks"] = moved.retention.tasks;
	if (moved.retention?.audit !== undefined) values["retention.audit"] = moved.retention.audit;
	if (moved.retention?.piTasks !== undefined) values["retention.pi_tasks"] = moved.retention.piTasks;
	if (moved.webauthn?.rpId !== undefined) values["webauthn.rp_id"] = moved.webauthn.rpId;
	if (moved.webauthn?.origins !== undefined) values["webauthn.origins"] = moved.webauthn.origins;
	if (moved.webauthn?.rpName !== undefined) values["webauthn.rp_name"] = moved.webauthn.rpName;
	if (moved.auth?.captcha !== undefined) values["auth.captcha"] = moved.auth.captcha;
	if (moved.auth?.argon2Concurrency !== undefined) values["auth.argon2_concurrency"] = moved.auth.argon2Concurrency;
	if (moved.auth?.argon2Queue !== undefined) values["auth.argon2_queue"] = moved.auth.argon2Queue;
	if (moved.realIpHeader !== undefined) values["listen.real_ip_header"] = moved.realIpHeader;
	return values;
}

/** A PATCH body that failed validation; `fields` maps an API field path to its message. */
export class SettingsValidationError extends Error {
	readonly fields: Record<string, string>;
	constructor(fields: Record<string, string>) {
		super("invalid settings");
		this.name = "SettingsValidationError";
		this.fields = fields;
	}
}

/** Validates a PATCH body into the flat stored form; Unknown fields and bad values become `fields`. */
export function parseSettingsPatch(body: unknown): SettingValues {
	if (typeof body !== "object" || body === null || Array.isArray(body)) {
		throw new SettingsValidationError({ "": "expected a JSON object" });
	}
	const input = body as Record<string, unknown>;
	const fields: Record<string, string> = {};
	const values: SettingValues = {};
	const check = (field: string, read: () => void): void => {
		try {
			read();
		} catch (err) {
			fields[field] = (err as Error).message;
		}
	};
	for (const key of Object.keys(input)) {
		if (!["publicUrl", "clockWarn", "retention", "webauthn", "auth", "realIpHeader"].includes(key)) {
			fields[key] = `unknown setting ${key}`;
		}
	}

	if (input.publicUrl !== undefined) {
		check("publicUrl", () => {
			values.public_url = parsePublicUrl(input.publicUrl);
		});
	}
	if (input.clockWarn !== undefined) {
		check("clockWarn", () => {
			values.clock_warn = parseSettingValue("clock_warn", input.clockWarn);
		});
	}
	if (input.realIpHeader !== undefined) {
		check("realIpHeader", () => {
			values["listen.real_ip_header"] = parseHeaderName(input.realIpHeader, "listen.real_ip_header");
		});
	}

	if (input.retention !== undefined) {
		const group = plainObject(input.retention);
		if (!group) fields.retention = "retention must be an object";
		else {
			for (const key of Object.keys(group)) {
				if (!["tasks", "audit", "piTasks"].includes(key)) fields[`retention.${key}`] = `unknown setting ${key}`;
			}
			const entries = [
				["tasks", "retention.tasks"],
				["audit", "retention.audit"],
				["piTasks", "retention.pi_tasks"],
			] as const;
			for (const [field, setting] of entries) {
				if (group[field] === undefined) continue;
				check(`retention.${field}`, () => {
					values[setting] = parseSettingValue(setting, group[field]);
				});
			}
		}
	}

	if (input.webauthn !== undefined) {
		const group = plainObject(input.webauthn);
		if (!group) fields.webauthn = "webauthn must be an object";
		else {
			for (const key of Object.keys(group)) {
				if (!["rpId", "rpName", "origins"].includes(key)) fields[`webauthn.${key}`] = `unknown setting ${key}`;
			}
			const hasRpId = group.rpId !== undefined;
			const hasOrigins = group.origins !== undefined;
			if (hasRpId !== hasOrigins) {
				fields[hasRpId ? "webauthn.origins" : "webauthn.rpId"] =
					"webauthn.rpId and webauthn.origins must be set together";
			}
			if (group.rpName !== undefined) {
				check("webauthn.rpName", () => {
					values["webauthn.rp_name"] = parseSettingValue("webauthn.rp_name", group.rpName);
				});
			}
			if (hasRpId && hasOrigins) {
				let rpId: string | null | undefined;
				let origins: string[] | undefined;
				check("webauthn.rpId", () => {
					rpId = parseSettingValue("webauthn.rp_id", group.rpId) as string | null;
				});
				check("webauthn.origins", () => {
					origins = parseSettingValue("webauthn.origins", group.origins) as string[];
				});
				if (rpId !== undefined && origins !== undefined) {
					if ((rpId === null) !== (origins.length === 0)) {
						fields["webauthn.origins"] = "webauthn.rpId and webauthn.origins must be set together";
					} else {
						values["webauthn.rp_id"] = rpId;
						values["webauthn.origins"] = origins;
					}
				}
			}
		}
	}

	if (input.auth !== undefined) {
		const group = plainObject(input.auth);
		if (!group) fields.auth = "auth must be an object";
		else {
			for (const key of Object.keys(group)) {
				if (!["captcha", "argon2Concurrency", "argon2Queue"].includes(key)) {
					fields[`auth.${key}`] = `unknown setting ${key}`;
				}
			}
			if (group.captcha !== undefined) {
				check("auth.captcha", () => {
					values["auth.captcha"] = parseSettingValue("auth.captcha", group.captcha);
				});
			}
			if (group.argon2Concurrency !== undefined) {
				check("auth.argon2Concurrency", () => {
					values["auth.argon2_concurrency"] = parseSettingValue("auth.argon2_concurrency", group.argon2Concurrency);
				});
			}
			if (group.argon2Queue !== undefined) {
				check("auth.argon2Queue", () => {
					values["auth.argon2_queue"] = parseSettingValue("auth.argon2_queue", group.argon2Queue);
				});
			}
		}
	}

	if (Object.keys(fields).length > 0) throw new SettingsValidationError(fields);
	return values;
}

function plainObject(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/** Resolves the stored/API form into the values the running server reads. Also validates the combination. */
function resolveSettings(wire: SystemSettings): RuntimeSettings {
	return {
		publicUrl: parsePublicUrl(wire.publicUrl),
		clockWarnMs: parseDurationMs(wire.clockWarn, "clock_warn"),
		retention: {
			tasksMs: parseRetentionDuration(wire.retention.tasks, "retention.tasks"),
			auditMs: parseRetentionDuration(wire.retention.audit, "retention.audit"),
			piTasksMs: parseRetentionDuration(wire.retention.piTasks, "retention.pi_tasks"),
		},
		webauthn: validateWebauthn(wire.webauthn.rpId, wire.webauthn.rpName, wire.webauthn.origins),
		auth: validateAuth(wire.auth.captcha, wire.auth.argon2Concurrency, wire.auth.argon2Queue),
		realIpHeader: parseHeaderName(wire.realIpHeader, "listen.real_ip_header"),
	};
}

export interface SettingsChange {
	key: SettingKey;
	oldValue: unknown;
	newValue: unknown;
}

/** One process-wide view of the settings; the server replaces it atomically after each write. */
export class SettingsStore {
	#wire: SystemSettings;
	#current: RuntimeSettings;
	#orgId: string | undefined;
	#loaded: boolean;
	/** Serializes writes, so two concurrent PATCHes cannot each plan from the same old values. */
	#pending: Promise<void> = Promise.resolve();

	private constructor(wire: SystemSettings, loaded: boolean, orgId?: string) {
		this.#wire = structuredClone(wire);
		this.#current = resolveSettings(this.#wire);
		this.#loaded = loaded;
		this.#orgId = orgId;
	}

	/** The defaults, until {@link ensureLoaded} reads the database. */
	static defaults(): SettingsStore {
		return new SettingsStore(DEFAULT_SYSTEM_SETTINGS, false);
	}

	/** An explicit in-memory state (tests, or a caller that already has the values). */
	static fromSystemSettings(wire: SystemSettings): SettingsStore {
		return new SettingsStore(wire, true);
	}

	static async load(db: Db): Promise<SettingsStore> {
		const orgId = await defaultOrgId(db);
		const rows = await db.selectFrom("settings").select(["key", "value"]).where("org_id", "=", orgId).execute();
		const values = defaultsByKey();
		for (const row of rows) {
			// A key written by a newer crhs is ignored, so an older binary can still read the database.
			if (!isSettingKey(row.key)) continue;
			let parsed: unknown;
			try {
				parsed = JSON.parse(row.value);
			} catch {
				throw new Error(`settings: ${row.key} is not valid JSON`);
			}
			try {
				values[row.key] = parseSettingValue(row.key, parsed);
			} catch (err) {
				throw new Error(`settings: invalid stored value for ${row.key}: ${(err as Error).message}`);
			}
		}
		return new SettingsStore(unflatten(values), true, orgId);
	}

	/** Reads the database the first time; a store that was already loaded (or built explicitly) is unchanged. */
	async ensureLoaded(db: Db): Promise<void> {
		if (this.#loaded) return;
		const loaded = await SettingsStore.load(db);
		this.#wire = loaded.#wire;
		this.#current = loaded.#current;
		this.#orgId = loaded.#orgId;
		this.#loaded = true;
	}

	/** The current values; read this at use time, never capture it at startup. */
	current(): RuntimeSettings {
		return this.#current;
	}

	/** The current API form, for `GET /api/settings`. */
	wire(): SystemSettings {
		return structuredClone(this.#wire);
	}

	/**
	 * Validates and stores a partial update, then replaces the in-memory object. A failed validation
	 * writes nothing. Returns the changed keys with their old and new API values for the audit log.
	 * Writes are serialized, so a second patch plans from the first one's result.
	 */
	patch(
		db: Db,
		patch: unknown,
		userId: string | null,
	): Promise<{ settings: SystemSettings; changes: SettingsChange[] }> {
		const run = this.#pending.then(() => this.#applyPatch(db, patch, userId));
		this.#pending = run.then(
			() => {},
			() => {},
		);
		return run;
	}

	async #applyPatch(
		db: Db,
		patch: unknown,
		userId: string | null,
	): Promise<{ settings: SystemSettings; changes: SettingsChange[] }> {
		await this.ensureLoaded(db);
		const values = parseSettingsPatch(patch);
		const orgId = this.#orgId ?? (await defaultOrgId(db));
		const before = flatten(this.#wire);
		const after: Record<SettingKey, unknown> = { ...before };
		for (const [key, value] of Object.entries(values) as [SettingKey, unknown][]) after[key] = value;
		const nextWire = unflatten(after);
		// Re-resolve before writing: the combination (webauthn rpId/origins) must be valid as a whole.
		const nextCurrent = resolveSettings(nextWire);
		const changes: SettingsChange[] = [];
		for (const key of Object.keys(values) as SettingKey[]) {
			if (JSON.stringify(before[key]) === JSON.stringify(after[key])) continue;
			changes.push({ key, oldValue: before[key], newValue: after[key] });
		}
		if (changes.length > 0) {
			const now = new Date().toISOString();
			await db.transaction().execute(async (trx) => {
				for (const change of changes) {
					await trx
						.insertInto("settings")
						.values({
							org_id: orgId,
							key: change.key,
							value: JSON.stringify(change.newValue),
							updated_at: now,
							updated_by_user_id: userId,
						})
						.onConflict((conflict) =>
							conflict.columns(["org_id", "key"]).doUpdateSet({
								value: JSON.stringify(change.newValue),
								updated_at: now,
								updated_by_user_id: userId,
							}),
						)
						.execute();
				}
			});
		}
		this.#wire = nextWire;
		this.#current = nextCurrent;
		this.#orgId = orgId;
		this.#loaded = true;
		// The Argon2id gate is a consumer like any other: its limits take effect at once, while running
		// hashes finish and queued work stays queued.
		configureHashGate({ concurrency: nextCurrent.auth.argon2Concurrency, queue: nextCurrent.auth.argon2Queue });
		return { settings: this.wire(), changes };
	}
}

/**
 * Imports the moved settings an old crhs.toml still holds. Each key is imported only when the
 * database has no value for it; a key that is already stored is an error, because two sources for
 * one setting would silently disagree.
 */
export async function importSettingsFromFile(
	db: Db,
	moved: FileSettings,
	warn: (message: string) => void = (message) => console.warn(message),
): Promise<SettingKey[]> {
	const values = fileSettingsToValues(moved);
	const keys = (Object.keys(values) as SettingKey[]).sort();
	if (keys.length === 0) return [];
	for (const key of keys) values[key] = parseSettingValue(key, values[key]);
	const orgId = await defaultOrgId(db);
	const stored = await db
		.selectFrom("settings")
		.select("key")
		.where("org_id", "=", orgId)
		.where("key", "in", keys)
		.execute();
	const storedKeys = new Set(stored.map((row) => row.key));
	const conflicts = keys.filter((key) => storedKeys.has(key));
	if (conflicts.length > 0) throw new Error(conflictMessage(conflicts));
	const now = new Date().toISOString();
	await db.transaction().execute(async (trx) => {
		for (const key of keys) {
			await trx
				.insertInto("settings")
				.values({
					org_id: orgId,
					key,
					value: JSON.stringify(values[key]),
					updated_at: now,
					updated_by_user_id: null,
				})
				.execute();
		}
	});
	for (const key of keys) warn(`imported ${key} from crhs.toml into System settings; remove it from crhs.toml`);
	return keys;
}

function conflictMessage(keys: SettingKey[]): string {
	if (keys.length === 1) return `${keys[0]} is now set in System settings; remove it from crhs.toml`;
	return `${keys.join(", ")} are now set in System settings; remove them from crhs.toml`;
}
