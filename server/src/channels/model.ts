/**
 * The internal chat channel interface (doc/design/channels.md "Channel kinds"). A platform adapter receives
 * messages and button presses and can send, edit and delete messages; the optional capabilities `drafts` and
 * `topics` let the core use a better primitive when the platform has one. The core never talks to a platform
 * itself, so Satori only has to implement this interface.
 */

/** The kinds of channel crhs knows; Satori is the later one. */
export type ChannelKind = "telegram" | "satori";

/** What an adapter's connection is doing (the admin page's state). */
export type ChannelState = "disabled" | "connecting" | "connected" | "unavailable";

export interface ChannelStatus {
	state: ChannelState;
	/** Why the last attempt failed; null when it succeeded. */
	lastError: string | null;
	/** When the next automatic attempt is scheduled while unavailable. */
	nextAttemptAt: string | null;
	/** The bot's username or another platform label, once known; null before the first connection. */
	account: string | null;
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

/** A private-chat message as the core sees it. */
export interface InboundMessage {
	/** The platform's update id, for idempotent submissions and the cursor. */
	updateId: number;
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
	/** Sends Markdown text, converted and split for the platform. */
	sendText(target: ChannelTarget, text: string, options?: ChannelSendOptions): Promise<SentMessage>;
	/** Edits a sent message's text and buttons. */
	editText(target: ChannelTarget, messageId: string, text: string, options?: ChannelSendOptions): Promise<void>;
	deleteMessage(target: ChannelTarget, messageId: string): Promise<void>;
	/** Shows a progress draft; present when `capabilities.drafts`. */
	sendDraft?(target: ChannelTarget, draftId: number, text: string): Promise<void>;
	/** Reads an inbound file's bytes and the metadata the library needs. */
	downloadFile(file: InboundFile): Promise<{ bytes: Uint8Array; name: string; mediaType: string }>;
	/** Creates a topic in a private chat and returns its id; present when `capabilities.topics`. */
	createTopic?(chatId: string, name: string): Promise<string>;
}
