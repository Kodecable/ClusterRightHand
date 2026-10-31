import { describe, expect, test } from "vitest";
import { parseGrantInput, parseQuotaInput, quotaStatus } from "./quota";

describe("parseQuotaInput", () => {
	test("leaves the quota unlimited on an empty field", () => {
		expect(parseQuotaInput("")).toEqual({ quota: null });
		expect(parseQuotaInput("   ")).toEqual({ quota: null });
	});

	test("accepts whole non-negative numbers", () => {
		expect(parseQuotaInput("0")).toEqual({ quota: 0 });
		expect(parseQuotaInput(" 1250 ")).toEqual({ quota: 1250 });
	});

	test("rejects fractions, negatives, exponents and unsafe integers", () => {
		for (const input of ["1.5", "-1", "1e6", "0x10", "9007199254740992", "12 000"]) {
			expect(parseQuotaInput(input), input).toHaveProperty("error");
		}
	});
});

describe("parseGrantInput", () => {
	test("only accepts a positive number to add", () => {
		expect(parseGrantInput("10")).toEqual({ tokens: 10 });
		expect(parseGrantInput("")).toEqual({ error: "positive-required" });
		expect(parseGrantInput("0")).toEqual({ error: "positive-required" });
		expect(parseGrantInput("abc")).toEqual({ error: "whole-number" });
	});
});

describe("quotaStatus", () => {
	test("distinguishes unlimited, remaining and used-up quotas", () => {
		expect(quotaStatus(null, 1234)).toEqual({ kind: "unlimited", remaining: 0, over: 0, used: 1234 });
		expect(quotaStatus(5000, 20)).toEqual({ kind: "remaining", remaining: 5000, over: 0, used: 20 });
		expect(quotaStatus(0, 20)).toEqual({ kind: "exhausted", remaining: 0, over: 0, used: 20 });
		expect(quotaStatus(-300, 20)).toEqual({ kind: "exhausted", remaining: 0, over: 300, used: 20 });
	});
});
