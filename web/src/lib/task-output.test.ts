import { describe, expect, test } from "vitest";
import { batchOutput, isTerminal, joinOutput, outputText, statusOutputNoteKey } from "./task-output";

describe("isTerminal", () => {
	test("knows the terminal and non-terminal states", () => {
		for (const state of ["exited", "errored", "rejected", "cancelled", "expired", "unknown", "denied"])
			expect(isTerminal(state)).toBe(true);
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
	const base = {
		outputBytes: 120,
		outputHead: "head\n",
		outputTail: "tail\n",
		outputFile: "/var/lib/crha/output/t.log",
	};

	test("reads the single stream's fields by output mode", () => {
		expect(batchOutput({ ...base, outputMode: "full" })).toEqual({
			kind: "output",
			head: "head\n",
			tail: "tail\n",
			bytes: 120,
		});
		expect(batchOutput({ ...base, outputMode: "text", outputHead: "" })).toEqual({
			kind: "output",
			head: "",
			tail: "tail\n",
			bytes: 120,
		});
		expect(batchOutput({ ...base, outputMode: "head", outputTail: "" })).toEqual({
			kind: "output",
			head: "head\n",
			tail: "",
			bytes: 120,
		});
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
		expect(statusOutputNoteKey({ state: "errored", exitCode: null, signal: null })).toBe("none");
		expect(statusOutputNoteKey({ state: "exited", exitCode: 0, signal: null })).toBe("ssh");
		expect(statusOutputNoteKey({ state: "exited", exitCode: null, signal: "SIGKILL" })).toBe("ssh");
	});
});
