import { describe, expect, test } from "vitest";
import type { TaskView } from "@/lib/api/types";
import { batchOutput, isTerminal, joinOutput, outputText, statusOutputNoteKey, taskOutcome } from "./output";

const baseTask = {
	state: "exited",
	exitCode: 0,
	signal: null,
	timedOut: false,
	cancelled: false,
	errorCode: null,
	errorMessage: null,
} as TaskView;

describe("isTerminal", () => {
	test("knows the terminal and non-terminal states", () => {
		for (const state of ["exited", "failed", "rejected", "unknown", "denied"]) expect(isTerminal(state)).toBe(true);
		for (const state of ["dispatched", "running", "accepted", "awaiting_approval", "awaiting_authorization"])
			expect(isTerminal(state)).toBe(false);
	});
});

describe("joinOutput", () => {
	test("without gap", () => {
		expect(joinOutput("hello", "", 5)).toEqual({ before: "hello", after: "", omitted: 0 });
		expect(joinOutput("hello", "hello", 5)).toEqual({ before: "hello", after: "", omitted: 0 });
	});

	test("with gap", () => {
		expect(outputText("abc", "xyz", 106)).toBe("abc\n… 100 bytes omitted …\nxyz");
	});

	test("overlapping head and tail", () => {
		expect(outputText("abcd", "cdef", 6)).toBe("abcdef");
	});

	test("counts bytes, not characters", () => {
		expect(joinOutput("é", "é!", 3).omitted).toBe(0);
	});
});

describe("batchOutput", () => {
	const base = { stdoutBytes: 100, stderrBytes: 20, stdoutTail: "tail\n", outputFile: "/var/lib/crha/output/t.log" };

	test("reads the fields by output mode", () => {
		expect(batchOutput({ ...base, outputMode: "full" })).toEqual({ kind: "full" });
		expect(batchOutput({ ...base, outputMode: "text" })).toEqual({ kind: "tail", text: "tail\n", bytes: 120 });
		expect(batchOutput({ ...base, outputMode: "status" })).toEqual({
			kind: "status",
			file: "/var/lib/crha/output/t.log",
		});
		expect(batchOutput({ ...base, outputMode: "status", outputFile: null })).toEqual({ kind: "status", file: null });
	});
});

describe("statusOutputNoteKey", () => {
	test("only blames SSH for a task that ran", () => {
		expect(statusOutputNoteKey({ state: "running", exitCode: null, signal: null })).toBe("running");
		expect(statusOutputNoteKey({ state: "failed", exitCode: null, signal: null })).toBe("none");
		expect(statusOutputNoteKey({ state: "exited", exitCode: 0, signal: null })).toBe("ssh");
		expect(statusOutputNoteKey({ state: "exited", exitCode: null, signal: "SIGKILL" })).toBe("ssh");
	});
});

describe("taskOutcome", () => {
	test("turns the task fields into a structured outcome", () => {
		expect(taskOutcome(baseTask)).toEqual({ kind: "exit", code: 0 });
		expect(taskOutcome({ ...baseTask, signal: "SIGKILL" })).toEqual({ kind: "signal", signal: "SIGKILL" });
		expect(taskOutcome({ ...baseTask, timedOut: true })).toEqual({ kind: "timed-out" });
		expect(taskOutcome({ ...baseTask, cancelled: true })).toEqual({ kind: "cancelled" });
		expect(taskOutcome({ ...baseTask, state: "failed", errorCode: "node_offline", errorMessage: "gone" })).toEqual({
			kind: "error",
			code: "node_offline",
			message: "gone",
		});
		expect(taskOutcome({ ...baseTask, state: "running" })).toEqual({ kind: "state", state: "running" });
	});
});
