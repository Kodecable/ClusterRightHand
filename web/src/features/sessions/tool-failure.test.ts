import { describe, expect, test } from "vitest";
import type { TaskGroupView, TaskView } from "@/lib/api/types";
import { groupViewFailure, taskViewFailure, toolFailure } from "./tool-failure";

const result = (value: Record<string, unknown>): string => JSON.stringify(value);

const view = (overrides: Partial<TaskView> = {}): TaskView =>
	({
		state: "exited",
		exitCode: 0,
		signal: null,
		timedOut: false,
		cancelled: false,
		...overrides,
	}) as TaskView;

const group = (overrides: Partial<TaskGroupView> = {}): TaskGroupView =>
	({ state: "finished", tasks: [view()], ...overrides }) as TaskGroupView;

describe("toolFailure", () => {
	test("a file read without an exit code is not a failure", () => {
		// The shape `read_file` returns: no exit_code at all, so nothing may be inferred from its absence.
		expect(toolFailure(result({ task_id: "t1", node: "web-1", state: "exited", lines: { from: 1, to: 10 } }))).toBe(
			undefined,
		);
	});

	test("an exited task with exit code 0 is not a failure", () => {
		expect(toolFailure(result({ task_id: "t1", node: "web-1", state: "exited", exit_code: 0 }))).toBeUndefined();
	});

	test("a running task is not a failure", () => {
		expect(toolFailure(result({ task_id: "t1", node: "web-1", state: "running" }))).toBeUndefined();
		expect(toolFailure(result({ task_group_id: "g1", state: "running", nodes: [] }))).toBeUndefined();
	});

	test("a non-zero exit code is a failure with the code as its label", () => {
		expect(toolFailure(result({ task_id: "t1", node: "web-1", state: "exited", exit_code: 2 }))).toEqual({
			kind: "failed",
			reason: "exit",
			exitCode: 2,
		});
	});

	test("a cancelled task is a failure, even when it exited", () => {
		expect(toolFailure(result({ task_id: "t1", state: "exited", exit_code: 0, cancelled: true }))).toEqual({
			kind: "failed",
			reason: "cancelled",
		});
		expect(toolFailure(result({ task_id: "t1", state: "failed", cancelled: true }))).toEqual({
			kind: "failed",
			reason: "cancelled",
		});
	});

	test("a timed-out task is a failure", () => {
		expect(toolFailure(result({ task_id: "t1", state: "exited", timed_out: true }))).toEqual({
			kind: "failed",
			reason: "timed-out",
		});
	});

	test("a signal is a failure", () => {
		expect(toolFailure(result({ task_id: "t1", state: "exited", signal: "SIGKILL" }))).toEqual({
			kind: "failed",
			reason: "signal",
		});
	});

	test("every failed state counts", () => {
		for (const state of ["failed", "denied", "rejected", "unknown"]) {
			expect(toolFailure(result({ task_id: "t1", state }))).toEqual({ kind: "failed", reason: "state" });
		}
	});

	test("a finished group whose members all succeeded is not a failure", () => {
		expect(
			toolFailure(
				result({
					task_group_id: "g1",
					state: "finished",
					nodes: [
						{ task_id: "t1", node: "a", state: "exited", exit_code: 0 },
						{ task_id: "t2", node: "b", state: "exited", exit_code: 0 },
					],
				}),
			),
		).toBeUndefined();
	});

	test("a group with one failed member is partly failed", () => {
		expect(
			toolFailure(
				result({
					task_group_id: "g1",
					state: "finished",
					nodes: [
						{ task_id: "t1", node: "a", state: "exited", exit_code: 0 },
						{ task_id: "t2", node: "b", state: "exited", exit_code: 1 },
					],
				}),
			),
		).toEqual({ kind: "partly-failed" });
	});

	test("a group all of whose members failed is failed", () => {
		expect(
			toolFailure(
				result({
					task_group_id: "g1",
					state: "finished",
					nodes: [
						{ task_id: "t1", node: "a", state: "failed" },
						{ task_id: "t2", node: "b", state: "exited", exit_code: 0, timed_out: true },
					],
				}),
			),
		).toEqual({ kind: "failed", reason: "state" });
	});

	test("an interrupted or rejected group is failed", () => {
		for (const state of ["interrupted", "rejected"]) {
			expect(
				toolFailure(
					result({
						task_group_id: "g1",
						state,
						nodes: [{ task_id: "t1", node: "a", state: "exited", exit_code: 0 }],
					}),
				),
			).toEqual({ kind: "failed", reason: "state" });
		}
	});

	test("a group with no member results is not a failure", () => {
		expect(toolFailure(result({ task_group_id: "g1", state: "finished", nodes: [] }))).toBeUndefined();
	});

	test("a result that is not a task or a group has no failure", () => {
		expect(toolFailure("not json")).toBeUndefined();
		expect(toolFailure('{"subagents":[]}')).toBeUndefined();
		expect(toolFailure(JSON.stringify(["a"]))).toBeUndefined();
	});
});

describe("taskViewFailure", () => {
	test("a clean exit and an open task are not failures", () => {
		expect(taskViewFailure(view())).toBeUndefined();
		expect(taskViewFailure(view({ state: "running", exitCode: null }))).toBeUndefined();
		expect(taskViewFailure(view({ state: "awaiting_approval", exitCode: null }))).toBeUndefined();
	});

	test("the stored fields fail exactly like a result's JSON", () => {
		expect(taskViewFailure(view({ exitCode: 2 }))).toEqual({ kind: "failed", reason: "exit", exitCode: 2 });
		expect(taskViewFailure(view({ signal: "SIGKILL" }))).toEqual({ kind: "failed", reason: "signal" });
		expect(taskViewFailure(view({ timedOut: true }))).toEqual({ kind: "failed", reason: "timed-out" });
		expect(taskViewFailure(view({ cancelled: true }))).toEqual({ kind: "failed", reason: "cancelled" });
		expect(taskViewFailure(view({ exitCode: 0, cancelled: true }))).toEqual({
			kind: "failed",
			reason: "cancelled",
		});
		for (const state of ["failed", "denied", "rejected", "unknown"]) {
			expect(taskViewFailure(view({ state })), state).toEqual({ kind: "failed", reason: "state" });
		}
	});
});

describe("groupViewFailure", () => {
	test("a finished group whose members all succeeded is not a failure", () => {
		expect(groupViewFailure(group())).toBeUndefined();
		expect(groupViewFailure(group({ tasks: [] }))).toBeUndefined();
	});

	test("a group with some failed members is partly failed", () => {
		expect(groupViewFailure(group({ tasks: [view(), view({ exitCode: 1 })] }))).toEqual({ kind: "partly-failed" });
	});

	test("a group all of whose members failed is failed", () => {
		expect(groupViewFailure(group({ tasks: [view({ state: "failed" }), view({ timedOut: true })] }))).toEqual({
			kind: "failed",
			reason: "state",
		});
	});

	test("an interrupted or rejected group is failed whatever its members did", () => {
		for (const state of ["interrupted", "rejected"] as const) {
			expect(groupViewFailure(group({ state })), state).toEqual({ kind: "failed", reason: "state" });
		}
	});
});
