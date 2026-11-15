import { randomInt } from "node:crypto";
import type { ChannelAccountView, ChannelPublicView, ChannelSettings, ChannelStatus, ChannelView } from "@crh/api";
import type { AgentRuntime } from "../agent/runtime.ts";
import type { Audit } from "../audit/audit.ts";
import { userActor } from "../audit/audit.ts";
import type { SessionUser } from "../auth/sessions.ts";
import type { Cluster } from "../cluster/cluster.ts";
import type { TaskGroups } from "../cluster/task-groups.ts";
import { decideExternalCall, externalCallViews, getExternalCall } from "../extensions/external-calls.ts";
import type { MasterKey } from "../keys/master-key.ts";
import type { LibraryBackend } from "../library/backend.ts";
import { beginLibraryUpload } from "../library/files.ts";
import { findUserLibrary, libraryRef } from "../library/library.ts";
import { validateLibraryPath } from "../library/paths.ts";
import { attachmentContent, resolveAttachments } from "../sessions/attachments.ts";
import { rootSessionIdOf } from "../sessions/session-chain.ts";
import type { SettingsStore } from "../settings/settings.ts";
import { DEFAULT_ATTACHMENT_INLINE_TEXT_BYTES, DEFAULT_ATTACHMENT_INLINE_TOTAL_BYTES } from "../settings/settings.ts";
import type { Db } from "../storage/db.ts";
import { errorText, NotFoundError, UserError } from "../util/errors.ts";
import { newId } from "../util/id.ts";
import type { ChannelAdapter, ChannelHandlers, ChannelTarget, SentMessage } from "./model.ts";
import { WebUiPresence } from "./presence.ts";
import {
	accountByPlatform,
	accountsForUser,
	accountView,
	bindThread,
	type ChannelAccountRow,
	type ChannelRow,
	type ChannelThreadRow,
	channelDefaultModel,
	channelDefaultRulePreset,
	channelPublicView,
	channelThread,
	channelView,
	consumeLinkCode,
	createLinkCode,
	defaultNotificationAccount,
	deleteChannel as deleteChannelRow,
	getChannelRow,
	lastUsedFrom,
	linkAccount,
	listChannelRows,
	listThreads,
	parseChannelCursor,
	readTelegramToken,
	saveChannel as saveChannelRow,
	saveUserChannelSettings,
	sessionOwner,
	setChannelCursor,
	threadById,
	threadForSession,
	unlinkAccount,
	unlinkUserAccounts,
	userChannelSettings,
} from "./store.ts";
import { TelegramChannel } from "./telegram.ts";

/**
 * The chat-channel core (doc/design/channels.md): adapters, linking, conversations, inbound messages and files,
 * outbound assistant text, notifications and approvals. The platform adapters implement the `ChannelAdapter`
 * interface; everything this file does is platform-independent except choosing the adapter by kind.
 */

export interface ChannelManagerOptions {
	db: Db;
	masterKey: MasterKey;
	runtime: AgentRuntime;
	cluster: Cluster;
	taskGroups: TaskGroups;
	audit: Audit;
	libraryBackend?: LibraryBackend;
	settings?: SettingsStore;
	/** The public base URL for WebUI links; settings.publicUrl wins. */
	publicUrl?: string | null;
	/** In-process fetch for the fake Telegram server in tests. */
	fetch?: typeof fetch;
	/** Overrides the Bot API root for tests. */
	telegramApiRoot?: string;
	pollTimeoutSeconds?: number;
	backoffBaseMs?: number;
	backoffMaxMs?: number;
	/** Messages replayed when a thread switches to a session (10 by default). */
	historyLimit?: number;
	/** Progress updates are throttled to this interval (1.5 s by default). */
	progressIntervalMs?: number;
	/** A shown draft is re-sent at this interval so it does not expire (20 s by default). */
	draftKeepaliveMs?: number;
	now?: () => number;
}

interface AdapterEntry {
	row: ChannelRow;
	adapter: ChannelAdapter;
}

interface TrackedMessage {
	key: string;
	rootSessionId: string;
	adapterName: string;
	target: ChannelTarget;
	messageId: string;
	/** What the message currently says, so a final edit can append how it ended. */
	text: string;
}

interface Route {
	adapterName: string;
	adapter: ChannelAdapter;
	target: ChannelTarget;
	thread: ChannelThreadRow | undefined;
	channelRow: ChannelRow;
	account: ChannelAccountRow;
}

interface DraftState {
	draftId: number;
	/** Where the draft is shown; a real message there clears it. */
	adapterName: string;
	target: ChannelTarget;
	lastSentAt: number;
	lastText: string;
	/** The status of the current step, shown again when a wait is over. */
	step: string;
	/** What the run waits for, if anything; its status replaces the step's while it waits. */
	waiting: "approval" | "signature" | null;
	/** The turn's last message went out; the draft is not shown again until progress does. */
	suppressed: boolean;
	/** Re-sends the shown status before the draft expires; absent while nothing is shown. */
	keepalive?: ReturnType<typeof setTimeout>;
}

/** A fallback progress message for a platform without drafts. */
interface StatusState {
	adapterName: string;
	target: ChannelTarget;
	messageId: string;
	lastSentAt: number;
	lastText: string;
}

interface RunState {
	deliveries: { name: string; source: string }[];
	/** Deliveries already sent in this run, keyed by source and path. */
	seen: Set<string>;
}

const UNSUPPORTED = "Only text, files and photos are supported.";
const FILES_NOT_SENT = "The attached files were not sent.";
const LINK_HELP =
	"To use ClusterRightHand from this chat, open your user settings in the WebUI, create a link code and send /link <code> here.";
const DEFAULT_HISTORY_LIMIT = 10;
const DEFAULT_PROGRESS_INTERVAL_MS = 1_500;
/** A draft expires after 30 s without an update; it is re-sent well before that. */
const DRAFT_KEEPALIVE_MS = 20_000;
const CLIP_CHARS = 500;
const SESSION_PAGE_SIZE = 5;
const NO_SESSIONS = "You have no sessions yet. Send /new to start one.";

/** Parses `/command@bot args`; undefined when the text is not a command. */
function parseCommand(text: string | null): { name: string; args: string[] } | undefined {
	if (!text?.startsWith("/")) return undefined;
	const [head = "", ...rest] = text.trim().split(/\s+/);
	const name = head.slice(1).split("@")[0]?.toLowerCase() ?? "";
	if (name === "") return undefined;
	return { name, args: rest };
}

function clip(text: string, limit = CLIP_CHARS): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}

function fileBaseName(name: string, fallback: string): string {
	const base = name.split(/[\\/]/).pop() ?? "";
	// Library paths are plain text; control characters and reserved separators are replaced, not interpreted.
	const safe = base
		.replace(/[\p{Cc}]/gu, "_")
		.replace(/[\\/]/g, "_")
		.trim();
	return safe === "" || safe === "." || safe === ".." ? fallback : safe.slice(0, 180);
}

function monthPath(now: Date): string {
	return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

function approvalKey(kind: "task" | "task_group" | "external_call", id: string): string {
	return `${kind}:${id}`;
}

type WaitRow = { state: string; handler_type: string | null; on_behalf_of_user_id: string };

/**
 * The wait a session's chat messages ask the user for, if any: a signature wins over an approval, and an
 * approval routed to an agent is not shown in the chat.
 */
function waitKindOf(
	tasks: readonly WaitRow[],
	groups: readonly WaitRow[],
	calls: readonly WaitRow[],
	owner: string,
): "approval" | "signature" | null {
	let waiting: "approval" | "signature" | null = null;
	for (const task of tasks) {
		if (task.on_behalf_of_user_id !== owner) continue;
		if (task.state === "awaiting_authorization") waiting = "signature";
		else if (task.state === "awaiting_approval" && task.handler_type === "user") waiting ??= "approval";
	}
	for (const group of groups) {
		if (group.on_behalf_of_user_id !== owner) continue;
		if (group.state === "awaiting_authorization") waiting = "signature";
		else if (group.state === "awaiting_approval" && group.handler_type === "user") waiting ??= "approval";
	}
	for (const call of calls) {
		if (call.on_behalf_of_user_id === owner && call.handler_type === "user") waiting ??= "approval";
	}
	return waiting;
}

export class ChannelManager {
	readonly #options: ChannelManagerOptions;
	readonly #presence: WebUiPresence;
	readonly #adapters = new Map<string, AdapterEntry>();
	readonly #rowErrors = new Map<string, string>();
	readonly #watchers = new Map<string, () => void>();
	readonly #watchStarts = new Map<string, Promise<void>>();
	readonly #runs = new Map<string, RunState>();
	readonly #drafts = new Map<string, DraftState>();
	readonly #statuses = new Map<string, StatusState>();
	readonly #tracked = new Map<string, TrackedMessage>();
	readonly #unlinkedReplied = new Set<string>();
	readonly #waitSyncs = new Map<string, Promise<void>>();
	readonly #topicCreations = new Map<string, Promise<ChannelThreadRow | undefined>>();
	readonly #historyLimit: number;
	readonly #progressIntervalMs: number;
	readonly #draftKeepaliveMs: number;
	readonly #now: () => number;
	#started = false;
	#stopped = false;
	#draftSeq = randomInt(1, 2 ** 31 - 1);

	constructor(options: ChannelManagerOptions) {
		this.#options = options;
		this.#presence = new WebUiPresence({ ...(options.now ? { now: options.now } : {}) });
		this.#historyLimit = options.historyLimit ?? DEFAULT_HISTORY_LIMIT;
		this.#progressIntervalMs = options.progressIntervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS;
		this.#draftKeepaliveMs = options.draftKeepaliveMs ?? DRAFT_KEEPALIVE_MS;
		this.#now = options.now ?? Date.now;
	}

	get presence(): WebUiPresence {
		return this.#presence;
	}

	/** Loads the stored channels and starts the enabled ones. */
	async start(): Promise<void> {
		if (this.#started) return;
		this.#started = true;
		this.#options.runtime.onSessionStateChanged((sessionId) => {
			void this.#stateChanged(sessionId).catch((err: unknown) => {
				console.error("channels: syncing a session's waits failed:", err);
			});
		});
		for (const row of await listChannelRows(this.#options.db)) await this.#openRow(row);
		// Pending waits are notified in the background: a slow platform must not delay startup.
		void this.#syncAllWaits().catch((err: unknown) => {
			console.error("channels: syncing waiting approvals at startup failed:", err);
		});
		// A thread's session may be mid-run when crh restarts; watch it so its output still reaches the chat.
		for (const thread of await listThreads(this.#options.db))
			if (thread.current === 1 || thread.topic_id !== null) {
				await this.#ensureWatcher(thread.session_id);
			}
	}

	async stop(): Promise<void> {
		if (this.#stopped) return;
		this.#stopped = true;
		this.#options.runtime.onSessionStateChanged(undefined);
		for (const stop of [...this.#watchers.values()]) {
			try {
				stop();
			} catch {}
		}
		this.#watchers.clear();
		for (const entry of [...this.#adapters.values()]) await entry.adapter.stop();
		this.#adapters.clear();
		for (const draft of this.#drafts.values()) this.#clearDraftKeepalive(draft);
		this.#drafts.clear();
		this.#statuses.clear();
	}

	// ---- admin views and lifecycle ----

	async listViews(): Promise<ChannelView[]> {
		const rows = await listChannelRows(this.#options.db);
		return rows.map((row) => channelView(row, this.status(row.name)));
	}

	status(name: string): ChannelStatus {
		const adapter = this.#adapters.get(name);
		if (adapter) return adapter.adapter.status();
		const error = this.#rowErrors.get(name);
		if (error !== undefined) return { state: "unavailable", lastError: error, nextAttemptAt: null, account: null };
		return { state: "disabled", lastError: null, nextAttemptAt: null, account: null };
	}

	/** Re-reads one channel after an admin change, starting or stopping its adapter. */
	async reload(name: string): Promise<void> {
		const existing = this.#adapters.get(name);
		if (existing) {
			this.#adapters.delete(name);
			await existing.adapter.stop();
		}
		this.#rowErrors.delete(name);
		const row = await getChannelRow(this.#options.db, name);
		if (!row) return;
		await this.#openRow(row);
	}

	/** Drops a deleted channel's adapter and state. */
	async remove(name: string): Promise<void> {
		const existing = this.#adapters.get(name);
		if (existing) {
			this.#adapters.delete(name);
			await existing.adapter.stop();
		}
		this.#rowErrors.delete(name);
	}

	async #openRow(row: ChannelRow): Promise<void> {
		if (row.enabled !== 1 || this.#stopped) return;
		if (row.kind !== "telegram") {
			// A Satori adapter implements ChannelAdapter and is constructed here; the kind is not available yet.
			this.#rowErrors.set(row.name, "the satori channel kind is not available");
			return;
		}
		let token: string;
		try {
			// The token is read through the store's helper so a broken or missing secret is reported, not thrown at startup.
			token = await readTelegramToken(this.#options.db, this.#options.masterKey, row);
		} catch (err) {
			this.#rowErrors.set(row.name, errorText(err));
			return;
		}
		const adapter = new TelegramChannel({
			channelId: row.id,
			token,
			...(this.#options.telegramApiRoot ? { apiRoot: this.#options.telegramApiRoot } : {}),
			...(this.#options.fetch ? { fetch: this.#options.fetch } : {}),
			...(this.#options.pollTimeoutSeconds !== undefined
				? { pollTimeoutSeconds: this.#options.pollTimeoutSeconds }
				: {}),
			initialCursor: parseChannelCursor(row),
			onCursor: (updateId) => setChannelCursor(this.#options.db, row.id, updateId),
			connection: {
				...(this.#options.backoffBaseMs !== undefined ? { baseMs: this.#options.backoffBaseMs } : {}),
				...(this.#options.backoffMaxMs !== undefined ? { maxMs: this.#options.backoffMaxMs } : {}),
			},
		});
		adapter.setHandlers(this.#handlers(row));
		this.#adapters.set(row.name, { row, adapter });
		this.#watchSends(adapter);
		adapter.start();
	}

	/**
	 * Telegram clears a private chat's draft when the bot sends a real message there. Wrapping `sendText`
	 * makes every send path re-show the draft it cleared, without each caller having to remember it. The
	 * replacement gets a new id, so it is a new preview rather than an update of the ended one.
	 */
	#watchSends(adapter: ChannelAdapter): void {
		const sendText = adapter.sendText.bind(adapter);
		adapter.sendText = async (target, text, options) => {
			const cleared: [string, DraftState][] = [];
			for (const [sessionId, draft] of this.#drafts) {
				if (this.#adapters.get(draft.adapterName)?.adapter !== adapter) continue;
				if (draft.target.chatId !== target.chatId) continue;
				if ((draft.target.topicId ?? null) !== (target.topicId ?? null)) continue;
				draft.draftId = this.#nextDraftId();
				cleared.push([sessionId, draft]);
			}
			const sent = await sendText(target, text, options);
			for (const [sessionId] of cleared) await this.#resendDraft(sessionId);
			return sent;
		};
	}

	#handlers(row: ChannelRow): ChannelHandlers {
		return {
			onMessage: (message) => this.#onMessage(row, message),
			onButton: (press) => this.#onButton(row, press),
			onGenerationStopped: (stop) => this.#onGenerationStopped(row, stop),
		};
	}

	// ---- user settings and linking ----

	async linkChannels(): Promise<ChannelPublicView[]> {
		const rows = (await listChannelRows(this.#options.db)).filter((row) => row.enabled === 1);
		return rows.map((row) => channelPublicView(row, this.#adapters.get(row.name)?.adapter.status().account ?? null));
	}

	async accounts(userId: string): Promise<ChannelAccountView[]> {
		const settings = await userChannelSettings(this.#options.db, userId);
		return (await accountsForUser(this.#options.db, userId)).map((item) =>
			accountView(item.account, item.channelName, settings.defaultAccountId === item.account.id),
		);
	}

	async createLinkCode(userId: string): Promise<{ code: string; expiresAt: string }> {
		return createLinkCode(this.#options.db, userId);
	}

	async unlink(user: SessionUser, accountId: string): Promise<void> {
		const row = await unlinkAccount(this.#options.db, user.userId, accountId);
		if (!row) throw new NotFoundError("no such linked chat account");
		void this.#options.audit.record({
			actor: userActor(user),
			action: "channel_account.unlinked",
			target: { type: "channel_account", id: row.id },
			detail: { channel_account: row.id, platform: row.platform, reason: "user" },
		});
	}

	async settings(userId: string): Promise<ChannelSettings> {
		const settings = await userChannelSettings(this.#options.db, userId);
		return { defaultAccountId: settings.defaultAccountId, showProgress: settings.showProgress };
	}

	async saveSettings(
		user: SessionUser,
		change: { defaultAccountId?: string | null; showProgress?: boolean },
	): Promise<ChannelSettings> {
		const before = await userChannelSettings(this.#options.db, user.userId);
		const after = await saveUserChannelSettings(this.#options.db, user.userId, change);
		if (before.defaultAccountId !== after.defaultAccountId) {
			void this.#options.audit.record({
				actor: userActor(user),
				action: "channel_account.default_changed",
				target: { type: "channel_account", id: after.defaultAccountId ?? before.defaultAccountId ?? "" },
				detail: {
					default_account_id: after.defaultAccountId,
					...(after.defaultAccountId ? {} : { cleared: true }),
				},
			});
		}
		return { defaultAccountId: after.defaultAccountId, showProgress: after.showProgress };
	}

	/** A disabled or deleted user stops all of their chat accounts (doc/design/channels.md "Accounts"). */
	async detachUser(userId: string): Promise<void> {
		const rows = await unlinkUserAccounts(this.#options.db, userId);
		this.#presence.forget(userId);
		for (const row of rows) {
			void this.#options.audit.record({
				actor: { type: "system", id: "channels" },
				action: "channel_account.unlinked",
				target: { type: "channel_account", id: row.id },
				detail: { channel_account: row.id, platform: row.platform, reason: "user_disabled" },
			});
		}
	}

	// ---- inbound ----

	async #onMessage(row: ChannelRow, message: import("./model.ts").InboundMessage): Promise<void> {
		const adapter = this.#adapters.get(row.name)?.adapter;
		if (!adapter) return;
		const target: ChannelTarget = { chatId: message.chatId, topicId: message.topicId };
		const command = parseCommand(message.text);
		if (command !== undefined) {
			await this.#runCommand(adapter, row, message, command, target);
			// A command never sends its attachments: they are not downloaded, and the user is told so.
			if (message.files.length > 0) await adapter.sendText(target, FILES_NOT_SENT);
			return;
		}
		const account = await accountByPlatform(this.#options.db, row.id, adapter.platform, message.platformUserId);
		if (!account) {
			await this.#replyUnlinked(adapter, row, message);
			return;
		}
		const user = await this.#sessionUser(account);
		if (!user) {
			await this.#replyUnlinked(adapter, row, message);
			return;
		}
		if (message.text === null && message.files.length === 0) {
			await adapter.sendText(target, UNSUPPORTED);
			return;
		}
		// Files go to the library before a session exists, so a failed upload leaves no empty session.
		let attachments: Awaited<ReturnType<typeof resolveAttachments>> | undefined;
		if (message.files.length > 0) {
			try {
				attachments = await this.#downloadAttachments(user, message.files, adapter);
			} catch (err) {
				await adapter.sendText(target, `Could not save the file: ${errorText(err)}`);
				return;
			}
		}
		const thread = await this.#threadFor(row, message, user, adapter, target);
		if (!thread) return;
		await this.#ensureWatcher(thread.session_id);
		await this.#submitMessage(row, thread, user, message, attachments, adapter, target);
	}

	/** Runs a command; a leading `/` is always a command, and an unknown one is answered with a hint. */
	async #runCommand(
		adapter: ChannelAdapter,
		row: ChannelRow,
		message: import("./model.ts").InboundMessage,
		command: { name: string; args: string[] },
		target: ChannelTarget,
	): Promise<void> {
		if (command.name === "link") {
			await this.#link(adapter, row, message, command.args[0] ?? "");
			return;
		}
		const account = await accountByPlatform(this.#options.db, row.id, adapter.platform, message.platformUserId);
		if (!account) {
			await this.#replyUnlinked(adapter, row, message);
			return;
		}
		const user = await this.#sessionUser(account);
		if (!user) {
			await this.#replyUnlinked(adapter, row, message);
			return;
		}
		if (command.name === "unlink") {
			await this.#unlinkFromChat(adapter, account, user, target);
			return;
		}
		if (command.name === "help" || command.name === "start") {
			await adapter.sendText(target, this.#helpText());
			return;
		}
		if (command.name === "approve" || command.name === "reject") {
			await this.#decideFromCommand(adapter, row, message, user, target, command);
			return;
		}
		if (command.name === "sessions") {
			await this.#showSessions(adapter, row, message, user, target);
			return;
		}
		if (command.name === "new") {
			await this.#newSession(adapter, row, message, user, target);
			return;
		}
		if (command.name === "quota") {
			await this.#quotaCommand(adapter, row, message, user, target, command.args);
			return;
		}
		if (command.name === "stop") {
			await this.#stopCommand(adapter, row, message, user, target);
			return;
		}
		await adapter.sendText(
			target,
			`Unknown command /${command.name}. Send /help for the list of commands. To send a message that starts with "/", begin it with another character.`,
		);
	}

	async #submitMessage(
		row: ChannelRow,
		thread: ChannelThreadRow,
		user: SessionUser,
		message: import("./model.ts").InboundMessage,
		attachments: Awaited<ReturnType<typeof resolveAttachments>> | undefined,
		adapter: ChannelAdapter,
		target: ChannelTarget,
	): Promise<void> {
		try {
			const text = message.text ?? "";
			await this.#options.runtime.submit(thread.session_id, user, text, `channel:${row.id}:${message.updateId}`, {
				// The session records where its latest user message came from: this thread.
				lastUsedFrom: thread.id,
				...(attachments
					? {
							content: attachmentContent(text, attachments.blocks),
							attachments: attachments.attachments,
						}
					: {}),
			});
		} catch (err) {
			await adapter.sendText(target, `Could not send the message: ${errorText(err)}`);
		}
	}

	async #threadFor(
		row: ChannelRow,
		message: import("./model.ts").InboundMessage,
		user: SessionUser,
		adapter: ChannelAdapter,
		target: ChannelTarget,
	): Promise<ChannelThreadRow | undefined> {
		const existing = await channelThread(this.#options.db, row.id, adapter.platform, message.chatId, message.topicId);
		let previous: "archived" | "unavailable" | undefined;
		if (existing) {
			const session = await this.#options.runtime.getSession(existing.session_id);
			if (session && session.ownerUserId === user.userId && session.status === "active") return existing;
			previous = session?.status === "archived" ? "archived" : "unavailable";
		}
		return this.#createSessionThread(row, message.chatId, message.topicId, user, adapter, target, previous);
	}

	async #createSessionThread(
		row: ChannelRow,
		chatId: string,
		topicId: string | null,
		user: SessionUser,
		adapter: ChannelAdapter,
		target: ChannelTarget,
		previous?: "archived" | "unavailable",
	): Promise<ChannelThreadRow | undefined> {
		const model = channelDefaultModel(row) ?? this.#options.runtime.modelPresets.get("session").model;
		if (!model) {
			await adapter.sendText(
				target,
				"This channel has no default model and the session model preset is unset; ask an administrator to set one.",
			);
			return undefined;
		}
		try {
			const session = await this.#options.runtime.createSession(user, {
				model,
				rulePreset: channelDefaultRulePreset(row) ?? "ask",
			});
			const thread = await bindThread(this.#options.db, {
				channelId: row.id,
				platform: adapter.platform,
				chatId,
				topicId,
				sessionId: session.id,
			});
			await this.#announceSession(adapter, target, session.id, previous);
			return thread;
		} catch (err) {
			await adapter.sendText(target, `Could not start a session: ${errorText(err)}`);
			return undefined;
		}
	}

	/** The one notice every session a chat starts sends; `previous` says why the old thread was replaced. */
	async #announceSession(
		adapter: ChannelAdapter,
		target: ChannelTarget,
		sessionId: string,
		previous?: "archived" | "unavailable",
	): Promise<void> {
		const prefix =
			previous === "archived"
				? "The previous session is archived. "
				: previous === "unavailable"
					? "The previous session is no longer available. "
					: "";
		const link = this.#sessionLink(sessionId);
		await adapter.sendText(target, `${prefix}Started a new session.${link ? ` ${link}` : ""}`);
	}

	async #downloadAttachments(
		user: SessionUser,
		files: readonly import("./model.ts").InboundFile[],
		adapter: ChannelAdapter,
	): Promise<Awaited<ReturnType<typeof resolveAttachments>>> {
		const backend = this.#options.libraryBackend;
		if (!backend) throw new UserError("this crhs has no library backend");
		const library = await findUserLibrary(this.#options.db, user.userId);
		if (!library) throw new UserError("the user has no library");
		const now = new Date();
		const downloaded: { library: string; path: string }[] = [];
		for (const file of files) {
			const content = await adapter.downloadFile(file);
			const fallback = file.fileId.replace(/[^A-Za-z0-9._-]/g, "_") || `${newId()}.bin`;
			const name = fileBaseName(content.name || file.name || fallback, fallback);
			const path = validateLibraryPath(`attachments/${monthPath(now)}/${name}`);
			const upload = beginLibraryUpload(this.#options.db, backend, {
				library: library.row,
				path,
				overwrite: false,
				rename: true,
				createdBy: user.userId,
			});
			try {
				await upload.write(content.bytes);
				await upload.finish();
				const { file: saved } = await upload.commit();
				downloaded.push({ library: libraryRef(library.row, library.ownerName), path: saved.path });
			} catch (err) {
				await upload.discard();
				throw err;
			}
		}
		const limits = this.#options.settings?.current().attachments ?? {
			inlineTextBytes: DEFAULT_ATTACHMENT_INLINE_TEXT_BYTES,
			inlineTotalBytes: DEFAULT_ATTACHMENT_INLINE_TOTAL_BYTES,
		};
		return resolveAttachments(
			this.#options.db,
			backend,
			user,
			downloaded.map((entry) => ({ library: entry.library, path: entry.path })),
			limits,
		);
	}

	async #replyUnlinked(
		adapter: ChannelAdapter,
		row: ChannelRow,
		message: import("./model.ts").InboundMessage,
	): Promise<void> {
		const key = `${row.id}:${message.platformUserId}`;
		if (this.#unlinkedReplied.has(key)) return;
		this.#unlinkedReplied.add(key);
		await adapter.sendText({ chatId: message.chatId, topicId: message.topicId }, LINK_HELP);
	}

	async #link(
		adapter: ChannelAdapter,
		row: ChannelRow,
		message: import("./model.ts").InboundMessage,
		code: string,
	): Promise<void> {
		const target: ChannelTarget = { chatId: message.chatId, topicId: message.topicId };
		if (code.trim() === "") {
			await adapter.sendText(target, "Send /link <code> with the code from your settings page.");
			return;
		}
		const userId = await consumeLinkCode(this.#options.db, code);
		if (!userId) {
			await adapter.sendText(target, "The link code is invalid, expired or already used.");
			return;
		}
		const userRow = await this.#options.db
			.selectFrom("users")
			.select(["id", "username", "kind", "status"])
			.where("id", "=", userId)
			.executeTakeFirst();
		if (!userRow || userRow.status !== "active") {
			await adapter.sendText(target, "That account is not active.");
			return;
		}
		try {
			const { account, created } = await linkAccount(
				this.#options.db,
				row.id,
				adapter.platform,
				message.platformUserId,
				message.chatId,
				userId,
				message.displayName,
			);
			if (created) {
				void this.#options.audit.record({
					actor: { type: "user", id: userId, onBehalfOfUserId: userId },
					action: "channel_account.linked",
					target: { type: "channel_account", id: account.id },
					detail: { channel: row.name, platform: adapter.platform, display_name: message.displayName },
				});
			}
			this.#unlinkedReplied.delete(`${row.id}:${message.platformUserId}`);
			await adapter.sendText(
				target,
				created ? "Linked. You can use this chat now. /help lists the commands." : "This chat is already linked.",
			);
		} catch (err) {
			await adapter.sendText(target, errorText(err));
		}
	}

	async #unlinkFromChat(
		adapter: ChannelAdapter,
		account: ChannelAccountRow,
		user: SessionUser,
		target: ChannelTarget,
	): Promise<void> {
		await this.unlink(user, account.id);
		this.#unlinkedReplied.delete(`${account.channel_id}:${account.platform_user_id}`);
		await adapter.sendText(target, "Unlinked. Send /link <code> to link this chat again.");
	}

	async #showSessions(
		adapter: ChannelAdapter,
		row: ChannelRow,
		message: import("./model.ts").InboundMessage,
		user: SessionUser,
		target: ChannelTarget,
	): Promise<void> {
		const page = await this.#sessionPage(row, adapter, user, message.chatId, message.topicId, 1);
		if (!page) {
			await adapter.sendText(target, NO_SESSIONS);
			return;
		}
		await adapter.sendText(target, page.text, { buttons: page.buttons });
	}

	/** One page of `/sessions`: the message text and its buttons, or undefined when the user has no sessions. */
	async #sessionPage(
		row: ChannelRow,
		adapter: ChannelAdapter,
		user: SessionUser,
		chatId: string,
		topicId: string | null,
		page: number,
	): Promise<{ text: string; buttons: import("./model.ts").ChannelButton[][] } | undefined> {
		const count = await this.#options.db
			.selectFrom("sessions")
			.select((eb) => eb.fn.countAll<string>().as("count"))
			.where("owner_user_id", "=", user.userId)
			.where("parent_session_id", "is", null)
			.where("status", "=", "active")
			.executeTakeFirstOrThrow();
		const total = Number(count.count);
		if (total === 0) return undefined;
		const pages = Math.ceil(total / SESSION_PAGE_SIZE);
		const currentPage = Math.min(Math.max(page, 1), pages);
		const sessions = await this.#options.db
			.selectFrom("sessions")
			.select(["id", "title", "last_used_from"])
			.where("owner_user_id", "=", user.userId)
			.where("parent_session_id", "is", null)
			.where("status", "=", "active")
			.orderBy("updated_at", "desc")
			.orderBy("id")
			.limit(SESSION_PAGE_SIZE)
			.offset((currentPage - 1) * SESSION_PAGE_SIZE)
			.execute();
		const current = await channelThread(this.#options.db, row.id, adapter.platform, chatId, topicId);
		const buttons: import("./model.ts").ChannelButton[][] = sessions.map((session) => [
			{
				text: `${session.id === current?.session_id ? "✓ " : ""}${clip(session.title || "New session", 40)}`,
				data: `switch:${session.id}`,
			},
		]);
		const nav: import("./model.ts").ChannelButton[] = [];
		if (currentPage > 1) nav.push({ text: "‹ Previous", data: `sessions:${currentPage - 1}` });
		if (currentPage < pages) nav.push({ text: "Next ›", data: `sessions:${currentPage + 1}` });
		if (nav.length > 0) buttons.push(nav);
		const text =
			pages > 1 ? `Switch this chat to a session (page ${currentPage} of ${pages}):` : "Switch this chat to a session:";
		return { text, buttons };
	}

	async #newSession(
		adapter: ChannelAdapter,
		row: ChannelRow,
		message: import("./model.ts").InboundMessage,
		user: SessionUser,
		target: ChannelTarget,
	): Promise<void> {
		const thread = await this.#createSessionThread(row, message.chatId, message.topicId, user, adapter, target);
		if (thread) await this.#ensureWatcher(thread.session_id);
	}

	async #stopCommand(
		adapter: ChannelAdapter,
		row: ChannelRow,
		message: import("./model.ts").InboundMessage,
		user: SessionUser,
		target: ChannelTarget,
	): Promise<void> {
		const thread = await channelThread(this.#options.db, row.id, adapter.platform, message.chatId, message.topicId);
		if (!thread || (await sessionOwner(this.#options.db, thread.session_id)) !== user.userId) {
			await adapter.sendText(target, "There is no running session in this chat.");
			return;
		}
		try {
			await this.#options.runtime.abort(thread.session_id, user);
			await adapter.sendText(target, "Stopped.");
		} catch (err) {
			await adapter.sendText(target, `Could not stop: ${errorText(err)}`);
		}
	}

	async #quotaCommand(
		adapter: ChannelAdapter,
		row: ChannelRow,
		message: import("./model.ts").InboundMessage,
		user: SessionUser,
		target: ChannelTarget,
		args: readonly string[],
	): Promise<void> {
		const thread = await channelThread(this.#options.db, row.id, adapter.platform, message.chatId, message.topicId);
		if (!thread || (await sessionOwner(this.#options.db, thread.session_id)) !== user.userId) {
			await adapter.sendText(target, "There is no session in this chat.");
			return;
		}
		const rootId = (await rootSessionIdOf(this.#options.db, thread.session_id)) ?? thread.session_id;
		const root = await this.#options.db
			.selectFrom("sessions")
			.select(["id", "title", "quota_tokens", "budget_used_tokens", "state", "waiting_kind"])
			.where("id", "=", rootId)
			.executeTakeFirst();
		if (!root) {
			await adapter.sendText(target, "There is no session in this chat.");
			return;
		}
		const sub = args[0]?.toLowerCase();
		if (sub === "add") {
			const tokens = Number(args[1]);
			if (!Number.isSafeInteger(tokens) || tokens <= 0) {
				await adapter.sendText(target, "Use /quota add <tokens> with a positive whole number of tokens.");
				return;
			}
			try {
				await this.#options.runtime.decideRootQuota(rootId, "approve", tokens);
				await this.#auditChannelApproval(user, "quota", rootId, "approved", row.name, adapter.platform, thread.id);
				await adapter.sendText(target, `Added ${tokens} tokens to the session's quota.`);
			} catch (err) {
				await adapter.sendText(target, errorText(err));
			}
			return;
		}
		if (sub === "stop") {
			try {
				await this.#options.runtime.decideRootQuota(rootId, "deny");
				await this.#auditChannelApproval(user, "quota", rootId, "rejected", row.name, adapter.platform, thread.id);
				await adapter.sendText(target, "Ended the turn.");
			} catch (err) {
				await adapter.sendText(target, errorText(err));
			}
			return;
		}
		if (root.quota_tokens === null) {
			await adapter.sendText(target, "This session has no token quota.");
			return;
		}
		const remaining = Number(root.quota_tokens);
		const used = Number(root.budget_used_tokens);
		if (remaining <= 0) {
			await adapter.sendText(
				target,
				`This session's token quota is used up (${remaining} remaining, ${used} used).\n/quota add <tokens> raises it and continues; /quota stop ends the turn.`,
			);
		} else {
			await adapter.sendText(target, `This session has ${remaining} tokens left (${used} used).`);
		}
	}

	async #decideFromCommand(
		adapter: ChannelAdapter,
		row: ChannelRow,
		message: import("./model.ts").InboundMessage,
		user: SessionUser,
		target: ChannelTarget,
		command: { name: string; args: string[] },
	): Promise<void> {
		const id = command.args[0];
		if (!id) {
			await adapter.sendText(target, `Use /${command.name} <id>${command.name === "reject" ? " [reason]" : ""}.`);
			return;
		}
		const decision = command.name === "approve" ? "approved" : "rejected";
		const reason = command.name === "reject" ? command.args.slice(1).join(" ").trim().slice(0, 1000) : "";
		const thread = await channelThread(this.#options.db, row.id, adapter.platform, message.chatId, message.topicId);
		const result = await this.#decideApproval(user, id, decision, reason || undefined);
		if (!result) {
			await adapter.sendText(target, "No waiting approval with that id is yours to decide.");
			return;
		}
		await this.#auditChannelApproval(user, result.kind, id, decision, row.name, adapter.platform, thread?.id);
		await this.#editDecided(result.key, decision, user.username, reason || undefined);
		await adapter.sendText(target, decision === "approved" ? "Approved." : "Rejected.");
	}

	async #decideApproval(
		user: SessionUser,
		id: string,
		decision: "approved" | "rejected",
		reason?: string,
	): Promise<{ kind: "task" | "task_group" | "external_call"; key: string } | undefined> {
		const record = {
			decision,
			by: { type: "user" as const, id: user.userId, onBehalfOfUserId: user.userId },
			at: new Date().toISOString(),
			...(reason ? { reason } : {}),
		};
		const task = await this.#options.cluster.getTask(id);
		if (
			task &&
			task.onBehalfOfUserId === user.userId &&
			task.state === "awaiting_approval" &&
			task.handlerType === "user" &&
			task.ruleChain
		) {
			const ok = await this.#options.cluster.decide(id, record, { handlerType: "user" });
			if (!ok) return undefined;
			return { kind: "task", key: approvalKey("task", id) };
		}
		const group = await this.#options.taskGroups.get(id);
		if (
			group &&
			group.onBehalfOfUserId === user.userId &&
			group.state === "awaiting_approval" &&
			group.handlerType === "user" &&
			group.ruleChain
		) {
			const ok = await this.#options.taskGroups.decide(id, record, { handlerType: "user" });
			if (!ok) return undefined;
			return { kind: "task_group", key: approvalKey("task_group", id) };
		}
		const call = await getExternalCall(this.#options.db, id);
		if (
			call &&
			call.on_behalf_of_user_id === user.userId &&
			call.state === "awaiting_approval" &&
			call.handler_type === "user" &&
			call.rule_chain
		) {
			const ok = await decideExternalCall(this.#options.db, id, record, reason, { handlerType: "user" });
			if (!ok) return undefined;
			return {
				kind: "external_call",
				key: approvalKey("external_call", id),
			};
		}
		return undefined;
	}

	async #auditChannelApproval(
		user: SessionUser,
		kind: string,
		id: string,
		decision: string,
		channel: string,
		platform: string,
		threadId: string | undefined,
	): Promise<void> {
		await this.#options.audit.record({
			actor: userActor(user),
			action: "channel.approval",
			target: { type: "approval", id },
			detail: {
				channel,
				via: platform,
				...(threadId ? { thread_id: threadId } : {}),
				approval_kind: kind,
				decision,
			},
		});
	}

	async #editDecided(key: string, decision: "approved" | "rejected", by: string, reason?: string): Promise<void> {
		const tracked = this.#tracked.get(key);
		if (!tracked) return;
		this.#tracked.delete(key);
		const entry = this.#adapters.get(tracked.adapterName);
		if (!entry) return;
		const ending = decision === "approved" ? `Approved by ${by}.` : `Rejected by ${by}${reason ? `: ${reason}` : ""}.`;
		try {
			await entry.adapter.editText(tracked.target, tracked.messageId, `${tracked.text}\n\n${ending}`);
		} catch (err) {
			console.error("channels: editing a decided approval message failed:", err);
		}
	}

	// ---- button presses ----

	async #onButton(row: ChannelRow, press: import("./model.ts").ButtonPress): Promise<void> {
		const adapter = this.#adapters.get(row.name)?.adapter;
		if (!adapter) return;
		const target: ChannelTarget = { chatId: press.chatId, topicId: press.topicId };
		const account = await accountByPlatform(this.#options.db, row.id, adapter.platform, press.platformUserId);
		const user = account ? await this.#sessionUser(account) : undefined;
		if (!user) {
			await adapter.sendText(target, LINK_HELP);
			return;
		}
		if (press.data.startsWith("switch:")) {
			const sessionId = press.data.slice("switch:".length);
			await this.#switchSession(row, press, user, sessionId, adapter, target);
			return;
		}
		if (press.data.startsWith("sessions:")) {
			const page = Number.parseInt(press.data.slice("sessions:".length), 10);
			await this.#editSessionPage(row, adapter, press, user, target, Number.isSafeInteger(page) ? page : 1);
			return;
		}
		if (press.data.startsWith("ap:")) {
			const [, kind, id, action] = press.data.split(":");
			if (!kind || !id || !action) return;
			const approvalKind =
				kind === "t" ? "task" : kind === "g" ? "task_group" : kind === "e" ? "external_call" : undefined;
			if (!approvalKind || (action !== "a" && action !== "r")) return;
			const decision = action === "a" ? "approved" : "rejected";
			const thread = await channelThread(this.#options.db, row.id, adapter.platform, press.chatId, press.topicId);
			const result = await this.#decideApproval(user, id, decision);
			if (!result) {
				await adapter.sendText(target, "That approval is no longer waiting, or you may not decide it.");
				return;
			}
			await this.#auditChannelApproval(user, result.kind, id, decision, row.name, adapter.platform, thread?.id);
			await this.#editDecided(result.key, decision, user.username);
			try {
				await adapter.editText(target, press.messageId, decision === "approved" ? "Approved." : "Rejected.");
			} catch {}
		}
	}

	async #switchSession(
		row: ChannelRow,
		press: import("./model.ts").ButtonPress,
		user: SessionUser,
		sessionId: string,
		adapter: ChannelAdapter,
		target: ChannelTarget,
	): Promise<void> {
		const session = await this.#options.runtime.getSession(sessionId);
		if (!session || session.ownerUserId !== user.userId || session.parentSessionId !== null) {
			await adapter.sendText(target, "That session is not yours to attach.");
			return;
		}
		await bindThread(this.#options.db, {
			channelId: row.id,
			platform: adapter.platform,
			chatId: press.chatId,
			topicId: press.topicId,
			sessionId: session.id,
		});
		await this.#ensureWatcher(session.id);
		await this.#replayHistory(adapter, target, session.id);
	}

	/** A page press edits the list message it came from rather than sending another one. */
	async #editSessionPage(
		row: ChannelRow,
		adapter: ChannelAdapter,
		press: import("./model.ts").ButtonPress,
		user: SessionUser,
		target: ChannelTarget,
		page: number,
	): Promise<void> {
		const view = await this.#sessionPage(row, adapter, user, press.chatId, press.topicId, page);
		try {
			if (!view) await adapter.editText(target, press.messageId, NO_SESSIONS);
			else await adapter.editText(target, press.messageId, view.text, { buttons: view.buttons });
		} catch (err) {
			console.error("channels: editing the session list failed:", err);
		}
	}

	async #replayHistory(adapter: ChannelAdapter, target: ChannelTarget, sessionId: string): Promise<void> {
		let messages: Awaited<ReturnType<AgentRuntime["chatHistory"]>>;
		try {
			messages = await this.#options.runtime.chatHistory(sessionId, this.#historyLimit);
		} catch (err) {
			await adapter.sendText(target, `Could not read the session's history: ${errorText(err)}`);
			return;
		}
		const link = this.#sessionLink(sessionId);
		for (const message of messages) {
			const label = message.role === "user" ? "You" : "Assistant";
			const text = clip(message.text);
			const cut = text.length < message.text.replace(/\s+/g, " ").trim().length;
			const body = `${label}: ${text}${cut && link ? `\n${link}` : ""}`;
			try {
				await adapter.sendText(target, body, { disablePreview: true });
			} catch (err) {
				console.error("channels: replaying a history message failed:", err);
				return;
			}
		}
	}

	// ---- outbound and notifications ----

	async #ensureWatcher(sessionId: string): Promise<void> {
		if (this.#watchers.has(sessionId) || this.#stopped) return;
		const starting = this.#watchStarts.get(sessionId);
		if (starting) return starting;
		const start = (async () => {
			try {
				const stop = await this.#options.runtime.watch(sessionId, (events) => {
					void this.#onSessionEvents(sessionId, events).catch((err: unknown) => {
						console.error("channels: handling session events failed:", err);
					});
				});
				if (this.#stopped) {
					stop();
					return;
				}
				this.#watchers.set(sessionId, stop);
			} catch (err) {
				if (!this.#options.runtime.closing) console.error("channels: watching a session failed:", err);
			} finally {
				this.#watchStarts.delete(sessionId);
			}
		})();
		this.#watchStarts.set(sessionId, start);
		return start;
	}

	/** Sends the assistant's text pieces and delivered-file links where the session's notifications go. */
	async #onSessionEvents(sessionId: string, events: import("../agent/runtime.ts").SessionEvent[]): Promise<void> {
		for (const event of events) {
			if (event.type === "run_start") {
				this.#runs.set(sessionId, { deliveries: [], seen: new Set() });
				await this.#showProgress(sessionId, "Working…");
				continue;
			}
			if (event.type === "run_end") {
				const run = this.#runs.get(sessionId);
				this.#runs.delete(sessionId);
				this.#dropDraft(sessionId);
				await this.#clearProgress(sessionId);
				if (run) await this.#sendDeliveries(sessionId, run);
				continue;
			}
			if (event.type === "message_start" && event.message.role === "assistant") {
				await this.#showProgress(sessionId, "Thinking…");
				continue;
			}
			if (event.type === "tool_execution_start") {
				await this.#showProgress(sessionId, `Running ${event.toolName}…`);
				continue;
			}
			if (event.type === "auto_retry_start") {
				await this.#showProgress(sessionId, `Retrying (attempt ${event.attempt})…`);
				continue;
			}
			if (event.type === "message_end") {
				await this.#onMessageEnd(sessionId, event.entry);
				continue;
			}
			if (event.type === "tool_execution_end" && event.entry) {
				this.#collectDelivery(sessionId, event.entry);
			}
		}
	}

	async #onMessageEnd(sessionId: string, entry: import("@crh/api").EntryRecord): Promise<void> {
		const message = entry.model?.[0];
		if (message?.role !== "assistant") return;
		const text = message.content
			.flatMap((block) =>
				block.type === "text" && "text" in block && typeof block.text === "string" ? [block.text] : [],
			)
			.join("");
		if (message.errorMessage) {
			await this.#sendFinal(sessionId, `The turn failed: ${message.errorMessage}`);
			return;
		}
		if (text.trim() === "") return;
		if (message.stopReason === "toolUse") await this.#send(sessionId, text);
		else await this.#sendFinal(sessionId, text);
	}

	#collectDelivery(sessionId: string, entry: import("@crh/api").EntryRecord): void {
		const message = entry.model?.[0];
		if (message?.role !== "toolResult") return;
		const details = message.details;
		if (typeof details !== "object" || details === null || !("delivery" in details)) return;
		const delivery = (details as { delivery?: { name?: unknown; source?: unknown } }).delivery;
		if (!delivery || typeof delivery.name !== "string") return;
		const source = delivery.source as
			| { library?: unknown; path?: unknown; node?: unknown; nodeId?: unknown }
			| undefined;
		if (!source) return;
		const key = source.library
			? `library:${String(source.library)}:${String(source.path)}`
			: `node:${String(source.node)}:${String(source.path)}`;
		const run = this.#runs.get(sessionId);
		if (!run || run.seen.has(key)) return;
		run.seen.add(key);
		const link =
			source.library !== undefined
				? this.#webUrl(
						`/library/${encodeURIComponent(String(source.library))}?path=${encodeURIComponent(String(source.path))}`,
					)
				: this.#webUrl(`/nodes/${encodeURIComponent(String(source.nodeId ?? source.node))}`);
		run.deliveries.push({ name: delivery.name, source: link ?? String(source.path ?? "") });
	}

	async #sendDeliveries(sessionId: string, run: RunState): Promise<void> {
		for (const delivery of run.deliveries) {
			await this.#send(sessionId, `File offered: ${delivery.name}\n${delivery.source}`);
		}
	}

	async #send(
		sessionId: string,
		text: string,
		options: { buttons?: readonly (readonly import("./model.ts").ChannelButton[])[] } = {},
	): Promise<void> {
		const route = await this.#routeForSession(sessionId);
		if (!route) return;
		const body = route.thread === undefined ? `Session "${await this.#sessionTitle(sessionId)}":\n${text}` : text;
		try {
			await route.adapter.sendText(route.target, body, options);
		} catch (err) {
			console.error(`channels: sending from session ${sessionId} failed:`, err);
		}
	}

	/**
	 * Sends a turn's last message without re-showing the progress draft its send cleared: the draft would sit
	 * there as "Thinking…" after the final answer until it times out. Its id is not reused if the run goes on.
	 */
	async #sendFinal(sessionId: string, text: string): Promise<void> {
		const draft = this.#drafts.get(sessionId);
		if (draft) {
			draft.suppressed = true;
			this.#clearDraftKeepalive(draft);
		}
		await this.#send(sessionId, text);
	}

	async #showProgress(sessionId: string, text: string): Promise<void> {
		const route = await this.#routeForSession(sessionId);
		if (!route) return;
		const settings = await userChannelSettings(this.#options.db, route.account.user_id);
		if (!settings.showProgress) return;
		const now = this.#now();
		if (route.adapter.capabilities.drafts && route.adapter.sendDraft && route.thread) {
			let draft = this.#drafts.get(sessionId);
			if (draft) {
				draft.step = text;
				draft.waiting = null;
				// The turn went on after its last message: show progress again without the old throttle or dedupe.
				if (draft.suppressed) {
					draft.suppressed = false;
					draft.lastSentAt = 0;
					draft.lastText = "";
				}
			} else {
				draft = {
					draftId: this.#nextDraftId(),
					adapterName: route.adapterName,
					target: route.target,
					lastSentAt: 0,
					lastText: "",
					step: text,
					waiting: null,
					suppressed: false,
				};
				this.#drafts.set(sessionId, draft);
			}
			if (now - draft.lastSentAt < this.#progressIntervalMs) return;
			const shown = this.#shownStatus(draft);
			if (draft.lastText === shown) return;
			try {
				await route.adapter.sendDraft(route.target, draft.draftId, shown);
				draft.adapterName = route.adapterName;
				draft.target = route.target;
				draft.lastSentAt = now;
				draft.lastText = shown;
				this.#armDraftKeepalive(sessionId, draft);
			} catch (err) {
				console.error("channels: sending a progress draft failed:", err);
			}
			return;
		}
		// A platform without drafts gets one status message, edited at most every few seconds.
		const existing = this.#statuses.get(sessionId);
		if (existing && now - existing.lastSentAt < this.#progressIntervalMs) return;
		if (existing?.lastText === text) return;
		try {
			if (!existing) {
				const sent = await route.adapter.sendText(
					route.target,
					route.thread ? text : `${text}\nThis is the session "${await this.#sessionTitle(sessionId)}".`,
					{ disablePreview: true },
				);
				this.#statuses.set(sessionId, {
					adapterName: route.adapterName,
					target: route.target,
					messageId: sent.messageId,
					lastSentAt: now,
					lastText: text,
				});
			} else {
				await route.adapter.editText(existing.target, existing.messageId, text, { disablePreview: true });
				existing.lastSentAt = now;
				existing.lastText = text;
			}
		} catch (err) {
			console.error("channels: showing progress failed:", err);
		}
	}

	/** The status a draft shows: the wait it is in, or the current step. */
	#shownStatus(draft: DraftState): string {
		if (draft.waiting === "signature") return "Waiting for a signature…";
		if (draft.waiting === "approval") return "Waiting for approval…";
		return draft.step;
	}

	/**
	 * Shows a run's draft again after a real message cleared it, or keeps a long step's draft from expiring,
	 * bypassing the throttle and the dedupe of `#showProgress`. A draft is never sent once the run ended or the
	 * final message suppressed it.
	 */
	async #resendDraft(sessionId: string): Promise<void> {
		if (!this.#runs.has(sessionId)) return;
		const draft = this.#drafts.get(sessionId);
		if (!draft || draft.suppressed) return;
		const adapter = this.#adapters.get(draft.adapterName)?.adapter;
		const sendDraft = adapter?.sendDraft?.bind(adapter);
		if (!sendDraft) return;
		const shown = this.#shownStatus(draft);
		try {
			await sendDraft(draft.target, draft.draftId, shown);
			draft.lastSentAt = this.#now();
			draft.lastText = shown;
			this.#armDraftKeepalive(sessionId, draft);
		} catch (err) {
			console.error("channels: restoring a progress draft failed:", err);
		}
	}

	/** Sets what a run waits for; a wait shows in its draft instead of the step it is on. */
	#markWaiting(sessionId: string, waiting: "approval" | "signature" | null): void {
		const draft = this.#drafts.get(sessionId);
		if (draft) draft.waiting = waiting;
	}

	/** Removes the fallback status message a turn used; a draft disappears by itself. */
	async #clearProgress(sessionId: string): Promise<void> {
		const status = this.#statuses.get(sessionId);
		if (!status) return;
		this.#statuses.delete(sessionId);
		const entry = this.#adapters.get(status.adapterName);
		if (!entry) return;
		try {
			await entry.adapter.deleteMessage(status.target, status.messageId);
		} catch (err) {
			console.error("channels: removing a progress message failed:", err);
		}
	}

	/** Forgets a run's draft and stops its keep-alive. */
	#dropDraft(sessionId: string): void {
		const draft = this.#drafts.get(sessionId);
		if (!draft) return;
		this.#clearDraftKeepalive(draft);
		this.#drafts.delete(sessionId);
	}

	/** Re-sends the shown status before the draft expires; the timer does not keep the process alive. */
	#armDraftKeepalive(sessionId: string, draft: DraftState): void {
		this.#clearDraftKeepalive(draft);
		if (this.#drafts.get(sessionId) !== draft || draft.suppressed) return;
		draft.keepalive = setTimeout(() => {
			draft.keepalive = undefined;
			if (this.#drafts.get(sessionId) === draft) void this.#resendDraft(sessionId);
		}, this.#draftKeepaliveMs);
		draft.keepalive.unref();
	}

	#clearDraftKeepalive(draft: DraftState): void {
		if (draft.keepalive) clearTimeout(draft.keepalive);
		draft.keepalive = undefined;
	}

	#nextDraftId(): number {
		this.#draftSeq += 1;
		if (this.#draftSeq > 2 ** 31 - 1) this.#draftSeq = 1;
		return this.#draftSeq;
	}

	async #onGenerationStopped(row: ChannelRow, stop: import("./model.ts").GenerationStopped): Promise<void> {
		const adapter = this.#adapters.get(row.name)?.adapter;
		if (!adapter) return;
		const thread = await channelThread(this.#options.db, row.id, adapter.platform, stop.chatId, stop.topicId);
		if (!thread) return;
		const owner = await sessionOwner(this.#options.db, thread.session_id);
		if (!owner) return;
		const userRow = await this.#options.db
			.selectFrom("users")
			.select(["id", "username", "kind", "status"])
			.where("id", "=", owner)
			.executeTakeFirst();
		if (!userRow || userRow.status !== "active") return;
		try {
			await this.#options.runtime.abort(thread.session_id, {
				sessionId: `channel:${thread.id}`,
				userId: userRow.id,
				username: userRow.username,
				kind: userRow.kind,
			});
		} catch (err) {
			console.error("channels: stopping a turn from a draft failed:", err);
		}
	}

	/** Where a session's notifications go (doc/design/channels.md "Notifications"). */
	async #routeForSession(sessionId: string): Promise<Route | undefined> {
		const owner = await sessionOwner(this.#options.db, sessionId);
		if (!owner) return undefined;
		const last = await lastUsedFrom(this.#options.db, sessionId);
		if (last !== null && last !== "web") {
			const thread = await threadById(this.#options.db, last);
			if (thread && thread.session_id === sessionId) {
				const route = await this.#routeForThread(thread);
				if (route) return route;
			}
		}
		if (this.#presence.online(owner)) return undefined;
		const fallback = await defaultNotificationAccount(this.#options.db, owner);
		if (!fallback) return undefined;
		const entry = this.#adapters.get(fallback.channel.name);
		if (!entry) return undefined;
		if (entry.adapter.capabilities.topics && entry.adapter.createTopic) {
			const existing = await threadForSession(this.#options.db, fallback.channel.id, sessionId);
			const chatId = fallback.account.platform_chat_id ?? fallback.account.platform_user_id;
			if (existing && existing.chat_id === chatId) {
				return {
					adapterName: entry.row.name,
					adapter: entry.adapter,
					target: { chatId: existing.chat_id, topicId: existing.topic_id },
					thread: existing,
					channelRow: entry.row,
					account: fallback.account,
				};
			}
			const created = await this.#createNotificationTopic(entry.row, entry.adapter, fallback.account, sessionId);
			if (created) {
				return {
					adapterName: entry.row.name,
					adapter: entry.adapter,
					target: { chatId: created.chat_id, topicId: created.topic_id },
					thread: created,
					channelRow: entry.row,
					account: fallback.account,
				};
			}
		}
		return {
			adapterName: entry.row.name,
			adapter: entry.adapter,
			target: { chatId: fallback.account.platform_chat_id ?? fallback.account.platform_user_id },
			thread: undefined,
			channelRow: entry.row,
			account: fallback.account,
		};
	}

	async #routeForThread(thread: ChannelThreadRow): Promise<Route | undefined> {
		for (const entry of this.#adapters.values()) {
			if (entry.row.id !== thread.channel_id) continue;
			const account = await this.#options.db
				.selectFrom("channel_accounts")
				.selectAll()
				.where("channel_id", "=", thread.channel_id)
				.where("platform", "=", thread.platform)
				.where((eb) =>
					eb.or([eb("platform_chat_id", "=", thread.chat_id), eb("platform_user_id", "=", thread.chat_id)]),
				)
				.executeTakeFirst();
			if (!account) continue;
			return {
				adapterName: entry.row.name,
				adapter: entry.adapter,
				target: { chatId: thread.chat_id, topicId: thread.topic_id },
				thread,
				channelRow: entry.row,
				account,
			};
		}
		return undefined;
	}

	async #createNotificationTopic(
		row: ChannelRow,
		adapter: ChannelAdapter,
		account: ChannelAccountRow,
		sessionId: string,
	): Promise<ChannelThreadRow | undefined> {
		const key = `${row.id}:${sessionId}`;
		const pending = this.#topicCreations.get(key);
		if (pending) return pending;
		const creating = (async () => {
			const createTopic = adapter.createTopic?.bind(adapter);
			if (!createTopic) return undefined;
			const session = await this.#options.runtime.getSession(sessionId);
			const title = clip(session?.title ?? "New session", 60);
			try {
				const topicId = await createTopic(account.platform_chat_id ?? account.platform_user_id, `CRH: ${title}`);
				return await bindThread(this.#options.db, {
					channelId: row.id,
					platform: adapter.platform,
					chatId: account.platform_chat_id ?? account.platform_user_id,
					topicId,
					sessionId,
				});
			} catch (err) {
				console.error("channels: creating a notification topic failed:", err);
				return undefined;
			} finally {
				this.#topicCreations.delete(key);
			}
		})();
		this.#topicCreations.set(key, creating);
		return creating;
	}

	// ---- approvals and quota waits in chat ----

	async #stateChanged(sessionId: string): Promise<void> {
		const rootId = (await rootSessionIdOf(this.#options.db, sessionId)) ?? sessionId;
		const pending = this.#waitSyncs.get(rootId);
		if (pending) return pending;
		const sync = this.#syncRootWaits(rootId)
			.catch((err: unknown) => {
				console.error(`channels: syncing waits of root ${rootId} failed:`, err);
			})
			.finally(() => this.#waitSyncs.delete(rootId));
		this.#waitSyncs.set(rootId, sync);
		return sync;
	}

	async #syncAllWaits(): Promise<void> {
		if (this.#stopped) return;
		const rows = await this.#options.db
			.selectFrom("sessions")
			.select("root_session_id")
			.where("state", "=", "awaiting")
			.groupBy("root_session_id")
			.execute();
		for (const row of rows) await this.#syncRootWaits(row.root_session_id);
	}

	async #syncRootWaits(rootId: string): Promise<void> {
		await this.#settleTracked(rootId);
		const owner = await sessionOwner(this.#options.db, rootId);
		if (!owner) return;
		const route = await this.#routeForSession(rootId);
		const tasks = await this.#options.db
			.selectFrom("tasks")
			.select(["id", "state", "handler_type", "on_behalf_of_user_id"])
			.where("root_session_id", "=", rootId)
			.where("state", "in", ["awaiting_approval", "awaiting_authorization"])
			.execute();
		for (const task of tasks) await this.#syncTaskWait(rootId, task, owner, route);
		const groups = await this.#options.db
			.selectFrom("task_groups")
			.select(["id", "state", "handler_type", "on_behalf_of_user_id"])
			.where("root_session_id", "=", rootId)
			.where("state", "in", ["awaiting_approval", "awaiting_authorization"])
			.execute();
		for (const group of groups) await this.#syncGroupWait(rootId, group, owner, route);
		const calls = await this.#options.db
			.selectFrom("external_calls")
			.select(["id", "state", "handler_type", "on_behalf_of_user_id"])
			.where("root_session_id", "=", rootId)
			.where("state", "=", "awaiting_approval")
			.execute();
		for (const call of calls) await this.#syncCallWait(rootId, call, owner, route);
		await this.#syncQuotaWait(rootId, owner, route);
		// A wait that ended above returns the draft to the step; one still waiting keeps its wait status.
		await this.#settleWaiting(rootId, waitKindOf(tasks, groups, calls, owner));
	}

	/** The status a run's draft shows while any of its waits need the user; a signature wins over an approval. */
	async #settleWaiting(rootId: string, waiting: "approval" | "signature" | null): Promise<void> {
		const draft = this.#drafts.get(rootId);
		if (!draft || draft.waiting === waiting) return;
		draft.waiting = waiting;
		await this.#resendDraft(rootId);
	}

	async #syncTaskWait(
		rootId: string,
		task: { id: string; state: string; handler_type: string | null; on_behalf_of_user_id: string },
		owner: string,
		route: Route | undefined,
	): Promise<void> {
		if (task.on_behalf_of_user_id !== owner) return;
		const key = approvalKey("task", task.id);
		if (task.state === "awaiting_authorization") {
			if (!route || this.#tracked.has(key)) return;
			const link = this.#webUrl(`/approvals/tasks/${task.id}`);
			await this.#sendTracked(
				key,
				rootId,
				route,
				`Task ${task.id} waits for your signature.${link ? `\n${link}` : ""}`,
				[],
				"signature",
			);
			return;
		}
		if (task.handler_type !== "user") return;
		if (!route || this.#tracked.has(key)) return;
		const view = await this.#options.cluster.getTask(task.id);
		if (!view) return;
		const text = `Approval needed for a task:\n${clip(view.summary || view.kind, 300)}\n\n/approve ${task.id}\n/reject ${task.id} [reason]`;
		await this.#sendTracked(
			key,
			rootId,
			route,
			text,
			[
				[
					{ text: "Approve", data: `ap:t:${task.id}:a` },
					{ text: "Reject", data: `ap:t:${task.id}:r` },
				],
			],
			"approval",
		);
	}

	async #syncGroupWait(
		rootId: string,
		group: { id: string; state: string; handler_type: string | null; on_behalf_of_user_id: string },
		owner: string,
		route: Route | undefined,
	): Promise<void> {
		if (group.on_behalf_of_user_id !== owner) return;
		const key = approvalKey("task_group", group.id);
		if (group.state === "awaiting_authorization") {
			if (!route || this.#tracked.has(key)) return;
			const link = this.#webUrl(`/approvals/task-groups/${group.id}`);
			await this.#sendTracked(
				key,
				rootId,
				route,
				`Task group ${group.id} waits for your signature.${link ? `\n${link}` : ""}`,
				[],
				"signature",
			);
			return;
		}
		if (group.handler_type !== "user") return;
		if (!route || this.#tracked.has(key)) return;
		const view = await this.#options.taskGroups.get(group.id);
		if (!view) return;
		const text = `Approval needed for a task group:\n${clip(view.summary || view.kind, 300)}\n\n/approve ${group.id}\n/reject ${group.id} [reason]`;
		await this.#sendTracked(
			key,
			rootId,
			route,
			text,
			[
				[
					{ text: "Approve", data: `ap:g:${group.id}:a` },
					{ text: "Reject", data: `ap:g:${group.id}:r` },
				],
			],
			"approval",
		);
	}

	async #syncCallWait(
		rootId: string,
		call: { id: string; state: string; handler_type: string | null; on_behalf_of_user_id: string },
		owner: string,
		route: Route | undefined,
	): Promise<void> {
		if (call.on_behalf_of_user_id !== owner || call.handler_type !== "user") return;
		const key = approvalKey("external_call", call.id);
		if (!route || this.#tracked.has(key)) return;
		const row = await getExternalCall(this.#options.db, call.id);
		if (!row) return;
		const view = (await externalCallViews(this.#options.db, [row]))[0];
		const what = view ? `${view.extension}/${view.tool}` : `${row.extension_name}/${row.tool_name}`;
		const text = `Approval needed for an extension call:\n${what}\n\n/approve ${call.id}\n/reject ${call.id} [reason]`;
		await this.#sendTracked(
			key,
			rootId,
			route,
			text,
			[
				[
					{ text: "Approve", data: `ap:e:${call.id}:a` },
					{ text: "Reject", data: `ap:e:${call.id}:r` },
				],
			],
			"approval",
		);
	}

	async #syncQuotaWait(rootId: string, owner: string, route: Route | undefined): Promise<void> {
		const key = `quota:${rootId}`;
		const root = await this.#options.db
			.selectFrom("sessions")
			.select(["id", "title", "quota_tokens", "budget_used_tokens", "owner_user_id"])
			.where("id", "=", rootId)
			.executeTakeFirst();
		if (!root || root.owner_user_id !== owner) return;
		const paused = await this.#options.db
			.selectFrom("sessions")
			.select("id")
			.where("waiting_level_id", "=", rootId)
			.where("waiting_kind", "=", "quota")
			.where("state", "=", "awaiting")
			.limit(1)
			.executeTakeFirst();
		if (!paused) return;
		if (!route || this.#tracked.has(key)) return;
		const remaining = root.quota_tokens === null ? 0 : Number(root.quota_tokens);
		const used = Number(root.budget_used_tokens);
		const text = `The token quota of "${clip(root.title || "this session", 80)}" is used up (${remaining} remaining, ${used} used).\n\n/quota add <tokens> continues\n/quota stop ends the turn`;
		await this.#sendTracked(key, rootId, route, text, []);
	}

	async #sendTracked(
		key: string,
		rootId: string,
		route: Route,
		text: string,
		buttons: readonly (readonly import("./model.ts").ChannelButton[])[],
		waiting?: "approval" | "signature",
	): Promise<void> {
		const withSwitch =
			route.thread === undefined ? [...buttons, [{ text: "Open session", data: `switch:${rootId}` }]] : buttons;
		const body = route.thread === undefined ? `Session "${await this.#sessionTitle(rootId)}":\n${text}` : text;
		let sent: SentMessage;
		// The wait's status is set before the send, so re-showing the cleared draft carries it.
		if (waiting !== undefined) this.#markWaiting(rootId, waiting);
		try {
			sent = await route.adapter.sendText(route.target, body, { buttons: withSwitch });
		} catch (err) {
			console.error("channels: sending an approval message failed:", err);
			return;
		}
		this.#tracked.set(key, {
			key,
			rootSessionId: rootId,
			adapterName: route.adapterName,
			target: route.target,
			messageId: sent.messageId,
			text: body,
		});
	}

	/** Edits tracked messages whose wait is over, saying how it ended (doc/design/channels.md "Approvals"). */
	async #settleTracked(rootId: string): Promise<void> {
		for (const [key, tracked] of [...this.#tracked]) {
			if (tracked.rootSessionId !== rootId) continue;
			const ending = await this.#waitEnding(key);
			if (ending === undefined) continue;
			this.#tracked.delete(key);
			const entry = this.#adapters.get(tracked.adapterName);
			if (!entry) continue;
			try {
				await entry.adapter.editText(tracked.target, tracked.messageId, `${tracked.text}\n\n${ending}`);
			} catch (err) {
				console.error("channels: editing an ended wait message failed:", err);
			}
		}
	}

	/** `undefined` while the wait goes on; otherwise how it ended. */
	async #waitEnding(key: string): Promise<string | undefined> {
		if (key.startsWith("quota:")) {
			const rootId = key.slice("quota:".length);
			const row = await this.#options.db
				.selectFrom("sessions")
				.select("state")
				.where("id", "=", rootId)
				.executeTakeFirst();
			if (!row) return "The session is gone.";
			if (row.state === "awaiting") {
				const paused = await this.#options.db
					.selectFrom("sessions")
					.select("id")
					.where("waiting_level_id", "=", rootId)
					.where("waiting_kind", "=", "quota")
					.where("state", "=", "awaiting")
					.limit(1)
					.executeTakeFirst();
				return paused ? undefined : "The quota wait ended.";
			}
			return "The quota wait ended.";
		}
		const [kind, id] = key.split(":");
		if (!kind || !id) return "The wait ended.";
		if (kind === "task") {
			const row = await this.#options.db
				.selectFrom("tasks")
				.select(["state", "approval"])
				.where("id", "=", id)
				.executeTakeFirst();
			if (!row) return "The task is gone.";
			if (row.state === "awaiting_approval" || row.state === "awaiting_authorization") return undefined;
			return this.#decisionEnding(row.approval, row.state === "rejected" ? "rejected" : undefined);
		}
		if (kind === "task_group") {
			const row = await this.#options.db
				.selectFrom("task_groups")
				.select(["state", "approval"])
				.where("id", "=", id)
				.executeTakeFirst();
			if (!row) return "The task group is gone.";
			if (row.state === "awaiting_approval" || row.state === "awaiting_authorization") return undefined;
			return this.#decisionEnding(row.approval, row.state === "rejected" ? "rejected" : undefined);
		}
		const row = await getExternalCall(this.#options.db, id);
		if (!row) return "The call is gone.";
		if (row.state === "awaiting_approval") return undefined;
		return this.#decisionEnding(row.approval, row.state === "rejected" ? "rejected" : undefined);
	}

	#decisionEnding(approvalJson: string | null, fallback: "rejected" | undefined): string {
		if (approvalJson) {
			try {
				const record = JSON.parse(approvalJson) as {
					decision?: { decision?: string; reason?: string; by?: { id?: string } };
				};
				const decision = record.decision;
				if (decision?.decision === "approved") return "Approved.";
				if (decision?.decision === "rejected") return `Rejected${decision.reason ? `: ${decision.reason}` : "."}`;
			} catch {}
		}
		return fallback === "rejected" ? "Rejected." : "The wait ended.";
	}

	/** Re-reads a session's waiting approvals and quota waits (its state change, or a test setup). */
	async refreshWaits(sessionId: string): Promise<void> {
		await this.#stateChanged(sessionId);
	}

	// ---- helpers ----

	async #sessionUser(account: ChannelAccountRow): Promise<SessionUser | undefined> {
		const user = await this.#options.db
			.selectFrom("users")
			.select(["id", "username", "kind", "status"])
			.where("id", "=", account.user_id)
			.executeTakeFirst();
		if (!user || user.status !== "active") return undefined;
		return {
			sessionId: `channel:${account.id}`,
			userId: user.id,
			username: user.username,
			kind: user.kind,
		};
	}

	#sessionLink(sessionId: string): string | null {
		return this.#webUrl(`/sessions/${sessionId}`);
	}

	async #sessionTitle(sessionId: string): Promise<string> {
		const session = await this.#options.runtime.getSession(sessionId);
		return clip(session?.title ?? "New session", 80);
	}

	#webUrl(path: string): string | null {
		const base = this.#options.settings?.current().publicUrl ?? this.#options.publicUrl ?? null;
		if (!base) return null;
		return `${base.replace(/\/+$/, "")}${path}`;
	}

	#helpText(): string {
		return [
			"ClusterRightHand commands:",
			"/link <code> — link this chat to your account",
			"/unlink — unlink this chat",
			"/new — start a new session",
			"/sessions — switch to one of your sessions",
			"/stop — stop the running turn",
			"/quota — show the session's token quota",
			"/quota add <tokens> — raise it and continue",
			"/quota stop — end the turn waiting for tokens",
			"/approve <id> — approve a waiting request",
			"/reject <id> [reason] — reject it",
			"/help — this list",
		].join("\n");
	}

	// ---- admin operations used by the routes ----

	async saveChannel(user: SessionUser, name: string, input: import("./store.ts").ChannelInput): Promise<ChannelView> {
		const { row, created } = await saveChannelRow(this.#options.db, this.#options.masterKey, name, input);
		await this.reload(name);
		void this.#options.audit.record({
			actor: userActor(user),
			action: created ? "channel.created" : "channel.updated",
			target: { type: "channel", id: row.id },
			detail: { name: row.name, kind: row.kind, enabled: row.enabled === 1 },
		});
		return channelView(row, this.status(name));
	}

	async deleteChannel(user: SessionUser, name: string): Promise<void> {
		const row = await deleteChannelRow(this.#options.db, name);
		await this.remove(name);
		void this.#options.audit.record({
			actor: userActor(user),
			action: "channel.deleted",
			target: { type: "channel", id: row.id },
			detail: { name: row.name, kind: row.kind },
		});
	}
}
