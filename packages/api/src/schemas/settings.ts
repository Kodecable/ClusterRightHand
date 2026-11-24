/**
 * Runtime schemas for the system settings routes (`GET`/`PATCH /api/settings`). The wire types in
 * `../settings.ts` are derived from them (doc/guide/reference/crhs-config.md).
 */
import { z } from "zod";
import { ErrorResponseSchema } from "./common.ts";
import { LibraryLimitsSchema, SystemSettingsLibrarySchema } from "./libraries.ts";

export const SystemSettingsRetentionSchema = z
	.object({
		tasks: z.string().describe('How long finished tasks are kept, e.g. "30d" or "off".'),
		audit: z.string().describe('How long audit events are kept, e.g. "180d" or "off".'),
		piTasks: z.string().describe('How long terminal durable agent tasks are kept, e.g. "7d" or "off".'),
	})
	.meta({ id: "SystemSettingsRetention" });

export const SystemSettingsWebauthnSchema = z
	.object({
		rpId: z.string().nullable().describe("The relying party id; null with empty origins derives it from the request."),
		rpName: z.string(),
		origins: z.array(z.string()).describe("The origins a Passkey registration may come from."),
	})
	.meta({ id: "SystemSettingsWebauthn" });

export const SystemSettingsAuthSchema = z
	.object({
		captcha: z.enum(["cap", "none"]),
		argon2Concurrency: z.number(),
		argon2Queue: z.number(),
	})
	.meta({ id: "SystemSettingsAuth" });

export const SystemSettingsAttachmentsSchema = z
	.object({
		inlineTextBytes: z.number().describe("The largest file whose text content is inlined into a message."),
		inlineTotalBytes: z.number().describe("The most text inlined over one message."),
	})
	.meta({ id: "SystemSettingsAttachments" });

export const SystemSettingsImageCacheSchema = z
	.object({
		diskBytes: z.number().describe("Bytes kept on crhs's local disk."),
		ttl: z.string().describe('A duration such as "7d"; an entry unused for longer is swept.'),
	})
	.meta({ id: "SystemSettingsImageCache" });

export const SystemSettingsDirectoryCopySchema = z
	.object({
		files: z.number().describe("The most files one directory copy into a library takes."),
		bytes: z.number().describe("The most bytes one directory copy into a library takes."),
	})
	.meta({ id: "SystemSettingsDirectoryCopy" });

export const SystemSettingsSkillsSchema = z
	.object({
		maxPerUser: z.number().describe("The most skills a session's system prompt lists; past it the prompt lists none."),
	})
	.meta({ id: "SystemSettingsSkills" });

/** The job limits of a session (doc/design/jobs.md "Completion notices" and "Lifecycle and retention"). */
export const SystemSettingsJobsSchema = z
	.object({
		maxConsecutiveWakes: z
			.number()
			.describe("The most times completion notices may wake a session since its last user-authored input."),
		maxRunning: z.number().describe("The most unsettled jobs a session (or an API token) may have at once."),
	})
	.meta({ id: "SystemSettingsJobs" });

/**
 * The terminal subsystem's settings (doc/design/pty.md "Settings and limits"). `scrollbackBytes` is
 * crha's ring buffer per terminal; crha clamps it to 64 KiB..16 MiB.
 */
export const SystemSettingsPtySchema = z
	.object({
		enabled: z.boolean().describe("Turning it off closes every terminal and hides the page and the agent tools."),
		maxPerNode: z.number().describe("The most terminals held on one node, opening, running or exited."),
		maxTotal: z.number().describe("The most terminals held across all nodes."),
		maxPerSession: z.number().describe("The most terminals one session created or is associated with."),
		agentIdleTimeoutMax: z.string().describe('The largest idle timeout an agent may ask for, e.g. "1h".'),
		watchTimeoutMax: z.string().describe('The longest pty_watch an agent may ask for, e.g. "10m".'),
		scrollbackBytes: z.number().describe("crha's ring buffer per terminal, in bytes."),
	})
	.meta({ id: "SystemSettingsPty" });

/**
 * The per-level retention of host metric buckets (doc/design/metrics.md "Storage"): level 1 is 1 minute,
 * 2 is 5 minutes, 3 is 1 hour and 4 is 1 day. Each level must be at least ten buckets long and at least as
 * long as the level before it.
 */
export const SystemSettingsMetricsRetentionSchema = z
	.object({
		l1: z.string().describe('How long 1-minute buckets are kept, e.g. "24h"; at least "10m".'),
		l2: z.string().describe('How long 5-minute buckets are kept, e.g. "7d"; at least "50m" and at least l1.'),
		l3: z.string().describe('How long 1-hour buckets are kept, e.g. "30d"; at least "10h" and at least l2.'),
		l4: z.string().describe('How long 1-day buckets are kept, e.g. "365d"; at least "10d" and at least l3.'),
	})
	.meta({ id: "SystemSettingsMetricsRetention" });

/** Host metrics collection (doc/design/metrics.md "Settings" and "Limits"). */
export const SystemSettingsMetricsSchema = z
	.object({
		enabled: z.boolean().describe("Whether crhs samples the host metrics of its nodes."),
		interval: z.number().describe("Seconds between samples: 15, 20, 30 or 60."),
		retention: SystemSettingsMetricsRetentionSchema,
	})
	.meta({ id: "SystemSettingsMetrics" });

/** The settings administrators edit in System settings. */
export const SystemSettingsSchema = z
	.object({
		publicUrl: z
			.string()
			.nullable()
			.describe("Absolute public base URL for generated links; null uses the request URL."),
		clockWarn: z.string().describe('A duration such as "60s"; "0s" disables the node clock warning.'),
		retention: SystemSettingsRetentionSchema,
		webauthn: SystemSettingsWebauthnSchema,
		auth: SystemSettingsAuthSchema,
		realIpHeader: z
			.string()
			.nullable()
			.describe("Header whose first value is the client address; null uses the socket."),
		library: SystemSettingsLibrarySchema,
		attachments: SystemSettingsAttachmentsSchema,
		imageCache: SystemSettingsImageCacheSchema,
		directoryCopy: SystemSettingsDirectoryCopySchema,
		skills: SystemSettingsSkillsSchema,
		jobs: SystemSettingsJobsSchema,
		pty: SystemSettingsPtySchema,
		metrics: SystemSettingsMetricsSchema,
	})
	.meta({ id: "SystemSettings" });

/** `GET /api/settings`: the current values and the defaults. */
export const SystemSettingsResponseSchema = z
	.object({
		settings: SystemSettingsSchema,
		defaults: SystemSettingsSchema.describe("The defaults a setting falls back to when it was never stored."),
	})
	.meta({ id: "SystemSettingsResponse" });

/** `PATCH /api/settings`: a partial update; omitted fields and groups keep their current value. */
export const SystemSettingsPatchSchema = z.object({
	publicUrl: z.string().nullable().optional(),
	clockWarn: z.string().optional(),
	retention: z
		.object({
			tasks: z.string().optional(),
			audit: z.string().optional(),
			piTasks: z.string().optional(),
		})
		.optional(),
	webauthn: z
		.object({
			rpId: z.string().nullable().optional().describe("Set together with origins."),
			rpName: z.string().optional(),
			origins: z.array(z.string()).optional(),
		})
		.optional(),
	auth: z
		.object({
			captcha: z.enum(["cap", "none"]).optional(),
			argon2Concurrency: z.number().optional(),
			argon2Queue: z.number().optional(),
		})
		.optional(),
	realIpHeader: z.string().nullable().optional(),
	library: z
		.object({
			user: LibraryLimitsSchema.partial().optional(),
			userGroup: LibraryLimitsSchema.partial().optional(),
		})
		.optional(),
	attachments: SystemSettingsAttachmentsSchema.partial().optional(),
	imageCache: SystemSettingsImageCacheSchema.partial().optional(),
	directoryCopy: SystemSettingsDirectoryCopySchema.partial().optional(),
	skills: SystemSettingsSkillsSchema.partial().optional(),
	jobs: SystemSettingsJobsSchema.partial().optional(),
	pty: SystemSettingsPtySchema.partial().optional(),
	metrics: z
		.object({
			enabled: z.boolean().optional(),
			interval: z.number().optional(),
			retention: SystemSettingsMetricsRetentionSchema.partial().optional(),
		})
		.optional(),
});

/** `PATCH /api/settings` success: the settings as they now are. */
export const SystemSettingsUpdateResponseSchema = z
	.object({ settings: SystemSettingsSchema })
	.meta({ id: "SystemSettingsUpdateResponse" });

/** A rejected settings patch: the message and one text per rejected field path. */
export const SettingsValidationErrorSchema = ErrorResponseSchema.extend({
	fields: z.record(z.string(), z.string()).describe("Field path to the problem; an empty key covers the whole body."),
}).meta({ id: "SettingsValidationError" });

/**
 * The `PATCH /api/settings` body: a JSON object whose fields the settings store validates one by one,
 * reporting every problem in `fields`.
 */
export const SystemSettingsPatchBodySchema = z.record(z.string(), z.unknown());
