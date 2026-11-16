import Element from "@satorijs/element";
import type { Event, Login, Message } from "@satorijs/protocol";
import { errorText } from "../util/errors.ts";
import { ChannelConnection, type ChannelConnectionOptions } from "./connection.ts";
import type {
	ChannelAdapter,
	ChannelCapabilities,
	ChannelHandlers,
	ChannelLogin,
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
import { splitMarkdown } from "./telegram-format.ts";

/**
 * The Satori kind (doc/design/channels.md "Channel kinds"): a small client written here on the protocol's two
 * official packages, `@satorijs/protocol` for the API types and `@satorijs/element` for message content.
 *
 * The satori.js stack is deliberately not used. Its stable line is released rarely, fixes merged upstream stay
 * unpublished for a long time, and the framework is heading for an incompatible move to cordis 4. The protocol
 * itself is small and stable, so crhs speaks it directly: one WebSocket to `<base>/v1/events`, and JSON calls to
 * `<base>/v1/<resource>.<method>`. That keeps crhs out of the adapter, middleware and lifecycle churn, at the
 * cost of implementing only the few operations a chat channel needs.
 *
 * One bot per channel: the gateway's READY must list the configured platform and bot id, and only that login's
 * private messages are handled. A gateway in front of Telegram still reports `telegram` as the platform.
 */

/** True when `url` is an http(s) URL on the same origin as the gateway base URL. */
function sameOrigin(url: string, base: string): boolean {
	try {
		const target = new URL(url);
		return (target.protocol === "http:" || target.protocol === "https:") && target.origin === new URL(base).origin;
	} catch {
		return false;
	}
}

/** What the gateway accepts in one `message.create`; longer text is split first. */
export const SATORI_TEXT_LIMIT = 4000;
/** The protocol's opcodes; the package declares them as a const enum, which cannot be imported at runtime. */
const OPCODE = { EVENT: 0, PING: 1, PONG: 2, IDENTIFY: 3, READY: 4, META: 5 } as const;
/** `Status.ONLINE`; only an online login may back a channel. */
const LOGIN_ONLINE = 1;
const PING_INTERVAL_MS = 10_000;
/** Any frame counts as life; without one for this long the socket is presumed dead and the loop reconnects. */
const IDLE_TIMEOUT_MS = 30_000;
const WATCHDOG_INTERVAL_MS = 5_000;

/** The subset of the global WebSocket this client uses. Node has it since version 22. */
interface SatoriSocket {
	send(data: string): void;
	close(code?: number, reason?: string): void;
	addEventListener(type: "open", listener: () => void): void;
	addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
	addEventListener(type: "close", listener: (event: { code?: number; reason?: string }) => void): void;
	addEventListener(type: "error", listener: (event: unknown) => void): void;
}

type SatoriSocketConstructor = new (url: string) => SatoriSocket;

function socketConstructor(): SatoriSocketConstructor {
	const ctor = (globalThis as { WebSocket?: unknown }).WebSocket;
	if (typeof ctor !== "function") throw new Error("this Node version has no WebSocket; Node 22 or later is required");
	return ctor as SatoriSocketConstructor;
}

export interface SatoriChannelOptions {
	channelId: string;
	/** The gateway base URL, such as `http://koishi:5140/satori`; its API is under `<base>/v1/`. */
	url: string;
	/** The gateway token; empty means the gateway is asked without one. */
	token: string;
	/** The platform of the bot, such as `telegram`. */
	platform: string;
	/** The login's user id in that platform. */
	botId: string;
	/** In-process fetch for tests; the global fetch otherwise. */
	fetch?: typeof fetch;
	/** The last handled sn, restored from the database. */
	initialCursor: number;
	/** Persists a handled sn. */
	onCursor: (sn: number) => Promise<void>;
	connection?: ChannelConnectionOptions;
}

/** The base URL without a trailing slash, so paths append predictably. */
function trimBase(url: string): string {
	return url.replace(/\/+$/, "");
}

/** `<base>/v1/events` with its scheme changed to ws or wss. */
function eventsUrl(base: string): string {
	const url = new URL(trimBase(base));
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	url.pathname = `${url.pathname.replace(/\/+$/, "")}/v1/events`;
	return url.toString();
}

interface ParsedContent {
	text: string | null;
	files: InboundFile[];
}

/** The text and files of a Satori `message.content`, an XML-ish element string. */
export function parseSatoriContent(content: string | undefined | null): ParsedContent {
	if (content === undefined || content === null || content === "") return { text: null, files: [] };
	let elements: Element[];
	try {
		elements = Element.parse(content);
	} catch {
		// Malformed content is still the user's text; do not lose it to a parse error.
		return { text: content, files: [] };
	}
	let text = "";
	const files: InboundFile[] = [];
	const walk = (nodes: readonly Element[]): void => {
		for (const node of nodes) {
			switch (node.type) {
				case "text":
					text += typeof node.attrs.content === "string" ? node.attrs.content : "";
					break;
				case "br":
					text += "\n";
					break;
				case "p":
					text += "\n";
					walk(node.children);
					text += "\n";
					break;
				case "at": {
					const name = node.attrs.name ?? node.attrs.id;
					text += typeof name === "string" && name !== "" ? `@${name}` : "";
					break;
				}
				case "img":
				case "audio":
				case "video":
				case "file": {
					const src = node.attrs.src;
					if (typeof src !== "string" || src === "") break;
					const name = node.attrs.title ?? node.attrs.name ?? node.attrs.filename;
					const mediaType = node.attrs.type ?? node.attrs.mime;
					files.push({
						fileId: src,
						name: typeof name === "string" && name !== "" ? name : null,
						mediaType: typeof mediaType === "string" && mediaType !== "" ? mediaType : null,
						bytes: null,
					});
					break;
				}
				default:
					// Quote, mention and unknown containers keep their text; their attributes are not content.
					walk(node.children);
			}
		}
	};
	walk(elements);
	const trimmed = text.replace(/\n{3,}/g, "\n\n").trim();
	return { text: trimmed === "" ? null : trimmed, files };
}

function mediaTypeOf(name: string | null, given: string | null | undefined, fromResponse: string | null): string {
	if (given) return given;
	if (fromResponse && fromResponse !== "application/octet-stream") return fromResponse;
	const ext = name?.split(".").pop()?.toLowerCase();
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

function fileNameOf(src: string): string | null {
	const clean = src.split(/[?#]/)[0] ?? src;
	const base = clean.slice(clean.lastIndexOf("/") + 1);
	return base === "" ? null : base;
}

export class SatoriChannel extends ChannelConnection implements ChannelAdapter {
	readonly kind = "satori" as const;
	readonly platform: string;
	readonly channelId: string;
	readonly capabilities: ChannelCapabilities = {
		drafts: false,
		topics: false,
		buttons: false,
		progress: false,
		maxTextLength: SATORI_TEXT_LIMIT,
	};
	readonly #base: string;
	readonly #token: string;
	readonly #botId: string;
	readonly #fetchImpl: typeof fetch;
	readonly #onCursor: (sn: number) => Promise<void>;
	#handlers: ChannelHandlers | undefined;
	#sn: number;
	#account: string | null = null;
	#logins: ChannelLogin[] = [];
	#proxyUrls: string[] = [];

	constructor(options: SatoriChannelOptions) {
		super(options.connection);
		this.channelId = options.channelId;
		this.#base = trimBase(options.url);
		this.#token = options.token;
		this.platform = `satori:${options.platform}`;
		this.#botId = options.botId;
		this.#fetchImpl = options.fetch ?? fetch;
		this.#onCursor = options.onCursor;
		this.#sn = options.initialCursor;
	}

	setHandlers(handlers: ChannelHandlers): void {
		this.#handlers = handlers;
	}

	override status(): ChannelStatus {
		return { ...super.status(), account: this.#account, logins: this.#logins };
	}

	protected async run(signal: AbortSignal): Promise<void> {
		const ctor = socketConstructor();
		const socket = new ctor(eventsUrl(this.#base));
		await new Promise<void>((resolve, reject) => {
			let settled = false;
			let lastFrameAt = Date.now();
			let handling: Promise<void> = Promise.resolve();
			let ping: ReturnType<typeof setInterval> | undefined;
			let watchdog: ReturnType<typeof setInterval> | undefined;

			const cleanup = (): void => {
				if (ping !== undefined) clearInterval(ping);
				if (watchdog !== undefined) clearInterval(watchdog);
				signal.removeEventListener("abort", abort);
			};
			const finish = (error?: Error): void => {
				if (settled) return;
				settled = true;
				cleanup();
				// Do not reconnect until the frames this socket already delivered have been handled: #sn (and the
				// stored cursor) must be current for the next IDENTIFY, or the gateway replays them and they run twice.
				// A handler that never settles therefore holds the reconnect, which is the handler's own timeout to own.
				void handling.then(() => {
					if (signal.aborted) resolve();
					else reject(error ?? new Error("the satori gateway connection closed"));
				});
			};
			const abort = (): void => {
				try {
					socket.close(1000, "crhs stopped");
				} catch {}
				finish();
			};
			signal.addEventListener("abort", abort, { once: true });

			socket.addEventListener("open", () => {
				lastFrameAt = Date.now();
				socket.send(JSON.stringify({ op: OPCODE.IDENTIFY, body: { token: this.#token, sn: this.#sn } }));
				ping = setInterval(() => {
					if (settled) return;
					try {
						socket.send(JSON.stringify({ op: OPCODE.PING, body: {} }));
					} catch (err) {
						finish(new Error(this.redact(`could not ping the satori gateway: ${errorText(err)}`)));
					}
				}, PING_INTERVAL_MS);
				ping.unref?.();
				watchdog = setInterval(() => {
					if (settled || Date.now() - lastFrameAt <= IDLE_TIMEOUT_MS) return;
					finish(new Error("the satori gateway sent nothing for 30 seconds"));
					try {
						socket.close(4000, "idle");
					} catch {}
				}, WATCHDOG_INTERVAL_MS);
				watchdog.unref?.();
			});

			socket.addEventListener("message", (event) => {
				// The socket is finished: anything already queued on `handling` still runs, but no new frame is taken.
				if (settled) return;
				lastFrameAt = Date.now();
				const raw = typeof event.data === "string" ? event.data : String(event.data ?? "");
				handling = handling
					.then(async () => {
						const error = await this.#handleFrame(raw);
						if (error !== undefined) {
							finish(error);
							try {
								socket.close(4000, "unusable");
							} catch {}
						}
					})
					.catch((err: unknown) => {
						this.markError(errorText(err));
					});
			});

			socket.addEventListener("close", (event) => {
				const code = event.code === undefined ? "" : ` (${event.code}${event.reason ? `: ${event.reason}` : ""})`;
				finish(new Error(`the satori gateway connection closed${code}`));
			});
			socket.addEventListener("error", () => {
				finish(new Error("the satori gateway connection failed"));
			});
		});
	}

	/**
	 * Handles one gateway frame. Returns an error only when the connection is unusable, such as READY naming no
	 * matching login; a failed event is reported with `markError` and the connection goes on.
	 */
	async #handleFrame(raw: string): Promise<Error | undefined> {
		let payload: { op?: unknown; body?: unknown };
		try {
			payload = JSON.parse(raw) as { op?: unknown; body?: unknown };
		} catch {
			return undefined;
		}
		switch (payload.op) {
			case OPCODE.READY:
				return this.#handleReady(payload.body as { logins?: Login[]; proxyUrls?: string[] });
			case OPCODE.META: {
				const body = payload.body as { proxyUrls?: unknown };
				this.#proxyUrls = Array.isArray(body?.proxyUrls)
					? body.proxyUrls.filter((url): url is string => typeof url === "string")
					: [];
				return undefined;
			}
			case OPCODE.PONG:
				return undefined;
			case OPCODE.EVENT: {
				const event = payload.body as Event | undefined;
				if (!event || typeof event !== "object") return undefined;
				const sn = Number(event.sn);
				if (!Number.isSafeInteger(sn)) return undefined;
				// A gateway resumes with events after the sn sent in IDENTIFY only, so a lower or equal sn means its
				// counter restarted (Koishi keeps it in memory): the event is new, and the cursor follows it down.
				try {
					await this.#handleEvent(event);
				} finally {
					this.#sn = sn;
					await this.#onCursor(sn);
				}
				return undefined;
			}
			default:
				return undefined;
		}
	}

	/** READY names the logins behind the gateway; the configured one must be there and online. */
	#handleReady(body: { logins?: Login[]; proxyUrls?: string[] } | undefined): Error | undefined {
		const logins = Array.isArray(body?.logins) ? body.logins : [];
		this.#proxyUrls = Array.isArray(body?.proxyUrls)
			? body.proxyUrls.filter((url): url is string => typeof url === "string")
			: [];
		this.#logins = logins.map((login) => ({
			platform: login.platform ?? this.#configuredPlatform(),
			id: login.user?.id ?? login.selfId ?? "",
			name: login.user?.nick ?? login.user?.name ?? null,
			online: login.status === LOGIN_ONLINE,
		}));
		const platform = this.#configuredPlatform();
		const match = logins.find(
			(login) => (login.platform ?? platform) === platform && (login.user?.id ?? login.selfId) === this.#botId,
		);
		if (!match) {
			const available = this.#logins.map((login) => `${login.platform}:${login.id}`).join(", ") || "none";
			return new Error(
				`the satori gateway has no login for platform ${platform} and bot ${this.#botId} (logins: ${available})`,
			);
		}
		if (match.status !== LOGIN_ONLINE) {
			return new Error(
				`the satori login ${platform}:${this.#botId} is not online (status ${match.status}); check that the gateway's bot is connected`,
			);
		}
		this.#account = match.user?.nick ?? match.user?.name ?? this.#botId;
		this.markConnected(this.#account);
		return undefined;
	}

	#configuredPlatform(): string {
		return this.platform.startsWith("satori:") ? this.platform.slice("satori:".length) : this.platform;
	}

	async #handleEvent(event: Event): Promise<void> {
		if (event.type !== "message-created") return;
		const platform = event.platform || event.login?.platform;
		const selfId = event.selfId || event.login?.user?.id || event.login?.selfId;
		if (platform !== this.#configuredPlatform() || selfId !== this.#botId) return;
		if (event.channel?.type !== 1 || typeof event.channel.id !== "string") return;
		const user = event.user;
		if (!user || typeof user.id !== "string" || user.id === "" || user.id === selfId || user.isBot === true) return;
		const { text, files } = parseSatoriContent(event.message?.content);
		const inbound: InboundMessage = {
			updateId: Number(event.sn),
			// The sn restarts with the gateway, so it cannot identify a submission; the platform message id can.
			...(typeof event.message?.id === "string" && event.message.id !== ""
				? { dedupeKey: `${event.channel.id}:${event.message.id}` }
				: {}),
			platformUserId: user.id,
			chatId: event.channel.id,
			topicId: null,
			displayName: user.nick ?? user.name ?? user.id,
			languageCode: undefined,
			text,
			files,
		};
		await this.#handlers?.onMessage(inbound);
	}

	/** The headers every gateway call carries, including the platform and bot the login acts as. */
	#headers(json: boolean): Record<string, string> {
		const platform = this.#configuredPlatform();
		return {
			...(this.#token === "" ? {} : { Authorization: `Bearer ${this.#token}` }),
			...(json ? { "Content-Type": "application/json" } : {}),
			"Satori-Platform": platform,
			"Satori-User-ID": this.#botId,
			"X-Platform": platform,
			"X-Self-ID": this.#botId,
		};
	}

	/** `POST <base>/v1/<resource>.<method>` with a JSON body, the protocol's header pairs and the token. */
	async #call<T>(resource: string, method: string, body: Record<string, unknown>): Promise<T> {
		const response = await this.#fetchImpl(`${this.#base}/v1/${resource}.${method}`, {
			method: "POST",
			headers: this.#headers(true),
			body: JSON.stringify(body),
		});
		const text = await response.text();
		if (!response.ok) {
			let detail = text;
			try {
				const parsed = JSON.parse(text) as { message?: unknown; error?: unknown };
				const message = parsed.message ?? parsed.error;
				if (typeof message === "string") detail = message;
			} catch {}
			throw new Error(
				this.redact(
					`satori ${resource}.${method} failed with ${response.status}${detail ? `: ${detail.slice(0, 500)}` : ""}`,
				),
			);
		}
		if (text === "") return undefined as T;
		try {
			return JSON.parse(text) as T;
		} catch {
			throw new Error(this.redact(`satori ${resource}.${method} returned invalid JSON`));
		}
	}

	async sendText(target: ChannelTarget, text: string, _options: ChannelSendOptions = {}): Promise<SentMessage> {
		const chunks = splitMarkdown(text, SATORI_TEXT_LIMIT);
		let messageId = "";
		for (const chunk of chunks) {
			const content = Element.escape(markdownEscapesToText(chunk));
			const result = await this.#call<Message[] | Message>("message", "create", {
				channel_id: target.chatId,
				content,
			});
			const last = Array.isArray(result) ? result[result.length - 1] : result;
			messageId = String(last?.id ?? last?.messageId ?? "");
		}
		return { chatId: target.chatId, messageId };
	}

	async editText(target: ChannelTarget, messageId: string, text: string): Promise<void> {
		try {
			await this.#call("message", "update", {
				channel_id: target.chatId,
				message_id: messageId,
				content: Element.escape(markdownEscapesToText(splitMarkdown(text, SATORI_TEXT_LIMIT)[0] ?? text)),
			});
		} catch (err) {
			// Editing a notice is best effort; the platform may have dropped the message.
			console.error("channels: editing a satori message failed:", errorText(err));
		}
	}

	async deleteMessage(target: ChannelTarget, messageId: string): Promise<void> {
		// Report the failure: the manager falls back to editing a decided wait message when deletion is refused.
		await this.#call("message", "delete", { channel_id: target.chatId, message_id: messageId });
	}

	/**
	 * Reads an inbound file without letting a message make crhs fetch an arbitrary address: a `data:` URL is
	 * decoded in place, an http(s) URL on the gateway's own origin is fetched directly (Koishi's Telegram adapter
	 * serves files from `<selfUrl>/telegram/...` without listing them as proxy roots), and anything else goes
	 * through the gateway's proxy, which checks it against its proxy roots.
	 */
	async downloadFile(
		file: InboundFile,
		options: DownloadFileOptions,
	): Promise<{ bytes: Uint8Array; name: string; mediaType: string }> {
		const src = file.fileId;
		if (src.startsWith("data:")) {
			const match = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(src);
			if (!match) throw new Error("satori file has a malformed data URL");
			const body = match[3] ?? "";
			const bytes = match[2]
				? new Uint8Array(Buffer.from(body, "base64"))
				: new TextEncoder().encode(decodeURIComponent(body));
			if (bytes.byteLength > options.maxBytes) throw new FileTooLargeError(options.maxBytes);
			const name = file.name ?? "file";
			return { bytes, name, mediaType: mediaTypeOf(name, file.mediaType, match[1] || null) };
		}
		const response = await this.#fetchImpl(sameOrigin(src, this.#base) ? src : `${this.#base}/v1/proxy/${src}`, {
			headers: this.#headers(false),
		});
		if (!response.ok) {
			const detail = await response.text().catch(() => "");
			throw new Error(
				this.redact(`satori file download failed with ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`),
			);
		}
		const bytes = await readResponseBytes(response, options.maxBytes);
		const name = file.name ?? fileNameOf(src) ?? "file";
		return {
			bytes,
			name,
			mediaType: mediaTypeOf(name, file.mediaType, response.headers.get("content-type")),
		};
	}

	/** The token is part of every gateway URL and may be quoted in an error; the admin page must not keep it. */
	protected override redact(message: string): string {
		return this.#token === "" ? message : message.replaceAll(this.#token, "<satori token>");
	}

	/** The gateway's proxy roots, kept from READY and META for diagnostics and a later download change. */
	get proxyUrls(): readonly string[] {
		return this.#proxyUrls;
	}
}
