/**
 * The internal chat channel interface (doc/design/channels.md "Channel kinds"). A platform adapter receives
 * messages and button presses and can send, edit and delete messages; the optional capabilities `drafts`,
 * `topics`, `buttons` and `progress` let the core use a better primitive when the platform has one, or fall
 * back to text when it has not. The core never talks to a platform itself, so Satori only has to implement
 * this interface.
 */

import { UserError } from "../util/errors.ts";

/** The kinds of channel crhs knows; Satori is the later one. */
export type ChannelKind = "telegram" | "satori";

/** What an adapter's connection is doing (the admin page's state). */
export type ChannelState = "disabled" | "connecting" | "connected" | "unavailable";

/** One login a Satori gateway's READY reported, for the admin page. */
export interface ChannelLogin {
	platform: string;
	id: string;
	name: string | null;
	/** Whether the gateway reports the login as ONLINE. */
	online: boolean;
}

export interface ChannelStatus {
	state: ChannelState;
	/** Why the last attempt failed; null when it succeeded. */
	lastError: string | null;
	/** When the next automatic attempt is scheduled while unavailable. */
	nextAttemptAt: string | null;
	/** The bot's username or another platform label, once known; null before the first connection. */
	account: string | null;
	/** The logins a Satori gateway reported; present on Satori channels only. */
	logins?: ChannelLogin[];
}

/** Where a message goes: the platform's chat and, when it has topics, the topic (thread). */
export interface ChannelTarget {
	chatId: string;
	topicId?: string | null;
}

export interface ChannelButton {
	text: string;
	/** The callback payload, at most 64 bytes on Telegram. */
	data: string;
}

export interface ChannelSendOptions {
	/** Rows of inline buttons. */
	buttons?: readonly (readonly ChannelButton[])[];
	/** Skip the link preview (default false). */
	disablePreview?: boolean;
	/**
	 * The text is already plain for this platform (a card rendered for a plain surface): send it literally
	 * instead of interpreting Markdown.
	 */
	plain?: boolean;
}

export interface SentMessage {
	chatId: string;
	messageId: string;
}

/** A file or photo an inbound message carries; the adapter downloads it on request. */
export interface InboundFile {
	/** The platform's file id. */
	fileId: string;
	/** The file's name when the platform gives one. */
	name: string | null;
	mediaType: string | null;
	bytes: number | null;
}

export interface DownloadFileOptions {
	/** The user's library single-file limit; a larger file is refused instead of being read whole. */
	maxBytes: number;
}

/** An inbound file the user's library would not accept; the manager words the refusal in the user's locale. */
export class FileTooLargeError extends UserError {
	readonly maxBytes: number;

	constructor(maxBytes: number) {
		super("the file is larger than the library's one-file size limit");
		this.maxBytes = maxBytes;
	}
}

/**
 * Reads a response body, stopping as soon as it passes `maxBytes`: a declared length is refused before the body is
 * read, and a longer stream is cancelled rather than buffered (doc/design/channels.md "Messages").
 */
export async function readResponseBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
	const declared = response.headers.get("content-length");
	if (declared !== null && Number(declared) > maxBytes) {
		await response.body?.cancel().catch(() => {});
		throw new FileTooLargeError(maxBytes);
	}
	if (!response.body) {
		const bytes = new Uint8Array(await response.arrayBuffer());
		if (bytes.byteLength > maxBytes) throw new FileTooLargeError(maxBytes);
		return bytes;
	}
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (!value) continue;
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel().catch(() => {});
			throw new FileTooLargeError(maxBytes);
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

/** A private-chat message as the core sees it. */
export interface InboundMessage {
	/** The platform's update id, for idempotent submissions and the cursor. */
	updateId: number;
	/** A stable id for idempotent submissions when the update id can repeat (Satori's sn restarts with the gateway). */
	dedupeKey?: string;
	platformUserId: string;
	chatId: string;
	topicId: string | null;
	displayName: string;
	/** The platform's language (`zh-hans`, `en`), for a reply before the user is linked. */
	languageCode?: string | null;
	text: string | null;
	files: InboundFile[];
}

/** A button press; `data` is what the button carried. */
export interface ButtonPress {
	updateId: number;
	platformUserId: string;
	chatId: string;
	topicId: string | null;
	messageId: string;
	data: string;
	displayName: string;
	languageCode?: string | null;
}

/** The platform told us the user pressed the draft's stop control. */
export interface GenerationStopped {
	updateId: number;
	platformUserId: string;
	chatId: string;
	topicId: string | null;
	/**
	 * The draft the user stopped. Telegram keeps stale drafts around for hours, so the manager only stops a turn
	 * when this is its current live draft (`null` on a platform whose stop control carries no draft id).
	 */
	draftId: number | null;
}

export interface ChannelHandlers {
	onMessage(message: InboundMessage): Promise<void>;
	onButton(press: ButtonPress): Promise<void>;
	onGenerationStopped(stop: GenerationStopped): Promise<void>;
}

/** The optional platform capabilities the core uses when present. */
export interface ChannelCapabilities {
	/** A streaming draft with a stop control (`sendMessageDraft` on Telegram). */
	drafts: boolean;
	/** Topics/threads in a private chat: one session per topic. */
	topics: boolean;
	/** Inline buttons; without them the manager sends no buttons and texts carry command hints. */
	buttons: boolean;
	/** A progress draft or status message while a turn runs; without it the manager shows no progress. */
	progress: boolean;
	/**
	 * Whether `sendText`/`editText` take Markdown. The manager renders a card as Markdown for such an adapter
	 * and as plain text for one without it, so no card is ever converted between the two formats.
	 */
	markdown: boolean;
	/** The platform's message length limit; the adapter may split a longer Markdown text. */
	maxTextLength: number;
}

/** The adapter interface both kinds implement; the manager owns lifecycle and routing around it. */
export interface ChannelAdapter {
	readonly kind: ChannelKind;
	/** The platform string stored on accounts and threads; Telegram's is `telegram`. */
	readonly platform: string;
	readonly channelId: string;
	readonly capabilities: ChannelCapabilities;
	setHandlers(handlers: ChannelHandlers): void;
	/** Starts connecting and polling; returns at once. */
	start(): void;
	/** Stops polling and closes the connection; resolves once it is gone. */
	stop(): Promise<void>;
	status(): ChannelStatus;
	/** Sends text: Markdown when `capabilities.markdown`, converted and split for the platform. */
	sendText(target: ChannelTarget, text: string, options?: ChannelSendOptions): Promise<SentMessage>;
	/** Edits a sent message's text and buttons. */
	editText(target: ChannelTarget, messageId: string, text: string, options?: ChannelSendOptions): Promise<void>;
	deleteMessage(target: ChannelTarget, messageId: string): Promise<void>;
	/** Shows a progress draft; present when `capabilities.drafts`. */
	sendDraft?(target: ChannelTarget, draftId: number, text: string): Promise<void>;
	/** Reads an inbound file's bytes and the metadata the library needs, within the user's file size limit. */
	downloadFile(
		file: InboundFile,
		options: DownloadFileOptions,
	): Promise<{ bytes: Uint8Array; name: string; mediaType: string }>;
	/** Creates a topic in a private chat and returns its id; present when `capabilities.topics`. */
	createTopic?(chatId: string, name: string): Promise<string>;
}
