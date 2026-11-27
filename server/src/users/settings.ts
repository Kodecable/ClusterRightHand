import type { RulePreset, UserSettings, UserSettingsUpdate } from "@crh/api";
import { sql } from "kysely";
import { parseRulePreset } from "../policy/store.ts";
import type { Db } from "../storage/db.ts";
import { isPostgres } from "../storage/dialect.ts";
import { withTransaction } from "../storage/library-rows.ts";
import type { UserSettingsTable } from "../storage/schema.ts";
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

type SettingsRow = Pick<
	UserSettingsTable,
	"locale" | "default_model" | "default_rule_preset" | "show_progress" | "default_channel_account_id"
>;

function toUserSettings(row: SettingsRow): UserSettings {
	return {
		locale: row.locale,
		defaultModel: parseStoredModelRef(row.default_model),
		defaultRulePreset: parseStoredRulePreset(row.default_rule_preset),
		showProgress: row.show_progress !== 0,
		defaultChannelAccountId: row.default_channel_account_id,
	};
}

export async function getUserSettings(db: Db, userId: string): Promise<UserSettings> {
	const row = await db
		.selectFrom("user_settings")
		.select(["locale", "default_model", "default_rule_preset", "show_progress", "default_channel_account_id"])
		.where("user_id", "=", userId)
		.executeTakeFirst();
	return row ? toUserSettings(row) : { ...DEFAULT_USER_SETTINGS };
}

/** The stable error code a caller maps when a default chat account is not the user's. */
export const CHANNEL_ACCOUNT_NOT_LINKED = "channel_account_not_linked";

/** The settings before and after one partial change, read and written under the same lock. */
export interface UserSettingsPatch {
	before: UserSettings;
	after: UserSettings;
}

/**
 * Applies a partial change; an omitted field stays, null clears. A default notification account must be
 * one of the user's linked accounts; the foreign key clears it when that account is deleted.
 *
 * Only the fields this request names are written. A whole-row read followed by a whole-row write would
 * let two concurrent PATCHes overwrite each other's omitted fields with a stale snapshot. The change is
 * serialized per user so `before` really is the value this request replaced, which the audit log needs:
 * PostgreSQL takes an advisory transaction lock keyed by the user; SQLite's `BEGIN IMMEDIATE` already
 * serializes writers. `RETURNING` then gives the row this statement wrote rather than a later read.
 */
export async function patchUserSettingsWithBefore(
	db: Db,
	userId: string,
	change: UserSettingsUpdate,
): Promise<UserSettingsPatch> {
	return withTransaction(db, async (trx) => {
		if (isPostgres(trx)) {
			await sql`select pg_advisory_xact_lock(hashtextextended(${userId}, 0))`.execute(trx);
			// The advisory lock serializes PATCHes. Lock the row itself too: an account unlink or channel
			// deletion clears the default through ON DELETE SET NULL, and that foreign-key update must
			// wait here or it can change the row between `before` and the write below.
			await trx.selectFrom("user_settings").select("user_id").where("user_id", "=", userId).forUpdate().execute();
		}
		const before = await getUserSettings(trx, userId);
		if (change.defaultChannelAccountId !== undefined && change.defaultChannelAccountId !== null) {
			const account = await trx
				.selectFrom("channel_accounts")
				.select("id")
				.where("id", "=", change.defaultChannelAccountId)
				.where("user_id", "=", userId)
				.executeTakeFirst();
			if (!account) throw new UserError("no such linked chat account", CHANNEL_ACCOUNT_NOT_LINKED);
		}
		const values = {
			...(change.locale !== undefined ? { locale: change.locale } : {}),
			...(change.defaultModel !== undefined
				? { default_model: change.defaultModel === null ? null : JSON.stringify(change.defaultModel) }
				: {}),
			...(change.defaultRulePreset !== undefined ? { default_rule_preset: change.defaultRulePreset } : {}),
			...(change.showProgress !== undefined ? { show_progress: change.showProgress ? 1 : 0 } : {}),
			...(change.defaultChannelAccountId !== undefined
				? { default_channel_account_id: change.defaultChannelAccountId }
				: {}),
		};
		if (Object.keys(values).length === 0) return { before, after: before };
		const now = new Date().toISOString();
		const written = await trx
			.insertInto("user_settings")
			.values({
				user_id: userId,
				locale: DEFAULT_USER_SETTINGS.locale,
				default_model: null,
				default_rule_preset: DEFAULT_USER_SETTINGS.defaultRulePreset,
				show_progress: DEFAULT_USER_SETTINGS.showProgress ? 1 : 0,
				default_channel_account_id: DEFAULT_USER_SETTINGS.defaultChannelAccountId,
				...values,
				updated_at: now,
			})
			.onConflict((oc) => oc.column("user_id").doUpdateSet({ ...values, updated_at: now }))
			.returningAll()
			.executeTakeFirstOrThrow();
		return { before, after: toUserSettings(written) };
	});
}

/** The changed settings; callers that need an exact audit old value use `patchUserSettingsWithBefore`. */
export async function patchUserSettings(db: Db, userId: string, change: UserSettingsUpdate): Promise<UserSettings> {
	return (await patchUserSettingsWithBefore(db, userId, change)).after;
}

/** Drops a disabled user's settings with their chat accounts (doc/design/channels.md "Accounts"). */
export async function deleteUserSettings(db: Db, userId: string): Promise<void> {
	await db.deleteFrom("user_settings").where("user_id", "=", userId).execute();
}
