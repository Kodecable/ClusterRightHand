import type { TaskGroupView, TaskView } from "@crh/api";
import { describe, expect, it } from "vitest";
import { type TaskOutcomeInput, taskGroupOutcome, taskOutcome } from "../src/cluster/outcome.ts";
import type { ToolContext } from "../src/tools/catalog.ts";
import { execTaskResult, groupTextNote, lateResultText, taskDetails } from "../src/tools/task-render.ts";

const task = (overrides: Partial<TaskOutcomeInput> = {}): TaskOutcomeInput => ({
	kind: "exec",
	state: "exited",
	exitCode: 0,
	signal: null,
	timedOut: false,
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
		expect(taskOutcome(task({ state: "cancelled", exitCode: 3, signal: "TERM" }))).toEqual({
			kind: "cancelled",
			failed: false,
		});
		expect(
			taskOutcome(
				task({
					state: "expired",
					exitCode: null,
					errorCode: "authorization_wait_expired",
					errorMessage: "no signature arrived within 24 hours",
				}),
			),
		).toEqual({
			kind: "expired",
			failed: false,
			errorCode: "authorization_wait_expired",
			errorMessage: "no signature arrived within 24 hours",
		});
		expect(taskOutcome(task({ state: "rejected", exitCode: null }))).toEqual({ kind: "rejected", failed: true });
		expect(taskOutcome(task({ state: "denied", exitCode: null }))).toEqual({ kind: "denied", failed: true });
		expect(
			taskOutcome(task({ state: "errored", exitCode: null, errorCode: "node_offline", errorMessage: "gone" })),
		).toEqual({ kind: "error", failed: true, errorCode: "node_offline", errorMessage: "gone" });
		expect(taskOutcome(task({ state: "unknown", exitCode: null }))).toEqual({ kind: "unknown", failed: true });
	});

	it("reads a cancelled task as cancelled, even when it kept an exit code or a signal", () => {
		expect(
			taskOutcome(
				task({
					state: "cancelled",
					exitCode: 143,
					signal: "TERM",
					errorMessage: "the session was stopped",
				}),
			),
		).toEqual({ kind: "cancelled", failed: false });
	});

	it("follows the documented priority when several flags hold", () => {
		// cancelled/expired > timed out > signal > rejected/denied > platform error > unknown > exit code.
		expect(
			taskOutcome(task({ state: "cancelled", timedOut: true, signal: "SIGKILL", errorCode: "x", exitCode: 2 })),
		).toMatchObject({ kind: "cancelled", failed: false });
		expect(
			taskOutcome(task({ state: "expired", timedOut: true, signal: "SIGKILL", errorCode: "x", exitCode: 2 })),
		).toMatchObject({ kind: "expired", failed: false });
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

	it("keeps the recorded unknown answer when a late result filled in the flags", () => {
		// The node later reported exit 0, but the task was already answered unknown.
		expect(
			taskOutcome(
				task({
					state: "unknown",
					errorCode: "connection_lost",
					errorMessage: "the connection was lost",
					exitCode: 0,
					signal: "SIGKILL",
					timedOut: true,
				}),
			),
		).toEqual({ kind: "error", failed: true, errorCode: "connection_lost", errorMessage: "the connection was lost" });
		// A row without a recorded reason stays unknown, even with a late exit or signal.
		expect(taskOutcome(task({ state: "unknown", exitCode: 0, signal: "SIGKILL", timedOut: true }))).toEqual({
			kind: "unknown",
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
						view({ outcome: { kind: "expired", failed: false } }),
						view({ outcome: { kind: "succeeded", failed: false } }),
					],
				}),
			),
		).toEqual({ kind: "expired", failed: false });
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

		const cancelled = execTaskResult(ctx, view({ state: "cancelled", exitCode: null }), "web-1");
		expect(cancelled.isError).toBe(false);
		expect(cancelled.content.at(-1)?.text).toContain("cancelled");

		const expired = execTaskResult(ctx, view({ state: "expired", exitCode: null }), "web-1");
		expect(expired.isError).toBe(false);
		expect(expired.content.at(-1)?.text).toContain("expired");

		const timedOut = execTaskResult(ctx, view({ state: "exited", exitCode: null, timedOut: true }), "web-1");
		expect(timedOut.isError).toBe(true);
		expect(timedOut.content.at(-1)?.text).toContain("timed out");

		const signal = execTaskResult(ctx, view({ state: "exited", exitCode: null, signal: "SIGKILL" }), "web-1");
		expect(signal.isError).toBe(true);
		expect(signal.content.at(-1)?.text).toContain("killed by SIGKILL");
	});

	it("does not put the old cancellation flag in the details", () => {
		const details = taskDetails(view({ state: "cancelled" }), "web-1");
		expect(details).toMatchObject({ state: "cancelled" });
		expect(details).not.toHaveProperty("cancelled");
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
		expect(groupTextNote(ctx, failed, undefined)).toContain("1 succeeded, 1 failed");
		const cancelled = group({ state: "cancelled", outcome: { kind: "cancelled", failed: false }, tasks: [] });
		expect(groupTextNote(ctx, cancelled, undefined)).toContain("cancelled");
	});
});

describe("late results on unknown tasks", () => {
	const ctx = {} as ToolContext;
	const unknown = (overrides: Partial<TaskView> = {}): TaskView =>
		view({
			state: "unknown",
			exitCode: null,
			signal: null,
			timedOut: false,
			errorCode: "connection_lost",
			errorMessage: "the connection to the node was lost while the task ran",
			...overrides,
		});

	it("names what the node reported later, only for an unknown task", () => {
		expect(lateResultText(unknown({ exitCode: 0 }))).toBe("the node later reported exit 0");
		expect(lateResultText(unknown({ exitCode: 0, timedOut: true }))).toBe("the node later reported exit 0 (timed out)");
		expect(lateResultText(unknown({ signal: "SIGKILL" }))).toBe("the node later reported it was killed by SIGKILL");
		expect(lateResultText(unknown({ signal: "SIGKILL", timedOut: true }))).toBe(
			"the node later reported it was killed by SIGKILL (timed out)",
		);
		expect(lateResultText(unknown())).toBeUndefined();
		expect(lateResultText(view({ exitCode: 2 }))).toBeUndefined();
	});

	it("appends the late result to the note block", () => {
		const exit = execTaskResult(ctx, unknown({ exitCode: 0 }), "web-1");
		expect(exit.isError).toBe(true);
		expect(exit.content.at(-1)?.text).toBe(
			"[web-1, error connection_lost: the connection to the node was lost while the task ran; the node later reported exit 0]",
		);

		const signal = execTaskResult(ctx, unknown({ signal: "SIGKILL" }), "web-1");
		expect(signal.content.at(-1)?.text).toContain("; the node later reported it was killed by SIGKILL]");

		const noLate = execTaskResult(ctx, unknown(), "web-1");
		expect(noLate.content.at(-1)?.text).toBe(
			"[web-1, error connection_lost: the connection to the node was lost while the task ran]",
		);
	});

	it("shows the late output tail like any other finished task's", () => {
		const result = execTaskResult(
			ctx,
			unknown({ exitCode: 0, outputBytes: 5, outputTail: "late\n", outputTailLines: 1, outputLines: 1 }),
			"web-1",
		);
		expect(result.content[0]?.text).toBe("late\n");
		expect(result.content.at(-1)?.text).toContain("the node later reported exit 0");
	});

	it("carries the late result in the status JSON and drops the SSH note for an unknown task", () => {
		const status = execTaskResult(ctx, unknown({ exitCode: 0, outputMode: "status" }), "web-1");
		const value = JSON.parse(status.content[0]?.text ?? "") as Record<string, unknown>;
		expect(value.late_result).toBe("the node later reported exit 0");
		expect(value.state).toBe("unknown");
		expect(value.exit_code).toBe(0);
		expect(value).not.toHaveProperty("note");

		// The "SSH nodes keep no output" note is for a task that really finished, not for an unknown one.
		const exited = execTaskResult(ctx, view({ outputMode: "status" }), "web-1");
		expect(JSON.parse(exited.content[0]?.text ?? "")).toMatchObject({
			note: "no output file was reported; SSH nodes keep no output",
		});
	});
});
