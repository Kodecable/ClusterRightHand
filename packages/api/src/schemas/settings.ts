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
