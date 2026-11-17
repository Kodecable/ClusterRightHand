import { describe, expect, test } from "vitest";
import { convertMathDelimiters } from "./math";

describe("convertMathDelimiters", () => {
	test("rewrites inline TeX delimiters to double dollars", () => {
		expect(convertMathDelimiters("a \\(x + 1\\) b")).toBe("a $$x + 1$$ b");
		expect(convertMathDelimiters("\\(\\frac{a}{b}\\)")).toBe("$$\\frac{a}{b}$$");
	});

	test("rewrites display TeX delimiters to a display fence", () => {
		expect(convertMathDelimiters("before\n\n\\[\nx + y\n\\]\n\nafter")).toBe("before\n\n$$\nx + y\n$$\n\nafter");
		expect(convertMathDelimiters("\\[a = b\\]")).toBe("$$\na = b\n$$");
	});

	test("display delimiters need the opener at line start and the closer at line end", () => {
		// Mid-line escaped brackets are ordinary Markdown (`[link]`), not math.
		expect(convertMathDelimiters("Use \\[x^2\\] and \\[link\\] text")).toBe("Use \\[x^2\\] and \\[link\\] text");
		// The opener must start its line.
		expect(convertMathDelimiters("text \\[\nx\n\\]")).toBe("text \\[\nx\n\\]");
		// The closer must end its line.
		expect(convertMathDelimiters("\\[\nx\n\\] trailing")).toBe("\\[\nx\n\\] trailing");
		// At most three spaces of indentation are a block start; list/blockquote prefixes are skipped.
		expect(convertMathDelimiters("    \\[\nx\n\\]")).toBe("    \\[\nx\n\\]");
		expect(convertMathDelimiters("> \\[\nx\n\\]")).toBe("> \\[\nx\n\\]");
	});

	test("preserves the fence indentation and trims the formula edges", () => {
		expect(convertMathDelimiters("   \\[\n  x + y  \n   \\]")).toBe("   $$\n   x + y\n   $$");
	});

	test("keeps a display formula inside its list item", () => {
		const source = "- Capacity check:\n\n  \\[\n  a + b\n  \\]\n\n- Next item\n";
		expect(convertMathDelimiters(source)).toBe("- Capacity check:\n\n  $$\n  a + b\n  $$\n\n- Next item\n");
	});

	test("indents a single-line display formula to stay inside its list item", () => {
		const source = "- Identity:\n\n  \\[a^2 + b^2 = c^2\\]\n\n- Next item\n";
		expect(convertMathDelimiters(source)).toBe("- Identity:\n\n  $$\n  a^2 + b^2 = c^2\n  $$\n\n- Next item\n");
	});

	test("a line-own \\[x\\] becomes a display fence", () => {
		expect(convertMathDelimiters("\\[x\\]")).toBe("$$\nx\n$$");
		expect(convertMathDelimiters("before\n\\[x\\]\nafter")).toBe("before\n$$\nx\n$$\nafter");
	});

	test("leaves fenced code and inline code untouched", () => {
		const fenced = "```tex\n\\(x\\)\n\\[y\\]\n```\n";
		expect(convertMathDelimiters(fenced)).toBe(fenced);
		expect(convertMathDelimiters("`\\(x\\)`")).toBe("`\\(x\\)`");
		expect(convertMathDelimiters("```\n\\[x\\]\n")).toBe("```\n\\[x\\]\n");
	});

	test("leaves an unclosed delimiter as text", () => {
		expect(convertMathDelimiters("a \\(x")).toBe("a \\(x");
		expect(convertMathDelimiters("\\[x")).toBe("\\[x");
	});

	test("leaves escaped delimiters alone", () => {
		expect(convertMathDelimiters("\\\\(x\\\\)")).toBe("\\\\(x\\\\)");
	});

	test("does not touch single dollars", () => {
		expect(convertMathDelimiters("$5 and $10")).toBe("$5 and $10");
	});
});
