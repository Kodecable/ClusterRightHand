import type {
	LibraryLimits,
	SystemSettings,
	SystemSettingsLibrary,
	SystemSettingsMetrics,
	SystemSettingsPty,
	SystemSettingsRetention,
} from "@crh/api";
import { configureHashGate } from "../auth/hash-gate.ts";
import type { AuthConfig, RetentionConfig, WebauthnConfig } from "../config.ts";
import {
	DEFAULT_ARGON2_CONCURRENCY,
	DEFAULT_ARGON2_QUEUE,
	DEFAULT_CAPTCHA,
	DEFAULT_GROUP_LIBRARY_LIMITS,
	DEFAULT_RP_NAME,
	DEFAULT_USER_LIBRARY_LIMITS,
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
import { METRIC_LEVEL_BUCKET_MS, type MetricLevel } from "../metrics/levels.ts";
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
	library: SystemSettingsLibrary;
	/** Resolved attachment inline limits, in bytes. */
	attachments: { inlineTextBytes: number; inlineTotalBytes: number };
	/** Resolved image cache size and TTL. */
	imageCache: { diskBytes: number; ttlMs: number };
	/** The limits of one directory copy into a library (doc/design/library.md "Directory copies"). */
	directoryCopy: { files: number; bytes: number };
	/** The most skills a system prompt lists (doc/design/library.md "Skills"). */
	skills: { maxPerUser: number };
	/** The job limits of a session (doc/design/jobs.md "Completion notices" and "Lifecycle and retention"). */
	jobs: { maxConsecutiveWakes: number; maxRunning: number };
	/** The resolved terminal subsystem settings (doc/design/pty.md "Settings and limits"). */
	pty: {
		enabled: boolean;
		maxPerNode: number;
		maxTotal: number;
		maxPerSession: number;
		agentIdleTimeoutMaxMs: number;
		watchTimeoutMaxMs: number;
		scrollbackBytes: number;
	};
	/** Host metrics collection and per-level bucket retention (doc/design/metrics.md "Settings"). */
	metrics: {
		enabled: boolean;
		intervalMs: number;
		retention: { l1Ms: number; l2Ms: number; l3Ms: number; l4Ms: number };
	};
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
	"library.user_files",
	"library.user_file_bytes",
	"library.user_total_bytes",
	"library.user_group_files",
	"library.user_group_file_bytes",
	"library.user_group_total_bytes",
	"attachments.inline_text_bytes",
	"attachments.inline_total_bytes",
	"image_cache.disk_bytes",
	"image_cache.ttl",
	"directory_copy.files",
	"directory_copy.bytes",
	"skills.max_per_user",
	"jobs.max_consecutive_wakes",
	"jobs.max_running",
	"pty.enabled",
	"pty.max_per_node",
	"pty.max_total",
	"pty.max_per_session",
	"pty.agent_idle_timeout_max",
	"pty.watch_timeout_max",
	"pty.scrollback_bytes",
	"metrics.enabled",
	"metrics.interval",
	"metrics.retention.l1",
	"metrics.retention.l2",
	"metrics.retention.l3",
	"metrics.retention.l4",
] as const;

export type SettingKey = (typeof SETTING_KEYS)[number];

const SETTING_KEY_SET: ReadonlySet<string> = new Set(SETTING_KEYS);

export function isSettingKey(value: string): value is SettingKey {
	return SETTING_KEY_SET.has(value);
}

/** A file up to this size has its text inlined into the attachment block (doc/design/library.md "Chat attachments"). */
export const DEFAULT_ATTACHMENT_INLINE_TEXT_BYTES = 32 * 1024;
/** The most attachment text inlined over one message. */
export const DEFAULT_ATTACHMENT_INLINE_TOTAL_BYTES = 64 * 1024;
/** The image cache's size on crhs's local disk. */
export const DEFAULT_IMAGE_CACHE_DISK_BYTES = 1024 * 1024 * 1024;
/** An image cache entry unused for this long is swept. */
export const DEFAULT_IMAGE_CACHE_TTL = "7d";
/** The most files and bytes one directory copy into a library takes. */
export const DEFAULT_DIRECTORY_COPY_FILES = 256;
export const DEFAULT_DIRECTORY_COPY_BYTES = 256 * 1024 * 1024;
/** The most skills a system prompt lists. */
export const DEFAULT_SKILLS_PER_USER = 64;
/** The most times completion notices may wake a session since its last user-authored input. */
export const DEFAULT_MAX_CONSECUTIVE_WAKES = 10;
/** The most unsettled jobs a session (or an API token) may have at once. */
export const DEFAULT_JOBS_MAX_RUNNING = 32;
/** The smallest and largest scrollback crha holds for one terminal (doc/design/pty.md "crha"). */
export const MIN_PTY_SCROLLBACK_BYTES = 64 * 1024;
export const MAX_PTY_SCROLLBACK_BYTES = 16 * 1024 * 1024;

/** The terminal defaults (doc/design/pty.md "Settings and limits"). */
export const DEFAULT_SYSTEM_SETTINGS_PTY: SystemSettingsPty = {
	enabled: true,
	maxPerNode: 8,
	maxTotal: 64,
	maxPerSession: 4,
	agentIdleTimeoutMax: "1h",
	watchTimeoutMax: "10m",
	scrollbackBytes: 1024 * 1024,
};

/** The sample intervals metrics may use, in seconds (doc/design/metrics.md "Settings"). */
export const METRICS_INTERVALS = [15, 20, 30, 60] as const;

/** The metrics defaults: collection on, once a minute, and the retention of doc/design/metrics.md "Storage". */
export const DEFAULT_SYSTEM_SETTINGS_METRICS: SystemSettingsMetrics = {
	enabled: true,
	interval: 60,
	retention: { l1: "24h", l2: "7d", l3: "30d", l4: "365d" },
};

/** The defaults from config.ts, in the API form the WebUI shows. */
export const DEFAULT_SYSTEM_SETTINGS: SystemSettings = {
	publicUrl: null,
	clockWarn: "60s",
	retention: { tasks: "90d", audit: "180d", piTasks: "7d" },
	webauthn: { rpId: null, rpName: DEFAULT_RP_NAME, origins: [] },
	auth: { captcha: DEFAULT_CAPTCHA, argon2Concurrency: DEFAULT_ARGON2_CONCURRENCY, argon2Queue: DEFAULT_ARGON2_QUEUE },
	realIpHeader: null,
	library: {
		user: { ...DEFAULT_USER_LIBRARY_LIMITS },
		userGroup: { ...DEFAULT_GROUP_LIBRARY_LIMITS },
	},
	attachments: {
		inlineTextBytes: DEFAULT_ATTACHMENT_INLINE_TEXT_BYTES,
		inlineTotalBytes: DEFAULT_ATTACHMENT_INLINE_TOTAL_BYTES,
	},
	imageCache: {
		diskBytes: DEFAULT_IMAGE_CACHE_DISK_BYTES,
		ttl: DEFAULT_IMAGE_CACHE_TTL,
	},
	directoryCopy: { files: DEFAULT_DIRECTORY_COPY_FILES, bytes: DEFAULT_DIRECTORY_COPY_BYTES },
	skills: { maxPerUser: DEFAULT_SKILLS_PER_USER },
	jobs: { maxConsecutiveWakes: DEFAULT_MAX_CONSECUTIVE_WAKES, maxRunning: DEFAULT_JOBS_MAX_RUNNING },
	pty: { ...DEFAULT_SYSTEM_SETTINGS_PTY },
	metrics: { ...DEFAULT_SYSTEM_SETTINGS_METRICS, retention: { ...DEFAULT_SYSTEM_SETTINGS_METRICS.retention } },
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
		"library.user_files": DEFAULT_SYSTEM_SETTINGS.library.user.files,
		"library.user_file_bytes": DEFAULT_SYSTEM_SETTINGS.library.user.fileBytes,
		"library.user_total_bytes": DEFAULT_SYSTEM_SETTINGS.library.user.totalBytes,
		"library.user_group_files": DEFAULT_SYSTEM_SETTINGS.library.userGroup.files,
		"library.user_group_file_bytes": DEFAULT_SYSTEM_SETTINGS.library.userGroup.fileBytes,
		"library.user_group_total_bytes": DEFAULT_SYSTEM_SETTINGS.library.userGroup.totalBytes,
		"attachments.inline_text_bytes": DEFAULT_SYSTEM_SETTINGS.attachments.inlineTextBytes,
		"attachments.inline_total_bytes": DEFAULT_SYSTEM_SETTINGS.attachments.inlineTotalBytes,
		"image_cache.disk_bytes": DEFAULT_SYSTEM_SETTINGS.imageCache.diskBytes,
		"image_cache.ttl": DEFAULT_SYSTEM_SETTINGS.imageCache.ttl,
		"directory_copy.files": DEFAULT_SYSTEM_SETTINGS.directoryCopy.files,
		"directory_copy.bytes": DEFAULT_SYSTEM_SETTINGS.directoryCopy.bytes,
		"skills.max_per_user": DEFAULT_SYSTEM_SETTINGS.skills.maxPerUser,
		"jobs.max_consecutive_wakes": DEFAULT_SYSTEM_SETTINGS.jobs.maxConsecutiveWakes,
		"jobs.max_running": DEFAULT_SYSTEM_SETTINGS.jobs.maxRunning,
		"pty.enabled": DEFAULT_SYSTEM_SETTINGS.pty.enabled,
		"pty.max_per_node": DEFAULT_SYSTEM_SETTINGS.pty.maxPerNode,
		"pty.max_total": DEFAULT_SYSTEM_SETTINGS.pty.maxTotal,
		"pty.max_per_session": DEFAULT_SYSTEM_SETTINGS.pty.maxPerSession,
		"pty.agent_idle_timeout_max": DEFAULT_SYSTEM_SETTINGS.pty.agentIdleTimeoutMax,
		"pty.watch_timeout_max": DEFAULT_SYSTEM_SETTINGS.pty.watchTimeoutMax,
		"pty.scrollback_bytes": DEFAULT_SYSTEM_SETTINGS.pty.scrollbackBytes,
		"metrics.enabled": DEFAULT_SYSTEM_SETTINGS.metrics.enabled,
		"metrics.interval": DEFAULT_SYSTEM_SETTINGS.metrics.interval,
		"metrics.retention.l1": DEFAULT_SYSTEM_SETTINGS.metrics.retention.l1,
		"metrics.retention.l2": DEFAULT_SYSTEM_SETTINGS.metrics.retention.l2,
		"metrics.retention.l3": DEFAULT_SYSTEM_SETTINGS.metrics.retention.l3,
		"metrics.retention.l4": DEFAULT_SYSTEM_SETTINGS.metrics.retention.l4,
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
		"library.user_files": settings.library.user.files,
		"library.user_file_bytes": settings.library.user.fileBytes,
		"library.user_total_bytes": settings.library.user.totalBytes,
		"library.user_group_files": settings.library.userGroup.files,
		"library.user_group_file_bytes": settings.library.userGroup.fileBytes,
		"library.user_group_total_bytes": settings.library.userGroup.totalBytes,
		"attachments.inline_text_bytes": settings.attachments.inlineTextBytes,
		"attachments.inline_total_bytes": settings.attachments.inlineTotalBytes,
		"image_cache.disk_bytes": settings.imageCache.diskBytes,
		"image_cache.ttl": settings.imageCache.ttl,
		"directory_copy.files": settings.directoryCopy.files,
		"directory_copy.bytes": settings.directoryCopy.bytes,
		"skills.max_per_user": settings.skills.maxPerUser,
		"jobs.max_consecutive_wakes": settings.jobs.maxConsecutiveWakes,
		"jobs.max_running": settings.jobs.maxRunning,
		"pty.enabled": settings.pty.enabled,
		"pty.max_per_node": settings.pty.maxPerNode,
		"pty.max_total": settings.pty.maxTotal,
		"pty.max_per_session": settings.pty.maxPerSession,
		"pty.agent_idle_timeout_max": settings.pty.agentIdleTimeoutMax,
		"pty.watch_timeout_max": settings.pty.watchTimeoutMax,
		"pty.scrollback_bytes": settings.pty.scrollbackBytes,
		"metrics.enabled": settings.metrics.enabled,
		"metrics.interval": settings.metrics.interval,
		"metrics.retention.l1": settings.metrics.retention.l1,
		"metrics.retention.l2": settings.metrics.retention.l2,
		"metrics.retention.l3": settings.metrics.retention.l3,
		"metrics.retention.l4": settings.metrics.retention.l4,
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
		library: {
			user: {
				files: values["library.user_files"] as number,
				fileBytes: values["library.user_file_bytes"] as number,
				totalBytes: values["library.user_total_bytes"] as number,
			},
			userGroup: {
				files: values["library.user_group_files"] as number,
				fileBytes: values["library.user_group_file_bytes"] as number,
				totalBytes: values["library.user_group_total_bytes"] as number,
			},
		},
		attachments: {
			inlineTextBytes: values["attachments.inline_text_bytes"] as number,
			inlineTotalBytes: values["attachments.inline_total_bytes"] as number,
		},
		imageCache: {
			diskBytes: values["image_cache.disk_bytes"] as number,
			ttl: values["image_cache.ttl"] as string,
		},
		directoryCopy: {
			files: values["directory_copy.files"] as number,
			bytes: values["directory_copy.bytes"] as number,
		},
		skills: { maxPerUser: values["skills.max_per_user"] as number },
		jobs: {
			maxConsecutiveWakes: values["jobs.max_consecutive_wakes"] as number,
			maxRunning: values["jobs.max_running"] as number,
		},
		pty: {
			enabled: values["pty.enabled"] as boolean,
			maxPerNode: values["pty.max_per_node"] as number,
			maxTotal: values["pty.max_total"] as number,
			maxPerSession: values["pty.max_per_session"] as number,
			agentIdleTimeoutMax: values["pty.agent_idle_timeout_max"] as string,
			watchTimeoutMax: values["pty.watch_timeout_max"] as string,
			scrollbackBytes: values["pty.scrollback_bytes"] as number,
		},
		metrics: {
			enabled: values["metrics.enabled"] as boolean,
			interval: values["metrics.interval"] as number,
			retention: {
				l1: values["metrics.retention.l1"] as string,
				l2: values["metrics.retention.l2"] as string,
				l3: values["metrics.retention.l3"] as string,
				l4: values["metrics.retention.l4"] as string,
			},
		},
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
		case "library.user_files":
		case "library.user_file_bytes":
		case "library.user_total_bytes":
		case "library.user_group_files":
		case "library.user_group_file_bytes":
		case "library.user_group_total_bytes":
			return parseLibraryLimit(value, key);
		case "attachments.inline_text_bytes":
		case "attachments.inline_total_bytes":
		case "image_cache.disk_bytes":
		case "directory_copy.files":
		case "directory_copy.bytes":
		case "skills.max_per_user":
		case "jobs.max_consecutive_wakes":
		case "jobs.max_running":
			return parseInteger(value, key, 0);
		case "image_cache.ttl": {
			const ms = parseDurationMs(value, "image_cache.ttl");
			if (ms <= 0) throw new Error("image_cache.ttl must be greater than zero");
			return (value as string).trim();
		}
		case "pty.enabled":
			if (typeof value !== "boolean") throw new Error("pty.enabled must be a boolean");
			return value;
		case "pty.max_per_node":
		case "pty.max_total":
		case "pty.max_per_session":
			return parseInteger(value, key, 0);
		case "pty.agent_idle_timeout_max":
		case "pty.watch_timeout_max": {
			const ms = parseDurationMs(value, key);
			if (ms <= 0) throw new Error(`${key} must be greater than zero`);
			return (value as string).trim();
		}
		case "pty.scrollback_bytes": {
			const bytes = parseInteger(value, key, MIN_PTY_SCROLLBACK_BYTES);
			if (bytes > MAX_PTY_SCROLLBACK_BYTES) {
				throw new Error(`${key} must be at most ${MAX_PTY_SCROLLBACK_BYTES} bytes (16 MiB)`);
			}
			return bytes;
		}
		case "metrics.enabled":
			if (typeof value !== "boolean") throw new Error("metrics.enabled must be a boolean");
			return value;
		case "metrics.interval":
			return parseMetricsInterval(value);
		case "metrics.retention.l1":
			return parseMetricRetentionSetting(value, 1);
		case "metrics.retention.l2":
			return parseMetricRetentionSetting(value, 2);
		case "metrics.retention.l3":
			return parseMetricRetentionSetting(value, 3);
		case "metrics.retention.l4":
			return parseMetricRetentionSetting(value, 4);
	}
}

/** A metrics sample interval: one of the values that divide a minute (doc/design/metrics.md "Settings"). */
function parseMetricsInterval(value: unknown): number {
	if (typeof value !== "number" || !(METRICS_INTERVALS as readonly number[]).includes(value)) {
		throw new Error(`metrics.interval must be one of ${METRICS_INTERVALS.join(", ")} seconds`);
	}
	return value;
}

/**
 * A metric level's retention: a duration of at least ten buckets of that level, so every read has data to
 * choose from (doc/design/metrics.md "Settings").
 */
function parseMetricRetentionMs(value: unknown, level: MetricLevel): number {
	const name = `metrics.retention.l${level}`;
	const ms = parseDurationMs(value, name);
	const minimum = 10 * METRIC_LEVEL_BUCKET_MS[level];
	if (ms < minimum) throw new Error(`${name} must be at least 10 buckets (${durationText(minimum)})`);
	return ms;
}

/** The stored form of a metric retention, validated. */
function parseMetricRetentionSetting(value: unknown, level: MetricLevel): string {
	parseMetricRetentionMs(value, level);
	return (value as string).trim();
}

/** A short crhs.toml duration for an error message. */
function durationText(ms: number): string {
	for (const [unitMs, suffix] of [
		[24 * 60 * 60 * 1000, "d"],
		[60 * 60 * 1000, "h"],
		[60 * 1000, "m"],
		[1000, "s"],
	] as const) {
		if (ms % unitMs === 0) return `${ms / unitMs}${suffix}`;
	}
	return `${ms}ms`;
}

/**
 * The ordering rule of doc/design/metrics.md "Settings": each level's retention is at least as long as the
 * level before it, so a read never chooses a coarser level whose window is shorter. Reports every offending
 * level by its API field path.
 */
function metricsRetentionProblems(retention: SystemSettingsMetrics["retention"]): Record<string, string> {
	const problems: Record<string, string> = {};
	const levels = ["l1", "l2", "l3", "l4"] as const;
	for (let index = 1; index < levels.length; index++) {
		const previous = levels[index - 1] as (typeof levels)[number];
		const current = levels[index] as (typeof levels)[number];
		const previousMs = parseDurationMs(retention[previous], `metrics.retention.${previous}`);
		const currentMs = parseDurationMs(retention[current], `metrics.retention.${current}`);
		if (currentMs < previousMs) {
			problems[`metrics.retention.${current}`] =
				`metrics.retention.${current} must be at least metrics.retention.${previous}`;
		}
	}
	return problems;
}

/** A library limit: an integer from 0 (nothing allowed) to the largest 32-bit signed integer. */
function parseLibraryLimit(value: unknown, name: string): number {
	const limit = parseInteger(value, name, 0);
	if (limit > 2_147_483_647) throw new Error(`${name} must be an integer <= 2147483647`);
	return limit;
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
		if (
			![
				"publicUrl",
				"clockWarn",
				"retention",
				"webauthn",
				"auth",
				"realIpHeader",
				"library",
				"attachments",
				"imageCache",
				"directoryCopy",
				"skills",
				"jobs",
				"pty",
				"metrics",
			].includes(key)
		) {
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

	if (input.library !== undefined) {
		const group = plainObject(input.library);
		if (!group) fields.library = "library must be an object";
		else {
			for (const owner of Object.keys(group)) {
				if (!["user", "userGroup"].includes(owner)) fields[`library.${owner}`] = `unknown setting ${owner}`;
			}
			for (const owner of ["user", "userGroup"] as const) {
				const valuesForOwner = group[owner];
				if (valuesForOwner === undefined) continue;
				const limits = plainObject(valuesForOwner);
				if (!limits) {
					fields[`library.${owner}`] = "must be an object";
					continue;
				}
				for (const key of Object.keys(limits)) {
					if (!["files", "fileBytes", "totalBytes"].includes(key)) {
						fields[`library.${owner}.${key}`] = `unknown setting ${key}`;
					}
				}
				// The stored setting keys spell the owner kind out: library.user_group_files.
				const prefix = owner === "userGroup" ? "user_group" : "user";
				for (const [field, setting] of [
					["files", "files"],
					["fileBytes", "file_bytes"],
					["totalBytes", "total_bytes"],
				] as const) {
					if (limits[field] === undefined) continue;
					check(`library.${owner}.${field}`, () => {
						values[`library.${prefix}_${setting}` as SettingKey] = parseLibraryLimit(
							limits[field],
							`library.${owner}.${field}`,
						);
					});
				}
			}
		}
	}

	if (input.attachments !== undefined) {
		const group = plainObject(input.attachments);
		if (!group) fields.attachments = "attachments must be an object";
		else {
			for (const key of Object.keys(group)) {
				if (!["inlineTextBytes", "inlineTotalBytes"].includes(key)) {
					fields[`attachments.${key}`] = `unknown setting ${key}`;
				}
			}
			for (const [field, setting] of [
				["inlineTextBytes", "attachments.inline_text_bytes"],
				["inlineTotalBytes", "attachments.inline_total_bytes"],
			] as const) {
				if (group[field] === undefined) continue;
				check(`attachments.${field}`, () => {
					values[setting] = parseSettingValue(setting, group[field]);
				});
			}
		}
	}

	if (input.imageCache !== undefined) {
		const group = plainObject(input.imageCache);
		if (!group) fields.imageCache = "imageCache must be an object";
		else {
			for (const key of Object.keys(group)) {
				if (!["diskBytes", "ttl"].includes(key)) {
					fields[`imageCache.${key}`] = `unknown setting ${key}`;
				}
			}
			for (const [field, setting] of [
				["diskBytes", "image_cache.disk_bytes"],
				["ttl", "image_cache.ttl"],
			] as const) {
				if (group[field] === undefined) continue;
				check(`imageCache.${field}`, () => {
					values[setting] = parseSettingValue(setting, group[field]);
				});
			}
		}
	}

	if (input.metrics !== undefined) {
		const group = plainObject(input.metrics);
		if (!group) fields.metrics = "metrics must be an object";
		else {
			for (const key of Object.keys(group)) {
				if (!["enabled", "interval", "retention"].includes(key)) {
					fields[`metrics.${key}`] = `unknown setting ${key}`;
				}
			}
			if (group.enabled !== undefined) {
				check("metrics.enabled", () => {
					values["metrics.enabled"] = parseSettingValue("metrics.enabled", group.enabled);
				});
			}
			if (group.interval !== undefined) {
				check("metrics.interval", () => {
					values["metrics.interval"] = parseSettingValue("metrics.interval", group.interval);
				});
			}
			if (group.retention !== undefined) {
				const retention = plainObject(group.retention);
				if (!retention) fields["metrics.retention"] = "metrics.retention must be an object";
				else {
					for (const key of Object.keys(retention)) {
						if (!["l1", "l2", "l3", "l4"].includes(key)) {
							fields[`metrics.retention.${key}`] = `unknown setting ${key}`;
						}
					}
					for (const level of [1, 2, 3, 4] as const) {
						const field = `metrics.retention.l${level}` as const;
						const value = retention[`l${level}`];
						if (value === undefined) continue;
						check(field, () => {
							values[field] = parseSettingValue(field, value);
						});
					}
				}
			}
		}
	}

	const groups = [
		[
			"directoryCopy",
			[
				["files", "directory_copy.files"],
				["bytes", "directory_copy.bytes"],
			],
		],
		["skills", [["maxPerUser", "skills.max_per_user"]]],
		[
			"jobs",
			[
				["maxConsecutiveWakes", "jobs.max_consecutive_wakes"],
				["maxRunning", "jobs.max_running"],
			],
		],
		[
			"pty",
			[
				["enabled", "pty.enabled"],
				["maxPerNode", "pty.max_per_node"],
				["maxTotal", "pty.max_total"],
				["maxPerSession", "pty.max_per_session"],
				["agentIdleTimeoutMax", "pty.agent_idle_timeout_max"],
				["watchTimeoutMax", "pty.watch_timeout_max"],
				["scrollbackBytes", "pty.scrollback_bytes"],
			],
		],
	] as const;
	for (const [name, entries] of groups) {
		if (input[name] === undefined) continue;
		const group = plainObject(input[name]);
		if (!group) {
			fields[name] = `${name} must be an object`;
			continue;
		}
		const known: readonly string[] = entries.map(([field]) => field);
		for (const key of Object.keys(group)) {
			if (!known.includes(key)) fields[`${name}.${key}`] = `unknown setting ${key}`;
		}
		for (const [field, setting] of entries) {
			if (group[field] === undefined) continue;
			check(`${name}.${field}`, () => {
				values[setting] = parseSettingValue(setting, group[field]);
			});
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
		library: {
			user: validateLibraryLimits(wire.library.user, "library.user"),
			userGroup: validateLibraryLimits(wire.library.userGroup, "library.userGroup"),
		},
		attachments: {
			inlineTextBytes: parseInteger(wire.attachments.inlineTextBytes, "attachments.inlineTextBytes", 0),
			inlineTotalBytes: parseInteger(wire.attachments.inlineTotalBytes, "attachments.inlineTotalBytes", 0),
		},
		imageCache: {
			diskBytes: parseInteger(wire.imageCache.diskBytes, "imageCache.diskBytes", 0),
			ttlMs: parseDurationMs(wire.imageCache.ttl, "image_cache.ttl"),
		},
		directoryCopy: {
			files: parseInteger(wire.directoryCopy.files, "directoryCopy.files", 0),
			bytes: parseInteger(wire.directoryCopy.bytes, "directoryCopy.bytes", 0),
		},
		skills: { maxPerUser: parseInteger(wire.skills.maxPerUser, "skills.maxPerUser", 0) },
		jobs: {
			maxConsecutiveWakes: parseInteger(wire.jobs.maxConsecutiveWakes, "jobs.maxConsecutiveWakes", 0),
			maxRunning: parseInteger(wire.jobs.maxRunning, "jobs.maxRunning", 0),
		},
		pty: {
			enabled: wire.pty.enabled,
			maxPerNode: parseInteger(wire.pty.maxPerNode, "pty.maxPerNode", 0),
			maxTotal: parseInteger(wire.pty.maxTotal, "pty.maxTotal", 0),
			maxPerSession: parseInteger(wire.pty.maxPerSession, "pty.maxPerSession", 0),
			agentIdleTimeoutMaxMs: parseDurationMs(wire.pty.agentIdleTimeoutMax, "pty.agentIdleTimeoutMax"),
			watchTimeoutMaxMs: parseDurationMs(wire.pty.watchTimeoutMax, "pty.watchTimeoutMax"),
			scrollbackBytes: parseInteger(wire.pty.scrollbackBytes, "pty.scrollbackBytes", MIN_PTY_SCROLLBACK_BYTES),
		},
		metrics: resolveMetrics(wire.metrics),
	};
}

function resolveMetrics(wire: SystemSettingsMetrics): RuntimeSettings["metrics"] {
	if (typeof wire.enabled !== "boolean") throw new Error("metrics.enabled must be a boolean");
	const interval = parseMetricsInterval(wire.interval);
	const retention = {
		l1Ms: parseMetricRetentionMs(wire.retention.l1, 1),
		l2Ms: parseMetricRetentionMs(wire.retention.l2, 2),
		l3Ms: parseMetricRetentionMs(wire.retention.l3, 3),
		l4Ms: parseMetricRetentionMs(wire.retention.l4, 4),
	};
	const problems = metricsRetentionProblems(wire.retention);
	const first = Object.values(problems)[0];
	if (first !== undefined) throw new Error(first);
	return { enabled: wire.enabled, intervalMs: interval * 1000, retention };
}

function validateLibraryLimits(limits: LibraryLimits, name: string): LibraryLimits {
	return {
		files: parseLibraryLimit(limits.files, `${name}.files`),
		fileBytes: parseLibraryLimit(limits.fileBytes, `${name}.fileBytes`),
		totalBytes: parseLibraryLimit(limits.totalBytes, `${name}.totalBytes`),
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
		// The levels must stay ordered as a whole: a patch may set only one of them.
		const metricsProblems = metricsRetentionProblems(nextWire.metrics.retention);
		if (Object.keys(metricsProblems).length > 0) throw new SettingsValidationError(metricsProblems);
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
