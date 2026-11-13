import { describe, expect, test } from "vitest";
import type { Json } from "./session-events";
import type { TranscriptItem } from "./transcript-items";
import { buildTranscriptTurns } from "./turns";

const user = (key: string, at?: number): TranscriptItem => ({
	kind: "user",
	key,
	text: "do it",
	...(at === undefined ? {} : { at }),
});
const thinking = (key: string): TranscriptItem => ({ kind: "thinking", key, text: "hmm", streaming: false });
const compaction = (key: string): TranscriptItem => ({ kind: "compaction", key, text: "summary" });
const text = (key: string, final: boolean, at?: number, durationMs?: number): TranscriptItem => ({
	kind: "text",
	key,
	text: "done",
	streaming: false,
	final,
	...(at === undefined ? {} : { at }),
	...(durationMs === undefined ? {} : { durationMs }),
});
const error = (key: string): TranscriptItem => ({ kind: "error", key, reason: "failed", message: "boom" });
const tool = (key: string, name: string, details?: Json, isError = false): TranscriptItem => ({
	kind: "tool",
	key,
	callId: `call-${key}`,
	name,
	args: {},
	status: "done",
	output: "",
	details: undefined,
	result: { text: "", isError, details, blocks: [""] },
});

describe("buildTranscriptTurns", () => {
	test("folds a completed turn with process and timing", () => {
		const [turn] = buildTranscriptTurns([user("u1", 1_000), thinking("t1"), text("a1", true, 2_000, 5_000)], false);
		expect(turn?.foldable).toBe(true);
		expect(turn?.ended).toBe(true);
		expect(turn?.durationMs).toBe(6_000);
		expect(turn?.process.map((item) => item.key)).toEqual(["t1"]);
		expect(turn?.final?.key).toBe("a1");
	});

	test("leaves the last turn open while the session is active", () => {
		const [turn] = buildTranscriptTurns([user("u1", 1_000), thinking("t1"), text("a1", true, 2_000, 5_000)], true);
		expect(turn?.foldable).toBe(false);
	});

	test("stays unfolded while the final answer streams and folds once its message ends", () => {
		const streaming = buildTranscriptTurns(
			[
				user("u1", 1_000),
				thinking("t1"),
				{ kind: "text", key: "a1", text: "partial answer", streaming: true, final: false },
			],
			true,
		);
		expect(streaming[0]?.foldable).toBe(false);
		expect(streaming[0]?.final).toBeUndefined();
		const ended = buildTranscriptTurns([user("u1", 1_000), thinking("t1"), text("a1", true, 2_000, 5_000)], false);
		expect(ended[0]?.foldable).toBe(true);
		expect(ended[0]?.final?.key).toBe("a1");
	});

	test("does not treat an intermediate text as the final answer", () => {
		// An assistant message with a tool call streams its text before the call arrives; it is not final.
		const [turn] = buildTranscriptTurns(
			[user("u1", 1_000), thinking("t1"), text("a1", false, 2_000, 5_000), tool("c1", "exec")],
			false,
		);
		expect(turn?.final).toBeUndefined();
		expect(turn?.foldable).toBe(false);
		expect(turn?.process.map((item) => item.key)).toEqual(["t1", "a1", "c1"]);
	});

	test("does not fold a turn without process or without timing", () => {
		const [plain] = buildTranscriptTurns([user("u1", 1_000), text("a1", true, 2_000, 5_000)], false);
		expect(plain?.foldable).toBe(false);
		const [untimed] = buildTranscriptTurns([user("u1"), thinking("t1"), text("a1", true)], false);
		expect(untimed?.foldable).toBe(false);
	});

	test("keeps an error and its turn visible", () => {
		const [turn] = buildTranscriptTurns(
			[
				user("u1", 1_000),
				thinking("t1"),
				{ kind: "error", key: "e1", reason: "failed", message: "boom" },
				text("a1", true, 2_000, 5_000),
			],
			false,
		);
		expect(turn?.foldable).toBe(false);
	});

	test("counts the trailing errors of the running turn into the retry attempt", () => {
		const [one] = buildTranscriptTurns([user("u1"), thinking("t1"), error("e1")], true);
		expect(one?.retryAttempt).toBe(2);
		const [two] = buildTranscriptTurns([user("u1"), error("e1"), error("e2")], true);
		expect(two?.retryAttempt).toBe(3);
	});

	test("shows no retry line once the turn stops ending in an error", () => {
		const [recovered] = buildTranscriptTurns(
			[user("u1"), error("e1"), { kind: "text", key: "a1", text: "again", streaming: true, final: false }],
			true,
		);
		expect(recovered?.retryAttempt).toBeUndefined();
		const [notTrailing] = buildTranscriptTurns([user("u1"), error("e1"), thinking("t1")], true);
		expect(notTrailing?.retryAttempt).toBeUndefined();
	});

	test("shows no retry line when the session stopped or a later turn followed", () => {
		const [stopped] = buildTranscriptTurns([user("u1"), error("e1")], false);
		expect(stopped?.retryAttempt).toBeUndefined();
		const [earlier] = buildTranscriptTurns([user("u1"), thinking("t1"), error("e1"), user("u2"), thinking("t2")], true);
		expect(earlier?.retryAttempt).toBeUndefined();
	});

	test("keeps the user outside the process and starts a new turn at the next user", () => {
		const turns = buildTranscriptTurns(
			[user("u1", 1_000), thinking("t1"), text("a1", true, 2_000, 5_000), user("u2", 10_000), thinking("t2")],
			true,
		);
		expect(turns).toHaveLength(2);
		expect(turns[0]?.foldable).toBe(true);
		expect(turns[0]?.process.map((item) => item.key)).toEqual(["t1"]);
		expect(turns[1]?.foldable).toBe(false);
	});

	test("a trailing compaction does not decide the final answer and stays after it", () => {
		const [turn] = buildTranscriptTurns(
			[user("u1", 1_000), thinking("t1"), text("a1", true, 2_000, 5_000), compaction("c1")],
			false,
		);
		expect(turn?.final?.key).toBe("a1");
		expect(turn?.foldable).toBe(true);
		expect(turn?.process.map((item) => item.key)).toEqual(["t1"]);
		expect(turn?.after.map((item) => item.key)).toEqual(["c1"]);
		expect(turn?.durationMs).toBe(6_000);
	});

	test("a compaction before the final answer stays in the process", () => {
		const [turn] = buildTranscriptTurns(
			[user("u1", 1_000), thinking("t1"), compaction("c1"), text("a1", true, 2_000, 5_000)],
			false,
		);
		expect(turn?.final?.key).toBe("a1");
		expect(turn?.foldable).toBe(true);
		expect(turn?.process.map((item) => item.key)).toEqual(["t1", "c1"]);
		expect(turn?.after).toEqual([]);
		expect(turn?.durationMs).toBe(6_000);
	});

	test("collects a turn's deliveries, deduplicated by source and path", () => {
		const delivery = {
			delivery: {
				source: { library: "user:alice", libraryId: "lib-1", path: "docs/report.txt" },
				name: "report.txt",
				bytes: 1234,
			},
		};
		const [turn] = buildTranscriptTurns(
			[
				user("u1", 1_000),
				tool("c1", "copy_file", delivery),
				tool("c2", "copy_file", delivery),
				tool("c3", "exec"),
				text("a1", true, 2_000, 5_000),
			],
			false,
		);
		expect(turn?.deliveries).toHaveLength(1);
		expect(turn?.deliveries[0]).toMatchObject({ name: "report.txt", bytes: 1234 });
	});

	test("does not show a failed delivery", () => {
		const delivery = {
			delivery: {
				source: { node: "web-1", nodeId: "node-1", path: "/srv/report.txt" },
				name: "report.txt",
				bytes: 12,
			},
		};
		const [turn] = buildTranscriptTurns(
			[user("u1", 1_000), tool("c1", "copy_file", delivery, true), text("a1", true, 2_000, 5_000)],
			false,
		);
		expect(turn?.deliveries).toEqual([]);
	});

	test("each turn keeps its own deliveries", () => {
		const first = {
			delivery: {
				source: { library: "user:alice", libraryId: "lib-1", path: "docs/a.txt" },
				name: "a.txt",
				bytes: 1,
			},
		};
		const second = {
			delivery: {
				source: { library: "user:alice", libraryId: "lib-1", path: "docs/b.txt" },
				name: "b.txt",
				bytes: 2,
			},
		};
		const turns = buildTranscriptTurns(
			[
				user("u1", 1_000),
				tool("c1", "copy_file", first),
				text("a1", true, 2_000, 5_000),
				user("u2", 10_000),
				tool("c2", "copy_file", second),
				text("a2", true, 11_000, 5_000),
			],
			false,
		);
		expect(turns[0]?.deliveries.map((delivery) => delivery.name)).toEqual(["a.txt"]);
		expect(turns[1]?.deliveries.map((delivery) => delivery.name)).toEqual(["b.txt"]);
	});
});
