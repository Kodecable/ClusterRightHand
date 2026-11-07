/**
 * Client state of one agent session, as a pure reducer over pi-durable "agent events" (the `events` SSE batches).
 * The first event of every connection is a `snapshot`, which replaces everything.
 */

import type {
	AgentEvent,
	EntryRecord,
	Json,
	JsonObject,
	Message,
	MessageChange,
	TextBlock,
	ThinkingBlock,
	ToolCallBlock,
	UsageState,
} from "./session-events";

/** A live (or finished-this-run) tool call, from `tool_execution_*` events. */
export interface LiveTool {
	callId: string;
	name: string;
	status: "pending" | "running" | "done";
	args?: JsonObject;
	output: string;
	details?: Json;
}

export interface SessionState {
	/** False until the first snapshot arrived. */
	ready: boolean;
	/** Committed transcript messages in order; `kind` keeps the entry type (`pi.compaction` is a note row). */
	entries: { id: string; kind: string; message: Message }[];
	/** The assistant message being generated. */
	streaming: Extract<Message, { role: "assistant" }> | undefined;
	/**
	 * The render key of the message being generated. Its rows keep this key
	 * after `message_end`, so the committed message is the same React element
	 * (and the same `TranscriptStreams` store) instead of a one-shot rerender of
	 * the whole Markdown tree (doc/webui.md "SafeMarkdown" has the block cache).
	 */
	liveKey: string | undefined;
	/** Counter that keeps `liveKey` unique per streamed message in this view, across reconnect snapshots. */
	liveCount: number;
	/** Entry id → its live render key, for messages that arrived through the stream. */
	streamedKeys: Record<string, string>;
	tools: Record<string, LiveTool>;
	running: boolean;
	/** Live context compactions by task id. A manual one outlives the run, so `run_end` keeps them. */
	compactions: { taskId: string; reason: string }[];
	queued: number;
	retry: string | undefined;
	failure: string | undefined;
	usage: UsageState | undefined;
	/** Cursor of the page before the oldest loaded entry; null when nothing older exists. */
	historyCursor: string | null;
}

export const initialState: SessionState = {
	ready: false,
	entries: [],
	streaming: undefined,
	liveKey: undefined,
	liveCount: 0,
	streamedKeys: {},
	tools: {},
	running: false,
	compactions: [],
	queued: 0,
	retry: undefined,
	failure: undefined,
	usage: undefined,
	historyCursor: null,
};

const SHOWN_KINDS = new Set(["pi.user", "pi.assistant", "pi.tool-result", "pi.compaction"]);

type ShownEntry = SessionState["entries"][number];

function shownEntry(entry: EntryRecord | undefined): ShownEntry | undefined {
	if (!entry || !SHOWN_KINDS.has(entry.kind)) return undefined;
	const message = entry.model?.[0];
	if (!message) return undefined;
	return { id: String(entry.id), kind: entry.kind, message };
}

function addEntry(entries: SessionState["entries"], entry: EntryRecord | undefined): SessionState["entries"] {
	const shown = shownEntry(entry);
	if (!shown || entries.some((e) => e.id === shown.id)) return entries;
	return [...entries, shown];
}

/** The numeric commit order of an entry id; entry ids are conversation sequence numbers. */
function entrySequence(id: string): number | undefined {
	if (id.trim() === "") return undefined;
	const value = Number(id);
	return Number.isFinite(value) ? value : undefined;
}

/**
 * A snapshot only carries the newest page of entries (doc/webui.md "会话事件流和历史").
 * Older pages the reader already loaded are not repeated in it, so they stay in
 * front on a reconnect, provided the two ranges overlap: at least one entry of
 * the previous state also appears in the snapshot. That overlap proves the
 * snapshot begins at or before the previous state's newest entry, so nothing
 * between them is missing. Without it (more than a page of entries were added
 * while disconnected), keeping the old page would leave a gap that no history
 * cursor can load, so the snapshot replaces the transcript and supplies the
 * cursor. Entries are identified by their numeric commit order; a snapshot
 * whose entries have no order replaces the transcript as before.
 */
function mergeSnapshotEntries(
	previous: SessionState["entries"],
	entries: readonly EntryRecord[],
): { entries: SessionState["entries"]; keptOlder: boolean } {
	let next: SessionState["entries"] = [];
	for (const entry of entries) next = addEntry(next, entry);
	const previousIds = new Set(previous.map((entry) => entry.id));
	const continuous = entries.some((entry) => previousIds.has(String(entry.id)));
	if (!continuous) return { entries: next, keptOlder: false };
	let oldest: number | undefined;
	for (const entry of next) {
		const sequence = entrySequence(entry.id);
		if (sequence !== undefined && (oldest === undefined || sequence < oldest)) oldest = sequence;
	}
	if (oldest === undefined) return { entries: next, keptOlder: false };
	const seen = new Set(next.map((entry) => entry.id));
	const older = previous.filter((entry) => {
		const sequence = entrySequence(entry.id);
		return sequence !== undefined && sequence < oldest && !seen.has(entry.id);
	});
	if (older.length === 0) return { entries: next, keptOlder: false };
	return { entries: [...older, ...next], keptOlder: true };
}

/**
 * Prepends one page of older entries and moves `historyCursor` back
 * (doc/webui.md "会话事件流和历史"). Purely a prepend: the live streaming
 * message, the running flag, the tool slots and the usage are left untouched,
 * and an entry that raced into the live stream is not duplicated. A tool
 * result on the newly loaded page whose call sits on a page not loaded yet is
 * kept in the entries; `transcript()` folds it into the call once that page
 * arrives (and ignores a result without a call), so page order never matters.
 */
export function prependHistory(
	state: SessionState,
	entries: readonly EntryRecord[],
	historyCursor: string | null,
): SessionState {
	const seen = new Set(state.entries.map((entry) => entry.id));
	const prepended: ShownEntry[] = [];
	for (const entry of entries) {
		const shown = shownEntry(entry);
		if (!shown || seen.has(shown.id)) continue;
		seen.add(shown.id);
		prepended.push(shown);
	}
	if (prepended.length === 0 && state.historyCursor === historyCursor) return state;
	return { ...state, entries: [...prepended, ...state.entries], historyCursor };
}

function asAssistant(m: Message | undefined): SessionState["streaming"] {
	return m && m.role === "assistant" ? { ...m, content: [...m.content] } : undefined;
}

/** The render key for a new streamed message; the previous key stays on its own row. */
function nextLiveKey(state: SessionState): Pick<SessionState, "liveKey" | "liveCount"> {
	const liveCount = state.liveCount + 1;
	return { liveKey: `live/${liveCount}`, liveCount };
}

/** Make sure a live message created without `message_start` (a bare delta) has a key. */
function ensureLiveKey(state: SessionState): Pick<SessionState, "liveKey" | "liveCount"> {
	return state.liveKey === undefined ? nextLiveKey(state) : { liveKey: state.liveKey, liveCount: state.liveCount };
}

function setAt(root: Json, path: readonly (string | number)[], delta: string): Json {
	if (path.length === 0) return typeof root === "string" ? root + delta : delta;
	const [head, ...rest] = path as [string | number, ...(string | number)[]];
	if (Array.isArray(root) || (typeof head === "number" && (root === null || typeof root !== "object"))) {
		const copy = Array.isArray(root) ? [...root] : [];
		copy[head as number] = setAt(copy[head as number] ?? null, rest, delta);
		return copy;
	}
	const obj: JsonObject = root !== null && typeof root === "object" ? { ...root } : {};
	obj[String(head)] = setAt(obj[String(head)] ?? null, rest, delta);
	return obj;
}

function applyChange(m: NonNullable<SessionState["streaming"]>, change: MessageChange): SessionState["streaming"] {
	if (change.type === "message") return asAssistant(change.message) ?? m;
	const content = [...m.content];
	const i = change.contentIndex;
	switch (change.type) {
		case "text_start":
		case "thinking_start":
		case "toolcall_start":
		case "block":
			content[i] = change.block;
			break;
		case "text_delta": {
			const b = content[i];
			content[i] = { type: "text", ...(b as object), text: ((b as TextBlock | undefined)?.text ?? "") + change.delta };
			break;
		}
		case "thinking_delta": {
			const b = content[i];
			content[i] = {
				type: "thinking",
				...(b as object),
				thinking: ((b as ThinkingBlock | undefined)?.thinking ?? "") + change.delta,
			};
			break;
		}
		case "toolcall_delta": {
			const b = (content[i] ?? { type: "toolCall", id: "", name: "", arguments: {} }) as ToolCallBlock;
			const args = setAt(b.arguments, change.path, change.delta);
			content[i] = { ...b, arguments: args as JsonObject };
			break;
		}
	}
	return { ...m, content };
}

export function applyOutput(
	current: string,
	output: { trimStart?: number; append?: string } | { set: string } | undefined,
): string {
	if (!output) return current;
	if ("set" in output) return output.set;
	return current.slice(output.trimStart ?? 0) + (output.append ?? "");
}

function liveTool(state: SessionState, callId: string, name: string): LiveTool {
	return state.tools[callId] ?? { callId, name, status: "pending", output: "" };
}

export function reduce(state: SessionState, event: AgentEvent): SessionState {
	switch (event.type) {
		case "snapshot": {
			if ("snapshot" in event) return reduce(state, { ...event.snapshot, type: "snapshot" });
			const snapshotEntries = mergeSnapshotEntries(state.entries, event.entries);
			const tools: Record<string, LiveTool> = {};
			for (const t of event.tools) {
				tools[t.callId] = {
					callId: t.callId,
					name: t.name,
					status: t.status,
					output: t.output ?? "",
					...(t.details === undefined ? {} : { details: t.details }),
				};
			}
			const streaming = asAssistant(event.generation?.message);
			// The counter never resets: a reconnect snapshot can carry another
			// generation, and its rows must not inherit a finished message's store.
			const live = streaming === undefined ? undefined : nextLiveKey(state);
			return {
				ready: true,
				entries: snapshotEntries.entries,
				streaming,
				liveKey: live?.liveKey,
				liveCount: live?.liveCount ?? state.liveCount,
				streamedKeys: {},
				tools,
				running: event.run !== undefined,
				compactions: (event.compactions ?? []).map((c) => ({ taskId: String(c.taskId), reason: c.reason })),
				queued: event.inbox.length,
				retry: event.generation?.retry?.error,
				failure: undefined,
				usage: event.usage,
				// Older pages that were kept already end before the snapshot's page,
				// so the cursor that follows them is still the previous one.
				historyCursor: snapshotEntries.keptOlder ? state.historyCursor : (event.historyCursor ?? null),
			};
		}
		case "run_start":
			return { ...state, running: true, failure: undefined };
		case "run_end":
			// A manual compaction can outlive its run, so `compactions` is not cleared here.
			return { ...state, running: false, streaming: undefined, liveKey: undefined, retry: undefined, tools: {} };
		case "message_start": {
			const streaming = asAssistant(event.message);
			return streaming ? { ...state, streaming, ...nextLiveKey(state), retry: undefined } : state;
		}
		case "message_update": {
			let streaming = state.streaming ?? { role: "assistant" as const, content: [] };
			for (const c of event.changes) streaming = applyChange(streaming, c) ?? streaming;
			if (event.usage) streaming = { ...streaming, usage: event.usage };
			return { ...state, streaming, ...ensureLiveKey(state) };
		}
		case "message_end": {
			const isAssistant = event.entry.model?.[0]?.role === "assistant";
			if (!isAssistant) return { ...state, entries: addEntry(state.entries, event.entry) };
			// The committed entry takes over the row key of the streamed message, so
			// nothing remounts when the incremental text becomes the final text.
			const streamedKeys =
				state.liveKey === undefined
					? state.streamedKeys
					: { ...state.streamedKeys, [String(event.entry.id)]: state.liveKey };
			return {
				...state,
				entries: addEntry(state.entries, event.entry),
				streaming: undefined,
				liveKey: undefined,
				streamedKeys,
			};
		}
		case "entry_appended":
			return { ...state, entries: addEntry(state.entries, event.entry) };
		case "tool_execution_start": {
			if (event.parentToolCallId) return state;
			const prev = liveTool(state, event.toolCallId, event.toolName);
			const tool: LiveTool = { ...prev, status: "running", args: event.args };
			return { ...state, tools: { ...state.tools, [event.toolCallId]: tool } };
		}
		case "tool_execution_update": {
			if (event.parentToolCallId) return state;
			const prev = liveTool(state, event.toolCallId, event.toolName);
			const tool: LiveTool = {
				...prev,
				status: prev.status === "done" ? "done" : "running",
				output: applyOutput(prev.output, event.output),
				...(event.details === undefined
					? {}
					: event.details === null
						? { details: undefined }
						: { details: event.details }),
			};
			return { ...state, tools: { ...state.tools, [event.toolCallId]: tool } };
		}
		case "tool_execution_end": {
			if (event.parentToolCallId) return state;
			const prev = liveTool(state, event.toolCallId, event.toolName);
			return {
				...state,
				entries: addEntry(state.entries, event.entry),
				tools: { ...state.tools, [event.toolCallId]: { ...prev, status: "done", output: "" } },
			};
		}
		case "inbox_update":
			return { ...state, queued: event.items.length };
		case "usage_changed":
			return { ...state, usage: event.usage };
		case "auto_retry_start":
			return { ...state, retry: event.errorMessage };
		case "auto_retry_end":
			return { ...state, retry: undefined };
		case "task_failed":
			return { ...state, failure: event.message };
		case "compaction_start": {
			const taskId = String(event.taskId);
			if (state.compactions.some((compaction) => compaction.taskId === taskId)) return state;
			return { ...state, compactions: [...state.compactions, { taskId, reason: event.reason }] };
		}
		case "compaction_end": {
			const taskId = String(event.taskId);
			const compactions = state.compactions.filter((compaction) => compaction.taskId !== taskId);
			return compactions.length === state.compactions.length ? state : { ...state, compactions };
		}
		default:
			return state;
	}
}

export function reduceAll(state: SessionState, events: readonly AgentEvent[]): SessionState {
	return events.reduce(reduce, state);
}

/** Whether a context compaction is running: the session counts as running while one is. */
export function isCompacting(state: SessionState): boolean {
	return state.compactions.length > 0;
}
