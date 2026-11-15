import { randomInt } from "node:crypto";
import type { ChannelAccountView, ChannelPublicView, ChannelView } from "@crh/api";
import type { Selectable } from "kysely";
import { parseModelRef } from "../agent/models.ts";
import { hashToken } from "../auth/token-hash.ts";
import { secretAad } from "../keys/export.ts";
import type { MasterKey } from "../keys/master-key.ts";
import { parseRulePreset } from "../policy/store.ts";
import type { Db } from "../storage/db.ts";
import { defaultOrgId } from "../storage/org.ts";
import type { ChannelAccountsTable, ChannelsTable, ChannelThreadsTable } from "../storage/schema.ts";
import { NotFoundError, UserError } from "../util/errors.ts";
import { newId } from "../util/id.ts";

/**
 * Stored channels, linked accounts, thread mappings and chat user settings (doc/design/channels.md). A channel's
 * credentials live in one `secrets` row encrypted with the master key, like an extension's headers, so the API
 * can say whether they are set but never return them.
 */

export type ChannelRow = Selectable<ChannelsTable>;
export type ChannelAccountRow = Selectable<ChannelAccountsTable>;
export type ChannelThreadRow = Selectable<ChannelThreadsTable>;

const SECRET_KIND = "channel_credentials";
export const CHANNEL_NAME_RE = /^[a-z-][a-z0-9-]{0,63}$/;
export const LINK_CODE_TTL_MS = 10 * 60_000;

/** The credentials a channel kind stores; Telegram only needs its bot token. */
export interface ChannelCredentials {
	token?: string;
	/** Satori only, when that kind is implemented. */
	url?: string;
}

export function validateChannelName(raw: string): string {
	if (!CHANNEL_NAME_RE.test(raw)) {
		throw new UserError(
			"the channel name must be at most 64 characters of lowercase letters, digits and '-', not starting with a digit",
		);
	}
	return raw;
}

export async function listChannelRows(db: Db): Promise<ChannelRow[]> {
	return db.selectFrom("channels").selectAll().orderBy("name").execute();
}

export async function getChannelRow(db: Db, name: string): Promise<ChannelRow | undefined> {
	const orgId = await defaultOrgId(db);
	return db.selectFrom("channels").selectAll().where("org_id", "=", orgId).where("name", "=", name).executeTakeFirst();
}

export async function getChannelById(db: Db, id: string): Promise<ChannelRow | undefined> {
	return db.selectFrom("channels").selectAll().where("id", "=", id).executeTakeFirst();
}

/** The decrypted credentials; a missing secret id means none. */
export async function readChannelCredentials(
	db: Db,
	masterKey: MasterKey,
	row: Pick<ChannelRow, "name" | "credentials_secret_id">,
): Promise<ChannelCredentials> {
	if (!row.credentials_secret_id) return {};
	const secret = await db
		.selectFrom("secrets")
		.select("ciphertext")
		.where("id", "=", row.credentials_secret_id)
		.executeTakeFirst();
	if (!secret) return {};
	try {
		return JSON.parse(
			masterKey.decrypt(secret.ciphertext, secretAad(row.credentials_secret_id, SECRET_KIND)).toString("utf8"),
		) as ChannelCredentials;
	} catch {
		throw new Error(`the stored credentials of channel ${row.name} cannot be decrypted`);
	}
}

/** The Telegram token of a channel; a missing or empty token is an error for the adapter. */
export async function readTelegramToken(
	db: Db,
	masterKey: MasterKey,
	row: Pick<ChannelRow, "name" | "credentials_secret_id">,
): Promise<string> {
	const credentials = await readChannelCredentials(db, masterKey, row);
	if (typeof credentials.token !== "string" || credentials.token.trim() === "") {
		throw new UserError(`channel ${row.name} has no bot token`);
	}
	return credentials.token.trim();
}

export interface ChannelInput {
	kind?: "telegram" | "satori";
	enabled?: boolean;
	/** Write-only; omitted keeps the stored credential. */
	token?: string | null;
	defaultModel?: unknown;
	defaultRulePreset?: unknown;
}

function parseDefaultModel(value: unknown): string | null {
	if (value === undefined) return null;
	if (value === null) return null;
	return JSON.stringify(parseModelRef(value));
}

function parseDefaultRulePreset(value: unknown): string | null {
	if (value === undefined || value === null) return null;
	return parseRulePreset(value);
}

/**
 * Creates or updates a channel. A new channel is Telegram; the Satori kind is a later task, so selecting it is
 * refused rather than stored as something no adapter can run.
 */
export async function saveChannel(
	db: Db,
	masterKey: MasterKey,
	name: string,
	input: ChannelInput,
): Promise<{ row: ChannelRow; created: boolean }> {
	validateChannelName(name);
	const existing = await getChannelRow(db, name);
	if (input.kind !== undefined && input.kind !== "telegram") {
		throw new UserError("only the telegram channel kind is available");
	}
	if (!existing && input.kind === undefined) {
		throw new UserError("kind is required to create a channel");
	}
	const orgId = await defaultOrgId(db);
	const now = new Date().toISOString();
	const token = typeof input.token === "string" ? input.token.trim() : input.token === null ? "" : undefined;
	if (!existing && (token === undefined || token === "")) throw new UserError("token is required to create a channel");
	const defaultModel =
		input.defaultModel === undefined ? (existing?.default_model ?? null) : parseDefaultModel(input.defaultModel);
	const defaultRulePreset =
		input.defaultRulePreset === undefined
			? (existing?.default_rule_preset ?? null)
			: parseDefaultRulePreset(input.defaultRulePreset);
	let created = false;
	await db.transaction().execute(async (trx) => {
		let secretId = existing?.credentials_secret_id ?? null;
		if (input.token !== undefined) {
			if (secretId) await trx.deleteFrom("secrets").where("id", "=", secretId).execute();
			secretId = null;
			if (token !== undefined && token !== "") {
				secretId = newId();
				await trx
					.insertInto("secrets")
					.values({
						id: secretId,
						org_id: orgId,
						kind: SECRET_KIND,
						ciphertext: masterKey.encrypt(
							Buffer.from(JSON.stringify({ token } satisfies ChannelCredentials), "utf8"),
							secretAad(secretId, SECRET_KIND),
						),
						created_at: now,
					})
					.execute();
			}
		}
		const values = {
			kind: "telegram" as const,
			enabled: (input.enabled ?? (existing ? existing.enabled === 1 : true)) ? 1 : 0,
			credentials_secret_id: secretId,
			default_model: defaultModel,
			default_rule_preset: defaultRulePreset,
			updated_at: now,
		};
		if (existing) {
			await trx.updateTable("channels").set(values).where("id", "=", existing.id).execute();
		} else {
			created = true;
			await trx
				.insertInto("channels")
				.values({ id: newId(), org_id: orgId, name, cursor: null, created_at: now, ...values })
				.execute();
		}
	});
	const row = await getChannelRow(db, name);
	if (!row) throw new NotFoundError("no such channel");
	return { row, created };
}

export async function deleteChannel(db: Db, name: string): Promise<ChannelRow> {
	const row = await getChannelRow(db, name);
	if (!row) throw new NotFoundError("no such channel");
	await db.transaction().execute(async (trx) => {
		const accounts = await trx.selectFrom("channel_accounts").select("id").where("channel_id", "=", row.id).execute();
		if (accounts.length > 0) {
			await trx
				.updateTable("channel_user_settings")
				.set({ default_account_id: null, updated_at: new Date().toISOString() })
				.where(
					"default_account_id",
					"in",
					accounts.map((account) => account.id),
				)
				.execute();
		}
		await trx.deleteFrom("channel_accounts").where("channel_id", "=", row.id).execute();
		await trx.deleteFrom("channel_threads").where("channel_id", "=", row.id).execute();
		await trx.deleteFrom("channels").where("id", "=", row.id).execute();
		if (row.credentials_secret_id) {
			await trx.deleteFrom("secrets").where("id", "=", row.credentials_secret_id).execute();
		}
	});
	return row;
}

/** Stores the last handled platform update id. */
export async function setChannelCursor(db: Db, channelId: string, updateId: number): Promise<void> {
	await db
		.updateTable("channels")
		.set({ cursor: String(updateId) })
		.where("id", "=", channelId)
		.execute();
}

export function parseChannelCursor(row: Pick<ChannelRow, "cursor">): number {
	if (!row.cursor) return 0;
	const value = Number(row.cursor);
	return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

export function channelDefaultModel(row: ChannelRow): ReturnType<typeof parseModelRef> | null {
	if (!row.default_model) return null;
	try {
		return parseModelRef(JSON.parse(row.default_model));
	} catch {
		return null;
	}
}

export function channelDefaultRulePreset(row: ChannelRow) {
	if (!row.default_rule_preset) return null;
	try {
		return parseRulePreset(row.default_rule_preset);
	} catch {
		return null;
	}
}

/** The administrator's view of a channel, with its live status. */
export function channelView(row: ChannelRow, status: ChannelView["status"]): ChannelView {
	return {
		id: row.id,
		name: row.name,
		kind: row.kind,
		enabled: row.enabled === 1,
		hasCredentials: row.credentials_secret_id !== null,
		defaultModel: channelDefaultModel(row),
		defaultRulePreset: channelDefaultRulePreset(row),
		status,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

/** A channel as a user's settings page sees it: only what linking needs. */
export function channelPublicView(row: ChannelRow, account: string | null): ChannelPublicView {
	return { id: row.id, name: row.name, kind: row.kind, account };
}

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function newLinkCode(): string {
	let code = "";
	for (let index = 0; index < 8; index++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
	return code;
}

/** Creates a one-time code for this user, valid for ten minutes; only its hash is stored. */
export async function createLinkCode(
	db: Db,
	userId: string,
	now = new Date(),
): Promise<{ code: string; expiresAt: string }> {
	const orgId = await defaultOrgId(db);
	const code = newLinkCode();
	const expiresAt = new Date(now.getTime() + LINK_CODE_TTL_MS).toISOString();
	await db
		.insertInto("channel_link_codes")
		.values({
			id: newId(),
			org_id: orgId,
			user_id: userId,
			code_hash: hashToken(code),
			expires_at: expiresAt,
			used_at: null,
			created_at: now.toISOString(),
		})
		.execute();
	return { code, expiresAt };
}

/** Uses a code once; returns the user it is bound to, or undefined when unknown, expired or used. */
export async function consumeLinkCode(db: Db, code: string, now = new Date()): Promise<string | undefined> {
	const row = await db
		.selectFrom("channel_link_codes")
		.select(["id", "user_id", "expires_at", "used_at"])
		.where("code_hash", "=", hashToken(code.trim().toUpperCase()))
		.executeTakeFirst();
	if (!row || row.used_at !== null || Date.parse(row.expires_at) <= now.getTime()) return undefined;
	const updated = await db
		.updateTable("channel_link_codes")
		.set({ used_at: now.toISOString() })
		.where("id", "=", row.id)
		.where("used_at", "is", null)
		.executeTakeFirst();
	return updated.numUpdatedRows > 0n ? row.user_id : undefined;
}

export async function accountByPlatform(
	db: Db,
	channelId: string,
	platform: string,
	platformUserId: string,
): Promise<ChannelAccountRow | undefined> {
	return db
		.selectFrom("channel_accounts")
		.selectAll()
		.where("channel_id", "=", channelId)
		.where("platform", "=", platform)
		.where("platform_user_id", "=", platformUserId)
		.executeTakeFirst();
}

/**
 * Links a platform account to a user. An account already linked to the same user is returned as is; one linked
 * to another user is refused, because it acts with that user's authority.
 */
export async function linkAccount(
	db: Db,
	channelId: string,
	platform: string,
	platformUserId: string,
	chatId: string,
	userId: string,
	displayName: string | null,
): Promise<{ account: ChannelAccountRow; created: boolean }> {
	const existing = await accountByPlatform(db, channelId, platform, platformUserId);
	if (existing) {
		if (existing.user_id !== userId) throw new UserError("this chat account is already linked to another user");
		return { account: existing, created: false };
	}
	const account = {
		id: newId(),
		channel_id: channelId,
		platform,
		platform_user_id: platformUserId,
		platform_chat_id: chatId,
		user_id: userId,
		display_name: displayName,
		linked_at: new Date().toISOString(),
	};
	await db.insertInto("channel_accounts").values(account).execute();
	return { account, created: true };
}

/** Unlinks one account; returns it for the audit, or undefined for an account the user does not own. */
export async function unlinkAccount(db: Db, userId: string, accountId: string): Promise<ChannelAccountRow | undefined> {
	const row = await db
		.selectFrom("channel_accounts")
		.selectAll()
		.where("id", "=", accountId)
		.where("user_id", "=", userId)
		.executeTakeFirst();
	if (!row) return undefined;
	await db.transaction().execute(async (trx) => {
		await trx.deleteFrom("channel_accounts").where("id", "=", accountId).execute();
		await trx
			.updateTable("channel_user_settings")
			.set({ default_account_id: null, updated_at: new Date().toISOString() })
			.where("user_id", "=", userId)
			.where("default_account_id", "=", accountId)
			.execute();
	});
	return row;
}

/** Removes every account of a disabled user (doc/design/channels.md "Accounts"); returns them for the audit. */
export async function unlinkUserAccounts(db: Db, userId: string): Promise<ChannelAccountRow[]> {
	const rows = await db.selectFrom("channel_accounts").selectAll().where("user_id", "=", userId).execute();
	if (rows.length === 0) return [];
	await db.transaction().execute(async (trx) => {
		await trx.deleteFrom("channel_accounts").where("user_id", "=", userId).execute();
		await trx.deleteFrom("channel_user_settings").where("user_id", "=", userId).execute();
	});
	return rows;
}

export interface ChannelAccountListItem {
	account: ChannelAccountRow;
	channelName: string;
	channelKind: ChannelRow["kind"];
}

/** The caller's linked accounts with their channel names. */
export async function accountsForUser(db: Db, userId: string): Promise<ChannelAccountListItem[]> {
	const rows = await db
		.selectFrom("channel_accounts as a")
		.innerJoin("channels as c", "c.id", "a.channel_id")
		.select([
			"a.id",
			"a.channel_id",
			"a.platform",
			"a.platform_user_id",
			"a.platform_chat_id",
			"a.user_id",
			"a.display_name",
			"a.linked_at",
			"c.name as channel_name",
			"c.kind as channel_kind",
		])
		.where("a.user_id", "=", userId)
		.orderBy("a.linked_at")
		.execute();
	return rows.map((row) => ({
		account: {
			id: row.id,
			channel_id: row.channel_id,
			platform: row.platform,
			platform_user_id: row.platform_user_id,
			platform_chat_id: row.platform_chat_id,
			user_id: row.user_id,
			display_name: row.display_name,
			linked_at: row.linked_at,
		},
		channelName: row.channel_name,
		channelKind: row.channel_kind,
	}));
}

export function accountView(account: ChannelAccountRow, channelName: string, isDefault: boolean): ChannelAccountView {
	return {
		id: account.id,
		channelId: account.channel_id,
		channelName,
		platform: account.platform,
		platformUserId: account.platform_user_id,
		displayName: account.display_name,
		linkedAt: account.linked_at,
		isDefault,
	};
}

export async function channelThread(
	db: Db,
	channelId: string,
	platform: string,
	chatId: string,
	topicId: string | null,
): Promise<ChannelThreadRow | undefined> {
	let query = db
		.selectFrom("channel_threads")
		.selectAll()
		.where("channel_id", "=", channelId)
		.where("platform", "=", platform)
		.where("chat_id", "=", chatId);
	query = topicId === null ? query.where("topic_id", "is", null) : query.where("topic_id", "=", topicId);
	return query.orderBy("created_at", "desc").executeTakeFirst();
}

export async function threadById(db: Db, id: string): Promise<ChannelThreadRow | undefined> {
	return db.selectFrom("channel_threads").selectAll().where("id", "=", id).executeTakeFirst();
}

export async function threadForSession(
	db: Db,
	channelId: string,
	sessionId: string,
): Promise<ChannelThreadRow | undefined> {
	return db
		.selectFrom("channel_threads")
		.selectAll()
		.where("channel_id", "=", channelId)
		.where("session_id", "=", sessionId)
		.orderBy("updated_at", "desc")
		.executeTakeFirst();
}

export async function threadsForSession(db: Db, sessionId: string): Promise<ChannelThreadRow[]> {
	return db.selectFrom("channel_threads").selectAll().where("session_id", "=", sessionId).execute();
}

export async function listThreads(db: Db): Promise<ChannelThreadRow[]> {
	return db.selectFrom("channel_threads").selectAll().execute();
}

/**
 * Points a thread at a session. A thread without a topic is the chat's current one: every other thread of that
 * chat stops being current in the same transaction, so `/sessions` switches instead of duplicating.
 */
export async function bindThread(
	db: Db,
	options: {
		channelId: string;
		platform: string;
		chatId: string;
		topicId: string | null;
		sessionId: string;
	},
): Promise<ChannelThreadRow> {
	const { channelId, platform, chatId, topicId, sessionId } = options;
	return db.transaction().execute(async (trx) => {
		if (topicId === null) {
			await trx
				.updateTable("channel_threads")
				.set({ current: 0, updated_at: new Date().toISOString() })
				.where("channel_id", "=", channelId)
				.where("platform", "=", platform)
				.where("chat_id", "=", chatId)
				.where("topic_id", "is", null)
				.where("current", "=", 1)
				.execute();
		}
		let threadQuery = trx
			.selectFrom("channel_threads")
			.selectAll()
			.where("channel_id", "=", channelId)
			.where("platform", "=", platform)
			.where("chat_id", "=", chatId);
		threadQuery =
			topicId === null ? threadQuery.where("topic_id", "is", null) : threadQuery.where("topic_id", "=", topicId);
		const existing = await threadQuery.executeTakeFirst();
		const now = new Date().toISOString();
		if (existing) {
			await trx
				.updateTable("channel_threads")
				.set({ session_id: sessionId, current: topicId === null ? 1 : 0, updated_at: now })
				.where("id", "=", existing.id)
				.execute();
			return { ...existing, session_id: sessionId, current: topicId === null ? 1 : 0, updated_at: now };
		}
		const row = {
			id: newId(),
			channel_id: channelId,
			platform,
			chat_id: chatId,
			topic_id: topicId,
			session_id: sessionId,
			current: topicId === null ? 1 : 0,
			created_at: now,
			updated_at: now,
		};
		await trx.insertInto("channel_threads").values(row).execute();
		return row;
	});
}

export interface ChannelUserSettings {
	defaultAccountId: string | null;
	showProgress: boolean;
}

export async function userChannelSettings(db: Db, userId: string): Promise<ChannelUserSettings> {
	const row = await db
		.selectFrom("channel_user_settings")
		.select(["default_account_id", "show_progress"])
		.where("user_id", "=", userId)
		.executeTakeFirst();
	return {
		defaultAccountId: row?.default_account_id ?? null,
		showProgress: row?.show_progress !== 0,
	};
}

/** Saves any of the caller's chat settings; an account chosen as default must belong to the user. */
export async function saveUserChannelSettings(
	db: Db,
	userId: string,
	change: { defaultAccountId?: string | null; showProgress?: boolean },
): Promise<ChannelUserSettings> {
	const current = await userChannelSettings(db, userId);
	if (change.defaultAccountId !== undefined && change.defaultAccountId !== null) {
		const account = await db
			.selectFrom("channel_accounts")
			.select("id")
			.where("id", "=", change.defaultAccountId)
			.where("user_id", "=", userId)
			.executeTakeFirst();
		if (!account) throw new UserError("no such linked chat account");
	}
	const next = {
		defaultAccountId: change.defaultAccountId === undefined ? current.defaultAccountId : change.defaultAccountId,
		showProgress: change.showProgress === undefined ? current.showProgress : change.showProgress,
	};
	const now = new Date().toISOString();
	await db
		.insertInto("channel_user_settings")
		.values({
			user_id: userId,
			default_account_id: next.defaultAccountId,
			show_progress: next.showProgress ? 1 : 0,
			updated_at: now,
		})
		.onConflict((oc) =>
			oc.column("user_id").doUpdateSet({
				default_account_id: next.defaultAccountId,
				show_progress: next.showProgress ? 1 : 0,
				updated_at: now,
			}),
		)
		.execute();
	return next;
}

/** The account notifications go to when the WebUI is not open; an account of a disabled channel is skipped. */
export async function defaultNotificationAccount(
	db: Db,
	userId: string,
): Promise<{ account: ChannelAccountRow; channel: ChannelRow } | undefined> {
	const settings = await userChannelSettings(db, userId);
	if (settings.defaultAccountId === null) return undefined;
	const row = await db
		.selectFrom("channel_accounts as a")
		.innerJoin("channels as c", "c.id", "a.channel_id")
		.select([
			"a.id",
			"a.channel_id",
			"a.platform",
			"a.platform_user_id",
			"a.platform_chat_id",
			"a.user_id",
			"a.display_name",
			"a.linked_at",
			"c.id as c_id",
			"c.org_id as c_org_id",
			"c.name as c_name",
			"c.kind as c_kind",
			"c.enabled as c_enabled",
			"c.credentials_secret_id as c_credentials_secret_id",
			"c.default_model as c_default_model",
			"c.default_rule_preset as c_default_rule_preset",
			"c.cursor as c_cursor",
			"c.created_at as c_created_at",
			"c.updated_at as c_updated_at",
		])
		.where("a.id", "=", settings.defaultAccountId)
		.where("a.user_id", "=", userId)
		.where("c.enabled", "=", 1)
		.executeTakeFirst();
	if (!row) return undefined;
	return {
		account: {
			id: row.id,
			channel_id: row.channel_id,
			platform: row.platform,
			platform_user_id: row.platform_user_id,
			platform_chat_id: row.platform_chat_id,
			user_id: row.user_id,
			display_name: row.display_name,
			linked_at: row.linked_at,
		},
		channel: {
			id: row.c_id,
			org_id: row.c_org_id,
			name: row.c_name,
			kind: row.c_kind,
			enabled: row.c_enabled,
			credentials_secret_id: row.c_credentials_secret_id,
			default_model: row.c_default_model,
			default_rule_preset: row.c_default_rule_preset,
			cursor: row.c_cursor,
			created_at: row.c_created_at,
			updated_at: row.c_updated_at,
		},
	};
}

/** Where a session's latest user message came from: `web`, a channel thread id, or null (nowhere yet). */
export async function lastUsedFrom(db: Db, sessionId: string): Promise<string | null> {
	const row = await db.selectFrom("sessions").select("last_used_from").where("id", "=", sessionId).executeTakeFirst();
	return row?.last_used_from ?? null;
}

export async function sessionOwner(db: Db, sessionId: string): Promise<string | undefined> {
	const row = await db.selectFrom("sessions").select("owner_user_id").where("id", "=", sessionId).executeTakeFirst();
	return row?.owner_user_id;
}
