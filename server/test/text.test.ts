import { describe, expect, test } from "vitest";
import { replaceInvalidText } from "../src/util/text.ts";
import { textResult } from "../src/util/tool-result.ts";

describe("replaceInvalidText", () => {
	test("replaces a NUL byte", () => {
		expect(replaceInvalidText("before\u0000after")).toBe("before\uFFFDafter");
	});

	test("replaces an unpaired surrogate on either side of a pair", () => {
		expect(replaceInvalidText("a\uD800b")).toBe("a\uFFFDb");
		expect(replaceInvalidText("a\uDC00b")).toBe("a\uFFFDb");
		// An emoji is a surrogate pair, one valid character, and stays as it is.
		expect(replaceInvalidText("a\uD83D\uDE00b")).toBe("a\uD83D\uDE00b");
	});

	test("leaves ordinary text alone", () => {
		expect(replaceInvalidText("中文 with ascii and an emoji 😀")).toBe("中文 with ascii and an emoji 😀");
	});
});

describe("textResult", () => {
	test("replaces invalid text in a tool's output and note", () => {
		const result = textResult([{ output: "out\u0000put", note: "n\uD800te" }]);
		expect(result.content.map((block) => block.text)).toEqual(["out\uFFFDput", "n\uFFFDte"]);
	});
});
