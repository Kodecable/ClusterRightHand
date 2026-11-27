import type { RulePreset, UserSettings, UserSettingsUpdate } from "@crh/api";
import { parseRulePreset } from "../policy/store.ts";
import type { Db } from "../storage/db.ts";
import { UserError } from "../util/errors.ts";
import { parseStoredModelRef } from "../util/model-ref.ts";

/**
 * One row per user of the user's own settings (doc/design/data-model.md "User settings"): the UI and
 * chat-bot language, the defaults for new sessions and the chat notification settings. A missing row is
 * the defaults, so a user has no settings until they change one.
 */

/** What a user gets before changing anything. */
export const DEFAULT_USER_SETTINGS: UserSettings = {
	locale: null,
	defaultModel: null,
	defaultRulePreset: null,
	showProgress: true,
	defaultChannelAccountId: null,
};

function parseStoredRulePreset(raw: string | null): RulePreset | null {
	if (!raw) return null;
	try {
		return parseRulePreset(raw);
	} catch {
		return null;
	}
}

export async function getUserSettings(db: Db, userId: string): Promise<UserSettings> {
	const row = await db
		.selectFrom("user_settings")
		.select(["locale", "default_model", "default_rule_preset", "show_progress", "default_channel_account_id"])
		.where("user_id", "=", userId)
		.executeTakeFirst();
	if (!row) return { ...DEFAULT_USER_SETTINGS };
	return {
		locale: row.locale,
		defaultModel: parseStoredModelRef(row.default_model),
		defaultRulePreset: parseStoredRulePreset(row.default_rule_preset),
		showProgress: row.show_progress !== 0,
		defaultChannelAccountId: row.default_channel_account_id,
	};
}

/**
 * Applies a partial change; an omitted field stays, null clears. A default notification account must be
 * one of the user's linked accounts; the foreign key clears it when that account is deleted.
 */
export async function patchUserSettings(db: Db, userId: string, change: UserSettingsUpdate): Promise<UserSettings> {
	const current = await getUserSettings(db, userId);
	if (change.defaultChannelAccountId !== undefined && change.defaultChannelAccountId !== null) {
		const account = await db
			.selectFrom("channel_accounts")
			.select("id")
			.where("id", "=", change.defaultChannelAccountId)
			.where("user_id", "=", userId)
			.executeTakeFirst();
		if (!account) throw new UserError("no such linked chat account");
	}
	const next: UserSettings = {
		locale: change.locale === undefined ? current.locale : change.locale,
		defaultModel: change.defaultModel === undefined ? current.defaultModel : change.defaultModel,
		defaultRulePreset: change.defaultRulePreset === undefined ? current.defaultRulePreset : change.defaultRulePreset,
		showProgress: change.showProgress === undefined ? current.showProgress : change.showProgress,
		defaultChannelAccountId:
			change.defaultChannelAccountId === undefined ? current.defaultChannelAccountId : change.defaultChannelAccountId,
	};
	const now = new Date().toISOString();
	const values = {
		locale: next.locale,
		default_model: next.defaultModel === null ? null : JSON.stringify(next.defaultModel),
		default_rule_preset: next.defaultRulePreset,
		show_progress: next.showProgress ? 1 : 0,
		default_channel_account_id: next.defaultChannelAccountId,
		updated_at: now,
	};
	await db
		.insertInto("user_settings")
		.values({ user_id: userId, ...values })
		.onConflict((oc) => oc.column("user_id").doUpdateSet(values))
		.execute();
	return next;
}

/** Drops a disabled user's settings with their chat accounts (doc/design/channels.md "Accounts"). */
export async function deleteUserSettings(db: Db, userId: string): Promise<void> {
	await db.deleteFrom("user_settings").where("user_id", "=", userId).execute();
}
