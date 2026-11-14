import { describe, expect, test } from "vitest";
import { formatByteSize, parseByteSize } from "./byte-size";

describe("parseByteSize", () => {
	test("reads a plain number as bytes", () => {
		expect(parseByteSize("1048576")).toBe(1_048_576);
		expect(parseByteSize("0")).toBe(0);
		expect(parseByteSize(" 42 ")).toBe(42);
	});

	test("reads every base-1024 unit and ignores case and spacing", () => {
		expect(parseByteSize("1K")).toBe(1024);
		expect(parseByteSize("1KB")).toBe(1024);
		expect(parseByteSize("1Ki")).toBe(1024);
		expect(parseByteSize("1KiB")).toBe(1024);
		expect(parseByteSize("1KIB")).toBe(1024);
		expect(parseByteSize("1M")).toBe(1_048_576);
		expect(parseByteSize("1MB")).toBe(1_048_576);
		expect(parseByteSize("1 MiB")).toBe(1_048_576);
		expect(parseByteSize("1mib")).toBe(1_048_576);
		expect(parseByteSize("1G")).toBe(1024 ** 3);
		expect(parseByteSize("2T")).toBe(2 * 1024 ** 4);
		expect(parseByteSize("1B")).toBe(1);
	});

	test("rounds decimals to whole bytes", () => {
		expect(parseByteSize("1.5G")).toBe(1.5 * 1024 ** 3);
		expect(parseByteSize("1.6K")).toBe(1638);
		expect(parseByteSize("0.5")).toBe(1);
	});

	test("rejects everything else", () => {
		for (const bad of [
			"",
			"   ",
			"-1",
			"-1M",
			"abc",
			"1X",
			"1 K B",
			"1e6",
			"1.5.5G",
			"1 GiB extra",
			"NaN",
			"B",
			".5M",
		]) {
			expect(parseByteSize(bad), bad).toBeUndefined();
		}
	});
});

describe("formatByteSize", () => {
	test("shows the largest unit that divides the count exactly", () => {
		expect(formatByteSize(1024)).toBe("1 KiB");
		expect(formatByteSize(32 * 1024 ** 2)).toBe("32 MiB");
		expect(formatByteSize(1024 ** 3)).toBe("1 GiB");
		expect(formatByteSize(5 * 1024 ** 3)).toBe("5 GiB");
		expect(formatByteSize(1024 ** 4)).toBe("1 TiB");
		expect(formatByteSize(2 * 1024 ** 4)).toBe("2 TiB");
	});

	test("keeps a count that no unit divides exact", () => {
		expect(formatByteSize(1)).toBe("1");
		expect(formatByteSize(1023)).toBe("1023");
		expect(formatByteSize(1536)).toBe("1536");
		expect(formatByteSize(1_048_577)).toBe("1048577");
	});

	test("shows zero as 0", () => {
		expect(formatByteSize(0)).toBe("0");
	});

	test("round-trips a formatted size", () => {
		for (const bytes of [0, 1, 1024, 1_048_576, 32 * 1024 ** 2, 5 * 1024 ** 3, 2 * 1024 ** 4]) {
			expect(parseByteSize(formatByteSize(bytes))).toBe(bytes);
		}
	});
});
