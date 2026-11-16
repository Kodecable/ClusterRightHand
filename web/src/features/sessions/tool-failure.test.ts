import type { TaskGroupView, TaskOutcome, TaskView } from "@crh/api";
import { describe, expect, test } from "vitest";
import {
	detailsFailure,
	outcomeFailure,
	taskGroupViewFailure,
	taskViewFailure,
	toolFailure,
	toolResultFailure,
	toolResultOutcome,
} from "./tool-failure";

const outcome = (overrides: Partial<TaskOutcome> = {}): TaskOutcome => ({
	kind: "exit",
	failed: true,
	exitCode: 2,
	...overrides,
});

const task = (overrides: Partial<TaskView> = {}): TaskView =>
	({
		id: "t1",
		state: "exited",
		exitCode: 2,
		outcome: outcome(),
		...overrides,
	}) as TaskView;

const group = (overrides: Partial<TaskGroupView> = {}): TaskGroupView =>
	({
		id: "g1",
		state: "finished",
		outcome: outcome({ kind: "error", failed: true, errorCode: null, errorMessage: null, exitCode: undefined }),
		tasks: [task(), task()],
		...overrides,
	}) as TaskGroupView;

describe("outcomeFailure", () => {
	test("reads the server's failed flag, including cancelled being not a failure", () => {
		expect(outcomeFailure(outcome())).toEqual({ kind: "failed", outcome: outcome() });
		expect(outcomeFailure({ kind: "cancelled", failed: false })).toBeUndefined();
		expect(outcomeFailure(null)).toBeUndefined();
	});
});

describe("toolFailure", () => {
	test("reads a single task's outcome from the JSON", () => {
		expect(toolFailure(JSON.stringify({ task_id: "t1", state: "exited", outcome: outcome() }))).toEqual({
			kind: "failed",
			outcome: outcome(),
		});
		expect(
			toolFailure(JSON.stringify({ task_id: "t1", state: "exited", outcome: { kind: "cancelled", failed: false } })),
		).toBeUndefined();
	});

	test("reads a group and marks a partly failed member list", () => {
		const partly = toolFailure(
			JSON.stringify({
				task_group_id: "g1",
				state: "finished",
				outcome: { kind: "error", failed: true, errorCode: null, errorMessage: null },
				nodes: [
					{ task_id: "t1", outcome: outcome({ kind: "succeeded", failed: false, exitCode: 0 }) },
					{ task_id: "t2", outcome: outcome() },
				],
			}),
		);
		expect(partly?.kind).toBe("partly-failed");
		const all = toolFailure(
			JSON.stringify({
				task_group_id: "g1",
				state: "finished",
				outcome: { kind: "error", failed: true, errorCode: null, errorMessage: null },
				nodes: [
					{ task_id: "t1", outcome: outcome() },
					{ task_id: "t2", outcome: outcome() },
				],
			}),
		);
		expect(all?.kind).toBe("failed");
	});

	test("a cancelled group is not a failure", () => {
		expect(
			toolFailure(
				JSON.stringify({
					task_group_id: "g1",
					state: "cancelled",
					outcome: { kind: "cancelled", failed: false },
					nodes: [],
				}),
			),
		).toBeUndefined();
	});
});

describe("toolResultFailure", () => {
	test("reads a single task's failure from the details", () => {
		expect(
			toolResultFailure({ text: "ignored", isError: false, details: { task_id: "t1", outcome: outcome() } }),
		).toEqual({ kind: "failed", outcome: outcome() });
	});

	test("an isError result without a task verdict is still a failure", () => {
		expect(toolResultFailure({ text: "plain", isError: true, details: undefined })).toMatchObject({ kind: "failed" });
		expect(toolResultFailure({ text: "plain", isError: false, details: { subagents: [] } })).toBeUndefined();
	});
});

describe("detailsFailure", () => {
	test("uses the server's outcome, never the raw flags", () => {
		expect(detailsFailure({ task_id: "t1", state: "exited", exit_code: 2 })).toBeUndefined();
		expect(detailsFailure({ task_id: "t1", state: "exited", outcome: outcome() })).toEqual({
			kind: "failed",
			outcome: outcome(),
		});
	});
});

describe("toolResultOutcome", () => {
	test("returns the task outcome a returned result carries", () => {
		expect(toolResultOutcome({ text: "", details: { task_id: "t1", outcome: outcome() } })).toEqual(outcome());
		expect(toolResultOutcome({ text: "", details: { subagents: [] } })).toBeUndefined();
	});
});

describe("taskViewFailure", () => {
	test("reads the view's outcome", () => {
		expect(taskViewFailure(task())).toEqual({ kind: "failed", outcome: outcome() });
		expect(taskViewFailure(task({ outcome: { kind: "succeeded", failed: false, exitCode: 0 } }))).toBeUndefined();
		expect(taskViewFailure(task({ outcome: null }))).toBeUndefined();
	});
});

describe("taskGroupViewFailure", () => {
	test("a group with some failed members is partly failed", () => {
		const partly = group({
			tasks: [
				task({ id: "t1", outcome: { kind: "succeeded", failed: false, exitCode: 0 } }),
				task({ id: "t2", outcome: outcome() }),
			],
		});
		expect(taskGroupViewFailure(partly)?.kind).toBe("partly-failed");
	});

	test("a group all of whose members failed is failed, and a cancelled group is not", () => {
		expect(taskGroupViewFailure(group())?.kind).toBe("failed");
		expect(
			taskGroupViewFailure(group({ state: "cancelled", outcome: { kind: "cancelled", failed: false } })),
		).toBeUndefined();
	});
});
