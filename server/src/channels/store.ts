import { randomInt } from "node:crypto";
import type { ChannelAccountView, ChannelConfig, ChannelPublicView, ChannelView, ModelRef, RulePreset } from "@crh/api";
import type { Selectable } from "kysely";
import { parseModelRef } from "../agent/models.ts";
import { hashToken } from "../auth/token-hash.ts";
import { secretAad } from "../keys/export.ts";
import type { MasterKey } from "../keys/master-key.ts";
import { parseRulePreset } from "../policy/store.ts";
import type { Db } from "../storage/db.ts";
import { defaultOrgId } from "../storage/org.ts";
import type { ChannelAccountsTable, ChannelsTable, ChannelThreadsTable } from "../storage/schema.ts";
import {
	clearDefaultChannelAccount,
	clearDefaultChannelAccounts,
	deleteUserSettings,
	getUserSettings,
} from "../users/settings.ts";
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

/** The credentials a channel kind stores: a Telegram bot token or a Satori gateway token (which may be empty). */
export interface ChannelCredentials {
	token?: string;
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

/** The Satori gateway token of a channel; without one the gateway is asked unauthenticated. */
export async function readSatoriToken(
	db: Db,
	masterKey: MasterKey,
	row: Pick<ChannelRow, "name" | "credentials_secret_id">,
): Promise<string> {
	const credentials = await readChannelCredentials(db, masterKey, row);
	return typeof credentials.token === "string" ? credentials.token.trim() : "";
}

/** The stored non-secret settings of a Satori channel; null when the column is empty or unreadable. */
export function parseChannelConfig(row: Pick<ChannelRow, "config">): ChannelConfig | null {
	if (!row.config) return null;
	try {
		const value = JSON.parse(row.config) as { url?: unknown; platform?: unknown; botId?: unknown };
		if (typeof value.url !== "string" || typeof value.platform !== "string" || typeof value.botId !== "string") {
			return null;
		}
		return { url: value.url, platform: value.platform, botId: value.botId };
	} catch {
		return null;
	}
}

function satoriConfig(input: unknown): ChannelConfig {
	if (typeof input !== "object" || input === null) throw new UserError("the gateway settings are required");
	const value = input as { url?: unknown; platform?: unknown; botId?: unknown };
	const url = typeof value.url === "string" ? value.url.trim() : "";
	const platform = typeof value.platform === "string" ? value.platform.trim() : "";
	const botId = typeof value.botId === "string" ? value.botId.trim() : "";
	if (platform === "") throw new UserError("the platform is required");
	if (botId === "") throw new UserError("the bot id is required");
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new UserError("the gateway URL must be an http or https URL");
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new UserError("the gateway URL must be an http or https URL");
	}
	return { url: url.replace(/\/+$/, ""), platform, botId };
}

export interface ChannelInput {
	kind?: "telegram" | "satori";
	enabled?: boolean;
	/** Write-only; omitted keeps the stored credential. */
	token?: string | null;
	/** Satori only: the gateway URL, platform and bot id. */
	config?: Partial<ChannelConfig> | null;
	/** Satori only: how users reach the bot, shown on the link page. */
	linkInstructions?: string | null;
}

/**
 * Creates or updates a channel. A new channel needs its kind; an existing channel keeps it, because its cursor and
 * credentials belong to that platform. Choosing Satori requires the gateway settings; its token may be empty.
 */
export async function saveChannel(
	db: Db,
	masterKey: MasterKey,
	name: string,
	input: ChannelInput,
): Promise<{ row: ChannelRow; created: boolean }> {
	validateChannelName(name);
	const existing = await getChannelRow(db, name);
	if (!existing && input.kind === undefined) throw new UserError("kind is required to create a channel");
	if (existing && input.kind !== undefined && input.kind !== existing.kind) {
		throw new UserError("a channel's kind cannot be changed");
	}
	const kind = existing?.kind ?? input.kind;
	if (kind === undefined) throw new UserError("kind is required to create a channel");
	const orgId = await defaultOrgId(db);
	const now = new Date().toISOString();
	const token = typeof input.token === "string" ? input.token.trim() : input.token === null ? "" : undefined;
	if (!existing && kind === "telegram" && (token === undefined || token === "")) {
		throw new UserError("token is required to create a channel");
	}
	const config =
		kind === "satori"
			? input.config === undefined
				? existing
					? parseChannelConfig(existing)
					: null
				: satoriConfig(input.config)
			: null;
	if (!existing && kind === "satori" && config === null) {
		throw new UserError("the gateway settings are required");
	}
	const linkInstructions =
		input.linkInstructions === undefined
			? (existing?.link_instructions ?? null)
			: input.linkInstructions === null
				? null
				: input.linkInstructions.trim();
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
			kind,
			enabled: (input.enabled ?? (existing ? existing.enabled === 1 : true)) ? 1 : 0,
			credentials_secret_id: secretId,
			config: config === null ? null : JSON.stringify(config),
			link_instructions: linkInstructions,
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
			await clearDefaultChannelAccounts(
				trx,
				accounts.map((account) => account.id),
			);
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

/** The administrator's view of a channel, with its live status. */
export function channelView(row: ChannelRow, status: ChannelView["status"]): ChannelView {
	return {
		id: row.id,
		name: row.name,
		kind: row.kind,
		enabled: row.enabled === 1,
		hasCredentials: row.credentials_secret_id !== null,
		config: parseChannelConfig(row),
		linkInstructions: row.link_instructions,
		status,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

/** A channel as a user's settings page sees it: only what linking needs. */
export function channelPublicView(row: ChannelRow, account: string | null): ChannelPublicView {
	return {
		id: row.id,
		name: row.name,
		kind: row.kind,
		account,
		linkInstructions: row.link_instructions,
	};
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
		await clearDefaultChannelAccount(trx, userId, accountId);
	});
	return row;
}

/** Removes every account of a disabled user (doc/design/channels.md "Accounts"); returns them for the audit. */
export async function unlinkUserAccounts(db: Db, userId: string): Promise<ChannelAccountRow[]> {
	const rows = await db.selectFrom("channel_accounts").selectAll().where("user_id", "=", userId).execute();
	if (rows.length === 0) return [];
	await db.transaction().execute(async (trx) => {
		await trx.deleteFrom("channel_accounts").where("user_id", "=", userId).execute();
		await deleteUserSettings(trx, userId);
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
				.set({ session_id: sessionId, draft: null, current: topicId === null ? 1 : 0, updated_at: now })
				.where("id", "=", existing.id)
				.execute();
			return { ...existing, session_id: sessionId, draft: null, current: topicId === null ? 1 : 0, updated_at: now };
		}
		const row = {
			id: newId(),
			channel_id: channelId,
			platform,
			chat_id: chatId,
			topic_id: topicId,
			session_id: sessionId,
			draft: null,
			current: topicId === null ? 1 : 0,
			created_at: now,
			updated_at: now,
		};
		await trx.insertInto("channel_threads").values(row).execute();
		return row;
	});
}

/** A thread's draft settings before its first message starts the session (doc/design/channels.md "Conversations"). */
export interface ChannelDraft {
	model: ModelRef;
	rulePreset: RulePreset;
	/** The extensions the session starts with turned off. */
	disabledExtensions: string[];
}

/** The stored draft; null when there is none or it cannot be read. */
export function parseThreadDraft(raw: string | null): ChannelDraft | null {
	if (!raw) return null;
	try {
		const value = JSON.parse(raw) as { model?: unknown; rulePreset?: unknown; disabledExtensions?: unknown };
		const disabled = Array.isArray(value.disabledExtensions)
			? value.disabledExtensions.filter((name): name is string => typeof name === "string")
			: [];
		return {
			model: parseModelRef(value.model),
			rulePreset: parseRulePreset(value.rulePreset),
			disabledExtensions: [...new Set(disabled)],
		};
	} catch {
		return null;
	}
}

/**
 * Records a draft in a thread, replacing any session it was on and discarding a previous draft. A thread without
 * a topic is the chat's current one, like `bindThread`.
 */
export async function saveDraftThread(
	db: Db,
	options: {
		channelId: string;
		platform: string;
		chatId: string;
		topicId: string | null;
		draft: ChannelDraft;
	},
): Promise<ChannelThreadRow> {
	const { channelId, platform, chatId, topicId, draft } = options;
	const encoded = JSON.stringify(draft);
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
				.set({ session_id: null, draft: encoded, current: topicId === null ? 1 : 0, updated_at: now })
				.where("id", "=", existing.id)
				.execute();
			return { ...existing, session_id: null, draft: encoded, current: topicId === null ? 1 : 0, updated_at: now };
		}
		const row = {
			id: newId(),
			channel_id: channelId,
			platform,
			chat_id: chatId,
			topic_id: topicId,
			session_id: null,
			draft: encoded,
			current: topicId === null ? 1 : 0,
			created_at: now,
			updated_at: now,
		};
		await trx.insertInto("channel_threads").values(row).execute();
		return row;
	});
}

/** Replaces a draft's settings; the thread stays on no session. */
export async function updateThreadDraft(db: Db, id: string, draft: ChannelDraft): Promise<ChannelThreadRow> {
	const draftJson = JSON.stringify(draft);
	await db
		.updateTable("channel_threads")
		.set({ draft: draftJson, updated_at: new Date().toISOString() })
		.where("id", "=", id)
		.execute();
	const row = await threadById(db, id);
	if (!row) throw new NotFoundError("no such channel thread");
	return row;
}

/** The account notifications go to when the WebUI is not open; an account of a disabled channel is skipped. */
export async function defaultNotificationAccount(
	db: Db,
	userId: string,
): Promise<{ account: ChannelAccountRow; channel: ChannelRow } | undefined> {
	const settings = await getUserSettings(db, userId);
	if (settings.defaultChannelAccountId === null) return undefined;
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
			"c.config as c_config",
			"c.link_instructions as c_link_instructions",
			"c.cursor as c_cursor",
			"c.created_at as c_created_at",
			"c.updated_at as c_updated_at",
		])
		.where("a.id", "=", settings.defaultChannelAccountId)
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
			config: row.c_config,
			link_instructions: row.c_link_instructions,
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
