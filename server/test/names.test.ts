import { describe, expect, it } from "vitest";
import { UserError } from "../src/util/errors.ts";
import { NAME_MAX, nameKey, normalizeName, validateName } from "../src/util/names.ts";

describe("validateName", () => {
	it("accepts the documented shape and keeps the case", () => {
		for (const name of ["ab", "web-1", "Web.Prod/1", "a".repeat(NAME_MAX), "a.b_c-d/e"]) {
			expect(validateName(name)).toBe(name);
		}
		expect(validateName("  Web-1  ")).toBe("Web-1");
	});

	it("rejects names outside the rule with a clear error", () => {
		for (const name of ["", " a ", "a", "_all", "_node", "1web", "-web", "web-", "web name", "web:1", "a".repeat(65)]) {
			expect(() => validateName(name, "node name"), name).toThrow(UserError);
		}
		expect(() => validateName("_all", "node name")).toThrow(/reserved for the system/);
		expect(() => validateName("web name", "node name")).toThrow(/node name must be 2-64 characters/);
	});

	it("compares case-insensitively through nameKey", () => {
		expect(nameKey("Web.Prod")).toBe("web.prod");
	});
});

describe("normalizeName", () => {
	it("replaces disallowed characters and keeps the case", () => {
		expect(normalizeName("Web Server_01.Example!")).toBe("Web-Server_01.Example");
		expect(normalizeName("my host")).toBe("my-host");
	});

	it("fixes a leading non-letter, a trailing non-alphanumeric and short names", () => {
		expect(normalizeName("123")).toBe("n-123");
		expect(normalizeName("-x")).toBe("n--x");
		expect(normalizeName("foo-")).toBe("foo");
		expect(normalizeName("a")).toBe("a0");
		// An empty or all-symbol input still ends with a letter or digit.
		expect(normalizeName("")).toBe("n0");
		expect(normalizeName("!")).toBe("n0");
	});

	it("truncates to 64 characters and re-strips a cut-off ending", () => {
		expect(normalizeName("x".repeat(100))).toHaveLength(NAME_MAX);
		expect(normalizeName(`${"a".repeat(63)}!`)).toHaveLength(63);
		expect(normalizeName(`${"a".repeat(63)}--`)).toHaveLength(63);
		// A cut that leaves only the leading letter is padded back to a valid name.
		expect(normalizeName(`a${"-".repeat(63)}b`)).toBe("a0");
	});

	it("appends -2, -3, … on collisions and stays within the limit", () => {
		const taken = new Set(["web", "web-2"]);
		expect(normalizeName("web", (key) => taken.has(key))).toBe("web-3");
		// An iterable of lowercase keys works too.
		expect(normalizeName("web", new Set(["web"]))).toBe("web-2");
		expect(normalizeName("web", () => false)).toBe("web");
		expect(normalizeName("web", (key) => key === "web")).toBe("web-2");

		const long = "x".repeat(NAME_MAX);
		const withTwo = normalizeName(long, (key) => key === long || key === `${long.slice(0, NAME_MAX - 2)}-2`);
		expect(withTwo).toHaveLength(NAME_MAX);
		expect(withTwo.endsWith("-3")).toBe(true);
	});
});
