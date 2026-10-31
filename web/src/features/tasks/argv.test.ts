import { describe, expect, test } from "vitest";
import { splitArgv } from "./argv";

describe("splitArgv", () => {
	test("splits with quotes and backslash escapes", () => {
		expect(splitArgv(`ls -l "my dir" 'a b' c\\ d`)).toEqual(["ls", "-l", "my dir", "a b", "c d"]);
		expect(splitArgv(`echo ""`)).toEqual(["echo", ""]);
		expect(splitArgv("   ")).toEqual([]);
	});
});
