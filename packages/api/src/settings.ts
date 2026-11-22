/**
 * Runtime system settings (`GET/PATCH /api/settings`): the low-frequency crhs settings that
 * administrators edit on the System settings page and that apply without a restart
 * (doc/guide/reference/crhs-config.md).
 *
 * Durations use the crhs.toml syntax (`"60s"`, `"5m"`, `"1d"`); retention values are also `"off"`.
 */

import type { z } from "zod";
import type {
	SystemSettingsAttachmentsSchema,
	SystemSettingsAuthSchema,
	SystemSettingsDirectoryCopySchema,
	SystemSettingsImageCacheSchema,
	SystemSettingsPatchSchema,
	SystemSettingsResponseSchema,
	SystemSettingsRetentionSchema,
	SystemSettingsSchema,
	SystemSettingsSkillsSchema,
	SystemSettingsWebauthnSchema,
} from "./schemas/settings.ts";

/** How long crhs keeps finished tasks and authorizations, audit events and durable tool tasks. */
export type SystemSettingsRetention = z.infer<typeof SystemSettingsRetentionSchema>;

/** Passkey settings; `rpId` null with empty `origins` derives the relying party from each request. */
export type SystemSettingsWebauthn = z.infer<typeof SystemSettingsWebauthnSchema>;

/** Login hashing and proof-of-work settings. */
export type SystemSettingsAuth = z.infer<typeof SystemSettingsAuthSchema>;

/** Chat attachments: how much short text is inlined into the model content (doc/design/library.md "Chat attachments"). */
export type SystemSettingsAttachments = z.infer<typeof SystemSettingsAttachmentsSchema>;

/** The image cache and its time to live (doc/design/library.md "Image cache"). */
export type SystemSettingsImageCache = z.infer<typeof SystemSettingsImageCacheSchema>;

/** The limits of one directory copy into a library (doc/design/library.md "Directory copies"). */
export type SystemSettingsDirectoryCopy = z.infer<typeof SystemSettingsDirectoryCopySchema>;

/** How many skills a session's system prompt lists (doc/design/library.md "Skills"). */
export type SystemSettingsSkills = z.infer<typeof SystemSettingsSkillsSchema>;

/** The settings administrators edit in System settings. */
export type SystemSettings = z.infer<typeof SystemSettingsSchema>;

export type SystemSettingsResponse = z.infer<typeof SystemSettingsResponseSchema>;

/** A partial update; omitted fields and groups keep their current value. */
export type SystemSettingsPatch = z.infer<typeof SystemSettingsPatchSchema>;
