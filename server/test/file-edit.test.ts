import { describe, expect, it } from "vitest";
import { applyEdits, detectLineEnding } from "../src/cluster/ssh/file-edit.ts";

const edit = (oldText: string, newText: string) => ({ oldText, newText });

describe("applyEdits", () => {
	it("keeps bytes outside the matched span, including a lone CR", () => {
		const content = "a\rb\nc";
		expect(applyEdits(content, [edit("c", "d")], detectLineEnding(content), "f")).toBe("a\rb\nd");
	});

	it("matches CRLF as LF and writes the file's line ending", () => {
		const content = "one\r\ntwo\r\nthree\r\n";
		expect(applyEdits(content, [edit("one\ntwo", "1\n2\n2.5")], detectLineEnding(content), "f")).toBe(
			"1\r\n2\r\n2.5\r\nthree\r\n",
		);
	});

	it("still rejects a replacement that produces the same bytes", () => {
		const content = "one\r\ntwo\r\n";
		let error: unknown;
		try {
			applyEdits(content, [edit("one\ntwo", "one\ntwo")], "\r\n", "f");
		} catch (e) {
			error = e;
		}
		expect(error).toMatchObject({ code: "edit_no_change" });
	});
});
