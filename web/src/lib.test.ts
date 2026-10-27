import { expect, test } from "vitest";
import type { TaskView } from "./api.ts";
import {
	alwaysRule,
	buildTargets,
	enrollCommand,
	isTerminal,
	joinOutput,
	mcpCommand,
	outputText,
	parseList,
	shellQuote,
	splitArgv,
	taskActor,
	taskOutcome,
	tokenStatus,
} from "./lib.ts";

test("isTerminal", () => {
	for (const s of ["exited", "failed", "rejected", "unknown", "denied"]) expect(isTerminal(s)).toBe(true);
	for (const s of ["dispatched", "running", "accepted", "awaiting_approval"]) expect(isTerminal(s)).toBe(false);
});

test("joinOutput without gap", () => {
	expect(joinOutput("hello", "", 5)).toEqual({ before: "hello", after: "", omitted: 0 });
	expect(joinOutput("hello", "hello", 5)).toEqual({ before: "hello", after: "", omitted: 0 });
});

test("joinOutput with gap", () => {
	expect(outputText("abc", "xyz", 106)).toBe("abc\n… 100 bytes omitted …\nxyz");
});

test("joinOutput overlapping head and tail", () => {
	expect(outputText("abcd", "cdef", 6)).toBe("abcdef");
});

test("joinOutput counts bytes, not characters", () => {
	expect(joinOutput("é", "é!", 3).omitted).toBe(0);
});

test("splitArgv", () => {
	expect(splitArgv(`ls -l "my dir" 'a b' c\\ d`)).toEqual(["ls", "-l", "my dir", "a b", "c d"]);
	expect(splitArgv(`echo ""`)).toEqual(["echo", ""]);
	expect(splitArgv("   ")).toEqual([]);
});

test("taskOutcome", () => {
	const base = {
		state: "exited",
		exitCode: 0,
		signal: null,
		timedOut: false,
		cancelled: false,
		errorCode: null,
		errorMessage: null,
	} as TaskView;
	expect(taskOutcome(base)).toBe("exit 0");
	expect(taskOutcome({ ...base, signal: "SIGKILL" })).toBe("signal SIGKILL");
	expect(taskOutcome({ ...base, state: "failed", errorCode: "node_offline", errorMessage: "gone" })).toBe(
		"node_offline: gone",
	);
});

test("enrollCommand", () => {
	expect(enrollCommand("https://h", "tok")).toBe("crha enroll https://h tok");
});

import { parseHash } from "./router.ts";

test("parseHash", () => {
	expect(parseHash("#/nodes/a%20b")).toEqual(["nodes", "a b"]);
	expect(parseHash("")).toEqual([]);
});

test("parseList and buildTargets", () => {
	expect(parseList("a, b  c,,a")).toEqual(["a", "b", "c"]);
	expect(buildTargets(["n1"], "group:web, n1")).toEqual(["n1", "group:web"]);
	expect(buildTargets([], "")).toEqual([]);
});

test("taskActor", () => {
	const t = { onBehalfOfUserId: "u1", actorType: "agent", actorId: "a1" } as TaskView;
	expect(taskActor(t, (id) => (id === "u1" ? "Alice" : undefined))).toBe("Alice");
	expect(taskActor(t, () => undefined)).toBe("u1");
	expect(taskActor({ ...t, onBehalfOfUserId: null }, () => undefined)).toBe("agent a1");
});

test("shellQuote", () => {
	expect(shellQuote("a/b-c_d.e:f,g=h+i@j%k")).toBe("a/b-c_d.e:f,g=h+i@j%k");
	expect(shellQuote("a b")).toBe("'a b'");
	expect(shellQuote("it's")).toBe("'it'\\''s'");
	expect(shellQuote("")).toBe("''");
});

test("alwaysRule", () => {
	expect(alwaysRule({ method: "exec", target: "/bin/sh -c 'echo hi; ls'" }, ["n1"], "exact")).toEqual({
		action: "allow",
		method: "exec",
		nodes: ["n1"],
		exact: "/bin/sh -c 'echo hi; ls'",
	});
	expect(alwaysRule({ method: "file.write", target: "/etc/x" }, ["n1", "n2"], "prefix")).toEqual({
		action: "allow",
		method: "file.write",
		nodes: ["n1", "n2"],
		prefix: "/etc/x",
	});
	expect(alwaysRule(null, ["n"], "exact")).toBeUndefined();
});

test("tokenStatus", () => {
	const now = Date.parse("2026-01-01T00:00:00Z");
	expect(tokenStatus({ revokedAt: "x", expiresAt: null }, now)).toBe("revoked");
	expect(tokenStatus({ revokedAt: null, expiresAt: "2025-01-01T00:00:00Z" }, now)).toBe("expired");
	expect(tokenStatus({ revokedAt: null, expiresAt: null }, now)).toBe("active");
});

test("mcpCommand", () => {
	expect(mcpCommand("http://h:1", "crh_x")).toBe(
		'claude mcp add --transport http crh http://h:1/mcp --header "Authorization: Bearer crh_x"',
	);
});
