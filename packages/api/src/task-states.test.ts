import { describe, expect, test } from "vitest";
import { TaskStateSchema } from "./schemas/task-state.ts";
import { isRecordedTaskState, isTerminalTaskState, RECORDED_TASK_STATES, TERMINAL_TASK_STATES } from "./task-states.ts";
import type { TaskState } from "./tasks.ts";

describe("task state sets", () => {
	test("name every state of the vocabulary, once", () => {
		const vocabulary = new Set(TaskStateSchema.options);
		for (const state of TERMINAL_TASK_STATES) expect(vocabulary.has(state)).toBe(true);
		for (const state of RECORDED_TASK_STATES) expect(TERMINAL_TASK_STATES.has(state)).toBe(true);
		// A recorded result is a terminal state with an answer; `unknown` is the one that is not recorded.
		expect([...TERMINAL_TASK_STATES].filter((state) => !RECORDED_TASK_STATES.has(state))).toEqual(["unknown"]);
	});

	test("judge states the way the server and the WebUI share", () => {
		const states: TaskState[] = [...TaskStateSchema.options];
		for (const state of states) {
			expect(isTerminalTaskState(state)).toBe(TERMINAL_TASK_STATES.has(state));
			expect(isRecordedTaskState(state)).toBe(RECORDED_TASK_STATES.has(state));
		}
		expect(isTerminalTaskState("unknown")).toBe(true);
		expect(isRecordedTaskState("unknown")).toBe(false);
		expect(isTerminalTaskState("running")).toBe(false);
		expect(isTerminalTaskState("not-a-state")).toBe(false);
	});
});
