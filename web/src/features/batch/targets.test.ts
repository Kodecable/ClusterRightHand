import { expect, test } from "vitest";
import { buildTargets, parseList } from "./targets";

test("parseList and buildTargets", () => {
	expect(parseList("a, b  c,,a")).toEqual(["a", "b", "c"]);
	expect(buildTargets(["n1"], "group:web, n1")).toEqual(["n1", "group:web"]);
	expect(buildTargets([], "")).toEqual([]);
});
