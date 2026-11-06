import { describe, expect, test } from "vitest";
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
const final = (key: string, at?: number, durationMs?: number): TranscriptItem => ({
	kind: "text",
	key,
	text: "done",
	streaming: false,
	...(at === undefined ? {} : { at }),
	...(durationMs === undefined ? {} : { durationMs }),
});

describe("buildTranscriptTurns", () => {
	test("folds a completed turn with process and timing", () => {
		const [turn] = buildTranscriptTurns([user("u1", 1_000), thinking("t1"), final("a1", 2_000, 5_000)], false);
		expect(turn?.foldable).toBe(true);
		expect(turn?.durationMs).toBe(6_000);
		expect(turn?.process.map((item) => item.key)).toEqual(["t1"]);
		expect(turn?.final?.key).toBe("a1");
	});

	test("leaves the last turn open while the session is active", () => {
		const [turn] = buildTranscriptTurns([user("u1", 1_000), thinking("t1"), final("a1", 2_000, 5_000)], true);
		expect(turn?.foldable).toBe(false);
	});

	test("folds as soon as the final answer starts streaming and ticks live", () => {
		const [turn] = buildTranscriptTurns(
			[user("u1", 1_000), thinking("t1"), { kind: "text", key: "a1", text: "partial answer", streaming: true }],
			true,
		);
		expect(turn?.foldable).toBe(true);
		expect(turn?.live).toBe(true);
		expect(turn?.startedAt).toBe(1_000);
		expect(turn?.durationMs).toBeUndefined();
	});

	test("does not fold a turn without process or without timing", () => {
		const [plain] = buildTranscriptTurns([user("u1", 1_000), final("a1", 2_000, 5_000)], false);
		expect(plain?.foldable).toBe(false);
		const [untimed] = buildTranscriptTurns([user("u1"), thinking("t1"), final("a1")], false);
		expect(untimed?.foldable).toBe(false);
	});

	test("keeps an error and its turn visible", () => {
		const [turn] = buildTranscriptTurns(
			[
				user("u1", 1_000),
				thinking("t1"),
				{ kind: "error", key: "e1", reason: "failed", message: "boom" },
				final("a1", 2_000, 5_000),
			],
			false,
		);
		expect(turn?.foldable).toBe(false);
	});

	test("keeps the user outside the process and starts a new turn at the next user", () => {
		const turns = buildTranscriptTurns(
			[user("u1", 1_000), thinking("t1"), final("a1", 2_000, 5_000), user("u2", 10_000), thinking("t2")],
			true,
		);
		expect(turns).toHaveLength(2);
		expect(turns[0]?.foldable).toBe(true);
		expect(turns[0]?.process.map((item) => item.key)).toEqual(["t1"]);
		expect(turns[1]?.foldable).toBe(false);
	});

	test("a trailing compaction does not decide the final answer and stays after it", () => {
		const [turn] = buildTranscriptTurns(
			[user("u1", 1_000), thinking("t1"), final("a1", 2_000, 5_000), compaction("c1")],
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
			[user("u1", 1_000), thinking("t1"), compaction("c1"), final("a1", 2_000, 5_000)],
			false,
		);
		expect(turn?.final?.key).toBe("a1");
		expect(turn?.foldable).toBe(true);
		expect(turn?.process.map((item) => item.key)).toEqual(["t1", "c1"]);
		expect(turn?.after).toEqual([]);
		expect(turn?.durationMs).toBe(6_000);
	});
});
