import { Api, GrammyError } from "grammy";
import type { InlineKeyboardMarkup, Message, Update } from "grammy/types";
import { errorText } from "../util/errors.ts";
import { ChannelConnection, type ChannelConnectionOptions } from "./connection.ts";
import { messagesFor } from "./messages.ts";
import type {
	ButtonPress,
	ChannelAdapter,
	ChannelCapabilities,
	ChannelHandlers,
	ChannelSendOptions,
	ChannelStatus,
	ChannelTarget,
	DownloadFileOptions,
	InboundFile,
	InboundMessage,
	SentMessage,
} from "./model.ts";
import { FileTooLargeError, readResponseBytes } from "./model.ts";
import { markdownEscapesToText } from "./plain-text.ts";
import {
	neutralizeTelegramButtons,
	splitMarkdown,
	TELEGRAM_PLAIN_TEXT_LIMIT,
	TELEGRAM_TEXT_LIMIT,
} from "./telegram-format.ts";

/**
 * The Telegram kind (doc/design/channels.md "Channel kinds"): grammY's API client with long polling, no
 * middleware and Node's global `fetch`. Private chats only; a topic is its own conversation. The last handled
 * update id is persisted after each update, so a restart does not handle one twice.
 */

export const TELEGRAM_PLATFORM = "telegram";

export interface TelegramChannelOptions {
	channelId: string;
	token: string;
	/** The Bot API root; tests point it at a fake server. */
	apiRoot?: string;
	/** In-process fetch for tests; the global fetch otherwise. */
	fetch?: typeof fetch;
	/** Long-poll seconds; tests shorten it. */
	pollTimeoutSeconds?: number;
	/** The last handled update id, restored from the database. */
	initialCursor: number;
	/** Persists a handled update id. */
	onCursor: (updateId: number) => Promise<void>;
	connection?: ChannelConnectionOptions;
}

function displayName(user: { first_name: string; last_name?: string; username?: string }): string {
	const full = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
	return full || user.username || String(user);
}

function topicOf(message: Pick<Message, "is_topic_message" | "message_thread_id">): string | null {
	if (message.is_topic_message !== true || message.message_thread_id === undefined) return null;
	return String(message.message_thread_id);
}

function chatIdOf(chatId: number | string): string {
	return String(chatId);
}

/** A draft id from an update as the number crhs sent, whether Telegram serialized it as a number or a string. */
function draftIdOf(value: unknown): number | null {
	const id = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
	return typeof id === "number" && Number.isSafeInteger(id) ? id : null;
}

/**
 * grammY creates its requests' AbortSignals with the `abort-controller` shim, which Node's global `fetch` rejects
 * as not a native AbortSignal. This adapter bridges the shim's signal to a native one; without a signal the
 * request is passed through unchanged.
 */
function fetchWithNativeSignal(baseFetch: typeof fetch): typeof fetch {
	return ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
		const signal = init?.signal as unknown as
			| {
					aborted: boolean;
					addEventListener: (type: string, listener: () => void, options?: { once?: boolean }) => void;
			  }
			| undefined;
		if (!signal || signal instanceof AbortSignal) return baseFetch(input, init);
		const controller = new AbortController();
		if (signal.aborted) controller.abort();
		else signal.addEventListener("abort", () => controller.abort(), { once: true });
		return baseFetch(input, { ...init, signal: controller.signal });
	}) as typeof fetch;
}

function fileMediaType(path: string | undefined, mime: string | undefined): string {
	if (mime) return mime;
	const ext = path?.split(".").pop()?.toLowerCase();
	switch (ext) {
		case "jpg":
		case "jpeg":
			return "image/jpeg";
		case "png":
			return "image/png";
		case "gif":
			return "image/gif";
		case "webp":
			return "image/webp";
		default:
			return "application/octet-stream";
	}
}

function isBadRequest(err: unknown): boolean {
	return err instanceof GrammyError && err.error_code === 400;
}

function isNotModified(err: unknown): boolean {
	return /message is not modified/i.test(errorText(err));
}

export class TelegramChannel extends ChannelConnection implements ChannelAdapter {
	readonly kind = "telegram" as const;
	readonly platform = TELEGRAM_PLATFORM;
	readonly channelId: string;
	readonly capabilities: ChannelCapabilities = {
		drafts: true,
		topics: true,
		buttons: true,
		progress: true,
		markdown: true,
		maxTextLength: TELEGRAM_TEXT_LIMIT,
	};
	readonly #api: Api;
	readonly #token: string;
	readonly #apiRoot: string;
	readonly #fetchImpl: typeof fetch;
	readonly #pollTimeoutSeconds: number;
	readonly #onCursor: (updateId: number) => Promise<void>;
	#handlers: ChannelHandlers | undefined;
	#offset: number;
	#account: string | null = null;

	constructor(options: TelegramChannelOptions) {
		super(options.connection);
		this.channelId = options.channelId;
		this.#token = options.token;
		this.#apiRoot = options.apiRoot ?? "https://api.telegram.org";
		this.#fetchImpl = options.fetch ?? fetch;
		this.#pollTimeoutSeconds = options.pollTimeoutSeconds ?? 30;
		this.#onCursor = options.onCursor;
		this.#offset = options.initialCursor + 1;
		this.#api = new Api(options.token, {
			...(options.apiRoot ? { apiRoot: options.apiRoot } : {}),
			fetch: fetchWithNativeSignal(this.#fetchImpl),
		});
	}

	setHandlers(handlers: ChannelHandlers): void {
		this.#handlers = handlers;
	}

	override status(): ChannelStatus {
		return { ...super.status(), account: this.#account };
	}

	protected async run(signal: AbortSignal): Promise<void> {
		const apiSignal = signal as unknown as never;
		const me = await this.#api.getMe(apiSignal);
		this.#account = me.username ?? me.first_name;
		await this.#setCommands();
		while (!signal.aborted) {
			const updates = await this.#api.getUpdates(
				{
					offset: this.#offset,
					timeout: this.#pollTimeoutSeconds,
					allowed_updates: ["message", "callback_query", "stopped_message_generation"],
				},
				apiSignal,
			);
			this.markConnected(this.#account);
			// Let a send queued by another event handler reach the API client before the next long poll; sharing
			// one HTTP connection, the poll would otherwise keep the send waiting for its full timeout.
			await new Promise<void>((resolve) => setImmediate(resolve));
			for (const update of updates) {
				if (signal.aborted) return;
				try {
					await this.#handleUpdate(update);
				} catch (err) {
					// A poison update (a malformed object, an API error on reply) must not stop every later update.
					this.markError(errorText(err));
				}
				this.#offset = update.update_id + 1;
				await this.#onCursor(update.update_id);
			}
		}
	}

	async #setCommands(): Promise<void> {
		try {
			// English is the default menu; Telegram shows the zh menu to clients whose language starts with zh.
			await this.#api.setMyCommands([...messagesFor("en").commandMenu]);
			await this.#api.setMyCommands([...messagesFor("zh-CN").commandMenu], { language_code: "zh" });
		} catch (err) {
			// A menu is a convenience; a platform that refuses it must not keep the bot from polling.
			this.markError(errorText(err));
		}
	}

	async #handleUpdate(update: Update): Promise<void> {
		if (update.callback_query) {
			await this.#handleCallback(update.update_id, update.callback_query);
			return;
		}
		if (update.stopped_message_generation) {
			const stopped = update.stopped_message_generation;
			if (stopped.chat.type !== "private") return;
			await this.#handlers?.onGenerationStopped({
				updateId: update.update_id,
				platformUserId: chatIdOf(stopped.chat.id),
				chatId: chatIdOf(stopped.chat.id),
				topicId: stopped.message_thread_id === undefined ? null : String(stopped.message_thread_id),
				// Bot API typings say number, but the update carries the id as a string: compare it as a number.
				draftId: draftIdOf(stopped.draft_id),
			});
			return;
		}
		const message = update.message;
		if (!message || message.chat.type !== "private" || !message.from || message.from.is_bot) return;
		const files: InboundFile[] = [];
		if (message.photo && message.photo.length > 0) {
			const largest = message.photo[message.photo.length - 1];
			if (largest)
				files.push({ fileId: largest.file_id, name: null, mediaType: "image/jpeg", bytes: largest.file_size ?? null });
		}
		if (message.document) {
			files.push({
				fileId: message.document.file_id,
				name: message.document.file_name ?? null,
				mediaType: message.document.mime_type ?? null,
				bytes: message.document.file_size ?? null,
			});
		}
		const inbound: InboundMessage = {
			updateId: update.update_id,
			platformUserId: String(message.from.id),
			chatId: chatIdOf(message.chat.id),
			topicId: topicOf(message),
			displayName: displayName(message.from),
			languageCode: message.from.language_code ?? null,
			text: message.text ?? message.caption ?? null,
			files,
		};
		await this.#handlers?.onMessage(inbound);
	}

	async #handleCallback(updateId: number, query: NonNullable<Update["callback_query"]>): Promise<void> {
		const message = query.message;
		try {
			await this.#api.answerCallbackQuery(query.id);
		} catch {
			// The query may already have timed out; the decision below is still the user's.
		}
		if (message?.chat.type !== "private" || !query.from || !query.data) return;
		const press: ButtonPress = {
			updateId,
			platformUserId: String(query.from.id),
			chatId: chatIdOf(message.chat.id),
			topicId: topicOf(message),
			messageId: String(message.message_id),
			data: query.data,
			displayName: displayName(query.from),
			languageCode: query.from.language_code ?? null,
		};
		await this.#handlers?.onButton(press);
	}

	async sendText(target: ChannelTarget, text: string, options: ChannelSendOptions = {}): Promise<SentMessage> {
		const chunks = splitMarkdown(text, options.plain ? TELEGRAM_PLAIN_TEXT_LIMIT - 8 : undefined);
		const thread = target.topicId ? { message_thread_id: Number(target.topicId) } : {};
		let sent: { message_id: number } | undefined;
		for (let index = 0; index < chunks.length; index++) {
			const markdown = chunks[index] ?? "";
			const markup: InlineKeyboardMarkup | undefined =
				index === chunks.length - 1 && options.buttons
					? {
							inline_keyboard: options.buttons.map((row) =>
								row.map((button) => ({ text: button.text, callback_data: button.data })),
							),
						}
					: undefined;
			if (options.plain) {
				// Already plain: do not interpret it as Markdown (a card rendered for a plain surface).
				sent = await this.#api.sendMessage(target.chatId, markdown, {
					...thread,
					...(markup ? { reply_markup: markup } : {}),
					...(options.disablePreview ? { link_preview_options: { is_disabled: true } } : {}),
				});
				continue;
			}
			try {
				// Rich messages have no link preview options; Telegram picks the preview itself.
				sent = await this.#api.sendRichMessage(
					target.chatId,
					{ markdown: neutralizeTelegramButtons(markdown) },
					{ ...thread, ...(markup ? { reply_markup: markup } : {}) },
				);
			} catch (err) {
				// Telegram rejects a rich message it cannot parse or that breaks its limits with a 400; the
				// text is still worth delivering as plain text.
				if (!isBadRequest(err)) throw err;
				sent = await this.#sendPlain(target.chatId, markdown, {
					...(target.topicId ? { messageThreadId: Number(target.topicId) } : {}),
					...(markup ? { replyMarkup: markup } : {}),
					...(options.disablePreview ? { disablePreview: true } : {}),
				});
			}
		}
		return { chatId: target.chatId, messageId: String(sent?.message_id ?? "") };
	}

	/** The plain-text fallback for a rich message Telegram rejected; each part fits the plain limit. */
	async #sendPlain(
		chatId: string,
		text: string,
		options: {
			messageThreadId?: number;
			replyMarkup?: InlineKeyboardMarkup;
			disablePreview?: boolean;
		},
	): Promise<{ message_id: number }> {
		const chunks = splitMarkdown(text, TELEGRAM_PLAIN_TEXT_LIMIT - 8);
		let sent: { message_id: number } | undefined;
		for (let index = 0; index < chunks.length; index++) {
			const last = index === chunks.length - 1;
			// Plain text shows Markdown escapes literally; the punctuation they escape is what was meant.
			sent = await this.#api.sendMessage(chatId, markdownEscapesToText(chunks[index] ?? ""), {
				...(options.messageThreadId !== undefined ? { message_thread_id: options.messageThreadId } : {}),
				...(last && options.replyMarkup ? { reply_markup: options.replyMarkup } : {}),
				...(options.disablePreview ? { link_preview_options: { is_disabled: true } } : {}),
			});
		}
		return sent ?? { message_id: 0 };
	}

	async editText(
		target: ChannelTarget,
		messageId: string,
		text: string,
		options: ChannelSendOptions = {},
	): Promise<void> {
		const markup: InlineKeyboardMarkup | undefined = options.buttons
			? {
					inline_keyboard: options.buttons.map((row) =>
						row.map((button) => ({ text: button.text, callback_data: button.data })),
					),
				}
			: undefined;
		const other = {
			...(markup ? { reply_markup: markup } : {}),
			...(options.disablePreview ? { link_preview_options: { is_disabled: true } } : {}),
		};
		if (options.plain) {
			// Already plain: a card rendered for a plain surface, edited literally.
			await this.#api.editMessageText(target.chatId, Number(messageId), text, other);
			return;
		}
		try {
			await this.#api.editMessageText(
				target.chatId,
				Number(messageId),
				{ markdown: neutralizeTelegramButtons(text) },
				other,
			);
		} catch (err) {
			if (isNotModified(err)) return;
			if (!isBadRequest(err)) throw err;
			try {
				await this.#api.editMessageText(target.chatId, Number(messageId), markdownEscapesToText(text), other);
			} catch (fallbackErr) {
				if (isNotModified(fallbackErr)) return;
				throw fallbackErr;
			}
		}
	}

	async deleteMessage(target: ChannelTarget, messageId: string): Promise<void> {
		await this.#api.deleteMessage(target.chatId, Number(messageId));
	}

	async sendDraft(target: ChannelTarget, draftId: number, text: string): Promise<void> {
		await this.#api.sendMessageDraft(Number(target.chatId), draftId, text.slice(0, TELEGRAM_PLAIN_TEXT_LIMIT), {
			...(target.topicId ? { message_thread_id: Number(target.topicId) } : {}),
			can_stop: true,
			keep_on_stop: false,
		});
	}

	/** The bot token is part of every API and file URL; an error that quotes a URL must not keep it. */
	protected override redact(message: string): string {
		return this.#token === "" ? message : message.replaceAll(this.#token, "<bot token>");
	}

	async downloadFile(
		file: InboundFile,
		options: DownloadFileOptions,
	): Promise<{ bytes: Uint8Array; name: string; mediaType: string }> {
		// Telegram's file_size is authoritative enough to refuse a large file before getFile even names it.
		if (file.bytes !== null && file.bytes > options.maxBytes) throw new FileTooLargeError(options.maxBytes);
		const info = await this.#api.getFile(file.fileId);
		if (!info.file_path) throw new Error("Telegram did not give the file's path");
		const url = `${this.#apiRoot}/file/bot${this.#token}/${info.file_path}`;
		const response = await this.#fetchImpl(url);
		if (!response.ok) throw new Error(`Telegram file download failed with ${response.status}`);
		const bytes = await readResponseBytes(response, options.maxBytes);
		const fromPath = info.file_path.slice(info.file_path.lastIndexOf("/") + 1);
		return {
			bytes,
			name: file.name ?? fromPath ?? `${file.fileId}.bin`,
			mediaType: fileMediaType(info.file_path, file.mediaType ?? undefined),
		};
	}

	async createTopic(chatId: string, name: string): Promise<string> {
		const topic = await this.#api.createForumTopic(chatId, name.slice(0, 128));
		return String(topic.message_thread_id);
	}
}
