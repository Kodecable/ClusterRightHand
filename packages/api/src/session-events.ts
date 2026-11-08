/**
 * The wire format of a session's event stream (`GET /api/sessions/:id/events`) and of its history pages
 * (`GET /api/sessions/:id/entries`), shared by the server and the WebUI (doc/webui.md "会话事件流和历史").
 *
 * The server converts pi-durable's agent events to these types at one boundary
 * (`server/src/agent/session-events.ts`): no pi type reaches the wire, and a pi upgrade that changes an event
 * is a compile error there instead of a silent WebUI break.
 */

/** A JSON value as it appears on the wire. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** A JSON object as it appears on the wire. */
export type JsonObject = { [key: string]: Json };

/** Token and cost counters of one model call or tool result. */
export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

export interface TextBlock {
	type: "text";
	text: string;
}

export interface ThinkingBlock {
	type: "thinking";
	thinking: string;
	redacted?: boolean;
}

export interface ToolCallBlock {
	type: "toolCall";
	id: string;
	name: string;
	arguments: JsonObject;
	argumentsError?: string;
}

/** A content block of an assistant message; `{ type: string }` admits a block type this version does not know. */
export type Block = TextBlock | ThinkingBlock | ToolCallBlock | { type: string };

/** One model-facing message as a session event carries it. */
export type Message =
	| { role: "user"; content: string | { type: string; text?: string }[]; timestamp?: number }
	| {
			role: "assistant";
			content: Block[];
			usage?: Usage;
			stopReason?: string;
			errorMessage?: string;
			timestamp?: number;
			durationMs?: number;
	  }
	| {
			role: "toolResult";
			toolCallId: string;
			toolName: string;
			content: { type: string; text?: string }[];
			details?: Json;
			isError: boolean;
			timestamp?: number;
			durationMs?: number;
	  }
	/** The prompt and tool schemas: the server drops their events, so the WebUI never renders one. */
	| { role: "system"; content: unknown };

/** One transcript entry as the WebUI receives it (pi's conversation bookkeeping fields do not leave the server). */
export interface EntryRecord {
	/** The conversation's commit order; a mock transcript may use strings. */
	id: string | number;
	kind: string;
	/** The model-facing messages the entry contributes. */
	model?: Message[];
	/** Application payload of the entry kind, for example a compaction's reason and summary. */
	data?: Json;
}

/** One tool call of the current round, as the snapshot presents it. */
export interface ToolSlot {
	callId: string;
	name: string;
	status: "pending" | "running" | "done";
	/** The retained running output. */
	output?: string;
	details?: Json;
	/** The result entry once the call is done. */
	entry?: string | number;
}

/** One change to the in-flight assistant message, relative to that message. */
export type MessageChange =
	| { type: "text_start" | "thinking_start" | "toolcall_start"; contentIndex: number; block: Block }
	| { type: "text_delta" | "thinking_delta"; contentIndex: number; delta: string }
	| { type: "toolcall_delta"; contentIndex: number; path: (string | number)[]; delta: string }
	| { type: "block"; contentIndex: number; block: Block }
	| { type: "message"; message: Message };

/** The session's accumulated spend, per model and per tool. */
export interface UsageState {
	models: Record<string, Usage>;
	tools: Record<string, Usage>;
}

/** Why a context compaction was started. */
export type CompactionReason = "manual" | "threshold" | "overflow";

/** A context compaction the snapshot reports as still running. */
export interface SnapshotCompaction {
	taskId: number;
	reason: CompactionReason;
	blocking: boolean;
	attempt: number;
	retry?: { at: number; error: string };
}

/** The state a `snapshot` event carries. */
export interface SnapshotState {
	/** The newest page of displayable entries (doc/webui.md "会话事件流和历史"). */
	entries: EntryRecord[];
	/** Cursor before the oldest entry above; null when no older entry exists. */
	historyCursor?: string | null;
	run?: { inputs: number[] };
	generation?: { attempt: number; message?: Message; retry?: { at: number; error: string } };
	tools: ToolSlot[];
	inbox: { id: number; mode: string }[];
	usage?: UsageState;
	/** Live compactions (a manual one can outlive its run). */
	compactions?: readonly SnapshotCompaction[];
}

/**
 * The first event of every connection: it replaces everything. The server wraps the snapshot state as
 * `{ type: "snapshot", snapshot }`, and a stream that overflows its buffer sends the same form again.
 */
export interface SnapshotEvent {
	type: "snapshot";
	snapshot: SnapshotState;
}

/** Everything an `events` SSE batch of a session carries. */
export type SessionEvent =
	| SnapshotEvent
	| { type: "run_start" | "run_end"; inputs: number[] }
	| { type: "turn_start" | "turn_end" }
	| { type: "message_start"; message: Message }
	| { type: "message_update"; usage?: Usage; changes: MessageChange[] }
	| { type: "message_end"; entry: EntryRecord }
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: JsonObject; parentToolCallId?: string }
	| {
			type: "tool_execution_update";
			toolCallId: string;
			toolName: string;
			parentToolCallId?: string;
			output?: { trimStart?: number; append?: string } | { set: string };
			details?: Json;
	  }
	| {
			type: "tool_execution_end";
			toolCallId: string;
			toolName: string;
			parentToolCallId?: string;
			entry?: EntryRecord;
	  }
	| { type: "inbox_update"; items: { id: number; mode: string }[] }
	| { type: "entry_appended"; entry: EntryRecord }
	| { type: "usage_changed"; usage: UsageState }
	| { type: "auto_retry_start"; attempt: number; at: number; errorMessage: string }
	| { type: "auto_retry_end"; attempt: number }
	| { type: "task_failed"; taskId: number; kind: string; message: string }
	| { type: "compaction_start"; taskId: number; reason: CompactionReason; blocking: boolean }
	| { type: "compaction_end"; taskId: number; reason: CompactionReason; error?: string };

/** `GET /api/sessions/:id/entries`: one page of older entries, oldest first. */
export interface SessionEntriesPage {
	entries: EntryRecord[];
	historyCursor: string | null;
}
