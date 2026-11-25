import { describe, expect, test } from "vitest";
import {
	nodeStatusTone,
	ruleResultTone,
	scheduleStatusTone,
	sessionStatusTone,
	sessionUiState,
	taskGroupStatusTone,
	taskStatusTone,
	tokenStatusTone,
} from "./status";

describe("nodeStatusTone", () => {
	test("maps node states and reachability", () => {
		// A crha node that is not connected is a problem, not a green active node.
		expect(nodeStatusTone("active", true)).toBe("ok");
		expect(nodeStatusTone("active", false)).toBe("danger");
		// An unknown connection (an SSH node connects per task) stays ok, as does the default.
		expect(nodeStatusTone("active", null)).toBe("ok");
		expect(nodeStatusTone("active")).toBe("ok");
		expect(nodeStatusTone("pending")).toBe("warn");
		expect(nodeStatusTone("other")).toBe("muted");
		// Reachability does not change a state that is not active.
		expect(nodeStatusTone("pending", false)).toBe("warn");
	});
});

describe("taskStatusTone", () => {
	test("in progress is informational and waiting for the user is a warning", () => {
		for (const state of ["dispatched", "running"]) expect(taskStatusTone(state), state).toBe("info");
		for (const state of ["awaiting_approval", "awaiting_authorization"]) {
			expect(taskStatusTone(state), state).toBe("warn");
		}
	});

	test("every terminal state is neutral: success or failure is the outcome's colour, not the status's", () => {
		for (const state of [
			"exited",
			"errored",
			"denied",
			"rejected",
			"cancelled",
			"expired",
			"unknown",
			"something_else",
		]) {
			expect(taskStatusTone(state), state).toBe("muted");
		}
	});
});

describe("taskGroupStatusTone", () => {
	test("follows the same lifecycle rule as a task", () => {
		expect(taskGroupStatusTone("running")).toBe("info");
		expect(taskGroupStatusTone("awaiting_approval")).toBe("warn");
		expect(taskGroupStatusTone("awaiting_authorization")).toBe("warn");
		for (const state of ["finished", "cancelled", "rejected", "interrupted", "weird"]) {
			expect(taskGroupStatusTone(state), state).toBe("muted");
		}
	});
});

describe("ruleResultTone", () => {
	test("maps a level's rule result", () => {
		expect(ruleResultTone("allow")).toBe("ok");
		expect(ruleResultTone("deny")).toBe("danger");
		expect(ruleResultTone("require-approval")).toBe("warn");
		expect(ruleResultTone("inherit")).toBe("muted");
		expect(ruleResultTone("weird")).toBe("muted");
	});
});

describe("sessionUiState", () => {
	test("maps the contract's three states without guessing", () => {
		expect(sessionUiState("awaiting")).toBe("awaiting");
		expect(sessionUiState("running")).toBe("running");
		expect(sessionUiState("idle")).toBe("idle");
		// States from before the contract change have no defined meaning: no guessing.
		for (const legacy of ["awaiting_quota", "awaiting_approval", "active", "ACTIVE", "stopped", "busy", ""]) {
			expect(sessionUiState(legacy), legacy).toBe("idle");
		}
		expect(sessionStatusTone("awaiting")).toBe("warn");
		expect(sessionStatusTone("running")).toBe("info");
		expect(sessionStatusTone("idle")).toBe("muted");
	});
});

describe("schedule / token tones", () => {
	test("schedule runs", () => {
		expect(scheduleStatusTone("succeeded")).toBe("ok");
		expect(scheduleStatusTone("running")).toBe("info");
		expect(scheduleStatusTone("preempted")).toBe("warn");
		expect(scheduleStatusTone("pending")).toBe("warn");
		expect(scheduleStatusTone("failed")).toBe("danger");
		expect(scheduleStatusTone("never")).toBe("muted");
	});

	test("API tokens", () => {
		expect(tokenStatusTone("active")).toBe("ok");
		expect(tokenStatusTone("expired")).toBe("warn");
		expect(tokenStatusTone("revoked")).toBe("danger");
	});
});
