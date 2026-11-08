/**
 * The session-event boundary: pi-durable's agent events converted to the WebUI's wire types from `@crh/api`.
 *
 * Everything the WebUI receives from a session passes through here, field by field, so pi types never leave
 * server/src/agent/ and an extra pi field cannot leak onto the wire. The `switch` in `toSessionEvent` is exhaustive
 * over pi's event union: a new or renamed pi event is a compile error here, not a silently missing WebUI update.
 */

import type {
	Block,
	EntryRecord,
	Json,
	JsonObject,
	Message,
	MessageChange,
	SessionEvent,
	SnapshotCompaction,
	SnapshotEvent,
	SnapshotState,
	Usage,
	UsageState,
} from "@crh/api";
import type {
	AssistantMessage,
	ImageContent,
	JsonValue,
	JsonObject as PiJsonObject,
	Message as PiMessage,
	Usage as PiUsage,
	TextContent,
} from "@earendil-works/pi-ai";
import type {
	AgentEvent,
	CompactionStatus,
	EntryRecord as PiEntryRecord,
	MessageChange as PiMessageChange,
	SnapshotEvent as PiSnapshotEvent,
	ToolSlot as PiToolSlot,
	UsageState as PiUsageState,
} from "@earendil-works/pi-durable";

/**
 * One pi agent event as the WebUI sees it. `null` means the WebUI's reducer ignores this event today, so it is
 * dropped at the boundary: `agent_changed`, `submission` and `deferred_poll` update no client state (an agent
 * config change is covered by `snapshot`, a submission by `inbox_update`/`message_*`, and a deferred poll by the
 * generation partial the stream already sends).
 */
export function toSessionEvent(event: AgentEvent): SessionEvent | null {
	switch (event.type) {
		case "snapshot":
			return toSnapshotEvent(event);
		case "run_start":
		case "run_end":
			return { type: event.type, inputs: [...event.inputs] };
		case "turn_start":
		case "turn_end":
			return { type: event.type };
		case "message_start":
			return { type: "message_start", message: toMessage(event.message) };
		case "message_update":
			return { type: "message_update", usage: toUsage(event.usage), changes: event.changes.map(toMessageChange) };
		case "message_end":
			return { type: "message_end", entry: toEntryRecord(event.entry) };
		case "tool_execution_start":
			return {
				type: "tool_execution_start",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: toJsonObject(event.args),
				...(event.parentToolCallId === undefined ? {} : { parentToolCallId: event.parentToolCallId }),
			};
		case "tool_execution_update":
			return {
				type: "tool_execution_update",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				...(event.parentToolCallId === undefined ? {} : { parentToolCallId: event.parentToolCallId }),
				...(event.output === undefined ? {} : { output: toToolOutput(event.output) }),
				...(event.details === undefined ? {} : { details: toJson(event.details) }),
			};
		case "tool_execution_end":
			return {
				type: "tool_execution_end",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				...(event.parentToolCallId === undefined ? {} : { parentToolCallId: event.parentToolCallId }),
				...(event.entry === undefined ? {} : { entry: toEntryRecord(event.entry) }),
			};
		case "inbox_update":
			return { type: "inbox_update", items: event.items.map((item) => ({ id: item.id, mode: item.mode })) };
		case "entry_appended":
			return { type: "entry_appended", entry: toEntryRecord(event.entry) };
		case "usage_changed":
			return { type: "usage_changed", usage: toUsageState(event.usage) };
		case "auto_retry_start":
			return { type: "auto_retry_start", attempt: event.attempt, at: event.at, errorMessage: event.errorMessage };
		case "auto_retry_end":
			return { type: "auto_retry_end", attempt: event.attempt };
		case "task_failed":
			return { type: "task_failed", taskId: event.taskId, kind: event.kind, message: event.message };
		case "compaction_start":
			return { type: "compaction_start", taskId: event.taskId, reason: event.reason, blocking: event.blocking };
		case "compaction_end":
			return {
				type: "compaction_end",
				taskId: event.taskId,
				reason: event.reason,
				...(event.error === undefined ? {} : { error: event.error }),
			};
		// The WebUI's reducer has no case for these three; dropping them changes nothing it renders.
		case "agent_changed":
		case "submission":
		case "deferred_poll":
			return null;
		default: {
			// A pi upgrade added an event type: map it here (or drop it deliberately) instead of sending it raw.
			const _exhaustive: never = event;
			throw new Error(`unhandled pi agent event: ${JSON.stringify(_exhaustive)}`);
		}
	}
}

/**
 * The snapshot event a watch starts with (and the form an overflowing stream sends mid-connection). The caller
 * may pass the newest page it selected and its history cursor; otherwise the whole snapshot and no cursor are used.
 */
export function toSnapshotEvent(
	snapshot: PiSnapshotEvent,
	entries: readonly PiEntryRecord[] = snapshot.entries,
	historyCursor?: string | null,
): SnapshotEvent {
	return {
		type: "snapshot",
		snapshot: {
			entries: entries.map(toEntryRecord),
			...(historyCursor === undefined ? {} : { historyCursor }),
			...(snapshot.run === undefined ? {} : { run: { inputs: [...snapshot.run.inputs] } }),
			...(snapshot.generation === undefined ? {} : { generation: toGeneration(snapshot.generation) }),
			tools: snapshot.tools.map(toToolSlot),
			inbox: snapshot.inbox.map((item) => ({ id: item.id, mode: item.mode })),
			usage: toUsageState(snapshot.usage),
			compactions: snapshot.compactions.map(toSnapshotCompaction),
		},
	};
}

/** One pi entry as the WebUI's EntryRecord: identity, kind, model messages and data only. */
export function toEntryRecord(entry: PiEntryRecord): EntryRecord {
	return {
		id: entry.id,
		kind: entry.kind,
		...(entry.model === undefined ? {} : { model: entry.model.map(toMessage) }),
		...(entry.data === undefined ? {} : { data: toJson(entry.data) }),
	};
}

/** One pi-ai message as the wire Message: provider/model bookkeeping and raw signatures stay inside. */
export function toMessage(message: PiMessage): Message {
	switch (message.role) {
		case "user":
			return {
				role: "user",
				content: typeof message.content === "string" ? message.content : toContentBlocks(message.content),
				...(message.timestamp === undefined ? {} : { timestamp: message.timestamp }),
			};
		case "assistant":
			return {
				role: "assistant",
				content: message.content.map(toBlock),
				...(message.usage === undefined ? {} : { usage: toUsage(message.usage) }),
				...(message.stopReason === undefined ? {} : { stopReason: message.stopReason }),
				...(message.errorMessage === undefined ? {} : { errorMessage: message.errorMessage }),
				...(message.timestamp === undefined ? {} : { timestamp: message.timestamp }),
				...(message.durationMs === undefined ? {} : { durationMs: message.durationMs }),
			};
		case "toolResult":
			return {
				role: "toolResult",
				toolCallId: message.toolCallId,
				toolName: message.toolName,
				content: toContentBlocks(message.content),
				...(message.details === undefined ? {} : { details: toJson(message.details) }),
				isError: message.isError,
				...(message.timestamp === undefined ? {} : { timestamp: message.timestamp }),
				...(message.durationMs === undefined ? {} : { durationMs: message.durationMs }),
			};
		case "system":
			return {
				role: "system",
				content: typeof message.content === "string" ? message.content : toContentBlocks(message.content),
			};
		default: {
			const _exhaustive: never = message;
			throw new Error(`unhandled pi message: ${JSON.stringify(_exhaustive)}`);
		}
	}
}

type PiGeneration = NonNullable<PiSnapshotEvent["generation"]>;

function toGeneration(generation: PiGeneration): NonNullable<SnapshotState["generation"]> {
	return {
		attempt: generation.attempt,
		...(generation.message === undefined ? {} : { message: toMessage(generation.message) }),
		...(generation.retry === undefined ? {} : { retry: { at: generation.retry.at, error: generation.retry.error } }),
	};
}

function toMessageChange(change: PiMessageChange): MessageChange {
	switch (change.type) {
		case "text_start":
		case "thinking_start":
		case "toolcall_start":
			return { type: change.type, contentIndex: change.contentIndex, block: toBlock(change.block) };
		case "text_delta":
		case "thinking_delta":
			return { type: change.type, contentIndex: change.contentIndex, delta: change.delta };
		case "toolcall_delta":
			return {
				type: "toolcall_delta",
				contentIndex: change.contentIndex,
				path: [...change.path],
				delta: change.delta,
			};
		case "block":
			return { type: "block", contentIndex: change.contentIndex, block: toBlock(change.block) };
		case "message":
			return { type: "message", message: toMessage(change.message) };
		default: {
			const _exhaustive: never = change;
			throw new Error(`unhandled pi message change: ${JSON.stringify(_exhaustive)}`);
		}
	}
}

/** One assistant content block; an unknown pi block type becomes the wire's open `{ type: string }` form. */
function toBlock(block: AssistantMessage["content"][number]): Block {
	switch (block.type) {
		case "text":
			return { type: "text", text: block.text };
		case "thinking":
			return {
				type: "thinking",
				thinking: block.thinking,
				...(block.redacted === undefined ? {} : { redacted: block.redacted }),
			};
		case "toolCall":
			return {
				type: "toolCall",
				id: block.id,
				name: block.name,
				arguments: toJsonObject(block.arguments),
				...(block.argumentsError === undefined ? {} : { argumentsError: block.argumentsError }),
			};
		default:
			return { type: (block as { type: string }).type };
	}
}

/** A user or tool-result content block. An image keeps only its type: the WebUI renders a placeholder, not pixels. */
function toContentBlocks(content: readonly (TextContent | ImageContent)[]): { type: string; text?: string }[] {
	return content.map((block) => {
		switch (block.type) {
			case "text":
				return { type: "text", text: block.text };
			case "image":
				return { type: "image" };
			default:
				return { type: (block as { type: string }).type };
		}
	});
}

function toUsage(usage: PiUsage): Usage {
	return {
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		totalTokens: usage.totalTokens,
		cost: {
			input: usage.cost.input,
			output: usage.cost.output,
			cacheRead: usage.cost.cacheRead,
			cacheWrite: usage.cost.cacheWrite,
			total: usage.cost.total,
		},
	};
}

function toUsageState(state: PiUsageState): UsageState {
	const models: Record<string, Usage> = {};
	for (const [model, usage] of Object.entries(state.models)) models[model] = toUsage(usage);
	const tools: Record<string, Usage> = {};
	for (const [tool, usage] of Object.entries(state.tools)) tools[tool] = toUsage(usage);
	return { models, tools };
}

function toToolSlot(slot: PiToolSlot): SnapshotState["tools"][number] {
	return {
		callId: slot.callId,
		name: slot.name,
		status: slot.status,
		...(slot.output === undefined ? {} : { output: slot.output }),
		...(slot.details === undefined ? {} : { details: toJson(slot.details) }),
		...(slot.entry === undefined ? {} : { entry: slot.entry }),
	};
}

function toSnapshotCompaction(compaction: CompactionStatus): SnapshotCompaction {
	return {
		taskId: compaction.taskId,
		reason: compaction.reason,
		blocking: compaction.blocking,
		attempt: compaction.attempt,
		...(compaction.retry === undefined ? {} : { retry: { at: compaction.retry.at, error: compaction.retry.error } }),
	};
}

function toToolOutput(output: NonNullable<Extract<AgentEvent, { type: "tool_execution_update" }>["output"]>) {
	return "set" in output ? { set: output.set } : { trimStart: output.trimStart, append: output.append };
}

/** A pi JSON value as the wire's JSON: a fresh tree, never a pi object the caller could still mutate. */
function toJson(value: JsonValue): Json {
	if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
		return value;
	}
	if (Array.isArray(value)) return value.map((item) => toJson(item));
	const object: JsonObject = {};
	for (const [key, item] of Object.entries(value)) object[key] = toJson(item);
	return object;
}

function toJsonObject(value: PiJsonObject): JsonObject {
	const object: JsonObject = {};
	for (const [key, item] of Object.entries(value)) object[key] = toJson(item);
	return object;
}
