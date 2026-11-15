import type { UserSettings, UserSettingsUpdate } from "@crh/api";
import { UserSettingsResponseSchema, UserSettingsUpdateSchema } from "@crh/api/schemas";
import { type ModelConfig, parseModelRef } from "../agent/models.ts";
import { userActor } from "../audit/audit.ts";
import { parseRulePreset } from "../policy/store.ts";
import type { Db } from "../storage/db.ts";
import { getUserSettings, patchUserSettings } from "../users/settings.ts";
import { errorText, isForeignKeyViolation, UserError } from "../util/errors.ts";
import { apiRouter, defineRoute, json } from "./openapi.ts";

const TAGS = ["Settings"];

const getRoute = defineRoute({
	method: "get",
	path: "/me/settings",
	tags: TAGS,
	summary: "The caller's own settings: language, new-session defaults and chat notifications",
	agent: "allow",
	responses: { 200: { description: "The settings", ...json(UserSettingsResponseSchema) } },
});

const patchRoute = defineRoute({
	method: "patch",
	path: "/me/settings",
	tags: TAGS,
	summary: "Change the caller's settings; omitted fields stay, null clears a field",
	agent: "deny", // it sets the default rule preset for new sessions
	request: { body: { required: true, ...json(UserSettingsUpdateSchema) } },
	responses: { 200: { description: "The settings as they now are", ...json(UserSettingsResponseSchema) } },
});

export interface UserSettingsRoutesOptions {
	/** Present when the agent runtime is; without it a default model cannot be checked or stored. */
	models?: ModelConfig;
}

/**
 * One user's own settings (doc/design/data-model.md "User settings"). The language is also the chat bot's
 * language; the session defaults apply to sessions the WebUI starts. A rejected field is reported as
 * `<field>: <problem>`, like a schema failure.
 */
export function userSettingsRoutes(db: Db, options: UserSettingsRoutesOptions = {}) {
	const app = apiRouter();

	app.openapi(getRoute, async (c) => {
		return c.json({ settings: await getUserSettings(db, c.get("user").userId) }, 200);
	});

	app.openapi(patchRoute, async (c) => {
		const user = c.get("user");
		const body = c.req.valid("json");
		const change: UserSettingsUpdate = {};
		if (body.locale !== undefined) change.locale = body.locale;
		if (body.showProgress !== undefined) change.showProgress = body.showProgress;

		if (body.defaultModel !== undefined) {
			if (body.defaultModel === null) {
				change.defaultModel = null;
			} else {
				const models = options.models;
				if (!models) throw new UserError("defaultModel: no model providers are configured");
				try {
					change.defaultModel = models.resolveRef(parseModelRef(body.defaultModel));
				} catch (err) {
					throw new UserError(`defaultModel: ${errorText(err)}`);
				}
			}
		}

		if (body.defaultRulePreset !== undefined) {
			if (body.defaultRulePreset === null) {
				change.defaultRulePreset = null;
			} else {
				try {
					change.defaultRulePreset = parseRulePreset(body.defaultRulePreset);
				} catch (err) {
					throw new UserError(`defaultRulePreset: ${errorText(err)}`);
				}
			}
		}

		if (body.defaultChannelAccountId !== undefined) {
			if (body.defaultChannelAccountId !== null) {
				const account = await db
					.selectFrom("channel_accounts")
					.select("id")
					.where("id", "=", body.defaultChannelAccountId)
					.where("user_id", "=", user.userId)
					.executeTakeFirst();
				if (!account) throw new UserError("defaultChannelAccountId: no such linked chat account");
			}
			change.defaultChannelAccountId = body.defaultChannelAccountId;
		}

		const before = await getUserSettings(db, user.userId);
		let after: UserSettings;
		try {
			after = await patchUserSettings(db, user.userId, change);
		} catch (err) {
			// The account check above and the write are separate statements: if the account is unlinked in
			// between, the foreign key rejects the write and the caller gets the same refusal as a bad id.
			if (isForeignKeyViolation(err)) {
				throw new UserError("defaultChannelAccountId: no such linked chat account");
			}
			throw err;
		}
		const keys = Object.keys(change) as (keyof UserSettings)[];
		const changed = keys.filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
		if (changed.length > 0) {
			const oldValues: Record<string, unknown> = {};
			const newValues: Record<string, unknown> = {};
			for (const key of changed) {
				oldValues[key] = before[key];
				newValues[key] = after[key];
			}
			void c.get("audit").record({
				actor: userActor(user),
				action: "user_settings.changed",
				target: { type: "user", id: user.userId },
				detail: { changed, old: oldValues, new: newValues },
			});
		}
		return c.json({ settings: after }, 200);
	});

	return app;
}
