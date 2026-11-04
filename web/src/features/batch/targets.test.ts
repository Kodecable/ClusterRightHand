import { expect, test } from "vitest";
import { parseList } from "@/lib/format";
import { buildTargets } from "./targets";

test("parseList splits comma and whitespace separated values", () => {
	expect(parseList("a, b  c,,a")).toEqual(["a", "b", "c"]);
});

test("buildTargets sends picked node and node-group names", () => {
	expect(buildTargets({ nodes: ["web-1"], nodeGroups: ["web"] })).toEqual(["web-1", "web"]);
	expect(buildTargets({ nodes: ["web-1"], extra: "db-1, web-2" })).toEqual(["web-1", "db-1", "web-2"]);
	expect(buildTargets({})).toEqual([]);
});

test("buildTargets sends _all alone", () => {
	expect(buildTargets({ all: true, nodes: ["web-1"], nodeGroups: ["web"], extra: "db-1" })).toEqual(["_all"]);
});

test("buildTargets removes duplicates case-insensitively and never adds group: syntax", () => {
	expect(buildTargets({ nodes: ["Web"], nodeGroups: ["web"], extra: "WEB, web-2" })).toEqual(["Web", "web-2"]);
});
