import { createHash, randomInt } from "node:crypto";
import type {
	AvailableModel,
	ChannelAccountView,
	ChannelPublicView,
	ChannelStatus,
	ChannelView,
	ModelRef,
	RulePreset,
	ThinkingLevel,
	UserSettings,
	UserSettingsLocale,
	UserSettingsUpdate,
} from "@crh/api";
import type { ModelConfig } from "../agent/models.ts";
import type { AgentRuntime, SessionView as AgentSessionView } from "../agent/runtime.ts";
import type { Audit } from "../audit/audit.ts";
import { userActor } from "../audit/audit.ts";
import type { SessionUser } from "../auth/sessions.ts";
import type { Cluster } from "../cluster/cluster.ts";
import type { TaskGroups } from "../cluster/task-groups.ts";
import {
	decideExternalCall,
	externalCallViews,
	getExternalCall,
	reevaluateExternalCalls,
} from "../extensions/external-calls.ts";
import { extensionsForUser, parseDisabledExtensionNames } from "../extensions/store.ts";
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
import { getUserSettings, patchUserSettings } from "../users/settings.ts";
import { errorText, NotFoundError, UserError } from "../util/errors.ts";
import { newId } from "../util/id.ts";
import { KeyedQueue } from "../util/keyed-queue.ts";
import { KeyedReconciler } from "../util/keyed-reconciler.ts";
import { SingleFlight } from "../util/single-flight.ts";
import {
	type BotMessages,
	botLocale,
	escapeMarkdown,
	formatBytes,
	localeFromLanguageCode,
	messagesFor,
} from "./messages.ts";
import {
	type ChannelAdapter,
	type ChannelHandlers,
	type ChannelTarget,
	FileTooLargeError,
	type SentMessage,
} from "./model.ts";
import { WebUiPresence } from "./presence.ts";
import { SatoriChannel } from "./satori.ts";
import {
	accountByPlatform,
	accountsForUser,
	accountView,
	bindThread,
	type ChannelAccountRow,
	type ChannelDraft,
	type ChannelRow,
	type ChannelThreadRow,
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
	parseChannelConfig,
	parseChannelCursor,
	parseThreadDraft,
	readSatoriToken,
	readTelegramToken,
	saveChannel as saveChannelRow,
	saveDraftThread,
	sessionOwner,
	setChannelCursor,
	threadById,
	threadForSession,
	threadsForSession,
	unlinkAccount,
	unlinkUserAccounts,
	updateThreadDraft,
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
	/** The offered models, for `/model` and for a draft's defaults. */
	models: ModelConfig;
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
	/** Unlinked senders remembered as already answered (1000 by default); the oldest is dropped past it. */
	unlinkedReplyLimit?: number;
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
	/** The language the message was written in; its ending is written in the same one. */
	locale: UserSettingsLocale;
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
	/** The status of the current step. */
	step: string;
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
	locale: UserSettingsLocale;
}

interface RunState {
	deliveries: { name: string; source: string }[];
	/** Deliveries already sent in this run, keyed by source and path. */
	seen: Set<string>;
}

const DEFAULT_HISTORY_LIMIT = 10;
const DEFAULT_PROGRESS_INTERVAL_MS = 1_500;
/** A draft expires after 30 s without an update; it is re-sent well before that. */
const DRAFT_KEEPALIVE_MS = 20_000;
const CLIP_CHARS = 500;
const SESSION_PAGE_SIZE = 5;
const MODEL_PAGE_SIZE = 5;
const EXTENSION_PAGE_SIZE = 5;
/** Unlinked senders are answered once; the set is bounded so a busy bot cannot grow it without limit. */
const UNLINKED_REPLY_LIMIT = 1000;
/** Approval messages tracked for a final edit; a root that never changes state again must not grow it forever. */
const TRACKED_MESSAGES_LIMIT = 1000;

/** The rule presets with the WebUI's product names (doc/design/webui.md "Composer"); the raw values stay internal. */
const RULE_PRESET_CHOICES: readonly { value: RulePreset; label: string }[] = [
	{ value: "ask", label: "Ask" },
	{ value: "auto_review", label: "Auto Review" },
	{ value: "yolo", label: "Yolo" },
];

const sameModel = (a: ModelRef, b: ModelRef): boolean => a.provider === b.provider && a.modelId === b.modelId;

/** A ModelRef with an explicit level; `off` is omitted, matching the stored shape. */
function withThinkingLevel(model: ModelRef, level: ThinkingLevel): ModelRef {
	return {
		provider: model.provider,
		modelId: model.modelId,
		...(level === "off" ? {} : { thinkingLevel: level }),
	};
}

/** A short, stable digest of a list a button's page showed, so a press after the list changed acts on nothing. */
function listHash(parts: readonly string[]): string {
	return createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 8);
}

function modelListHash(available: readonly AvailableModel[]): string {
	return listHash(available.map((model) => `${model.provider}/${model.modelId}`));
}

function modelRefHash(model: ModelRef): string {
	return listHash([`${model.provider}/${model.modelId}`]);
}

/** A short digest of the session or draft a settings button was shown for, so a press after `/sessions` does nothing. */
function targetTag(state: Extract<ChatTarget, { state: "draft" | "session" }>): string {
	return listHash([state.state === "draft" ? `${state.thread.id}draft` : state.session.id]);
}

interface ResolvedDefaults {
	model: ModelRef | undefined;
	thinkingLevel: ThinkingLevel;
}

/**
 * A new session's defaults, the WebUI new-session page's resolution (doc/design/webui.md "New session"): the
 * user's default model, then the session model preset, then the first offered model. A default a provider no
 * longer offers falls through; the thinking level comes with that model and is dropped when the model changed
 * its levels.
 */
function resolveNewSessionDefaults(
	available: readonly AvailableModel[],
	settings: UserSettings | null,
	sessionModel: ModelRef | null,
): ResolvedDefaults {
	const offered = (candidate: ModelRef | null | undefined): AvailableModel | undefined =>
		candidate === null || candidate === undefined ? undefined : available.find((model) => sameModel(model, candidate));
	for (const candidate of [settings?.defaultModel, sessionModel]) {
		const found = offered(candidate);
		if (found === undefined || candidate === null || candidate === undefined) continue;
		const level =
			candidate.thinkingLevel !== undefined && found.thinkingLevels.includes(candidate.thinkingLevel)
				? candidate.thinkingLevel
				: "off";
		return { model: { provider: found.provider, modelId: found.modelId }, thinkingLevel: level };
	}
	const first = available[0];
	return {
		model: first === undefined ? undefined : { provider: first.provider, modelId: first.modelId },
		thinkingLevel: "off",
	};
}

/** A chat thread with the session or draft its commands act on. */
type ChatTarget =
	| { state: "none" }
	| { state: "missing" }
	| { state: "notYours" }
	| { state: "draft"; thread: ChannelThreadRow; draft: ChannelDraft }
	| { state: "session"; thread: ChannelThreadRow; session: AgentSessionView };

/** Parses `/command@bot args`; undefined when the text is not a command. */
function parseCommand(text: string | null): { name: string; args: string[] } | undefined {
	if (!text?.startsWith("/")) return undefined;
	const [head = "", ...rest] = text.trim().split(/\s+/);
	const name = head.slice(1).split("@")[0]?.toLowerCase() ?? "";
	if (name === "") return undefined;
	return { name, args: rest };
}

/**
 * The argument of a list command: none is the first page, `page <n>` is another page, and `<n>` is the n-th item of
 * the whole list, which is numbered across pages. Anything else is refused with the command's hint.
 */
type ListArgs = { kind: "page"; page: number } | { kind: "index"; index: number } | { kind: "invalid" };

function positiveNumber(raw: string | undefined): number | undefined {
	if (raw === undefined || !/^\d+$/.test(raw)) return undefined;
	const value = Number(raw);
	return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function parseListArgs(args: readonly string[]): ListArgs {
	if (args.length === 0) return { kind: "page", page: 1 };
	if (args[0]?.toLowerCase() === "page") {
		const page = positiveNumber(args[1]);
		return page === undefined ? { kind: "invalid" } : { kind: "page", page };
	}
	const index = positiveNumber(args[0]);
	return index === undefined ? { kind: "invalid" } : { kind: "index", index };
}

/** A numbered line of a choice list; the number is global, so page 2 starts at 6. */
function numberedItem(offset: number, text: string, selected: boolean): string {
	return `${offset + 1}. ${selected ? "✓ " : ""}${escapeMarkdown(text)}`;
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
 * Whether a session's chat messages wait for the user: an approval or signature that is shown in the chat.
 * An approval routed to an agent is not shown there.
 */
function hasWait(
	tasks: readonly WaitRow[],
	groups: readonly WaitRow[],
	calls: readonly WaitRow[],
	owner: string,
): boolean {
	for (const task of tasks) {
		if (task.on_behalf_of_user_id !== owner) continue;
		if (task.state === "awaiting_authorization") return true;
		if (task.state === "awaiting_approval" && task.handler_type === "user") return true;
	}
	for (const group of groups) {
		if (group.on_behalf_of_user_id !== owner) continue;
		if (group.state === "awaiting_authorization") return true;
		if (group.state === "awaiting_approval" && group.handler_type === "user") return true;
	}
	for (const call of calls) {
		if (call.on_behalf_of_user_id === owner && call.handler_type === "user") return true;
	}
	return false;
}

export class ChannelManager {
	readonly #options: ChannelManagerOptions;
	readonly #presence: WebUiPresence;
	readonly #adapters = new Map<string, AdapterEntry>();
	readonly #rowErrors = new Map<string, string>();
	readonly #watchers = new Map<string, () => void>();
	readonly #watchStarts = new SingleFlight<void>();
	/** Each watched session's event batches, handled one after another. */
	readonly #eventQueue = new KeyedQueue("channel event queue");
	readonly #runs = new Map<string, RunState>();
	readonly #drafts = new Map<string, DraftState>();
	readonly #statuses = new Map<string, StatusState>();
	readonly #tracked = new Map<string, TrackedMessage>();
	readonly #unlinkedReplied = new Set<string>();
	/** Each channel's admin operations, so a reload never overlaps another for the same name. */
	readonly #channelOps = new KeyedQueue("channel admin queue");
	/** Wait syncs per root: a state change during a sync asks for one more pass that reads the newer waits. */
	readonly #waitSyncs = new KeyedReconciler<void>();
	readonly #topicCreations = new SingleFlight<ChannelThreadRow | undefined>();
	readonly #historyLimit: number;
	readonly #progressIntervalMs: number;
	readonly #draftKeepaliveMs: number;
	readonly #unlinkedReplyLimit: number;
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
		this.#unlinkedReplyLimit = options.unlinkedReplyLimit ?? UNLINKED_REPLY_LIMIT;
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
			if (thread.session_id !== null && (thread.current === 1 || thread.topic_id !== null)) {
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
		for (const entry of [...this.#adapters.values()]) {
			try {
				await entry.adapter.stop();
			} catch (err) {
				console.error(`channels: stopping channel ${entry.row.name} failed:`, err);
			}
		}
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

	/**
	 * Runs an admin operation after the previous one for the same channel, so two overlapping saves cannot open
	 * two adapters and lose the reference to one of them (doc/design/channels.md "Channels").
	 */
	#serialized<T>(name: string, operation: () => Promise<T>): Promise<T> {
		return this.#channelOps.run(name, operation);
	}

	/** Re-reads one channel after an admin change, starting or stopping its adapter. */
	async reload(name: string): Promise<void> {
		await this.#serialized(name, () => this.#reloadNow(name));
	}

	async #reloadNow(name: string): Promise<void> {
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
		await this.#serialized(name, () => this.#removeNow(name));
	}

	async #removeNow(name: string): Promise<void> {
		const existing = this.#adapters.get(name);
		if (existing) {
			this.#adapters.delete(name);
			await existing.adapter.stop();
		}
		this.#rowErrors.delete(name);
		// The channel's thread rows are gone, so a session only it reached no longer needs its event watch.
		await this.#releaseUnusedWatchers();
	}

	async #openRow(row: ChannelRow): Promise<void> {
		if (row.enabled !== 1 || this.#stopped) return;
		let adapter: ChannelAdapter;
		if (row.kind === "satori") {
			const config = parseChannelConfig(row);
			if (config === null) {
				this.#rowErrors.set(row.name, `channel ${row.name} has no gateway settings`);
				return;
			}
			let token: string;
			try {
				token = await readSatoriToken(this.#options.db, this.#options.masterKey, row);
			} catch (err) {
				this.#rowErrors.set(row.name, errorText(err));
				return;
			}
			adapter = new SatoriChannel({
				channelId: row.id,
				...config,
				token,
				...(this.#options.fetch ? { fetch: this.#options.fetch } : {}),
				initialCursor: parseChannelCursor(row),
				onCursor: (updateId) => setChannelCursor(this.#options.db, row.id, updateId),
				connection: {
					...(this.#options.backoffBaseMs !== undefined ? { baseMs: this.#options.backoffBaseMs } : {}),
					...(this.#options.backoffMaxMs !== undefined ? { maxMs: this.#options.backoffMaxMs } : {}),
				},
			});
		} else {
			let token: string;
			try {
				// The token is read through the store's helper so a broken or missing secret is reported, not thrown at startup.
				token = await readTelegramToken(this.#options.db, this.#options.masterKey, row);
			} catch (err) {
				this.#rowErrors.set(row.name, errorText(err));
				return;
			}
			adapter = new TelegramChannel({
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
		}
		adapter.setHandlers(this.#handlers(row));
		this.#adapters.set(row.name, { row, adapter });
		this.#watchSends(adapter);
		this.#withoutButtons(adapter);
		adapter.start();
	}

	/**
	 * A platform without inline buttons gets none from the manager, even where a caller passed them: the texts
	 * that carry buttons also carry the equivalent command (`/approve <id>`) and, for a notification without a
	 * thread, the session's link.
	 */
	#withoutButtons(adapter: ChannelAdapter): void {
		if (adapter.capabilities.buttons) return;
		const sendText = adapter.sendText.bind(adapter);
		adapter.sendText = async (target, text, options) =>
			sendText(target, text, options === undefined ? undefined : { ...options, buttons: undefined });
		const editText = adapter.editText.bind(adapter);
		adapter.editText = async (target, messageId, text, options) =>
			editText(target, messageId, text, options === undefined ? undefined : { ...options, buttons: undefined });
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
		const settings = await getUserSettings(this.#options.db, userId);
		return (await accountsForUser(this.#options.db, userId)).map((item) =>
			accountView(item.account, item.channelName, settings.defaultChannelAccountId === item.account.id),
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
			if (message.files.length > 0) {
				const account = await accountByPlatform(this.#options.db, row.id, adapter.platform, message.platformUserId);
				const locale = account
					? await this.#localeForAccount(account, message.languageCode)
					: localeFromLanguageCode(message.languageCode);
				await adapter.sendText(target, messagesFor(locale).filesNotSent);
			}
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
		const locale = await this.#localeForAccount(account, message.languageCode);
		const m = messagesFor(locale);
		if (message.text === null && message.files.length === 0) {
			await adapter.sendText(target, m.unsupported);
			return;
		}
		// Files go to the library before a session exists, so a failed upload leaves no empty session.
		let attachments: Awaited<ReturnType<typeof resolveAttachments>> | undefined;
		if (message.files.length > 0) {
			try {
				attachments = await this.#downloadAttachments(user, message.files, adapter);
			} catch (err) {
				const text =
					err instanceof FileTooLargeError
						? m.fileTooLarge(formatBytes(err.maxBytes))
						: m.couldNotSaveFile(errorText(err));
				await adapter.sendText(target, text);
				return;
			}
		}
		const found = await this.#threadFor(row, message, user, adapter, target, locale);
		if (!found) return;
		const thread =
			found.draft === null
				? found.thread
				: await this.#startDraftSession(row, found.thread, found.draft, user, adapter, target, locale);
		if (!thread || thread.session_id === null) return;
		await this.#ensureWatcher(thread.session_id);
		await this.#submitMessage(row, thread, user, message, attachments, adapter, target, locale);
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
		const locale = await this.#localeForAccount(account, message.languageCode);
		const m = messagesFor(locale);
		if (command.name === "unlink") {
			await this.#unlinkFromChat(adapter, account, user, target, m);
			return;
		}
		if (command.name === "help" || command.name === "start") {
			await adapter.sendText(target, m.help);
			return;
		}
		if (command.name === "approve" || command.name === "reject") {
			await this.#decideFromCommand(adapter, row, message, user, target, command, m);
			return;
		}
		if (command.name === "sessions") {
			await this.#showSessions(adapter, row, message, user, target, m, command.args);
			return;
		}
		if (command.name === "model") {
			await this.#modelCommand(row, adapter, user, target, m, command.args);
			return;
		}
		if (command.name === "think") {
			await this.#thinkCommand(row, adapter, user, target, m, command.args);
			return;
		}
		if (command.name === "rules") {
			await this.#rulesCommand(row, adapter, user, target, m, command.args);
			return;
		}
		if (command.name === "extensions") {
			await this.#extensionsCommand(row, adapter, user, target, m, command.args);
			return;
		}
		if (command.name === "new") {
			await this.#newSession(adapter, row, message, user, target, locale);
			return;
		}
		if (command.name === "quota") {
			await this.#quotaCommand(adapter, row, message, user, target, command.args, m);
			return;
		}
		if (command.name === "stop") {
			await this.#stopCommand(adapter, row, message, user, target, m);
			return;
		}
		await adapter.sendText(target, m.unknownCommand(command.name));
	}

	async #submitMessage(
		row: ChannelRow,
		thread: ChannelThreadRow,
		user: SessionUser,
		message: import("./model.ts").InboundMessage,
		attachments: Awaited<ReturnType<typeof resolveAttachments>> | undefined,
		adapter: ChannelAdapter,
		target: ChannelTarget,
		locale: UserSettingsLocale,
	): Promise<void> {
		if (thread.session_id === null) return;
		try {
			const text = message.text ?? "";
			// The thread is the source only while its account belongs to the owner; a shared user's message
			// counts as the WebUI, so notifications keep following the owner.
			const owner = await sessionOwner(this.#options.db, thread.session_id);
			await this.#options.runtime.submit(
				thread.session_id,
				user,
				text,
				`channel:${row.id}:${message.dedupeKey ?? message.updateId}`,
				{
					lastUsedFrom: owner === user.userId ? thread.id : "web",
					...(attachments
						? {
								content: attachmentContent(text, attachments.blocks),
								attachments: attachments.attachments,
							}
						: {}),
				},
			);
		} catch (err) {
			await adapter.sendText(target, messagesFor(locale).couldNotSendMessage(errorText(err)));
		}
	}

	async #threadFor(
		row: ChannelRow,
		message: import("./model.ts").InboundMessage,
		user: SessionUser,
		adapter: ChannelAdapter,
		target: ChannelTarget,
		locale: UserSettingsLocale,
	): Promise<{ thread: ChannelThreadRow; draft: ChannelDraft | null } | undefined> {
		const existing = await channelThread(this.#options.db, row.id, adapter.platform, message.chatId, message.topicId);
		let previous: "archived" | "unavailable" | undefined;
		let replacedSessionId: string | null = null;
		if (existing) {
			if (existing.session_id === null) {
				// A draft waits for its first ordinary message to create the session it starts.
				const draft = parseThreadDraft(existing.draft);
				if (draft) return { thread: existing, draft };
			} else {
				const session = await this.#options.runtime.getSession(existing.session_id);
				if (session && session.ownerUserId === user.userId && session.status === "active") {
					return { thread: existing, draft: null };
				}
				previous = session?.status === "archived" ? "archived" : "unavailable";
				replacedSessionId = existing.session_id;
			}
		}
		const thread = await this.#createSessionThread(
			row,
			message.chatId,
			message.topicId,
			user,
			adapter,
			target,
			locale,
			previous,
		);
		if (replacedSessionId !== null) await this.#releaseWatcherIfUnused(replacedSessionId);
		return thread ? { thread, draft: null } : undefined;
	}

	/** A new session's settings from the user's defaults; the chat no longer has defaults of its own. */
	async #sessionDefaults(user: SessionUser): Promise<ResolvedDefaults & { rulePreset: RulePreset }> {
		const settings = await getUserSettings(this.#options.db, user.userId);
		const resolved = resolveNewSessionDefaults(
			this.#options.models.available(),
			settings,
			this.#options.runtime.modelPresets.get("session").model,
		);
		return { ...resolved, rulePreset: settings.defaultRulePreset ?? "ask" };
	}

	/** Creates a session directly, for a chat or topic with no thread at all or a thread whose session went away. */
	async #createSessionThread(
		row: ChannelRow,
		chatId: string,
		topicId: string | null,
		user: SessionUser,
		adapter: ChannelAdapter,
		target: ChannelTarget,
		locale: UserSettingsLocale,
		previous?: "archived" | "unavailable",
	): Promise<ChannelThreadRow | undefined> {
		const m = messagesFor(locale);
		const defaults = await this.#sessionDefaults(user);
		if (!defaults.model) {
			await adapter.sendText(target, m.noDefaultModel);
			return undefined;
		}
		try {
			const session = await this.#options.runtime.createSession(user, {
				model: withThinkingLevel(defaults.model, defaults.thinkingLevel),
				rulePreset: defaults.rulePreset,
			});
			const thread = await bindThread(this.#options.db, {
				channelId: row.id,
				platform: adapter.platform,
				chatId,
				topicId,
				sessionId: session.id,
			});
			await this.#announceSession(adapter, target, session.id, m, previous);
			return thread;
		} catch (err) {
			await adapter.sendText(target, m.couldNotStartSession(errorText(err)));
			return undefined;
		}
	}

	/** Starts the session a draft holds, with its model, thinking level, rule preset and disabled extensions. */
	async #startDraftSession(
		row: ChannelRow,
		thread: ChannelThreadRow,
		draft: ChannelDraft,
		user: SessionUser,
		adapter: ChannelAdapter,
		target: ChannelTarget,
		locale: UserSettingsLocale,
	): Promise<ChannelThreadRow | undefined> {
		const m = messagesFor(locale);
		let model = draft.model;
		try {
			const ref = { provider: model.provider, modelId: model.modelId };
			this.#options.models.assertAvailable(ref);
			// A level the model no longer supports is clamped, as a WebUI model change would be.
			model = this.#options.models.resolveRef(ref, model.thinkingLevel);
		} catch {
			// The draft's model is gone: fall back to the defaults the WebUI would open with.
			const defaults = await this.#sessionDefaults(user);
			if (!defaults.model) {
				await adapter.sendText(target, m.noDefaultModel);
				return undefined;
			}
			model = withThinkingLevel(defaults.model, defaults.thinkingLevel);
		}
		const availableExtensions = (await extensionsForUser(this.#options.db, user.userId)).map((row) => row.name);
		const disabledExtensions = draft.disabledExtensions.filter((name) => availableExtensions.includes(name));
		try {
			const session = await this.#options.runtime.createSession(user, {
				model,
				rulePreset: draft.rulePreset,
			});
			if (disabledExtensions.length > 0) {
				await this.#options.runtime.configure(session.id, { disabledExtensions });
			}
			const bound = await bindThread(this.#options.db, {
				channelId: row.id,
				platform: adapter.platform,
				chatId: thread.chat_id,
				topicId: thread.topic_id,
				sessionId: session.id,
			});
			await this.#announceSession(adapter, target, session.id, m);
			return bound;
		} catch (err) {
			await adapter.sendText(target, m.couldNotStartSession(errorText(err)));
			return undefined;
		}
	}

	/** The one notice every session a chat starts sends; `previous` says why the old thread was replaced. */
	async #announceSession(
		adapter: ChannelAdapter,
		target: ChannelTarget,
		sessionId: string,
		m: BotMessages,
		previous?: "archived" | "unavailable",
	): Promise<void> {
		const prefix =
			previous === "archived" ? m.previousArchived : previous === "unavailable" ? m.previousUnavailable : "";
		await adapter.sendText(target, `${prefix}${m.newSessionStarted(this.#sessionLink(sessionId))}`);
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
			const content = await adapter.downloadFile(file, { maxBytes: library.row.max_file_bytes });
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
		if (this.#unlinkedReplied.size > this.#unlinkedReplyLimit) {
			const oldest = this.#unlinkedReplied.values().next().value;
			if (oldest !== undefined) this.#unlinkedReplied.delete(oldest);
		}
		const m = messagesFor(localeFromLanguageCode(message.languageCode));
		await adapter.sendText({ chatId: message.chatId, topicId: message.topicId }, m.linkHelp);
	}

	async #link(
		adapter: ChannelAdapter,
		row: ChannelRow,
		message: import("./model.ts").InboundMessage,
		code: string,
	): Promise<void> {
		const target: ChannelTarget = { chatId: message.chatId, topicId: message.topicId };
		const platform = messagesFor(localeFromLanguageCode(message.languageCode));
		if (code.trim() === "") {
			await adapter.sendText(target, platform.linkMissingCode);
			return;
		}
		const userId = await consumeLinkCode(this.#options.db, code);
		if (!userId) {
			await adapter.sendText(target, platform.linkInvalidCode);
			return;
		}
		const userRow = await this.#options.db
			.selectFrom("users")
			.select(["id", "username", "kind", "status"])
			.where("id", "=", userId)
			.executeTakeFirst();
		if (!userRow || userRow.status !== "active") {
			await adapter.sendText(target, platform.accountNotActive);
			return;
		}
		const m = messagesFor(botLocale(await this.#userLocale(userId), message.languageCode));
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
			await adapter.sendText(target, created ? m.linked : m.alreadyLinked);
		} catch (err) {
			await adapter.sendText(target, errorText(err));
		}
	}

	async #unlinkFromChat(
		adapter: ChannelAdapter,
		account: ChannelAccountRow,
		user: SessionUser,
		target: ChannelTarget,
		m: BotMessages,
	): Promise<void> {
		await this.unlink(user, account.id);
		this.#unlinkedReplied.delete(`${account.channel_id}:${account.platform_user_id}`);
		await adapter.sendText(target, m.unlinked);
	}

	async #showSessions(
		adapter: ChannelAdapter,
		row: ChannelRow,
		message: import("./model.ts").InboundMessage,
		user: SessionUser,
		target: ChannelTarget,
		m: BotMessages,
		args: readonly string[] = [],
	): Promise<void> {
		const parsed = parseListArgs(args);
		if (parsed.kind === "invalid") {
			await adapter.sendText(target, m.invalidChoice("sessions"));
			return;
		}
		if (parsed.kind === "index") {
			const session = await this.#sessionAt(user, parsed.index);
			if (!session) {
				await adapter.sendText(target, m.invalidChoice("sessions"));
				return;
			}
			await this.#switchToSession(row, adapter, user, session.id, message.chatId, message.topicId, target, m);
			return;
		}
		const page = await this.#sessionPage(row, adapter, user, message.chatId, message.topicId, parsed.page, m);
		if (!page) {
			await adapter.sendText(target, m.noSessions);
			return;
		}
		await adapter.sendText(target, page.text, { buttons: page.buttons });
	}

	/** The n-th active root session of the user, in the same order `/sessions` lists them. */
	async #sessionAt(user: SessionUser, index: number): Promise<{ id: string; title: string | null } | undefined> {
		return this.#options.db
			.selectFrom("sessions")
			.select(["id", "title"])
			.where("owner_user_id", "=", user.userId)
			.where("parent_session_id", "is", null)
			.where("status", "=", "active")
			.orderBy("updated_at", "desc")
			.orderBy("id")
			.limit(1)
			.offset(index - 1)
			.executeTakeFirst();
	}

	/** One page of `/sessions`: the message text and its buttons, or undefined when the user has no sessions. */
	async #sessionPage(
		row: ChannelRow,
		adapter: ChannelAdapter,
		user: SessionUser,
		chatId: string,
		topicId: string | null,
		page: number,
		m: BotMessages,
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
				text: `${session.id === current?.session_id ? "✓ " : ""}${clip(session.title || m.newSessionTitle, 40)}`,
				data: `switch:${session.id}`,
			},
		]);
		const nav: import("./model.ts").ChannelButton[] = [];
		if (currentPage > 1) nav.push({ text: m.previousPage, data: `sessions:${currentPage - 1}` });
		if (currentPage < pages) nav.push({ text: m.nextPage, data: `sessions:${currentPage + 1}` });
		if (nav.length > 0) buttons.push(nav);
		const title = pages > 1 ? m.sessionsTitle(currentPage, pages) : m.sessionsTitleSingle;
		const lines = sessions.map((session, index) =>
			numberedItem(
				(currentPage - 1) * SESSION_PAGE_SIZE + index,
				clip(session.title || m.newSessionTitle, 40),
				session.id === current?.session_id,
			),
		);
		const text = `${title}\n\n${lines.join("\n")}\n\n${m.choiceHint("sessions", currentPage, pages)}`;
		return { text, buttons };
	}

	/** `/new` records a draft, like the WebUI's new-session page; the first message creates the session. */
	async #newSession(
		adapter: ChannelAdapter,
		row: ChannelRow,
		message: import("./model.ts").InboundMessage,
		user: SessionUser,
		target: ChannelTarget,
		locale: UserSettingsLocale,
	): Promise<void> {
		const m = messagesFor(locale);
		const defaults = await this.#sessionDefaults(user);
		if (!defaults.model) {
			await adapter.sendText(target, m.noDefaultModel);
			return;
		}
		const draft: ChannelDraft = {
			model: withThinkingLevel(defaults.model, defaults.thinkingLevel),
			rulePreset: defaults.rulePreset,
			disabledExtensions: [],
		};
		const previous = await channelThread(this.#options.db, row.id, adapter.platform, message.chatId, message.topicId);
		await saveDraftThread(this.#options.db, {
			channelId: row.id,
			platform: adapter.platform,
			chatId: message.chatId,
			topicId: message.topicId,
			draft,
		});
		if (previous?.session_id) await this.#releaseWatcherIfUnused(previous.session_id);
		await adapter.sendText(
			target,
			m.draftStarted(
				this.#modelName(draft.model),
				this.#thinkingLevelName(draft.model, draft.model.thinkingLevel ?? "off", m),
				this.#rulePresetName(draft.rulePreset),
			),
		);
	}

	// ---- chat management commands: the thread's session, or its draft ----

	/** The session or draft this chat's management commands act on. */
	async #chatTarget(
		adapter: ChannelAdapter,
		row: ChannelRow,
		user: SessionUser,
		chatId: string,
		topicId: string | null,
	): Promise<ChatTarget> {
		const thread = await channelThread(this.#options.db, row.id, adapter.platform, chatId, topicId);
		if (!thread) return { state: "none" };
		if (thread.session_id === null) {
			const draft = parseThreadDraft(thread.draft);
			return draft ? { state: "draft", thread, draft } : { state: "none" };
		}
		const session = await this.#options.runtime.getSession(thread.session_id);
		if (!session) return { state: "missing" };
		if (session.ownerUserId !== user.userId) return { state: "notYours" };
		return { state: "session", thread, session };
	}

	/** The reply a management command sends when the chat has no session or draft to act on. */
	async #replyNoTarget(
		adapter: ChannelAdapter,
		state: ChatTarget["state"],
		target: ChannelTarget,
		m: BotMessages,
	): Promise<void> {
		const text = state === "missing" ? m.noSessionInChat : state === "notYours" ? m.sessionNotYours : m.noSessionYet;
		await adapter.sendText(target, text);
	}

	#modelName(model: ModelRef): string {
		const offered = this.#options.models.available().find((candidate) => sameModel(candidate, model));
		return offered ? `${offered.name} (${offered.providerName})` : `${model.provider}/${model.modelId}`;
	}

	#thinkingLevelName(model: ModelRef, level: ThinkingLevel, m: BotMessages): string {
		const offered = this.#options.models.available().find((candidate) => sameModel(candidate, model));
		return offered?.thinkingLabels?.[level] ?? m.thinkingLevel(level);
	}

	#rulePresetName(rulePreset: RulePreset): string {
		return RULE_PRESET_CHOICES.find((choice) => choice.value === rulePreset)?.label ?? rulePreset;
	}

	/** One page of offered models with the current one marked; the page a press showed is digested in each button. */
	#modelPage(
		available: readonly AvailableModel[],
		current: ModelRef,
		page: number,
		m: BotMessages,
		tag: string,
	): {
		text: string;
		buttons: import("./model.ts").ChannelButton[][];
		models: readonly AvailableModel[];
		page: number;
	} {
		const pages = Math.max(1, Math.ceil(available.length / MODEL_PAGE_SIZE));
		const currentPage = Math.min(Math.max(page, 1), pages);
		const models = available.slice((currentPage - 1) * MODEL_PAGE_SIZE, currentPage * MODEL_PAGE_SIZE);
		const hash = modelListHash(available);
		const buttons: import("./model.ts").ChannelButton[][] = models.map((model, index) => [
			{
				text: `${sameModel(model, current) ? "✓ " : ""}${clip(`${model.name} (${model.providerName})`, 60)}`,
				data: `model:${currentPage}:${index}:${hash}:${tag}`,
			},
		]);
		const nav: import("./model.ts").ChannelButton[] = [];
		if (currentPage > 1) nav.push({ text: m.previousPage, data: `modelp:${currentPage - 1}:${hash}:${tag}` });
		if (currentPage < pages) nav.push({ text: m.nextPage, data: `modelp:${currentPage + 1}:${hash}:${tag}` });
		if (nav.length > 0) buttons.push(nav);
		const title = pages > 1 ? m.modelTitle(currentPage, pages) : m.modelTitleSingle;
		const lines = models.map((model, index) =>
			numberedItem(
				(currentPage - 1) * MODEL_PAGE_SIZE + index,
				`${model.name} (${model.providerName})`,
				sameModel(model, current),
			),
		);
		return {
			text: `${title}\n\n${lines.join("\n")}\n\n${m.choiceHint("model", currentPage, pages)}`,
			buttons,
			models,
			page: currentPage,
		};
	}

	/** Writes a model choice to the thread's draft and the user's defaults, or to the session. */
	async #applyModel(
		row: ChannelRow,
		adapter: ChannelAdapter,
		user: SessionUser,
		state: Extract<ChatTarget, { state: "draft" | "session" }>,
		ref: ModelRef,
		m: BotMessages,
		target: ChannelTarget,
	): Promise<boolean> {
		try {
			if (state.state === "draft") {
				await updateThreadDraft(this.#options.db, state.thread.id, { ...state.draft, model: ref });
				await this.#writeUserDefaults(user, { defaultModel: ref }, row, adapter, state.thread);
			} else {
				await this.#options.runtime.configure(state.session.id, { model: ref });
			}
		} catch (err) {
			await adapter.sendText(target, m.couldNotChange(errorText(err)));
			return false;
		}
		await this.#auditSettingsChange(user, row, adapter, state.thread, ref, {
			model: ref,
			...(state.state === "session" ? { draft: false } : { draft: true }),
		});
		return true;
	}

	async #modelCommand(
		row: ChannelRow,
		adapter: ChannelAdapter,
		user: SessionUser,
		target: ChannelTarget,
		m: BotMessages,
		args: readonly string[] = [],
	): Promise<void> {
		const state = await this.#chatTarget(adapter, row, user, target.chatId, target.topicId ?? null);
		if (state.state !== "draft" && state.state !== "session") {
			await this.#replyNoTarget(adapter, state.state, target, m);
			return;
		}
		const available = this.#options.models.available();
		if (available.length === 0) {
			await adapter.sendText(target, m.noDefaultModel);
			return;
		}
		const parsed = parseListArgs(args);
		if (parsed.kind === "invalid") {
			await adapter.sendText(target, m.invalidChoice("model"));
			return;
		}
		if (parsed.kind === "index") {
			const model = available[parsed.index - 1];
			if (!model) {
				await adapter.sendText(target, m.invalidChoice("model"));
				return;
			}
			const ref: ModelRef = { provider: model.provider, modelId: model.modelId };
			if (await this.#applyModel(row, adapter, user, state, ref, m, target)) {
				await adapter.sendText(target, m.modelSet(this.#modelName(ref)));
			}
			return;
		}
		const current = state.state === "draft" ? state.draft.model : state.session.model;
		const view = this.#modelPage(available, current, parsed.page, m, targetTag(state));
		await adapter.sendText(target, view.text, { buttons: view.buttons });
	}

	async #pressModel(
		row: ChannelRow,
		press: import("./model.ts").ButtonPress,
		user: SessionUser,
		adapter: ChannelAdapter,
		target: ChannelTarget,
		data: string,
		m: BotMessages,
	): Promise<void> {
		const [, rawPage, rawIndex, hash, tag] = data.split(":");
		const page = Number.parseInt(rawPage ?? "", 10);
		const index = Number.parseInt(rawIndex ?? "", 10);
		const state = await this.#chatTarget(adapter, row, user, press.chatId, press.topicId);
		if (state.state !== "draft" && state.state !== "session") {
			await this.#replyNoTarget(adapter, state.state, target, m);
			return;
		}
		const available = this.#options.models.available();
		const current = state.state === "draft" ? state.draft.model : state.session.model;
		const currentTag = targetTag(state);
		const view = this.#modelPage(available, current, Number.isSafeInteger(page) ? page : 1, m, currentTag);
		// The target switched or the offered list changed since the press: show the list as it is now instead
		// of acting on an index that belonged to another session or another list.
		if (tag !== currentTag || hash !== modelListHash(available) || !Number.isSafeInteger(index)) {
			await this.#editPage(adapter, target, press.messageId, view.text, view.buttons);
			return;
		}
		const model = view.models[index];
		if (!model) {
			await this.#editPage(adapter, target, press.messageId, view.text, view.buttons);
			return;
		}
		const ref: ModelRef = { provider: model.provider, modelId: model.modelId };
		if (!(await this.#applyModel(row, adapter, user, state, ref, m, target))) return;
		await this.#editPage(adapter, target, press.messageId, m.modelSet(this.#modelName(ref)));
	}

	async #pressModelPage(
		row: ChannelRow,
		press: import("./model.ts").ButtonPress,
		user: SessionUser,
		adapter: ChannelAdapter,
		target: ChannelTarget,
		data: string,
		m: BotMessages,
	): Promise<void> {
		const [, rawPage] = data.split(":");
		const page = Number.parseInt(rawPage ?? "", 10);
		const state = await this.#chatTarget(adapter, row, user, press.chatId, press.topicId);
		if (state.state !== "draft" && state.state !== "session") {
			await this.#replyNoTarget(adapter, state.state, target, m);
			return;
		}
		const current = state.state === "draft" ? state.draft.model : state.session.model;
		const view = this.#modelPage(
			this.#options.models.available(),
			current,
			Number.isSafeInteger(page) ? page : 1,
			m,
			targetTag(state),
		);
		await this.#editPage(adapter, target, press.messageId, view.text, view.buttons);
	}

	async #thinkCommand(
		row: ChannelRow,
		adapter: ChannelAdapter,
		user: SessionUser,
		target: ChannelTarget,
		m: BotMessages,
		args: readonly string[] = [],
	): Promise<void> {
		const state = await this.#chatTarget(adapter, row, user, target.chatId, target.topicId ?? null);
		if (state.state !== "draft" && state.state !== "session") {
			await this.#replyNoTarget(adapter, state.state, target, m);
			return;
		}
		const model = state.state === "draft" ? state.draft.model : state.session.model;
		const offered = this.#options.models.available().find((candidate) => sameModel(candidate, model));
		const levels = offered?.thinkingLevels ?? ["off"];
		const raw = args[0]?.toLowerCase();
		if (raw !== undefined) {
			const level = levels.find((candidate) => candidate.toLowerCase() === raw);
			if (level === undefined) {
				await adapter.sendText(target, m.invalidChoice("think"));
				return;
			}
			if (await this.#applyThinking(row, adapter, user, state, level, m, target)) {
				await adapter.sendText(target, m.thinkingSet(offered?.thinkingLabels?.[level] ?? m.thinkingLevel(level)));
			}
			return;
		}
		if (levels.length <= 1) {
			await adapter.sendText(target, m.thinkingNone(this.#modelName(model)));
			return;
		}
		const view = this.#thinkingPage(model, offered, levels, m, targetTag(state));
		await adapter.sendText(target, view.text, { buttons: view.buttons });
	}

	#thinkingPage(
		model: ModelRef,
		offered: AvailableModel | undefined,
		levels: readonly ThinkingLevel[],
		m: BotMessages,
		tag: string,
	): { text: string; buttons: import("./model.ts").ChannelButton[][] } {
		const current = model.thinkingLevel ?? "off";
		const hash = modelRefHash(model);
		const buttons: import("./model.ts").ChannelButton[][] = levels.map((level) => [
			{
				text: `${level === current ? "✓ " : ""}${offered?.thinkingLabels?.[level] ?? m.thinkingLevel(level)}`,
				data: `think:${level}:${hash}:${tag}`,
			},
		]);
		const lines = levels.map((level) => {
			const label = offered?.thinkingLabels?.[level] ?? m.thinkingLevel(level);
			return `- ${level === current ? "✓ " : ""}${escapeMarkdown(label)} (${level})`;
		});
		const text = `${m.thinkingTitle(this.#modelName(model))}\n\n${lines.join("\n")}\n\n${m.thinkingHint}`;
		return { text, buttons };
	}

	/** Writes a thinking level to the thread's draft and the user's defaults, or to the session. */
	async #applyThinking(
		row: ChannelRow,
		adapter: ChannelAdapter,
		user: SessionUser,
		state: Extract<ChatTarget, { state: "draft" | "session" }>,
		level: ThinkingLevel,
		m: BotMessages,
		target: ChannelTarget,
	): Promise<boolean> {
		const model = state.state === "draft" ? state.draft.model : state.session.model;
		const next = withThinkingLevel(model, level);
		try {
			if (state.state === "draft") {
				await updateThreadDraft(this.#options.db, state.thread.id, { ...state.draft, model: next });
				await this.#writeUserDefaults(user, { defaultModel: next }, row, adapter, state.thread);
			} else {
				await this.#options.runtime.configure(state.session.id, {
					model: { provider: model.provider, modelId: model.modelId, thinkingLevel: level },
				});
			}
		} catch (err) {
			await adapter.sendText(target, m.couldNotChange(errorText(err)));
			return false;
		}
		await this.#auditSettingsChange(user, row, adapter, state.thread, next, {
			thinking_level: level,
			draft: state.state === "draft",
		});
		return true;
	}

	async #pressThink(
		row: ChannelRow,
		press: import("./model.ts").ButtonPress,
		user: SessionUser,
		adapter: ChannelAdapter,
		target: ChannelTarget,
		data: string,
		m: BotMessages,
	): Promise<void> {
		const [, rawLevel, hash, tag] = data.split(":");
		const state = await this.#chatTarget(adapter, row, user, press.chatId, press.topicId);
		if (state.state !== "draft" && state.state !== "session") {
			await this.#replyNoTarget(adapter, state.state, target, m);
			return;
		}
		const model = state.state === "draft" ? state.draft.model : state.session.model;
		const offered = this.#options.models.available().find((candidate) => sameModel(candidate, model));
		const levels = offered?.thinkingLevels ?? ["off"];
		const level = levels.find((candidate) => candidate === rawLevel);
		const currentTag = targetTag(state);
		if (tag !== currentTag || hash !== modelRefHash(model) || level === undefined) {
			// The target or model changed, or the level is no longer offered: show the current levels.
			const view =
				levels.length <= 1
					? { text: m.thinkingNone(this.#modelName(model)), buttons: [] }
					: this.#thinkingPage(model, offered, levels, m, currentTag);
			await this.#editPage(adapter, target, press.messageId, view.text, view.buttons);
			return;
		}
		if (!(await this.#applyThinking(row, adapter, user, state, level, m, target))) return;
		await this.#editPage(
			adapter,
			target,
			press.messageId,
			m.thinkingSet(offered?.thinkingLabels?.[level] ?? m.thinkingLevel(level)),
		);
	}

	async #rulesCommand(
		row: ChannelRow,
		adapter: ChannelAdapter,
		user: SessionUser,
		target: ChannelTarget,
		m: BotMessages,
		args: readonly string[] = [],
	): Promise<void> {
		const state = await this.#chatTarget(adapter, row, user, target.chatId, target.topicId ?? null);
		if (state.state !== "draft" && state.state !== "session") {
			await this.#replyNoTarget(adapter, state.state, target, m);
			return;
		}
		const raw = args[0]?.toLowerCase();
		if (raw !== undefined) {
			const choice = RULE_PRESET_CHOICES.find((candidate) => candidate.value === raw);
			if (!choice) {
				await adapter.sendText(target, m.invalidChoice("rules"));
				return;
			}
			if (await this.#applyRules(row, adapter, user, state, choice.value, m, target)) {
				await adapter.sendText(target, m.rulesSet(choice.label));
			}
			return;
		}
		const current = state.state === "draft" ? state.draft.rulePreset : (state.session.rules?.rulePreset ?? "ask");
		const view = this.#rulesPage(current, m, targetTag(state));
		await adapter.sendText(target, view.text, { buttons: view.buttons });
	}

	#rulesPage(
		current: RulePreset,
		m: BotMessages,
		tag: string,
	): { text: string; buttons: import("./model.ts").ChannelButton[][] } {
		const buttons = RULE_PRESET_CHOICES.map((choice) => [
			{ text: `${choice.value === current ? "✓ " : ""}${choice.label}`, data: `rules:${choice.value}:${tag}` },
		]);
		const lines = RULE_PRESET_CHOICES.map(
			(choice) => `- ${choice.value === current ? "✓ " : ""}${escapeMarkdown(choice.label)} (${choice.value})`,
		);
		return { text: `${m.rulesTitle}\n\n${lines.join("\n")}\n\n${m.rulesHint}`, buttons };
	}

	/** Writes a rule preset to the thread's draft and the user's defaults, or to the session. */
	async #applyRules(
		row: ChannelRow,
		adapter: ChannelAdapter,
		user: SessionUser,
		state: Extract<ChatTarget, { state: "draft" | "session" }>,
		value: RulePreset,
		m: BotMessages,
		target: ChannelTarget,
	): Promise<boolean> {
		try {
			if (state.state === "draft") {
				await updateThreadDraft(this.#options.db, state.thread.id, {
					...state.draft,
					rulePreset: value,
				});
				await this.#writeUserDefaults(user, { defaultRulePreset: value }, row, adapter, state.thread);
			} else {
				await this.#options.runtime.configure(state.session.id, { rulePreset: value });
				void this.#options.audit.record({
					actor: userActor(user),
					action: "rules.changed",
					target: { type: "session", id: state.session.id },
					detail: {
						rule_preset: value,
						channel: row.name,
						via: adapter.platform,
						thread_id: state.thread.id,
					},
				});
				// Waiting work may not need approval any more (doc/design/access-control.md "Approvals").
				await this.#reevaluateRules(state.session.id);
			}
		} catch (err) {
			await adapter.sendText(target, m.couldNotChange(errorText(err)));
			return false;
		}
		await this.#auditSettingsChange(user, row, adapter, state.thread, value, {
			rule_preset: value,
			draft: state.state === "draft",
		});
		return true;
	}

	async #pressRules(
		row: ChannelRow,
		press: import("./model.ts").ButtonPress,
		user: SessionUser,
		adapter: ChannelAdapter,
		target: ChannelTarget,
		data: string,
		m: BotMessages,
	): Promise<void> {
		const [, value, tag] = data.split(":");
		const state = await this.#chatTarget(adapter, row, user, press.chatId, press.topicId);
		if (state.state !== "draft" && state.state !== "session") {
			await this.#replyNoTarget(adapter, state.state, target, m);
			return;
		}
		const current = state.state === "draft" ? state.draft.rulePreset : (state.session.rules?.rulePreset ?? "ask");
		const currentTag = targetTag(state);
		const choice = RULE_PRESET_CHOICES.find((candidate) => candidate.value === value);
		if (tag !== currentTag || !choice) {
			// The chat now acts on another session, or the preset is unknown: show the current target's list.
			const view = this.#rulesPage(current, m, currentTag);
			await this.#editPage(adapter, target, press.messageId, view.text, view.buttons);
			return;
		}
		if (!(await this.#applyRules(row, adapter, user, state, choice.value, m, target))) return;
		await this.#editPage(adapter, target, press.messageId, m.rulesSet(choice.label));
	}

	async #extensionsCommand(
		row: ChannelRow,
		adapter: ChannelAdapter,
		user: SessionUser,
		target: ChannelTarget,
		m: BotMessages,
		args: readonly string[] = [],
	): Promise<void> {
		const state = await this.#chatTarget(adapter, row, user, target.chatId, target.topicId ?? null);
		if (state.state !== "draft" && state.state !== "session") {
			await this.#replyNoTarget(adapter, state.state, target, m);
			return;
		}
		const names = await this.#extensionNames(user);
		if (names.length === 0) {
			await adapter.sendText(target, m.noExtensions);
			return;
		}
		const parsed = parseListArgs(args);
		if (parsed.kind === "invalid") {
			await adapter.sendText(target, m.invalidChoice("extensions"));
			return;
		}
		const disabled = await this.#disabledExtensions(state);
		if (parsed.kind === "index") {
			const name = names[parsed.index - 1];
			if (!name) {
				await adapter.sendText(target, m.invalidChoice("extensions"));
				return;
			}
			const enabled = await this.#toggleExtension(row, adapter, user, state, name, disabled, m, target);
			if (enabled !== undefined) await adapter.sendText(target, m.extensionSet(name, enabled));
			return;
		}
		const view = this.#extensionPage(names, disabled, parsed.page, m, targetTag(state));
		await adapter.sendText(target, view.text, { buttons: view.buttons });
	}

	/** Toggles one extension; undefined when the write failed (the user was told). */
	async #toggleExtension(
		row: ChannelRow,
		adapter: ChannelAdapter,
		user: SessionUser,
		state: Extract<ChatTarget, { state: "draft" | "session" }>,
		name: string,
		disabled: readonly string[],
		m: BotMessages,
		target: ChannelTarget,
	): Promise<boolean | undefined> {
		const nextDisabled = disabled.includes(name) ? disabled.filter((entry) => entry !== name) : [...disabled, name];
		try {
			if (state.state === "draft") {
				await updateThreadDraft(this.#options.db, state.thread.id, {
					...state.draft,
					disabledExtensions: nextDisabled,
				});
			} else {
				await this.#options.runtime.configure(state.session.id, { disabledExtensions: nextDisabled });
			}
		} catch (err) {
			await adapter.sendText(target, m.couldNotChange(errorText(err)));
			return undefined;
		}
		const enabled = !nextDisabled.includes(name);
		await this.#auditSettingsChange(user, row, adapter, state.thread, name, {
			extension: name,
			enabled,
			draft: state.state === "draft",
		});
		return enabled;
	}

	async #extensionNames(user: SessionUser): Promise<string[]> {
		return (await extensionsForUser(this.#options.db, user.userId)).map((row) => row.name);
	}

	async #disabledExtensions(state: Extract<ChatTarget, { state: "draft" | "session" }>): Promise<string[]> {
		if (state.state === "draft") return state.draft.disabledExtensions;
		const row = await this.#options.db
			.selectFrom("sessions")
			.select("disabled_extensions")
			.where("id", "=", state.session.id)
			.executeTakeFirst();
		return parseDisabledExtensionNames(row?.disabled_extensions ?? null);
	}

	#extensionPage(
		names: readonly string[],
		disabled: readonly string[],
		page: number,
		m: BotMessages,
		tag: string,
	): { text: string; buttons: import("./model.ts").ChannelButton[][]; names: readonly string[]; page: number } {
		const pages = Math.max(1, Math.ceil(names.length / EXTENSION_PAGE_SIZE));
		const currentPage = Math.min(Math.max(page, 1), pages);
		const pageNames = names.slice((currentPage - 1) * EXTENSION_PAGE_SIZE, currentPage * EXTENSION_PAGE_SIZE);
		const hash = listHash([...names, "|", ...[...disabled].sort()]);
		const buttons: import("./model.ts").ChannelButton[][] = pageNames.map((name, index) => [
			{
				text: `${disabled.includes(name) ? "" : "✓ "}${clip(name, 60)}`,
				data: `ext:${currentPage}:${index}:${hash}:${tag}`,
			},
		]);
		const nav: import("./model.ts").ChannelButton[] = [];
		if (currentPage > 1) nav.push({ text: m.previousPage, data: `extp:${currentPage - 1}:${hash}:${tag}` });
		if (currentPage < pages) nav.push({ text: m.nextPage, data: `extp:${currentPage + 1}:${hash}:${tag}` });
		if (nav.length > 0) buttons.push(nav);
		const title = pages > 1 ? m.extensionsTitle(currentPage, pages) : m.extensionsTitleSingle;
		const lines = pageNames.map((name, index) =>
			numberedItem((currentPage - 1) * EXTENSION_PAGE_SIZE + index, clip(name, 60), !disabled.includes(name)),
		);
		return {
			text: `${title}\n\n${lines.join("\n")}\n\n${m.choiceHint("extensions", currentPage, pages)}`,
			buttons,
			names: pageNames,
			page: currentPage,
		};
	}

	async #pressExtension(
		row: ChannelRow,
		press: import("./model.ts").ButtonPress,
		user: SessionUser,
		adapter: ChannelAdapter,
		target: ChannelTarget,
		data: string,
		m: BotMessages,
	): Promise<void> {
		const [, rawPage, rawIndex, hash, tag] = data.split(":");
		const page = Number.parseInt(rawPage ?? "", 10);
		const index = Number.parseInt(rawIndex ?? "", 10);
		const state = await this.#chatTarget(adapter, row, user, press.chatId, press.topicId);
		if (state.state !== "draft" && state.state !== "session") {
			await this.#replyNoTarget(adapter, state.state, target, m);
			return;
		}
		const names = await this.#extensionNames(user);
		const disabled = await this.#disabledExtensions(state);
		const currentTag = targetTag(state);
		const view = this.#extensionPage(names, disabled, Number.isSafeInteger(page) ? page : 1, m, currentTag);
		const hashNow = listHash([...names, "|", ...[...disabled].sort()]);
		if (tag !== currentTag || hash !== hashNow || !Number.isSafeInteger(index)) {
			await this.#editPage(adapter, target, press.messageId, view.text, view.buttons);
			return;
		}
		const name = view.names[index];
		if (!name) {
			await this.#editPage(adapter, target, press.messageId, view.text, view.buttons);
			return;
		}
		const enabled = await this.#toggleExtension(row, adapter, user, state, name, disabled, m, target);
		if (enabled === undefined) return;
		const nextDisabled = enabled ? disabled.filter((entry) => entry !== name) : [...disabled, name];
		const after = this.#extensionPage(names, nextDisabled, view.page, m, currentTag);
		await this.#editPage(adapter, target, press.messageId, after.text, after.buttons);
	}

	async #pressExtensionPage(
		row: ChannelRow,
		press: import("./model.ts").ButtonPress,
		user: SessionUser,
		adapter: ChannelAdapter,
		target: ChannelTarget,
		data: string,
		m: BotMessages,
	): Promise<void> {
		const [, rawPage] = data.split(":");
		const page = Number.parseInt(rawPage ?? "", 10);
		const state = await this.#chatTarget(adapter, row, user, press.chatId, press.topicId);
		if (state.state !== "draft" && state.state !== "session") {
			await this.#replyNoTarget(adapter, state.state, target, m);
			return;
		}
		const names = await this.#extensionNames(user);
		const disabled = await this.#disabledExtensions(state);
		const view = this.#extensionPage(names, disabled, Number.isSafeInteger(page) ? page : 1, m, targetTag(state));
		await this.#editPage(adapter, target, press.messageId, view.text, view.buttons);
	}

	async #editPage(
		adapter: ChannelAdapter,
		target: ChannelTarget,
		messageId: string,
		text: string,
		buttons?: readonly (readonly import("./model.ts").ChannelButton[])[],
	): Promise<void> {
		try {
			await adapter.editText(target, messageId, text, buttons ? { buttons } : {});
		} catch (err) {
			console.error("channels: editing a settings message failed:", err);
		}
	}

	/** Writes a draft's change to the user's defaults, like the WebUI new-session page, and audits it. */
	async #writeUserDefaults(
		user: SessionUser,
		change: UserSettingsUpdate,
		row: ChannelRow,
		adapter: ChannelAdapter,
		thread: ChannelThreadRow,
	): Promise<void> {
		const before = await getUserSettings(this.#options.db, user.userId);
		const after = await patchUserSettings(this.#options.db, user.userId, change);
		const keys = Object.keys(change) as (keyof UserSettings)[];
		const changed = keys.filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
		if (changed.length === 0) return;
		const oldValues: Record<string, unknown> = {};
		const newValues: Record<string, unknown> = {};
		for (const key of changed) {
			oldValues[key] = before[key];
			newValues[key] = after[key];
		}
		void this.#options.audit.record({
			actor: userActor(user),
			action: "user_settings.changed",
			target: { type: "user", id: user.userId },
			detail: {
				changed,
				old: oldValues,
				new: newValues,
				channel: row.name,
				via: adapter.platform,
				thread_id: thread.id,
				draft: true,
			},
		});
	}

	/** Records a settings change made from chat, with the channel like the other chat decisions. */
	async #auditSettingsChange(
		user: SessionUser,
		row: ChannelRow,
		adapter: ChannelAdapter,
		thread: ChannelThreadRow,
		target: unknown,
		detail: Record<string, unknown>,
	): Promise<void> {
		void this.#options.audit.record({
			actor: userActor(user),
			action: "channel.settings_changed",
			target:
				thread.session_id === null
					? { type: "channel_thread", id: thread.id }
					: { type: "session", id: thread.session_id },
			detail: { channel: row.name, via: adapter.platform, thread_id: thread.id, target, ...detail },
		});
	}

	/** A rule change may settle what was waiting for approval (doc/design/access-control.md "Approvals"). */
	async #reevaluateRules(sessionId: string): Promise<void> {
		const ref = { type: "session" as const, id: sessionId };
		await this.#options.cluster.reevaluate(ref);
		await this.#options.taskGroups.reevaluate(ref);
		await reevaluateExternalCalls(this.#options.db, ref);
	}

	async #stopCommand(
		adapter: ChannelAdapter,
		row: ChannelRow,
		message: import("./model.ts").InboundMessage,
		user: SessionUser,
		target: ChannelTarget,
		m: BotMessages,
	): Promise<void> {
		const thread = await channelThread(this.#options.db, row.id, adapter.platform, message.chatId, message.topicId);
		if (
			!thread ||
			thread.session_id === null ||
			(await sessionOwner(this.#options.db, thread.session_id)) !== user.userId
		) {
			await adapter.sendText(target, m.noRunningSession);
			return;
		}
		try {
			await this.#options.runtime.abort(thread.session_id, user);
			await adapter.sendText(target, m.stopped);
		} catch (err) {
			await adapter.sendText(target, m.couldNotStop(errorText(err)));
		}
	}

	async #quotaCommand(
		adapter: ChannelAdapter,
		row: ChannelRow,
		message: import("./model.ts").InboundMessage,
		user: SessionUser,
		target: ChannelTarget,
		args: readonly string[],
		m: BotMessages,
	): Promise<void> {
		const thread = await channelThread(this.#options.db, row.id, adapter.platform, message.chatId, message.topicId);
		if (!thread) {
			await adapter.sendText(target, m.noSessionInChat);
			return;
		}
		if (thread.session_id === null) {
			// A draft has no session and so nothing that could run or wait.
			await adapter.sendText(target, m.noRunningSession);
			return;
		}
		if ((await sessionOwner(this.#options.db, thread.session_id)) !== user.userId) {
			await adapter.sendText(target, m.noSessionInChat);
			return;
		}
		const rootId = (await rootSessionIdOf(this.#options.db, thread.session_id)) ?? thread.session_id;
		const root = await this.#options.db
			.selectFrom("sessions")
			.select(["id", "title", "quota_tokens", "budget_used_tokens", "state", "waiting_kind"])
			.where("id", "=", rootId)
			.executeTakeFirst();
		if (!root) {
			await adapter.sendText(target, m.noSessionInChat);
			return;
		}
		const sub = args[0]?.toLowerCase();
		if (sub === "add") {
			const tokens = Number(args[1]);
			if (!Number.isSafeInteger(tokens) || tokens <= 0) {
				await adapter.sendText(target, m.quotaAddUsage);
				return;
			}
			try {
				await this.#options.runtime.decideRootQuota(rootId, "approve", tokens);
				await this.#auditChannelApproval(user, "quota", rootId, "approved", row.name, adapter.platform, thread.id);
				await adapter.sendText(target, m.quotaAdded(tokens));
			} catch (err) {
				await adapter.sendText(target, errorText(err));
			}
			return;
		}
		if (sub === "stop") {
			try {
				await this.#options.runtime.decideRootQuota(rootId, "deny");
				await this.#auditChannelApproval(user, "quota", rootId, "rejected", row.name, adapter.platform, thread.id);
				await adapter.sendText(target, m.quotaEnded);
			} catch (err) {
				await adapter.sendText(target, errorText(err));
			}
			return;
		}
		if (root.quota_tokens === null) {
			await adapter.sendText(target, m.noQuota);
			return;
		}
		const remaining = Number(root.quota_tokens);
		const used = Number(root.budget_used_tokens);
		await adapter.sendText(target, remaining <= 0 ? m.quotaUsedUp(remaining, used) : m.quotaRemaining(remaining, used));
	}

	async #decideFromCommand(
		adapter: ChannelAdapter,
		row: ChannelRow,
		message: import("./model.ts").InboundMessage,
		user: SessionUser,
		target: ChannelTarget,
		command: { name: string; args: string[] },
		m: BotMessages,
	): Promise<void> {
		const id = command.args[0];
		if (!id) {
			await adapter.sendText(target, m.decideUsage(command.name, command.name === "reject"));
			return;
		}
		const decision = command.name === "approve" ? "approved" : "rejected";
		const reason = command.name === "reject" ? command.args.slice(1).join(" ").trim().slice(0, 1000) : "";
		const thread = await channelThread(this.#options.db, row.id, adapter.platform, message.chatId, message.topicId);
		const result = await this.#decideApproval(user, id, decision, reason || undefined);
		if (!result) {
			await adapter.sendText(target, m.noWaitingApproval);
			return;
		}
		await this.#auditChannelApproval(user, result.kind, id, decision, row.name, adapter.platform, thread?.id);
		await this.#editDecided(result.key, decision, user.username, reason || undefined);
		await adapter.sendText(target, decision === "approved" ? m.approved : m.rejected);
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

	async #editDecided(
		key: string,
		decision: "approved" | "rejected",
		by: string,
		reason: string | undefined,
	): Promise<void> {
		const tracked = this.#tracked.get(key);
		if (!tracked) return;
		this.#tracked.delete(key);
		const entry = this.#adapters.get(tracked.adapterName);
		if (!entry) return;
		const m = messagesFor(tracked.locale);
		const ending = decision === "approved" ? m.approvedBy(by) : m.rejectedBy(by, reason ?? null);
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
		if (!user || !account) {
			await adapter.sendText(target, messagesFor(localeFromLanguageCode(press.languageCode)).linkHelp);
			return;
		}
		const m = messagesFor(await this.#localeForAccount(account, press.languageCode));
		if (press.data.startsWith("switch:")) {
			const sessionId = press.data.slice("switch:".length);
			await this.#switchSession(row, press, user, sessionId, adapter, target, m);
			return;
		}
		if (press.data.startsWith("sessions:")) {
			const page = Number.parseInt(press.data.slice("sessions:".length), 10);
			await this.#editSessionPage(row, adapter, press, user, target, Number.isSafeInteger(page) ? page : 1, m);
			return;
		}
		if (press.data.startsWith("model:")) {
			await this.#pressModel(row, press, user, adapter, target, press.data, m);
			return;
		}
		if (press.data.startsWith("modelp:")) {
			await this.#pressModelPage(row, press, user, adapter, target, press.data, m);
			return;
		}
		if (press.data.startsWith("think:")) {
			await this.#pressThink(row, press, user, adapter, target, press.data, m);
			return;
		}
		if (press.data.startsWith("rules:")) {
			await this.#pressRules(row, press, user, adapter, target, press.data, m);
			return;
		}
		if (press.data.startsWith("ext:")) {
			await this.#pressExtension(row, press, user, adapter, target, press.data, m);
			return;
		}
		if (press.data.startsWith("extp:")) {
			await this.#pressExtensionPage(row, press, user, adapter, target, press.data, m);
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
				await adapter.sendText(target, m.approvalNoLongerWaiting);
				return;
			}
			await this.#auditChannelApproval(user, result.kind, id, decision, row.name, adapter.platform, thread?.id);
			await this.#editDecided(result.key, decision, user.username, undefined);
			try {
				await adapter.editText(target, press.messageId, decision === "approved" ? m.approved : m.rejected);
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
		m: BotMessages,
	): Promise<void> {
		await this.#switchToSession(row, adapter, user, sessionId, press.chatId, press.topicId, target, m);
	}

	/**
	 * Binds a chat to one of the user's sessions and replays its recent history. The reply names the session, so a
	 * list that changed between showing and choosing is noticed.
	 */
	async #switchToSession(
		row: ChannelRow,
		adapter: ChannelAdapter,
		user: SessionUser,
		sessionId: string,
		chatId: string,
		topicId: string | null,
		target: ChannelTarget,
		m: BotMessages,
	): Promise<void> {
		const session = await this.#options.runtime.getSession(sessionId);
		if (!session || session.ownerUserId !== user.userId || session.parentSessionId !== null) {
			await adapter.sendText(target, m.sessionNotYours);
			return;
		}
		const previous = await channelThread(this.#options.db, row.id, adapter.platform, chatId, topicId);
		await bindThread(this.#options.db, {
			channelId: row.id,
			platform: adapter.platform,
			chatId,
			topicId,
			sessionId: session.id,
		});
		await this.#ensureWatcher(session.id);
		if (previous?.session_id && previous.session_id !== session.id) {
			await this.#releaseWatcherIfUnused(previous.session_id);
		}
		await adapter.sendText(target, m.sessionSwitched(session.title || m.newSessionTitle));
		await this.#replayHistory(adapter, target, session.id, m);
	}

	/** A page press edits the list message it came from rather than sending another one. */
	async #editSessionPage(
		row: ChannelRow,
		adapter: ChannelAdapter,
		press: import("./model.ts").ButtonPress,
		user: SessionUser,
		target: ChannelTarget,
		page: number,
		m: BotMessages,
	): Promise<void> {
		const view = await this.#sessionPage(row, adapter, user, press.chatId, press.topicId, page, m);
		try {
			if (!view) await adapter.editText(target, press.messageId, m.noSessions);
			else await adapter.editText(target, press.messageId, view.text, { buttons: view.buttons });
		} catch (err) {
			console.error("channels: editing the session list failed:", err);
		}
	}

	async #replayHistory(
		adapter: ChannelAdapter,
		target: ChannelTarget,
		sessionId: string,
		m: BotMessages,
	): Promise<void> {
		let messages: Awaited<ReturnType<AgentRuntime["chatHistory"]>>;
		try {
			messages = await this.#options.runtime.chatHistory(sessionId, this.#historyLimit);
		} catch (err) {
			await adapter.sendText(target, m.couldNotReadHistory(errorText(err)));
			return;
		}
		const link = this.#sessionLink(sessionId);
		for (const message of messages) {
			const label = message.role === "user" ? m.historyUser : m.historyAssistant;
			const text = clip(message.text);
			const cut = text.length < message.text.replace(/\s+/g, " ").trim().length;
			const body = `${label}: ${text}${cut && link ? `\n\n${link}` : ""}`;
			try {
				await adapter.sendText(target, body, { disablePreview: true });
			} catch (err) {
				console.error("channels: replaying a history message failed:", err);
				return;
			}
		}
	}

	// ---- outbound and notifications ----

	#queueSessionEvents(sessionId: string, events: import("../agent/runtime.ts").SessionEvent[]): void {
		void this.#eventQueue
			.run(sessionId, () => this.#onSessionEvents(sessionId, events))
			.catch((err: unknown) => {
				console.error("channels: handling session events failed:", err);
			});
	}

	/** Resolves once the session's queued event batches are handled (tests). */
	async sessionEventsSettled(sessionId: string): Promise<void> {
		await this.#eventQueue.tail(sessionId);
	}

	async #ensureWatcher(sessionId: string): Promise<void> {
		if (this.#watchers.has(sessionId) || this.#stopped) return;
		const starting = this.#watchStarts.current(sessionId);
		if (starting) return starting;
		return this.#watchStarts.run(sessionId, async () => {
			try {
				// The runtime awaits this callback: returning its promise keeps one session's batches in order.
				// Batches of one session are handled in order through the manager's own queue, and the callback
				// returns at once: a slow send must not hold up the watch, which past 100 pending batches replaces
				// them with one snapshot event that carries no run_end or message_end.
				const stop = await this.#options.runtime.watch(sessionId, (events) => {
					this.#queueSessionEvents(sessionId, events);
				});
				if (this.#stopped) {
					stop();
					return;
				}
				this.#watchers.set(sessionId, stop);
			} catch (err) {
				if (!this.#options.runtime.closing) console.error("channels: watching a session failed:", err);
			}
		});
	}

	/**
	 * Drops a session's event watch once nothing needs it any more: no chat thread points at the session and the
	 * manager holds no run or draft for it. Watches are otherwise kept for the life of the process.
	 */
	async #releaseWatcherIfUnused(sessionId: string): Promise<void> {
		if (this.#runs.has(sessionId) || this.#drafts.has(sessionId) || !this.#watchers.has(sessionId)) return;
		const starting = this.#watchStarts.current(sessionId);
		if (starting) await starting;
		if (!this.#watchers.has(sessionId) || this.#runs.has(sessionId) || this.#drafts.has(sessionId)) return;
		if ((await threadsForSession(this.#options.db, sessionId)).length > 0) return;
		const stop = this.#watchers.get(sessionId);
		if (!stop) return;
		this.#watchers.delete(sessionId);
		try {
			stop();
		} catch {}
	}

	/** Releases every watch whose session no thread references any more, after a channel's threads went away. */
	async #releaseUnusedWatchers(): Promise<void> {
		for (const sessionId of [...this.#watchers.keys()]) await this.#releaseWatcherIfUnused(sessionId);
	}

	/** Sends the assistant's text pieces and delivered-file links where the session's notifications go. */
	async #onSessionEvents(sessionId: string, events: import("../agent/runtime.ts").SessionEvent[]): Promise<void> {
		for (const event of events) {
			// One bad event must not skip the rest of the batch, above all its run_end cleanup.
			try {
				if (event.type === "run_start") {
					this.#runs.set(sessionId, { deliveries: [], seen: new Set() });
					await this.#showProgress(sessionId, (m) => m.working);
					continue;
				}
				if (event.type === "run_end") {
					const run = this.#runs.get(sessionId);
					this.#runs.delete(sessionId);
					this.#dropDraft(sessionId);
					await this.#clearProgress(sessionId);
					if (run) await this.#sendDeliveries(sessionId, run);
					// A chat that switched away while the run ran keeps its watch only until the run ends.
					await this.#releaseWatcherIfUnused(sessionId);
					continue;
				}
				if (event.type === "message_start" && event.message.role === "assistant") {
					await this.#showProgress(sessionId, (m) => m.thinking);
					continue;
				}
				if (event.type === "tool_execution_start") {
					await this.#showProgress(sessionId, (m) => m.running(event.toolName));
					continue;
				}
				if (event.type === "auto_retry_start") {
					await this.#showProgress(sessionId, (m) => m.retrying(event.attempt));
					continue;
				}
				if (event.type === "message_end") {
					await this.#onMessageEnd(sessionId, event.entry);
					continue;
				}
				if (event.type === "tool_execution_end" && event.entry) {
					this.#collectDelivery(sessionId, event.entry);
				}
			} catch (err) {
				console.error(`channels: handling a ${event.type} event failed:`, err);
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
			const m = await this.#messagesForSession(sessionId);
			await this.#sendFinal(sessionId, m.turnFailed(message.errorMessage));
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
		const m = await this.#messagesForSession(sessionId);
		for (const delivery of run.deliveries) {
			await this.#send(sessionId, m.fileOffered(delivery.name, delivery.source));
		}
	}

	async #send(
		sessionId: string,
		text: string,
		options: { buttons?: readonly (readonly import("./model.ts").ChannelButton[])[] } = {},
	): Promise<void> {
		const route = await this.#routeForSession(sessionId);
		if (!route) return;
		const locale = botLocale(await this.#userLocale(route.account.user_id));
		const m = messagesFor(locale);
		const body = route.thread === undefined ? m.sessionBody(await this.#sessionTitle(sessionId, locale), text) : text;
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

	async #showProgress(sessionId: string, status: (m: BotMessages) => string): Promise<void> {
		const route = await this.#routeForSession(sessionId);
		if (!route) return;
		if (!route.adapter.capabilities.progress) return;
		const settings = await getUserSettings(this.#options.db, route.account.user_id);
		if (!settings.showProgress) return;
		const locale = botLocale(settings.locale);
		const m = messagesFor(locale);
		const text = status(m);
		const now = this.#now();
		if (route.adapter.capabilities.drafts && route.adapter.sendDraft && route.thread) {
			let draft = this.#drafts.get(sessionId);
			if (draft) {
				draft.step = text;
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
					suppressed: false,
				};
				this.#drafts.set(sessionId, draft);
			}
			if (now - draft.lastSentAt < this.#progressIntervalMs) return;
			const shown = draft.step;
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
					route.thread ? text : m.statusUntrackedSession(text, await this.#sessionTitle(sessionId, locale)),
					{ disablePreview: true },
				);
				this.#statuses.set(sessionId, {
					adapterName: route.adapterName,
					target: route.target,
					messageId: sent.messageId,
					lastSentAt: now,
					lastText: text,
					locale,
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
		const shown = draft.step;
		try {
			await sendDraft(draft.target, draft.draftId, shown);
			draft.lastSentAt = this.#now();
			draft.lastText = shown;
			this.#armDraftKeepalive(sessionId, draft);
		} catch (err) {
			console.error("channels: restoring a progress draft failed:", err);
		}
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
			if (this.#drafts.get(sessionId) === draft) {
				void this.#resendDraft(sessionId).catch((err: unknown) => {
					console.error("channels: keeping a progress draft alive failed:", err);
				});
			}
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
		if (!thread || thread.session_id === null) return;
		const owner = await sessionOwner(this.#options.db, thread.session_id);
		if (!owner) return;
		// Only the owner's own linked account may stop the turn; a chat relinked to someone else cannot.
		const presser = await accountByPlatform(this.#options.db, row.id, adapter.platform, stop.platformUserId);
		if (!presser || presser.user_id !== owner) return;
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
				// A thread is the source only while the account linked for its chat is the session owner's;
				// after a relink the session is treated as last used from the WebUI.
				const route = await this.#routeForThread(thread, owner);
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

	async #routeForThread(thread: ChannelThreadRow, owner: string): Promise<Route | undefined> {
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
			if (!account || account.user_id !== owner) continue;
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
		return this.#topicCreations.run(key, async () => {
			// A rejected creation must not be cached: SingleFlight removes the entry when it settles, also on throw.
			const createTopic = adapter.createTopic?.bind(adapter);
			if (!createTopic) return undefined;
			const locale = botLocale(await this.#userLocale(account.user_id));
			const title = clip(await this.#sessionTitle(sessionId, locale), 60);
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
			}
		});
	}

	// ---- approvals and quota waits in chat ----

	async #stateChanged(sessionId: string): Promise<void> {
		const rootId = (await rootSessionIdOf(this.#options.db, sessionId)) ?? sessionId;
		try {
			// A state change during a sync is a hint that the waits changed again: the reconciler runs the sync
			// once more after the current pass, so the last pass reads data newer than the last request.
			await this.#waitSyncs.run(rootId, () => this.#syncRootWaits(rootId));
		} catch (err) {
			console.error(`channels: syncing waits of root ${rootId} failed:`, err);
		}
	}

	async #syncAllWaits(): Promise<void> {
		if (this.#stopped) return;
		const rows = await this.#options.db
			.selectFrom("sessions")
			.select("root_session_id")
			.where("state", "=", "awaiting")
			.groupBy("root_session_id")
			.execute();
		for (const row of rows) {
			try {
				await this.#waitSyncs.run(row.root_session_id, () => this.#syncRootWaits(row.root_session_id));
			} catch (err) {
				console.error(`channels: syncing waits of root ${row.root_session_id} failed:`, err);
			}
		}
	}

	async #syncRootWaits(rootId: string): Promise<void> {
		await this.#settleTracked(rootId);
		const owner = await sessionOwner(this.#options.db, rootId);
		if (!owner) return;
		const locale = botLocale(await this.#userLocale(owner));
		const m = messagesFor(locale);
		const route = await this.#routeForSession(rootId);
		const tasks = await this.#options.db
			.selectFrom("tasks")
			.select(["id", "state", "handler_type", "on_behalf_of_user_id"])
			.where("root_session_id", "=", rootId)
			.where("state", "in", ["awaiting_approval", "awaiting_authorization"])
			.execute();
		for (const task of tasks) await this.#syncTaskWait(rootId, task, owner, route, locale, m);
		const groups = await this.#options.db
			.selectFrom("task_groups")
			.select(["id", "state", "handler_type", "on_behalf_of_user_id"])
			.where("root_session_id", "=", rootId)
			.where("state", "in", ["awaiting_approval", "awaiting_authorization"])
			.execute();
		for (const group of groups) await this.#syncGroupWait(rootId, group, owner, route, locale, m);
		const calls = await this.#options.db
			.selectFrom("external_calls")
			.select(["id", "state", "handler_type", "on_behalf_of_user_id"])
			.where("root_session_id", "=", rootId)
			.where("state", "=", "awaiting_approval")
			.execute();
		for (const call of calls) await this.#syncCallWait(rootId, call, owner, route, locale, m);
		await this.#syncQuotaWait(rootId, owner, route, locale, m);
		// A run waiting for the user shows no draft: drop any draft that a progress update created before the wait.
		if (hasWait(tasks, groups, calls, owner)) this.#dropDraft(rootId);
	}

	async #syncTaskWait(
		rootId: string,
		task: { id: string; state: string; handler_type: string | null; on_behalf_of_user_id: string },
		owner: string,
		route: Route | undefined,
		locale: UserSettingsLocale,
		m: BotMessages,
	): Promise<void> {
		if (task.on_behalf_of_user_id !== owner) return;
		const key = approvalKey("task", task.id);
		if (task.state === "awaiting_authorization") {
			if (!route || this.#tracked.has(key)) return;
			const link = this.#webUrl(`/approvals/tasks/${task.id}`);
			await this.#sendTracked(key, rootId, route, m.taskSignatureWait(task.id, link), [], locale, true);
			return;
		}
		if (task.handler_type !== "user") return;
		if (!route || this.#tracked.has(key)) return;
		const view = await this.#options.cluster.getTask(task.id);
		if (!view) return;
		const text = m.taskApproval(clip(view.summary || view.kind, 300), task.id);
		await this.#sendTracked(
			key,
			rootId,
			route,
			text,
			[
				[
					{ text: m.approveButton, data: `ap:t:${task.id}:a` },
					{ text: m.rejectButton, data: `ap:t:${task.id}:r` },
				],
			],
			locale,
			true,
		);
	}

	async #syncGroupWait(
		rootId: string,
		group: { id: string; state: string; handler_type: string | null; on_behalf_of_user_id: string },
		owner: string,
		route: Route | undefined,
		locale: UserSettingsLocale,
		m: BotMessages,
	): Promise<void> {
		if (group.on_behalf_of_user_id !== owner) return;
		const key = approvalKey("task_group", group.id);
		if (group.state === "awaiting_authorization") {
			if (!route || this.#tracked.has(key)) return;
			const link = this.#webUrl(`/approvals/task-groups/${group.id}`);
			await this.#sendTracked(key, rootId, route, m.taskGroupSignatureWait(group.id, link), [], locale, true);
			return;
		}
		if (group.handler_type !== "user") return;
		if (!route || this.#tracked.has(key)) return;
		const view = await this.#options.taskGroups.get(group.id);
		if (!view) return;
		const text = m.taskGroupApproval(clip(view.summary || view.kind, 300), group.id);
		await this.#sendTracked(
			key,
			rootId,
			route,
			text,
			[
				[
					{ text: m.approveButton, data: `ap:g:${group.id}:a` },
					{ text: m.rejectButton, data: `ap:g:${group.id}:r` },
				],
			],
			locale,
			true,
		);
	}

	async #syncCallWait(
		rootId: string,
		call: { id: string; state: string; handler_type: string | null; on_behalf_of_user_id: string },
		owner: string,
		route: Route | undefined,
		locale: UserSettingsLocale,
		m: BotMessages,
	): Promise<void> {
		if (call.on_behalf_of_user_id !== owner || call.handler_type !== "user") return;
		const key = approvalKey("external_call", call.id);
		if (!route || this.#tracked.has(key)) return;
		const row = await getExternalCall(this.#options.db, call.id);
		if (!row) return;
		const view = (await externalCallViews(this.#options.db, [row]))[0];
		const what = view ? `${view.extension}/${view.tool}` : `${row.extension_name}/${row.tool_name}`;
		const text = m.callApproval(what, call.id);
		await this.#sendTracked(
			key,
			rootId,
			route,
			text,
			[
				[
					{ text: m.approveButton, data: `ap:e:${call.id}:a` },
					{ text: m.rejectButton, data: `ap:e:${call.id}:r` },
				],
			],
			locale,
			true,
		);
	}

	async #syncQuotaWait(
		rootId: string,
		owner: string,
		route: Route | undefined,
		locale: UserSettingsLocale,
		m: BotMessages,
	): Promise<void> {
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
		const text = m.quotaWait(clip(root.title || m.newSessionTitle, 80), remaining, used);
		await this.#sendTracked(key, rootId, route, text, [], locale);
	}

	async #sendTracked(
		key: string,
		rootId: string,
		route: Route,
		text: string,
		buttons: readonly (readonly import("./model.ts").ChannelButton[])[],
		locale: UserSettingsLocale,
		waiting?: boolean,
	): Promise<void> {
		// The run now waits for the user: its draft expires on its own and is not shown again until the run goes on.
		if (waiting === true) this.#dropDraft(rootId);
		const m = messagesFor(locale);
		const buttonsOn = route.adapter.capabilities.buttons;
		const withSwitch =
			route.thread === undefined && buttonsOn
				? [...buttons, [{ text: m.openSession, data: `switch:${rootId}` }]]
				: buttons;
		const header = route.thread === undefined ? m.sessionBody(await this.#sessionTitle(rootId, locale), text) : text;
		const link = route.thread === undefined && !buttonsOn ? this.#sessionLink(rootId) : null;
		const body = link === null ? header : `${header}\n\n${m.openSessionLink(link)}`;
		let sent: SentMessage;
		try {
			sent = await route.adapter.sendText(route.target, body, { buttons: withSwitch });
		} catch (err) {
			console.error("channels: sending an approval message failed:", err);
			return;
		}
		if (this.#tracked.size >= TRACKED_MESSAGES_LIMIT && !this.#tracked.has(key)) {
			const oldest = this.#tracked.keys().next().value;
			if (oldest !== undefined) this.#tracked.delete(oldest);
		}
		this.#tracked.set(key, {
			key,
			rootSessionId: rootId,
			adapterName: route.adapterName,
			target: route.target,
			messageId: sent.messageId,
			text: body,
			locale,
		});
	}

	/** Edits tracked messages whose wait is over, saying how it ended (doc/design/channels.md "Approvals"). */
	async #settleTracked(rootId: string): Promise<void> {
		for (const [key, tracked] of [...this.#tracked]) {
			if (tracked.rootSessionId !== rootId) continue;
			const ending = await this.#waitEnding(key, messagesFor(tracked.locale));
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
	async #waitEnding(key: string, m: BotMessages): Promise<string | undefined> {
		if (key.startsWith("quota:")) {
			const rootId = key.slice("quota:".length);
			const row = await this.#options.db
				.selectFrom("sessions")
				.select("state")
				.where("id", "=", rootId)
				.executeTakeFirst();
			if (!row) return m.sessionGone;
			if (row.state === "awaiting") {
				const paused = await this.#options.db
					.selectFrom("sessions")
					.select("id")
					.where("waiting_level_id", "=", rootId)
					.where("waiting_kind", "=", "quota")
					.where("state", "=", "awaiting")
					.limit(1)
					.executeTakeFirst();
				return paused ? undefined : m.quotaWaitEnded;
			}
			return m.quotaWaitEnded;
		}
		const [kind, id] = key.split(":");
		if (!kind || !id) return m.waitEnded;
		if (kind === "task") {
			const row = await this.#options.db
				.selectFrom("tasks")
				.select(["state", "approval"])
				.where("id", "=", id)
				.executeTakeFirst();
			if (!row) return m.taskGone;
			if (row.state === "awaiting_approval" || row.state === "awaiting_authorization") return undefined;
			return this.#decisionEnding(row.approval, row.state === "rejected" ? "rejected" : undefined, m);
		}
		if (kind === "task_group") {
			const row = await this.#options.db
				.selectFrom("task_groups")
				.select(["state", "approval"])
				.where("id", "=", id)
				.executeTakeFirst();
			if (!row) return m.taskGroupGone;
			if (row.state === "awaiting_approval" || row.state === "awaiting_authorization") return undefined;
			return this.#decisionEnding(row.approval, row.state === "rejected" ? "rejected" : undefined, m);
		}
		const row = await getExternalCall(this.#options.db, id);
		if (!row) return m.callGone;
		if (row.state === "awaiting_approval") return undefined;
		return this.#decisionEnding(row.approval, row.state === "rejected" ? "rejected" : undefined, m);
	}

	#decisionEnding(approvalJson: string | null, fallback: "rejected" | undefined, m: BotMessages): string {
		if (approvalJson) {
			try {
				const record = JSON.parse(approvalJson) as {
					decision?: { decision?: string; reason?: string; by?: { id?: string } };
				};
				const decision = record.decision;
				if (decision?.decision === "approved") return m.approvedEnding;
				if (decision?.decision === "rejected") return m.rejectedEnding(decision.reason ?? null);
			} catch {}
		}
		return fallback === "rejected" ? m.rejected : m.waitEnded;
	}

	/** Re-reads a session's waiting approvals and quota waits (its state change, or a test setup). */
	async refreshWaits(sessionId: string): Promise<void> {
		await this.#stateChanged(sessionId);
	}

	/** Test-only: whether a runtime event watch is held for the session. */
	watchesSession(sessionId: string): boolean {
		return this.#watchers.has(sessionId);
	}

	/** Test-only: how many unlinked senders are remembered as answered; the set is bounded. */
	unlinkedReplyCount(): number {
		return this.#unlinkedReplied.size;
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

	/** A user's stored locale; null means their platform's language or English decides. */
	async #userLocale(userId: string): Promise<UserSettingsLocale | null> {
		return (await getUserSettings(this.#options.db, userId)).locale;
	}

	async #localeForAccount(
		account: ChannelAccountRow,
		languageCode: string | null | undefined,
	): Promise<UserSettingsLocale> {
		return botLocale(await this.#userLocale(account.user_id), languageCode);
	}

	async #messagesForSession(sessionId: string): Promise<BotMessages> {
		const owner = await sessionOwner(this.#options.db, sessionId);
		return messagesFor(owner ? botLocale(await this.#userLocale(owner)) : "en");
	}

	#sessionLink(sessionId: string): string | null {
		return this.#webUrl(`/sessions/${sessionId}`);
	}

	async #sessionTitle(sessionId: string, locale: UserSettingsLocale): Promise<string> {
		const session = await this.#options.runtime.getSession(sessionId);
		return clip(session?.title ?? messagesFor(locale).newSessionTitle, 80);
	}

	#webUrl(path: string): string | null {
		const base = this.#options.settings?.current().publicUrl ?? this.#options.publicUrl ?? null;
		if (!base) return null;
		return `${base.replace(/\/+$/, "")}${path}`;
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
		const row = await this.#serialized(name, async () => {
			const row = await deleteChannelRow(this.#options.db, name);
			await this.#removeNow(name);
			return row;
		});
		void this.#options.audit.record({
			actor: userActor(user),
			action: "channel.deleted",
			target: { type: "channel", id: row.id },
			detail: { name: row.name, kind: row.kind },
		});
	}
}
