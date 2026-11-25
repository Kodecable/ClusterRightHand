import { describe, expect, it } from "vitest";
import {
	firstFilesystem,
	isValidTrafficNextReset,
	NODE_METRICS_RANGE_NAMES,
	NODE_METRICS_RANGES,
	NODE_USER_REMARK_MAX_CODE_POINTS,
	nodeUserRemarkProblem,
	TRAFFIC_PERIOD_MS,
} from "./metrics.ts";
import { NodeTrafficNextResetBodySchema, NodeUserRemarkBodySchema } from "./schemas/nodes.ts";

describe("node metric ranges", () => {
	it("lists the five ranges the WebUI and node_metrics share, with their widths", () => {
		expect(NODE_METRICS_RANGE_NAMES).toEqual(["1h", "24h", "7d", "30d", "365d"]);
		expect(NODE_METRICS_RANGES).toEqual({
			"1h": 60 * 60 * 1000,
			"24h": 24 * 60 * 60 * 1000,
			"7d": 7 * 24 * 60 * 60 * 1000,
			"30d": 30 * 24 * 60 * 60 * 1000,
			"365d": 365 * 24 * 60 * 60 * 1000,
		});
	});
});

describe("traffic period", () => {
	const now = Date.UTC(2026, 5, 1, 12, 0, 0);

	it("is exactly 30 days", () => {
		expect(TRAFFIC_PERIOD_MS).toBe(30 * 86_400_000);
	});

	it("accepts only an instant in the future and within one period", () => {
		expect(isValidTrafficNextReset(now + 1, now)).toBe(true);
		expect(isValidTrafficNextReset(now + TRAFFIC_PERIOD_MS, now)).toBe(true);
		expect(isValidTrafficNextReset(now, now)).toBe(false);
		expect(isValidTrafficNextReset(now - 1, now)).toBe(false);
		expect(isValidTrafficNextReset(now + TRAFFIC_PERIOD_MS + 1, now)).toBe(false);
		expect(isValidTrafficNextReset(Number.NaN, now)).toBe(false);
	});
});

describe("node user remark", () => {
	it("accepts 50 code points, counting an emoji as one", () => {
		expect(nodeUserRemarkProblem("😀".repeat(NODE_USER_REMARK_MAX_CODE_POINTS))).toBeUndefined();
	});

	it("rejects a 51st code point", () => {
		expect(nodeUserRemarkProblem("x".repeat(NODE_USER_REMARK_MAX_CODE_POINTS + 1))).toMatch(/at most 50/);
		expect(nodeUserRemarkProblem(`${"😀".repeat(NODE_USER_REMARK_MAX_CODE_POINTS)}😀`)).toMatch(/at most 50/);
	});

	it("rejects control, line/paragraph separator and bidi characters", () => {
		for (const character of ["\n", "\t", "\u0000", "\u007f", "\u2028", "\u2029", "\u061c", "\u200e", "\u200f"]) {
			expect(nodeUserRemarkProblem(`a${character}b`), JSON.stringify(character)).toMatch(/single line/);
		}
		for (const codePoint of [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069]) {
			expect(nodeUserRemarkProblem(`a${String.fromCodePoint(codePoint)}b`), codePoint.toString(16)).toMatch(
				/single line/,
			);
		}
	});

	it("is the schema's refinement too, so a request cannot bypass it", () => {
		expect(NodeUserRemarkBodySchema.safeParse({ userRemark: "rack 4" }).success).toBe(true);
		expect(NodeUserRemarkBodySchema.safeParse({ userRemark: null }).success).toBe(true);
		expect(NodeUserRemarkBodySchema.safeParse({ userRemark: "   " }).success).toBe(true);
		expect(NodeUserRemarkBodySchema.safeParse({ userRemark: "a\u202eb" }).success).toBe(false);
		expect(
			NodeUserRemarkBodySchema.safeParse({ userRemark: "x".repeat(NODE_USER_REMARK_MAX_CODE_POINTS + 1) }).success,
		).toBe(false);
	});
});

describe("firstFilesystem", () => {
	it("prefers the collector's report order, skipping names it does not have", () => {
		expect(firstFilesystem(["root", "data"], ["gone", "data", "root"])).toBe("data");
	});

	it("falls back to root before the alphabetical order", () => {
		expect(firstFilesystem(["alpha", "root"])).toBe("root");
	});

	it("sorts by code unit, not locale, so every runtime picks the same name", () => {
		// In an English locale collation "alpha" sorts before "Zeta"; code-unit order puts "Zeta" first.
		expect(firstFilesystem(["alpha", "Zeta"])).toBe("Zeta");
	});

	it("has nothing to choose when no filesystem is complete", () => {
		expect(firstFilesystem([], ["data"])).toBeUndefined();
	});
});

describe("next reset schema", () => {
	it("requires an instant that names its zone", () => {
		expect(NodeTrafficNextResetBodySchema.safeParse({ nextResetAt: "2026-07-01T12:00:00Z" }).success).toBe(true);
		expect(NodeTrafficNextResetBodySchema.safeParse({ nextResetAt: "2026-07-01T12:00:00+02:00" }).success).toBe(true);
		expect(NodeTrafficNextResetBodySchema.safeParse({ nextResetAt: "2026-07-01T12:00:00" }).success).toBe(false);
		expect(NodeTrafficNextResetBodySchema.safeParse({ nextResetAt: "not a time" }).success).toBe(false);
	});
});
