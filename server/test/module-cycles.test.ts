import { describe, expect, it } from "vitest";
import { parseImports } from "../../scripts/check-module-cycles.ts";

describe("module cycle checker: import parsing", () => {
	it("marks fully type-only imports and ignores comments", () => {
		const parsed = parseImports(`
			// import { runtime } from "./comment.ts";
			import type { A } from "./a.ts";
			import { type B, type C as D } from "./b.ts";
			import { type E, F } from "./f.ts";
			import { G } from "./g.ts";
			import "./side.ts";
			import Default, { type H } from "./h.ts";
		`);
		expect(parsed).toEqual([
			{ specifier: "./a.ts", typeOnly: true },
			{ specifier: "./b.ts", typeOnly: true },
			{ specifier: "./f.ts", typeOnly: false },
			{ specifier: "./g.ts", typeOnly: false },
			{ specifier: "./side.ts", typeOnly: false },
			{ specifier: "./h.ts", typeOnly: false },
		]);
	});

	it("treats re-exports like imports", () => {
		const parsed = parseImports(`
			export type { A } from "./a.ts";
			export { type B } from "./b.ts";
			export { C } from "./c.ts";
			export * from "./star.ts";
			export function helper() {}
		`);
		expect(parsed).toEqual([
			{ specifier: "./a.ts", typeOnly: true },
			{ specifier: "./b.ts", typeOnly: true },
			{ specifier: "./c.ts", typeOnly: false },
			{ specifier: "./star.ts", typeOnly: false },
		]);
	});

	it("reads a multi-line named list as one statement", () => {
		const parsed = parseImports(`
			import {
				type A,
				B,
			} from "./multi.ts";
		`);
		expect(parsed).toEqual([{ specifier: "./multi.ts", typeOnly: false }]);
	});
});
