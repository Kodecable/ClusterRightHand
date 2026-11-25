import { describe, expect, it } from "vitest";
import { formatBytes } from "../src/util/format.ts";

describe("formatBytes", () => {
	it("uses the largest binary unit at one decimal places above bytes", () => {
		expect(formatBytes(0)).toBe("0 B");
		expect(formatBytes(1023)).toBe("1023 B");
		expect(formatBytes(1024)).toBe("1 KiB");
		expect(formatBytes(1536)).toBe("1.5 KiB");
		expect(formatBytes(32 * 1024 ** 2)).toBe("32 MiB");
	});

	it("clamps a negative or non-finite count to zero instead of printing NaN", () => {
		expect(formatBytes(-1)).toBe("0 B");
		expect(formatBytes(Number.NaN)).toBe("0 B");
		expect(formatBytes(Number.POSITIVE_INFINITY)).toBe("0 B");
	});
});
