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
	test("maps node states", () => {
		expect(nodeStatusTone("active")).toBe("ok");
		expect(nodeStatusTone("pending")).toBe("warn");
		expect(nodeStatusTone("other")).toBe("muted");
	});
});

describe("taskStatusTone", () => {
	test("exited is Finished and ok whatever the command's exit code or signal", () => {
		expect(taskStatusTone("exited")).toBe("ok");
	});

	test("waiting and running tasks are informational", () => {
		for (const state of ["awaiting_approval", "awaiting_authorization", "running", "dispatched"]) {
			expect(taskStatusTone(state), state).toBe("info");
		}
	});

	test("platform failures are dangerous", () => {
		for (const state of ["failed", "denied", "rejected", "unknown"]) {
			expect(taskStatusTone(state), state).toBe("danger");
		}
		expect(taskStatusTone("something_else")).toBe("muted");
	});
});

describe("taskGroupStatusTone", () => {
	test("uses the task tones for the states they share", () => {
		expect(taskGroupStatusTone("finished")).toBe("ok");
		expect(taskGroupStatusTone("running")).toBe("info");
		expect(taskGroupStatusTone("awaiting_approval")).toBe(taskStatusTone("awaiting_approval"));
		expect(taskGroupStatusTone("awaiting_authorization")).toBe(taskStatusTone("awaiting_authorization"));
		expect(taskGroupStatusTone("cancelled")).toBe(taskStatusTone("cancelled"));
		expect(taskGroupStatusTone("rejected")).toBe("danger");
		expect(taskGroupStatusTone("interrupted")).toBe("danger");
		expect(taskGroupStatusTone("weird")).toBe("muted");
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
