/**
 * The pi-durable "agent events" a session's `events` SSE batches carry, and the
 * message, block and entry shapes inside them. The first event of every
 * connection is a `snapshot`, which replaces everything (see `session-reducer.ts`).
 */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

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
export type Block = TextBlock | ThinkingBlock | ToolCallBlock | { type: string };

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
	| { role: "system"; content: unknown };

export interface EntryRecord {
	id: string | number;
	kind: string;
	model?: Message[];
	data?: Json;
}

export interface ToolSlot {
	callId: string;
	name: string;
	status: "pending" | "running" | "done";
	output?: string;
	details?: Json;
	entry?: string | number;
}

export type MessageChange =
	| { type: "text_start" | "thinking_start" | "toolcall_start"; contentIndex: number; block: Block }
	| { type: "text_delta" | "thinking_delta"; contentIndex: number; delta: string }
	| { type: "toolcall_delta"; contentIndex: number; path: (string | number)[]; delta: string }
	| { type: "block"; contentIndex: number; block: Block }
	| { type: "message"; message: Message };

export interface UsageState {
	models: Record<string, Usage>;
	tools: Record<string, Usage>;
}

/** Why a context compaction was started. */
export type CompactionReason = "manual" | "threshold" | "overflow";

/** A context compaction the snapshot reports as still running. */
export interface SnapshotCompaction {
	taskId: number | string;
	reason: CompactionReason;
	blocking: boolean;
	attempt: number;
	retry?: { at: number; error: string };
}

export interface SnapshotEvent {
	type: "snapshot";
	/** The newest page of displayable entries (doc/webui.md "会话事件流"). */
	entries: EntryRecord[];
	/** Cursor before the oldest entry above; null when no older entry exists. */
	historyCursor?: string | null;
	run?: { inputs: string[] };
	generation?: { attempt: number; message?: Message; retry?: { at: number; error: string } };
	tools: ToolSlot[];
	inbox: { id: string; mode: string }[];
	usage?: UsageState;
	/** Live compactions (a manual one can outlive its run). */
	compactions?: readonly SnapshotCompaction[];
}

/** What the server sends first: pi-durable's snapshot event wrapped as `{ type: "snapshot", snapshot }`. */
export interface WrappedSnapshotEvent {
	type: "snapshot";
	snapshot: Omit<SnapshotEvent, "type"> & { type?: "snapshot" };
}

export type AgentEvent =
	| SnapshotEvent
	| WrappedSnapshotEvent
	| { type: "run_start" | "run_end"; inputs: string[] }
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
	| { type: "inbox_update"; items: { id: string; mode: string }[] }
	| { type: "entry_appended"; entry: EntryRecord }
	| { type: "usage_changed"; usage: UsageState }
	| { type: "auto_retry_start"; attempt: number; at: number; errorMessage: string }
	| { type: "auto_retry_end"; attempt: number }
	| { type: "task_failed"; taskId: string; kind: string; message: string }
	| { type: "compaction_start"; taskId: number | string; reason: CompactionReason; blocking: boolean }
	| { type: "compaction_end"; taskId: number | string; reason: CompactionReason; error?: string }
	| { type: "agent_changed" | "submission" | "deferred_poll" };
