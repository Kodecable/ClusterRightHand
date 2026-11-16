import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A fake Telegram Bot API server for channel tests, adapted from the Satori spike's server
 * (doc/design/channels.md "Channel kinds"). It implements only the methods the Telegram adapter calls and records
 * every request, so a test can inject updates and assert what the bot sent.
 */

export interface FakeCall {
	method: string;
	body: Record<string, unknown>;
	/** The bot token in the request URL. */
	token: string;
	at: string;
}

export interface FakeFile {
	bytes: Uint8Array;
	name: string;
	mediaType: string;
	/** Serve without a content-length, so a download must stop reading at the limit. */
	chunked?: boolean;
}

const PNG_1PX = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
	"base64",
);

const BOT = { id: 424242, is_bot: true, first_name: "Test Bot", username: "test_bot" };

function json(res: ServerResponse, value: unknown, status = 200): void {
	const body = JSON.stringify(value);
	res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
	res.end(body);
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(Buffer.from(chunk as Buffer));
	const raw = Buffer.concat(chunks);
	if (raw.length === 0) return {};
	try {
		return JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
	} catch {
		return Object.fromEntries(new URLSearchParams(raw.toString("utf8")));
	}
}

export interface FakeTelegramOptions {
	token?: string;
	/** The webhook info URL is always empty; the adapter uses long polling. */
	quiet?: boolean;
}

export interface FakeTelegram {
	readonly apiRoot: string;
	readonly token: string;
	readonly calls: FakeCall[];
	readonly files: Map<string, FakeFile>;
	/** Queue an update verbatim; its update_id is assigned, or the given one is used. */
	inject(update: Record<string, unknown>, updateId?: number): number;
	text(userId: number, text: string, options?: { chatId?: number; topicId?: number; languageCode?: string }): number;
	photo(userId: number, fileId: string, options?: { topicId?: number; caption?: string; fileSize?: number }): number;
	document(
		userId: number,
		fileId: string,
		name: string,
		options?: { topicId?: number; caption?: string; fileSize?: number },
	): number;
	callback(
		userId: number,
		data: string,
		options?: { messageId?: number; topicId?: number; languageCode?: string },
	): number;
	stopGeneration(userId: number, options?: { topicId?: number; draftId?: number | string }): number;
	/** Lets a second bot token talk to this fake server, for a channel under test beside the main one. */
	allowToken(token: string): void;
	addFile(fileId: string, file: Partial<FakeFile> & { bytes: Uint8Array }): void;
	/** Makes the next sendRichMessage fail with a 400, for the adapter's plain-text fallback. */
	failNextRichMessage(description?: string): void;
	/** Makes the next deleteMessage fail with a 400, for the delete-then-edit fallback. */
	failNextDeleteMessage(description?: string): void;
	/**
	 * Holds the next message send in flight until `release()`: `held` resolves once the request reached the
	 * server, so a test can let the state change that sends it race with another.
	 */
	holdNextSend(): { held: Promise<void>; release: () => void };
	callsOf(method: string): FakeCall[];
	/** The most getUpdates requests in flight at once for a token; overlapping adapters would raise it. */
	maxConcurrentPolls(token?: string): number;
	/** Calls that sent a message, as plain text or as a rich message. */
	sentCalls(): FakeCall[];
	waitFor(method: string, predicate?: (call: FakeCall) => boolean, timeoutMs?: number): Promise<FakeCall>;
	/** Waits for a sendMessage or sendRichMessage call matching the predicate. */
	waitForSent(predicate?: (call: FakeCall) => boolean, timeoutMs?: number): Promise<FakeCall>;
	waitForCount(method: string, count: number, timeoutMs?: number): Promise<FakeCall[]>;
	close(): Promise<void>;
}

/** The text a send or edit call carried, whether as plain text or as rich Markdown. */
export function sentText(call: FakeCall): string {
	const rich = call.body.rich_message as { markdown?: unknown } | undefined;
	if (typeof rich?.markdown === "string") return rich.markdown;
	return typeof call.body.text === "string" ? call.body.text : "";
}

export async function startFakeTelegram(options: FakeTelegramOptions = {}): Promise<FakeTelegram> {
	const token = options.token ?? "123456:TEST_TOKEN";
	const extraTokens = new Set<string>();
	const calls: FakeCall[] = [];
	const updates: { update_id: number; [key: string]: unknown }[] = [];
	const files = new Map<string, FakeFile>();
	const polls = new Map<string, { active: number; max: number }>();
	let nextUpdateId = 1;
	let nextMessageId = 1000;
	let nextTopicId = 500;
	let richFailure: string | null = null;
	let deleteFailure: string | null = null;
	let sendHold: { reached: () => void; wait: Promise<void> } | null = null;
	const waiters = new Set<() => void>();
	let server: Server;
	let apiRoot = "";

	const knownToken = (candidate: string): boolean => candidate === token || extraTokens.has(candidate);
	const pollState = (botToken: string): { active: number; max: number } => {
		let state = polls.get(botToken);
		if (!state) {
			state = { active: 0, max: 0 };
			polls.set(botToken, state);
		}
		return state;
	};

	const sent = (): FakeCall[] =>
		calls.filter((call) => call.method === "sendMessage" || call.method === "sendRichMessage");

	const record = (method: string, body: Record<string, unknown>, botToken: string): FakeCall => {
		const call = { method, body, token: botToken, at: new Date().toISOString() };
		calls.push(call);
		return call;
	};

	const wake = (): void => {
		for (const waiter of [...waiters]) {
			waiters.delete(waiter);
			waiter();
		}
	};

	const message = (chatId: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
		message_id: ++nextMessageId,
		date: Math.floor(Date.now() / 1000),
		chat: { id: chatId, type: "private", first_name: "Tester" },
		from: { id: chatId, is_bot: false, first_name: "Tester" },
		...extra,
	});

	const inject = (update: Record<string, unknown>, updateId?: number): number => {
		const id = updateId ?? nextUpdateId;
		if (updateId === undefined) nextUpdateId += 1;
		else nextUpdateId = Math.max(nextUpdateId, updateId + 1);
		updates.push({ update_id: id, ...update });
		wake();
		return id;
	};

	const text = (
		userId: number,
		body: string,
		opts: { chatId?: number; topicId?: number; languageCode?: string } = {},
	): number =>
		inject({
			message: message(opts.chatId ?? userId, {
				text: body,
				...(opts.topicId !== undefined ? { message_thread_id: opts.topicId, is_topic_message: true } : {}),
				...(opts.languageCode !== undefined
					? { from: { id: userId, is_bot: false, first_name: "Tester", language_code: opts.languageCode } }
					: {}),
			}),
		});

	const photo = (
		userId: number,
		fileId: string,
		opts: { topicId?: number; caption?: string; fileSize?: number } = {},
	): number =>
		inject({
			message: message(userId, {
				photo: [
					{
						file_id: fileId,
						file_unique_id: `u-${fileId}`,
						width: 1,
						height: 1,
						file_size: opts.fileSize ?? files.get(fileId)?.bytes.length ?? 68,
					},
				],
				...(opts.caption ? { caption: opts.caption } : {}),
				...(opts.topicId !== undefined ? { message_thread_id: opts.topicId, is_topic_message: true } : {}),
			}),
		});

	const document = (
		userId: number,
		fileId: string,
		name: string,
		opts: { topicId?: number; caption?: string; fileSize?: number } = {},
	): number =>
		inject({
			message: message(userId, {
				document: {
					file_id: fileId,
					file_unique_id: `u-${fileId}`,
					file_name: name,
					mime_type: "text/plain",
					file_size: opts.fileSize ?? files.get(fileId)?.bytes.length ?? 12,
				},
				...(opts.caption ? { caption: opts.caption } : {}),
				...(opts.topicId !== undefined ? { message_thread_id: opts.topicId, is_topic_message: true } : {}),
			}),
		});

	const callback = (
		userId: number,
		data: string,
		opts: { messageId?: number; topicId?: number; languageCode?: string } = {},
	): number => {
		const target = message(userId, {
			message_id: opts.messageId ?? ++nextMessageId,
			...(opts.topicId !== undefined ? { message_thread_id: opts.topicId, is_topic_message: true } : {}),
		});
		return inject({
			callback_query: {
				id: `cb-${Math.random().toString(36).slice(2)}`,
				from: {
					id: userId,
					is_bot: false,
					first_name: "Tester",
					...(opts.languageCode !== undefined ? { language_code: opts.languageCode } : {}),
				},
				chat_instance: "ci",
				data,
				message: target,
			},
		});
	};

	const stopGeneration = (userId: number, opts: { topicId?: number; draftId?: number | string } = {}): number =>
		inject({
			stopped_message_generation: {
				chat: { id: userId, type: "private", first_name: "Tester" },
				...(opts.topicId !== undefined ? { message_thread_id: opts.topicId } : {}),
				draft_id: opts.draftId ?? 1,
			},
		});

	const addFile = (fileId: string, file: Partial<FakeFile> & { bytes: Uint8Array }): void => {
		files.set(fileId, {
			bytes: file.bytes,
			name: file.name ?? `${fileId}.png`,
			mediaType: file.mediaType ?? "image/png",
			...(file.chunked !== undefined ? { chunked: file.chunked } : {}),
		});
	};

	const api = async (
		botToken: string,
		method: string,
		body: Record<string, unknown>,
		res: ServerResponse,
	): Promise<void> => {
		record(method, body, botToken);
		if ((method === "sendMessage" || method === "sendRichMessage") && sendHold) {
			const hold = sendHold;
			sendHold = null;
			hold.reached();
			await hold.wait;
		}
		switch (method) {
			case "getMe":
				return json(res, { ok: true, result: BOT });
			case "getUpdates": {
				const poll = pollState(botToken);
				poll.active += 1;
				poll.max = Math.max(poll.max, poll.active);
				let finished = false;
				const finish = (): void => {
					if (finished) return;
					finished = true;
					poll.active -= 1;
				};
				res.once("close", finish);
				try {
					const offset = Number(body.offset ?? 0);
					const timeout = Number(body.timeout ?? 0);
					const pick = () => updates.filter((update) => update.update_id >= offset);
					let available = pick();
					if (available.length === 0 && timeout > 0) {
						await new Promise<void>((resolve) => {
							const done = () => {
								clearTimeout(timer);
								resolve();
							};
							const timer = setTimeout(done, Math.min(timeout * 1000, 30_000));
							waiters.add(done);
						});
						available = pick();
					}
					// A real client cancels a long poll when it stops; the fake server must not consume updates for it.
					if (res.destroyed || res.socket?.destroyed) return;
					for (const update of available) {
						const index = updates.indexOf(update);
						if (index >= 0) updates.splice(index, 1);
					}
					json(res, { ok: true, result: available });
				} finally {
					finish();
				}
				return;
			}
			case "sendRichMessage": {
				if (richFailure !== null) {
					const description = richFailure;
					richFailure = null;
					return json(res, { ok: false, error_code: 400, description }, 400);
				}
				const msg = message(Number(body.chat_id), {
					rich_message: body.rich_message,
					...(body.reply_markup ? { reply_markup: body.reply_markup } : {}),
					...(body.message_thread_id !== undefined ? { message_thread_id: body.message_thread_id } : {}),
				});
				return json(res, { ok: true, result: msg });
			}
			case "sendMessage": {
				const msg = message(Number(body.chat_id), {
					text: typeof body.text === "string" ? body.text : "",
					...(body.reply_markup ? { reply_markup: body.reply_markup } : {}),
					...(body.message_thread_id !== undefined ? { message_thread_id: body.message_thread_id } : {}),
				});
				return json(res, { ok: true, result: msg });
			}
			case "editMessageText": {
				const msg = message(Number(body.chat_id), {
					message_id: Number(body.message_id),
					...(typeof body.text === "string" ? { text: body.text } : {}),
					...(body.rich_message ? { rich_message: body.rich_message } : {}),
					...(body.reply_markup ? { reply_markup: body.reply_markup } : {}),
				});
				return json(res, { ok: true, result: msg });
			}
			case "deleteMessage": {
				if (deleteFailure !== null) {
					const description = deleteFailure;
					deleteFailure = null;
					return json(res, { ok: false, error_code: 400, description }, 400);
				}
				return json(res, { ok: true, result: true });
			}
			case "answerCallbackQuery":
			case "setMyCommands":
			case "deleteWebhook":
				return json(res, { ok: true, result: true });
			case "sendMessageDraft": {
				return json(res, { ok: true, result: true });
			}
			case "createForumTopic": {
				return json(res, {
					ok: true,
					result: { message_thread_id: ++nextTopicId, name: body.name, icon_color: 0 },
				});
			}
			case "getFile": {
				const file = files.get(String(body.file_id));
				if (!file) return json(res, { ok: false, error_code: 400, description: "Bad Request: file not found" }, 400);
				record("getFilePath", { file_id: body.file_id, path: `documents/${body.file_id}` }, botToken);
				return json(res, {
					ok: true,
					result: {
						file_id: body.file_id,
						file_unique_id: `u-${String(body.file_id)}`,
						file_size: file.bytes.length,
						file_path: `documents/${String(body.file_id)}`,
					},
				});
			}
			default:
				return json(res, { ok: true, result: true });
		}
	};

	server = createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", "http://localhost");
		const fileMatch = /^\/file\/bot([^/]+)\/(.+)$/.exec(url.pathname);
		if (fileMatch) {
			const botToken = fileMatch[1] ?? "";
			if (!knownToken(botToken)) return json(res, { ok: false }, 401);
			const path = decodeURIComponent(fileMatch[2] ?? "");
			record("fileDownload", { path }, botToken);
			const file = files.get(path.split("/").pop() ?? "");
			if (!file) {
				res.writeHead(404);
				res.end("not found");
				return;
			}
			res.writeHead(
				200,
				file.chunked
					? { "content-type": file.mediaType }
					: { "content-type": file.mediaType, "content-length": file.bytes.length },
			);
			res.end(file.bytes);
			return;
		}
		const apiMatch = /^\/bot([^/]+)\/([A-Za-z]+)$/.exec(url.pathname);
		if (!apiMatch) {
			res.writeHead(404);
			res.end("not found");
			return;
		}
		if (!knownToken(apiMatch[1] ?? ""))
			return json(res, { ok: false, error_code: 401, description: "Unauthorized" }, 401);
		await api(apiMatch[1] ?? "", apiMatch[2] ?? "", await readBody(req), res);
	});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	apiRoot = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

	return {
		apiRoot,
		token,
		calls,
		files,
		inject,
		text,
		photo,
		document,
		callback,
		stopGeneration,
		allowToken: (next) => {
			extraTokens.add(next);
		},
		addFile,
		failNextRichMessage: (description = "Bad Request: can't parse rich message") => {
			richFailure = description;
		},
		failNextDeleteMessage: (description = "Bad Request: message can't be deleted") => {
			deleteFailure = description;
		},
		holdNextSend: () => {
			if (sendHold) throw new Error("a send is already held");
			let reached!: () => void;
			let release!: () => void;
			const held = new Promise<void>((resolve) => {
				reached = resolve;
			});
			const wait = new Promise<void>((resolve) => {
				release = resolve;
			});
			sendHold = { reached, wait };
			return { held, release: () => release() };
		},
		callsOf: (method) => calls.filter((call) => call.method === method),
		maxConcurrentPolls: (botToken = token) => polls.get(botToken)?.max ?? 0,
		sentCalls: sent,
		waitFor: async (method, predicate = () => true, timeoutMs = 5_000) => {
			const deadline = Date.now() + timeoutMs;
			for (;;) {
				const found = calls.find((call) => call.method === method && predicate(call));
				if (found) return found;
				if (Date.now() > deadline) throw new Error(`timed out waiting for ${method}`);
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
		},
		waitForSent: async (predicate = () => true, timeoutMs = 5_000) => {
			const deadline = Date.now() + timeoutMs;
			for (;;) {
				const found = sent().find(predicate);
				if (found) return found;
				if (Date.now() > deadline) throw new Error("timed out waiting for a sent message");
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
		},
		waitForCount: async (method, count, timeoutMs = 5_000) => {
			const deadline = Date.now() + timeoutMs;
			for (;;) {
				const found = calls.filter((call) => call.method === method);
				if (found.length >= count) return found;
				if (Date.now() > deadline) throw new Error(`timed out waiting for ${count} ${method} calls`);
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
		},
		close: async () => {
			wake();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

export { PNG_1PX };
