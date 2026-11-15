/**
 * One user's own settings (doc/design/data-model.md "User settings"): the UI and chat-bot language, the
 * defaults for new sessions and the chat notification settings.
 */

import type { z } from "zod";
import type {
	UserSettingsLocaleSchema,
	UserSettingsSchema,
	UserSettingsUpdateSchema,
} from "./schemas/user-settings.ts";

export type UserSettingsLocale = z.infer<typeof UserSettingsLocaleSchema>;

/** `GET /api/me/settings`. */
export type UserSettings = z.infer<typeof UserSettingsSchema>;

/** `PATCH /api/me/settings`; omitted fields stay unchanged, null clears a field. */
export type UserSettingsUpdate = z.infer<typeof UserSettingsUpdateSchema>;
