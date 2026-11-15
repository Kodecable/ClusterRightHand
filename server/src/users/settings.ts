import type { ModelRef, RulePreset, UserSettings, UserSettingsUpdate } from "@crh/api";
import { parseRulePreset } from "../policy/store.ts";
import type { Db } from "../storage/db.ts";
import { UserError } from "../util/errors.ts";

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

function parseStoredModel(raw: string | null): ModelRef | null {
	if (!raw) return null;
	try {
		const value = JSON.parse(raw) as { provider?: unknown; modelId?: unknown; thinkingLevel?: unknown };
		if (typeof value.provider !== "string" || typeof value.modelId !== "string") return null;
		return {
			provider: value.provider,
			modelId: value.modelId,
			...(typeof value.thinkingLevel === "string"
				? { thinkingLevel: value.thinkingLevel as ModelRef["thinkingLevel"] }
				: {}),
		};
	} catch {
		return null;
	}
}

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
		defaultModel: parseStoredModel(row.default_model),
		defaultRulePreset: parseStoredRulePreset(row.default_rule_preset),
		showProgress: row.show_progress !== 0,
		defaultChannelAccountId: row.default_channel_account_id,
	};
}

/**
 * Applies a partial change; an omitted field stays, null clears. A default notification account must be
 * one of the user's linked accounts, so a later unlink can only clear an account it actually removed.
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

/** Clears a user's default notification account when it is the one being unlinked. */
export async function clearDefaultChannelAccount(db: Db, userId: string, accountId: string): Promise<void> {
	await db
		.updateTable("user_settings")
		.set({ default_channel_account_id: null, updated_at: new Date().toISOString() })
		.where("user_id", "=", userId)
		.where("default_channel_account_id", "=", accountId)
		.execute();
}

/** Clears every default that points at one of the accounts of a deleted channel. */
export async function clearDefaultChannelAccounts(db: Db, accountIds: readonly string[]): Promise<void> {
	if (accountIds.length === 0) return;
	await db
		.updateTable("user_settings")
		.set({ default_channel_account_id: null, updated_at: new Date().toISOString() })
		.where("default_channel_account_id", "in", accountIds)
		.execute();
}

/** Drops a disabled user's settings with their chat accounts (doc/design/channels.md "Accounts"). */
export async function deleteUserSettings(db: Db, userId: string): Promise<void> {
	await db.deleteFrom("user_settings").where("user_id", "=", userId).execute();
}
