/**
 * Runtime schemas for one user's own settings (`../user-settings.ts`, doc/design/data-model.md "User settings").
 * The language is also the chat bot's language; the session defaults apply to sessions the WebUI starts.
 */
import { z } from "zod";
import { ModelRefSchema } from "./models.ts";
import { RulePresetSchema } from "./policy.ts";

/** The languages the WebUI and the chat bot speak. */
export const UserSettingsLocaleSchema = z.enum(["en", "zh-CN"]);

/** One user's settings; a missing/empty field means the default. */
export const UserSettingsSchema = z
	.object({
		locale: UserSettingsLocaleSchema.nullable().describe("The UI and chat-bot language; null follows the browser."),
		defaultModel: ModelRefSchema.nullable().describe(
			"New sessions' model, thinking level included; null uses the session model preset.",
		),
		defaultRulePreset: RulePresetSchema.nullable().describe("New sessions' rule preset; null means ask."),
		showProgress: z.boolean().describe("Whether a progress status/draft is shown in chat while a turn runs."),
		defaultChannelAccountId: z
			.string()
			.nullable()
			.describe("The linked chat account notifications fall back to; null means none."),
	})
	.meta({ id: "UserSettings" });

/** `PATCH /api/me/settings`; omitted fields stay unchanged, null clears a field. */
export const UserSettingsUpdateSchema = z.object({
	locale: UserSettingsLocaleSchema.nullable().optional(),
	defaultModel: ModelRefSchema.nullable().optional(),
	defaultRulePreset: RulePresetSchema.nullable().optional(),
	showProgress: z.boolean().optional(),
	defaultChannelAccountId: z.string().nullable().optional(),
});

export const UserSettingsResponseSchema = z.object({ settings: UserSettingsSchema });
