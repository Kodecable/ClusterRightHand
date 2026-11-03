import { describe, expect, test } from "vitest";
import {
	authorizationStatusTone,
	nodeStatusTone,
	scheduleStatusTone,
	sessionStatusTone,
	sessionUiState,
	taskStatusTone,
	tokenStatusTone,
} from "./status";

describe("nodeStatusTone", () => {
	test("maps node states", () => {
		expect(nodeStatusTone("active")).toBe("ok");
		expect(nodeStatusTone("pending")).toBe("warn");
		expect(nodeStatusTone("disabled")).toBe("muted");
		expect(nodeStatusTone("other")).toBe("muted");
	});
});

describe("taskStatusTone", () => {
	test("a zero exit is ok, a non-zero exit is the command's own failure", () => {
		expect(taskStatusTone("exited", 0)).toBe("ok");
		expect(taskStatusTone("exited", 1)).toBe("warn");
		expect(taskStatusTone("exited", 0, "SIGTERM")).toBe("warn");
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

describe("authorization / schedule / token tones", () => {
	test("authorization", () => {
		expect(authorizationStatusTone("active")).toBe("ok");
		expect(authorizationStatusTone("pending")).toBe("warn");
		expect(authorizationStatusTone("expired")).toBe("danger");
		expect(authorizationStatusTone("weird")).toBe("muted");
	});

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
