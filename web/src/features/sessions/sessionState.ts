/**
 * Client state of one agent session, as a pure reducer over pi-durable "agent events" (the `events` SSE batches).
 * The first event of every connection is a `snapshot`, which replaces everything.
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
	/** Counter that keeps `liveKey` unique per streamed message in this view. */
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
			let entries: SessionState["entries"] = [];
			for (const e of event.entries) entries = addEntry(entries, e);
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
			return {
				ready: true,
				entries,
				streaming,
				liveKey: streaming === undefined ? undefined : "live/1",
				liveCount: streaming === undefined ? 0 : 1,
				streamedKeys: {},
				tools,
				running: event.run !== undefined,
				compactions: (event.compactions ?? []).map((c) => ({ taskId: String(c.taskId), reason: c.reason })),
				queued: event.inbox.length,
				retry: event.generation?.retry?.error,
				failure: undefined,
				usage: event.usage,
				historyCursor: event.historyCursor ?? null,
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

// ---- derived view ----

export type TranscriptItem =
	| { kind: "user"; key: string; text: string; at?: number }
	| {
			kind: "text";
			key: string;
			text: string;
			streaming: boolean;
			/** The row came from the live stream and keeps its `StreamingTextStore` after commit. */
			live?: boolean;
			/** Epoch ms when the producing assistant message started. */
			at?: number;
			/** How long the producing assistant message took. */
			durationMs?: number;
	  }
	| {
			kind: "thinking";
			key: string;
			text: string;
			streaming: boolean;
			/** The row came from the live stream and keeps its `StreamingTextStore` after commit. */
			live?: boolean;
	  }
	| {
			kind: "tool";
			key: string;
			callId: string;
			name: string;
			args: JsonObject;
			status: "pending" | "running" | "done";
			output: string;
			details: Json | undefined;
			/** The result's content blocks, one per block: a text result has a raw and a note block (D112). */
			result: { text: string; isError: boolean; details: Json | undefined; blocks?: string[] } | undefined;
	  }
	| { kind: "error"; key: string; reason: "aborted" | "failed"; message: string | null }
	| { kind: "compaction"; key: string; text: string }
	| { kind: "compacting"; key: string };

function userText(content: string | { type: string; text?: string }[]): string {
	return typeof content === "string"
		? content
		: content.map((c) => (c.type === "text" ? (c.text ?? "") : "[image]")).join("");
}

/** The result's text blocks in order; an old result has exactly one. */
function textBlocks(content: { type: string; text?: string }[]): string[] {
	return content.filter((c) => c.type === "text").map((c) => c.text ?? "");
}

/**
 * The numeric commit order of an entry id; `undefined` for ids that are not
 * finite numbers. A snapshot lists entries in the model's view order (a
 * compaction comes before the messages it kept), so the transcript re-sorts by
 * id to match the order the entries committed in (doc/webui.md "消息渲染").
 */
function entryOrder(id: string): number | undefined {
	if (id.trim() === "") return undefined;
	const value = Number(id);
	return Number.isFinite(value) ? value : undefined;
}

/** The transcript in display order: tool results are folded into their call's card. */
export function transcript(state: SessionState): TranscriptItem[] {
	// Sort a copy: entries keep their arrival order in the state, so prepending a
	// history page and reducing live events stay untouched. Non-numeric ids
	// compare equal, so a stable sort keeps their relative position.
	const ordered = [...state.entries].sort((a, b) => {
		const left = entryOrder(a.id);
		const right = entryOrder(b.id);
		return left === undefined || right === undefined ? 0 : left - right;
	});
	const results = new Map<string, Extract<Message, { role: "toolResult" }>>();
	for (const { message } of ordered) if (message.role === "toolResult") results.set(message.toolCallId, message);
	const items: TranscriptItem[] = [];
	const addAssistant = (
		key: string,
		m: Extract<Message, { role: "assistant" }>,
		streaming: boolean,
		liveRow: boolean,
	) => {
		const timing = {
			...(m.timestamp === undefined ? {} : { at: m.timestamp }),
			...(m.durationMs === undefined ? {} : { durationMs: m.durationMs }),
		};
		m.content.forEach((b, i) => {
			const k = `${key}/${i}`;
			// While streaming, a block is listed from its first delta; its text is
			// read from the row's own StreamingTextStore, not from this snapshot.
			if (b.type === "text") {
				const text = (b as TextBlock).text;
				if (text || streaming)
					items.push({ kind: "text", key: k, text, streaming, ...(liveRow ? { live: true } : {}), ...timing });
			} else if (b.type === "thinking") {
				const text = (b as ThinkingBlock).thinking;
				if (text || streaming)
					items.push({ kind: "thinking", key: k, text, streaming, ...(liveRow ? { live: true } : {}) });
			} else if (b.type === "toolCall") {
				const call = b as ToolCallBlock;
				const live = state.tools[call.id];
				const res = results.get(call.id);
				items.push({
					kind: "tool",
					key: k,
					callId: call.id,
					name: call.name,
					args: call.arguments ?? {},
					status: res ? "done" : (live?.status ?? "pending"),
					output: live?.output ?? "",
					details: res?.details ?? live?.details,
					result: res
						? {
								text: userText(res.content),
								isError: res.isError,
								details: res.details,
								blocks: textBlocks(res.content),
							}
						: undefined,
				});
			}
		});
		if (!streaming && (m.stopReason === "error" || m.stopReason === "aborted")) {
			items.push({
				kind: "error",
				key: `${key}/stop`,
				reason: m.stopReason === "aborted" ? "aborted" : "failed",
				message: m.errorMessage ?? null,
			});
		}
	};
	for (const { id, kind, message } of ordered) {
		if (kind === "pi.compaction" && message.role === "user") {
			items.push({ kind: "compaction", key: id, text: userText(message.content) });
		} else if (message.role === "user")
			items.push({
				kind: "user",
				key: id,
				text: userText(message.content),
				...(message.timestamp === undefined ? {} : { at: message.timestamp }),
			});
		else if (message.role === "assistant") {
			const liveKey = state.streamedKeys[id];
			addAssistant(liveKey ?? id, message, false, liveKey !== undefined);
		}
	}
	if (state.streaming) addAssistant(state.liveKey ?? "streaming", state.streaming, true, true);
	// One live row per running compaction, always after everything already shown (doc/webui.md "消息渲染").
	for (const { taskId } of state.compactions) items.push({ kind: "compacting", key: `compacting/${taskId}` });
	return items;
}

/** `details.state === "awaiting_approval"` with an approval link, as cluster tools publish while waiting. */
export function approvalWait(details: Json | undefined): { url: string } | undefined {
	if (!details || typeof details !== "object" || Array.isArray(details)) return undefined;
	if (details.state !== "awaiting_approval") return undefined;
	const url = details.approval_url;
	return typeof url === "string" ? { url } : undefined;
}

/**
 * `details.state === "awaiting_authorization"` with the link to the signing page, as cluster tools
 * publish while a privileged task waits for the user's signature (doc/privilege.md).
 */
export function authorizationWait(details: Json | undefined): { url: string } | undefined {
	if (!details || typeof details !== "object" || Array.isArray(details)) return undefined;
	if (details.state !== "awaiting_authorization") return undefined;
	const url = details.authorization_url;
	return typeof url === "string" ? { url } : undefined;
}

/** Pretty-prints JSON text; undefined when the text is not a JSON object or array. */
export function prettyJson(text: string): { pretty: string; value: JsonObject | Json[] } | undefined {
	const t = text.trim();
	if (!t.startsWith("{") && !t.startsWith("[")) return undefined;
	try {
		const value = JSON.parse(t) as JsonObject | Json[];
		return { pretty: JSON.stringify(value, null, 2), value };
	} catch {
		return undefined;
	}
}
