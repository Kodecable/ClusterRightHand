import type { TaskGroupView, TaskView } from "@crh/api";
import { describe, expect, it } from "vitest";
import { type TaskOutcomeInput, taskGroupOutcome, taskOutcome } from "../src/cluster/outcome.ts";
import type { ToolContext } from "../src/tools/catalog.ts";
import { execTaskResult, groupTextNote } from "../src/tools/task-render.ts";

const task = (overrides: Partial<TaskOutcomeInput> = {}): TaskOutcomeInput => ({
	kind: "exec",
	state: "exited",
	exitCode: 0,
	signal: null,
	timedOut: false,
	cancelled: false,
	errorCode: null,
	errorMessage: null,
	...overrides,
});

const view = (overrides: Partial<TaskView> = {}): TaskView =>
	({
		id: "t1",
		nodeId: "n1",
		kind: "exec",
		summary: "true",
		action: { type: "exec", command: "true" },
		source: { type: "user", userId: "u1", username: "alice" },
		outcome: null,
		operation: null,
		actorType: "user",
		actorId: "u1",
		onBehalfOfUserId: "u1",
		state: "exited",
		exitCode: 0,
		signal: null,
		timedOut: false,
		cancelled: false,
		timeoutMs: null,
		errorCode: null,
		errorMessage: null,
		outputBytes: 0,
		outputHead: "",
		outputTail: "",
		outputTailLines: 0,
		outputLines: null,
		notice: null,
		maxLines: null,
		maxBytes: null,
		outputFile: null,
		outputMode: "full",
		privileged: false,
		authorization: null,
		result: null,
		createdAt: "2026-01-01T00:00:00.000Z",
		finishedAt: null,
		taskGroupId: null,
		ruleChain: null,
		approval: null,
		rootSessionId: null,
		handlerType: null,
		handlerSessionId: null,
		purpose: null,
		phase: "awaiting_user",
		...overrides,
	}) as TaskView;

const group = (overrides: Partial<TaskGroupView> = {}): TaskGroupView =>
	({
		id: "g1",
		state: "finished",
		targets: ["n1"],
		refs: {},
		nodeIds: ["n1"],
		parallel: 1,
		failFast: false,
		outputMode: "status",
		nodeMaxLines: null,
		nodeMaxBytes: null,
		privileged: false,
		skipped: [],
		tasks: [],
		createdAt: "2026-01-01T00:00:00.000Z",
		finishedAt: null,
		summary: "true",
		action: { type: "exec", command: "true" },
		source: { type: "user", userId: "u1", username: "alice" },
		outcome: null,
		kind: "exec",
		ruleChain: null,
		approval: null,
		actorType: "user",
		actorId: "u1",
		onBehalfOfUserId: "u1",
		operation: null,
		rootSessionId: null,
		handlerType: null,
		handlerSessionId: null,
		purpose: null,
		phase: "awaiting_user",
		...overrides,
	}) as TaskGroupView;

describe("taskOutcome", () => {
	it("is null while the task is not terminal", () => {
		for (const state of ["awaiting_approval", "awaiting_authorization", "dispatched", "running"] as const) {
			expect(taskOutcome(task({ state })), state).toBeNull();
		}
	});

	it("classifies every kind and its failed flag", () => {
		expect(taskOutcome(task({ state: "exited", exitCode: 0 }))).toEqual({
			kind: "succeeded",
			failed: false,
			exitCode: 0,
		});
		expect(taskOutcome(task({ state: "exited", exitCode: 2 }))).toEqual({ kind: "exit", failed: true, exitCode: 2 });
		expect(taskOutcome(task({ state: "exited", exitCode: null, signal: "SIGKILL" }))).toEqual({
			kind: "signal",
			failed: true,
			signal: "SIGKILL",
		});
		expect(taskOutcome(task({ state: "exited", exitCode: null, timedOut: true }))).toEqual({
			kind: "timed_out",
			failed: true,
		});
		expect(taskOutcome(task({ state: "exited", exitCode: null, cancelled: true }))).toEqual({
			kind: "cancelled",
			failed: false,
		});
		expect(taskOutcome(task({ state: "rejected", exitCode: null }))).toEqual({ kind: "rejected", failed: true });
		expect(taskOutcome(task({ state: "denied", exitCode: null }))).toEqual({ kind: "denied", failed: true });
		expect(
			taskOutcome(task({ state: "failed", exitCode: null, errorCode: "node_offline", errorMessage: "gone" })),
		).toEqual({ kind: "error", failed: true, errorCode: "node_offline", errorMessage: "gone" });
		expect(taskOutcome(task({ state: "unknown", exitCode: null }))).toEqual({ kind: "unknown", failed: true });
	});

	it("reads a wait ended by a stopped session (rejected with the cancel code) as cancelled, not failed", () => {
		expect(
			taskOutcome(
				task({
					state: "rejected",
					exitCode: null,
					errorCode: "cancelled",
					errorMessage: "the session was stopped",
				}),
			),
		).toEqual({ kind: "cancelled", failed: false });
	});

	it("follows the documented priority when several flags hold", () => {
		// cancelled > timed out > signal > rejected/denied > platform error > unknown > exit code.
		expect(
			taskOutcome(
				task({ state: "rejected", cancelled: true, timedOut: true, signal: "SIGKILL", errorCode: "x", exitCode: 2 }),
			),
		).toMatchObject({ kind: "cancelled", failed: false });
		expect(
			taskOutcome(task({ state: "rejected", timedOut: true, signal: "SIGKILL", errorCode: "x", exitCode: 2 })),
		).toMatchObject({ kind: "timed_out", failed: true });
		expect(taskOutcome(task({ state: "rejected", signal: "SIGKILL", errorCode: "x", exitCode: 2 }))).toMatchObject({
			kind: "signal",
			failed: true,
		});
		expect(taskOutcome(task({ state: "rejected", errorCode: "approval_required", exitCode: 2 }))).toMatchObject({
			kind: "rejected",
			failed: true,
		});
		expect(taskOutcome(task({ state: "unknown", errorCode: "connection_lost", exitCode: 2 }))).toMatchObject({
			kind: "error",
			failed: true,
		});
	});

	it("keeps exec's exit 0 as a code but leaves a file operation's success bare", () => {
		expect(taskOutcome(task({ kind: "exec", exitCode: 0 }))?.exitCode).toBe(0);
		expect(taskOutcome(task({ kind: "file.read", exitCode: 0 }))?.exitCode).toBeUndefined();
		expect(taskOutcome(task({ kind: "file.read", exitCode: 3 }))).toEqual({
			kind: "exit",
			failed: true,
			exitCode: 3,
		});
	});
});

describe("taskGroupOutcome", () => {
	it("is null until the group is terminal", () => {
		expect(taskGroupOutcome(group({ state: "running" }))).toBeNull();
		expect(taskGroupOutcome(group({ state: "awaiting_approval" }))).toBeNull();
	});

	it("keeps cancelled not failed, makes rejected and interrupted failed, and looks at the members of a finished group", () => {
		expect(taskGroupOutcome(group({ state: "cancelled" }))).toEqual({ kind: "cancelled", failed: false });
		expect(taskGroupOutcome(group({ state: "rejected" }))).toEqual({ kind: "rejected", failed: true });
		expect(taskGroupOutcome(group({ state: "interrupted" }))).toMatchObject({ kind: "error", failed: true });
		expect(taskGroupOutcome(group({ state: "finished", tasks: [] }))).toEqual({
			kind: "succeeded",
			failed: false,
		});
		expect(
			taskGroupOutcome(
				group({
					state: "finished",
					tasks: [
						view({ outcome: { kind: "succeeded", failed: false, exitCode: 0 } }),
						view({ outcome: { kind: "exit", failed: true, exitCode: 1 } }),
					],
				}),
			),
		).toEqual({ kind: "error", failed: true, errorCode: null, errorMessage: null });
	});
});

describe("task-render text", () => {
	const ctx = {} as ToolContext;
	it("uses the outcome's ordering and failed flag in the model-facing note", () => {
		const exit = execTaskResult(ctx, view({ exitCode: 2 }), "web-1");
		expect(exit.isError).toBe(true);
		expect(exit.content.at(-1)?.text).toContain("exit 2");

		const cancelled = execTaskResult(ctx, view({ state: "exited", exitCode: null, cancelled: true }), "web-1");
		expect(cancelled.isError).toBe(false);
		expect(cancelled.content.at(-1)?.text).toContain("cancelled");

		const timedOut = execTaskResult(ctx, view({ state: "exited", exitCode: null, timedOut: true }), "web-1");
		expect(timedOut.isError).toBe(true);
		expect(timedOut.content.at(-1)?.text).toContain("timed out");

		const signal = execTaskResult(ctx, view({ state: "exited", exitCode: null, signal: "SIGKILL" }), "web-1");
		expect(signal.isError).toBe(true);
		expect(signal.content.at(-1)?.text).toContain("killed by SIGKILL");
	});

	it("counts a group from member outcomes and marks it failed when the group outcome failed", () => {
		const failed = group({
			state: "finished",
			outcome: { kind: "error", failed: true, errorCode: null, errorMessage: null },
			tasks: [
				view({ id: "t1", outcome: { kind: "succeeded", failed: false, exitCode: 0 } }),
				view({ id: "t2", outcome: { kind: "exit", failed: true, exitCode: 1 } }),
			],
		});
		expect(groupTextNote(ctx, failed, false)).toContain("1 succeeded, 1 failed");
		const cancelled = group({ state: "cancelled", outcome: { kind: "cancelled", failed: false }, tasks: [] });
		expect(groupTextNote(ctx, cancelled, false)).toContain("cancelled");
	});
});
