import { expect, test } from "vitest";
import {
	type AgentEvent,
	applyOutput,
	approvalWait,
	type EntryRecord,
	initialState,
	prettyJson,
	reduceAll,
	safeHashLink,
	type TranscriptItem,
	transcript,
	usageTotals,
} from "./sessionState.ts";

const usage = (total: number) => ({
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: total,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: total / 1000 },
});
const userEntry = (id: string, text: string): EntryRecord => ({
	id,
	kind: "pi.user",
	model: [{ role: "user", content: text }],
});
const assistantEntry = (id: string, content: unknown[], stopReason = "stop"): EntryRecord => ({
	id,
	kind: "pi.assistant",
	model: [{ role: "assistant", content: content as never, stopReason }],
});
const emptySnapshot: AgentEvent = { type: "snapshot", snapshot: { entries: [], tools: [], inbox: [] } };

test("an unwrapped snapshot works too", () => {
	const s = reduceAll(initialState, [{ type: "snapshot", entries: [userEntry("1", "x")], tools: [], inbox: [] }]);
	expect(s.entries).toHaveLength(1);
});

test("a snapshot builds the transcript and the in-flight message", () => {
	const s = reduceAll(initialState, [
		{
			type: "snapshot",
			entries: [
				userEntry("1", "hi"),
				assistantEntry("2", [{ type: "text", text: "hello" }]),
				{ id: "3", kind: "pi.system" },
			],
			run: { inputs: ["s1"] },
			generation: { attempt: 1, message: { role: "assistant", content: [{ type: "text", text: "par" }] } },
			tools: [{ callId: "c", name: "exec", status: "running", output: "abc" }],
			inbox: [],
			usage: { models: { "faux/x": usage(1500) }, tools: {} },
		},
	]);
	expect(s.ready).toBe(true);
	expect(s.running).toBe(true);
	expect(s.tools.c?.output).toBe("abc");
	expect(transcript(s).map((i) => [i.kind, "text" in i ? i.text : ""])).toEqual([
		["user", "hi"],
		["text", "hello"],
		["text", "par"],
	]);
	expect(usageTotals(s.usage)).toEqual({ tokens: 1500 });
});

test("a reconnect snapshot resets the state", () => {
	const a = reduceAll(initialState, [emptySnapshot, { type: "entry_appended", entry: userEntry("1", "x") }]);
	expect(a.entries).toHaveLength(1);
	expect(reduceAll(a, [emptySnapshot]).entries).toHaveLength(0);
});

test("user message, streamed text and the committed entry", () => {
	let s = reduceAll(initialState, [
		emptySnapshot,
		{ type: "run_start", inputs: ["s1"] },
		{ type: "message_start", message: { role: "user", content: "hi" } },
		{ type: "message_end", entry: userEntry("1", "hi") },
		{ type: "turn_start" },
		{ type: "message_start", message: { role: "assistant", content: [] } },
		{
			type: "message_update",
			usage: usage(1),
			changes: [{ type: "text_start", contentIndex: 0, block: { type: "text", text: "" } }],
		},
		{ type: "message_update", usage: usage(2), changes: [{ type: "text_delta", contentIndex: 0, delta: "Hel" }] },
	]);
	expect(s.running).toBe(true);
	expect(transcript(s).at(-1)).toMatchObject({ kind: "text", text: "Hel", streaming: true });
	s = reduceAll(s, [
		{ type: "message_update", changes: [{ type: "text_delta", contentIndex: 0, delta: "lo" }] },
		{ type: "message_end", entry: assistantEntry("2", [{ type: "text", text: "Hello" }]) },
		{ type: "turn_end" },
		{ type: "run_end", inputs: ["s1"] },
	]);
	expect(s.streaming).toBeUndefined();
	expect(s.running).toBe(false);
	expect(transcript(s)).toEqual([
		{ kind: "user", key: "1", text: "hi" },
		{ kind: "text", key: "2/0", text: "Hello", streaming: false },
	]);
});

test("thinking streams into its own item", () => {
	const s = reduceAll(initialState, [
		emptySnapshot,
		{ type: "message_start", message: { role: "assistant", content: [] } },
		{
			type: "message_update",
			changes: [
				{ type: "thinking_start", contentIndex: 0, block: { type: "thinking", thinking: "" } },
				{ type: "thinking_delta", contentIndex: 0, delta: "hmm" },
				{ type: "text_start", contentIndex: 1, block: { type: "text", text: "" } },
				{ type: "text_delta", contentIndex: 1, delta: "ok" },
			],
		},
	]);
	expect(transcript(s).map((i) => i.kind)).toEqual(["thinking", "text"]);
});

const callBlock = { type: "toolCall", id: "call-1", name: "exec", arguments: { node: "n1", argv: ["echo", "hi"] } };

test("a tool call: streamed arguments, running output, result, second turn", () => {
	let s = reduceAll(initialState, [
		emptySnapshot,
		{ type: "run_start", inputs: ["s1"] },
		{ type: "message_end", entry: userEntry("1", "run it") },
		{ type: "message_start", message: { role: "assistant", content: [] } },
		{
			type: "message_update",
			changes: [
				{
					type: "toolcall_start",
					contentIndex: 0,
					block: { type: "toolCall", id: "call-1", name: "exec", arguments: {} },
				},
				{ type: "toolcall_delta", contentIndex: 0, path: ["node"], delta: "n" },
				{ type: "toolcall_delta", contentIndex: 0, path: ["node"], delta: "1" },
				{ type: "toolcall_delta", contentIndex: 0, path: ["argv", 0], delta: "echo" },
			],
		},
	]);
	const partial = transcript(s).at(-1) as Extract<TranscriptItem, { kind: "tool" }>;
	expect(partial.args).toEqual({ node: "n1", argv: ["echo"] });
	expect(partial.status).toBe("pending");

	s = reduceAll(s, [
		{ type: "message_end", entry: assistantEntry("2", [callBlock], "toolUse") },
		{ type: "tool_execution_start", toolCallId: "call-1", toolName: "exec", args: callBlock.arguments },
		{ type: "tool_execution_update", toolCallId: "call-1", toolName: "exec", output: { append: "line 1\n" } },
		{
			type: "tool_execution_update",
			toolCallId: "call-1",
			toolName: "exec",
			details: { state: "awaiting_approval", approval_url: "http://x/#/approvals/tasks/t1" },
		},
	]);
	let tool = transcript(s).at(-1) as Extract<TranscriptItem, { kind: "tool" }>;
	expect(tool).toMatchObject({ status: "running", output: "line 1\n", result: undefined });
	expect(approvalWait(tool.details)).toEqual({ url: "http://x/#/approvals/tasks/t1" });

	s = reduceAll(s, [
		{
			type: "tool_execution_update",
			toolCallId: "call-1",
			toolName: "exec",
			output: { trimStart: 7, append: "line 2\n" },
		},
	]);
	expect(s.tools["call-1"]?.output).toBe("line 2\n");

	const result: EntryRecord = {
		id: "3",
		kind: "pi.tool-result",
		model: [
			{
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "exec",
				content: [{ type: "text", text: '{"state":"exited","exit_code":0}' }],
				isError: false,
			},
		],
	};
	s = reduceAll(s, [
		{ type: "tool_execution_end", toolCallId: "call-1", toolName: "exec", entry: result },
		{ type: "entry_appended", entry: result }, // duplicates are ignored
		{ type: "message_start", message: { role: "assistant", content: [] } },
		{
			type: "message_update",
			changes: [{ type: "text_start", contentIndex: 0, block: { type: "text", text: "Done" } }],
		},
		{ type: "message_end", entry: assistantEntry("4", [{ type: "text", text: "Done" }]) },
		{ type: "run_end", inputs: ["s1"] },
	]);
	expect(s.entries).toHaveLength(4);
	tool = transcript(s).find((i) => i.kind === "tool") as typeof tool;
	expect(tool.status).toBe("done");
	expect(tool.result?.text).toContain("exit_code");

	// second turn
	s = reduceAll(s, [
		{ type: "run_start", inputs: ["s2"] },
		{ type: "message_end", entry: userEntry("5", "again") },
		{ type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "" }] } },
		{ type: "message_update", changes: [{ type: "text_delta", contentIndex: 0, delta: "Sure" }] },
	]);
	expect(transcript(s).map((i) => i.kind)).toEqual(["user", "tool", "text", "user", "text"]);
	expect(s.running).toBe(true);
});

test("nested tool events are ignored; errors and aborts show", () => {
	let s = reduceAll(initialState, [
		emptySnapshot,
		{ type: "tool_execution_start", toolCallId: "c/k", toolName: "inner", args: {}, parentToolCallId: "c" },
	]);
	expect(s.tools).toEqual({});
	s = reduceAll(s, [{ type: "message_end", entry: assistantEntry("1", [], "aborted") }]);
	expect(transcript(s)).toEqual([{ kind: "error", key: "1/stop", text: "Stopped." }]);
});

test("retry and failure state", () => {
	let s = reduceAll(initialState, [
		emptySnapshot,
		{ type: "auto_retry_start", attempt: 1, at: 0, errorMessage: "overloaded" },
	]);
	expect(s.retry).toBe("overloaded");
	s = reduceAll(s, [
		{ type: "auto_retry_end", attempt: 1 },
		{ type: "task_failed", taskId: "t", kind: "x", message: "boom" },
	]);
	expect(s.retry).toBeUndefined();
	expect(s.failure).toBe("boom");
});

test("helpers", () => {
	expect(applyOutput("abc", { set: "z" })).toBe("z");
	expect(applyOutput("abc", { trimStart: 1 })).toBe("bc");
	expect(prettyJson('{"a":1}')?.pretty).toBe('{\n  "a": 1\n}');
	expect(prettyJson("plain")).toBeUndefined();
	expect(prettyJson("{oops")).toBeUndefined();
	expect(safeHashLink("http://h:1/#/approvals/tasks/abc")).toBe("#/approvals/tasks/abc");
	expect(safeHashLink("javascript:alert(1)")).toBeUndefined();
	expect(approvalWait({ state: "exited" })).toBeUndefined();
	expect(usageTotals(undefined)).toBeUndefined();
});
