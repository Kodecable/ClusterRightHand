import type { TaskAction } from "@crh/api";
import { describe, expect, it, vi } from "vitest";
import type { Cluster, TaskView } from "../src/cluster/cluster.ts";
import { taskGroupOutcome, taskOutcome } from "../src/cluster/outcome.ts";
import type { TaskGroups, TaskGroupView } from "../src/cluster/task-groups.ts";
import { TERMINAL } from "../src/cluster/types.ts";
import { CallRunner } from "../src/extensions/call-runner.ts";
import { createJobs, type Jobs } from "../src/jobs/jobs.ts";
import type { JobRow, SubagentJobRuntime } from "../src/jobs/types.ts";
import type { Db } from "../src/storage/db.ts";
import { defaultOrgId } from "../src/storage/org.ts";
import { execJobRenderers } from "../src/tools/job-renderers.ts";
import { derivedId, jobId } from "../src/util/id.ts";
import { textResult } from "../src/util/tool-result.ts";
import { openTestDb } from "./helpers/db.ts";

function task(overrides: Partial<TaskView>): TaskView {
	const base: TaskView = {
		id: "t1",
		nodeId: "n1",
		kind: "exec",
		summary: "true",
		action: { type: "exec", command: "true" },
		source: { type: "user", userId: "u1", username: "u1" },
		outcome: null,
		operation: null,
		actorType: "session",
		actorId: "s1",
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
		notice: null,
		outputLines: null,
		maxLines: null,
		maxBytes: null,
		outputFile: null,
		outputLost: false,
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
	};
	base.outcome = overrides.outcome ?? taskOutcome(base);
	return base;
}

function group(overrides: Partial<TaskGroupView>): TaskGroupView {
	const base: TaskGroupView = {
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
		finishedAt: "2026-01-01T00:00:00.000Z",
		summary: "true",
		action: { type: "exec", command: "true" },
		source: { type: "user", userId: "u1", username: "u1" },
		outcome: null,
		kind: "exec",
		ruleChain: null,
		approval: null,
		actorType: "session",
		actorId: "s1",
		onBehalfOfUserId: "u1",
		operation: null,
		rootSessionId: null,
		handlerType: null,
		handlerSessionId: null,
		purpose: null,
		phase: "awaiting_user",
		...overrides,
	};
	base.outcome = overrides.outcome ?? taskGroupOutcome(base);
	return base;
}

/** The fake execution records a job adapter reads; no Cluster state machine runs in these tests. */
interface World {
	db: Db;
	jobs: Jobs;
	cluster: Cluster;
	taskGroups: TaskGroups;
	setTask(task: TaskView): Promise<void>;
	setGroup(value: TaskGroupView): Promise<void>;
}

async function world(owner: string): Promise<World> {
	const db = await openTestDb("sqlite");
	// The job and session rows reference a real user; the tests use the fixed id "u1" as the owner.
	await db
		.insertInto("users")
		.values({
			id: owner,
			org_id: await defaultOrgId(db),
			username: owner,
			display_name: owner,
			email: null,
			kind: "member",
			password_hash: null,
			status: "active",
			created_at: new Date().toISOString(),
		})
		.execute();
	const tasks = new Map<string, TaskView>();
	const groups = new Map<string, TaskGroupView>();
	const fakeCluster = {
		getTask: async (id: string) => tasks.get(id),
		waitTask: async (id: string) => tasks.get(id),
		cancelTask: async (id: string) => {
			const current = tasks.get(id);
			if (!current || TERMINAL.has(current.state)) return false;
			tasks.set(id, task({ ...current, state: "cancelled", exitCode: null }));
			wake(id);
			return true;
		},
		get waitsEnded() {
			return false;
		},
		onTaskChanged: undefined as ((taskId: string) => void) | undefined,
	} as unknown as Cluster;
	const cluster: Cluster = fakeCluster;
	const wake = (id: string) => (cluster as unknown as { onTaskChanged?: (taskId: string) => void }).onTaskChanged?.(id);
	const fakeGroups = {
		get: async (id: string) => groups.get(id),
		wait: async (id: string) => groups.get(id),
		cancel: async (id: string) => {
			const current = groups.get(id);
			if (!current || !["running", "awaiting_approval", "awaiting_authorization"].includes(current.state)) return false;
			groups.set(id, group({ ...current, state: "cancelled", tasks: [] }));
			return true;
		},
		get waitsEnded() {
			return false;
		},
		onGroupSettled: undefined as ((groupId: string) => void) | undefined,
	} as unknown as TaskGroups;
	const jobs = createJobs({
		callRunner: new CallRunner(),
		db,
		cluster,
		taskGroups: fakeGroups,
		execRenderers: execJobRenderers,
	});
	return {
		db,
		jobs,
		cluster,
		taskGroups: fakeGroups,
		async setTask(value) {
			tasks.set(value.id, value);
			wake(value.id);
		},
		async setGroup(value) {
			groups.set(value.id, value);
		},
	};
}

async function addSession(
	db: Db,
	input: { id: string; owner: string; parent?: string | null; state?: "idle" | "running" | "awaiting" },
): Promise<void> {
	const now = new Date().toISOString();
	await db
		.insertInto("sessions")
		.values({
			id: input.id,
			org_id: await defaultOrgId(db),
			owner_user_id: input.owner,
			conversation_id: `conv-${input.id}`,
			parent_session_id: input.parent ?? null,
			root_session_id: input.parent ?? input.id,
			title: null,
			title_pending: 0,
			model: JSON.stringify({ provider: "p", modelId: "m" }),
			status: "active",
			created_at: now,
			updated_at: now,
			archived_at: null,
			last_submission_id: null,
			disabled_extensions: null,
			state: input.state ?? "idle",
			waiting_kind: null,
			waiting_level_id: null,
			waiting_handler_id: null,
			state_changed_at: now,
			quota_tokens: null,
		})
		.execute();
}

async function addExternalCall(
	db: Db,
	input: {
		id: string;
		state: "awaiting_approval" | "running" | "succeeded" | "failed" | "rejected" | "cancelled" | "unknown";
		handler?: "user" | "agent" | null;
		approval?: Record<string, unknown> | null;
	},
): Promise<void> {
	const now = new Date().toISOString();
	await db
		.insertInto("external_calls")
		.values({
			id: input.id,
			org_id: await defaultOrgId(db),
			actor_type: "session",
			actor_id: "s1",
			on_behalf_of_user_id: "u1",
			extension_name: "github",
			tool_name: "create_issue",
			arguments: input.state === "running" || input.state === "awaiting_approval" ? "{}" : null,
			operation: JSON.stringify({ method: "ext.write", target: "github/create_issue" }),
			annotations: null,
			rule_chain: null,
			approval: input.approval ? JSON.stringify(input.approval) : null,
			pending_input: null,
			root_session_id: null,
			handler_type: input.handler ?? null,
			handler_session_id: null,
			state: input.state,
			created_at: now,
			finished_at: null,
			source_tool_task: null,
			tool_rev: null,
		})
		.execute();
}

const EXEC_ACTION: TaskAction = { type: "exec", command: "true" };

function jobOf(
	kind: "exec" | "call" | "subagent",
	callKey: string,
	resource: { type: "task" | "task_group" | "external_call" | "session"; id: string },
	action: TaskAction = EXEC_ACTION,
): Parameters<Jobs["ensure"]>[0] {
	return {
		kind,
		callKey,
		actor: { type: "session", id: "s1", onBehalfOfUserId: "u1" },
		sessionId: "s1",
		resourceType: resource.type,
		resourceId: resource.id,
		action,
	};
}

describe("jobs: ids and replay", () => {
	it("derives the id from the call key and the kind", () => {
		const hex = derivedId("job:call-1").replaceAll("-", "").slice(0, 16);
		expect(jobId("exec", "call-1")).toBe(`exec-${hex}`);
		expect(jobId("call", "call-1")).toBe(`call-${hex}`);
		expect(jobId("exec", "call-1")).not.toBe(jobId("exec", "call-2"));
		expect(jobId("subagent", "call-1")).toMatch(/^subagent-[0-9a-f]{16}$/);
	});

	it("creates one row for a replayed tool call", async () => {
		const w = await world("u1");
		try {
			await addSession(w.db, { id: "s1", owner: "u1" });
			const first = await w.jobs.ensure(jobOf("exec", "call-1", { type: "task", id: "t1" }));
			const again = await w.jobs.ensure(jobOf("exec", "call-1", { type: "task", id: "t1" }));
			expect(again.id).toBe(first.id);
			expect(await w.db.selectFrom("jobs").selectAll().execute()).toHaveLength(1);
			expect(first).toMatchObject({
				kind: "exec",
				resource_type: "task",
				resource_id: "t1",
				actor_type: "session",
				actor_id: "s1",
				session_id: "s1",
				call_key: "call-1",
				notice: "none",
			});
			expect(JSON.parse(first.action)).toEqual(EXEC_ACTION);
		} finally {
			await w.db.destroy();
		}
	});
});

describe("jobs: exec projection", () => {
	it("maps a task's waiting, running and terminal states", async () => {
		const w = await world("u1");
		try {
			await addSession(w.db, { id: "s1", owner: "u1" });
			const job = await w.jobs.ensure(jobOf("exec", "approval", { type: "task", id: "t1" }));
			await w.setTask(task({ id: "t1", state: "awaiting_approval", handlerType: "user" }));
			let projected = await w.jobs.project(job);
			expect(projected).toMatchObject({ state: "waiting", wait: "approval" });

			await w.setTask(task({ id: "t1", state: "awaiting_authorization" }));
			projected = await w.jobs.project(job);
			expect(projected).toMatchObject({ state: "waiting", wait: "signature" });

			// Reviewing is running: a pending Auto Review marker is not a user-facing wait.
			await w.setTask(
				task({
					id: "t1",
					state: "awaiting_approval",
					handlerType: "user",
					approval: {
						evaluation: { result: "require-approval", levels: [] },
						review: { status: "pending", startedAt: "x" },
					},
				}),
			);
			projected = await w.jobs.project(job);
			expect(projected).toMatchObject({ state: "running", wait: null });

			await w.setTask(task({ id: "t1", state: "running", exitCode: null }));
			projected = await w.jobs.project(job);
			expect(projected).toMatchObject({ state: "running", wait: null, settled_at: null });

			await w.setTask(task({ id: "t1", state: "exited", exitCode: 0 }));
			projected = await w.jobs.project(job);
			expect(projected?.state).toBe("settled");
			expect(projected?.settled_at).not.toBeNull();
			expect(JSON.parse(projected?.outcome ?? "null")).toEqual({ kind: "succeeded", failed: false, exitCode: 0 });
			const settledAt = projected?.settled_at;
			// A settled job keeps its settled_at on a later projection.
			await w.jobs.project(job);
			const kept = await w.jobs.get(job.id);
			expect(kept?.settled_at).toBe(settledAt);
		} finally {
			await w.db.destroy();
		}
	});

	it("maps a group's terminal outcome and a failed member", async () => {
		const w = await world("u1");
		try {
			await addSession(w.db, { id: "s1", owner: "u1" });
			const job = await w.jobs.ensure(jobOf("exec", "group", { type: "task_group", id: "g1" }));
			await w.setGroup(
				group({
					id: "g1",
					state: "finished",
					tasks: [task({ id: "t1", state: "errored", exitCode: 1 })],
				}),
			);
			const projected = await w.jobs.project(job);
			expect(projected?.state).toBe("settled");
			expect(JSON.parse(projected?.outcome ?? "null")).toMatchObject({ kind: "error", failed: true });
		} finally {
			await w.db.destroy();
		}
	});
});

describe("jobs: record-change hooks", () => {
	it("projects a task and a group after the cluster notifies a change", async () => {
		const w = await world("u1");
		try {
			await addSession(w.db, { id: "s1", owner: "u1" });
			const taskJob = await w.jobs.ensure(jobOf("exec", "task-change", { type: "task", id: "t1" }));
			await w.setTask(task({ id: "t1", state: "awaiting_approval", handlerType: "user" }));
			const taskWaited = await waitFor(
				() => w.jobs.get(taskJob.id),
				(row) => row?.wait === "approval",
			);
			expect(taskWaited?.state).toBe("waiting");

			const groupJob = await w.jobs.ensure(jobOf("exec", "group-change", { type: "task_group", id: "g1" }));
			await w.setGroup(group({ id: "g1", state: "awaiting_authorization" }));
			(w.cluster as unknown as { onGroupChanged?: (id: string) => void }).onGroupChanged?.("g1");
			const groupWaited = await waitFor(
				() => w.jobs.get(groupJob.id),
				(row) => row?.wait === "signature",
			);
			expect(groupWaited?.state).toBe("waiting");
		} finally {
			await w.db.destroy();
		}
	});

	it("drains the projections a record change started", async () => {
		const w = await world("u1");
		try {
			await addSession(w.db, { id: "s1", owner: "u1" });
			const job = await w.jobs.ensure(jobOf("exec", "drain", { type: "task", id: "t1" }));
			await w.setTask(task({ id: "t1", state: "awaiting_approval", handlerType: "user" }));
			(w.cluster as unknown as { onTaskChanged?: (id: string) => void }).onTaskChanged?.("t1");
			// The hook is fire-and-forget; shutdown calls drain() and only then destroys the database.
			await w.jobs.drain();
			expect((await w.jobs.get(job.id))?.state).toBe("waiting");
		} finally {
			await w.db.destroy();
		}
	});
});

/** Polls a read until `done` holds, so a fire-and-forget projection can be observed without sleeping blindly. */
async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
	for (let attempt = 0; attempt < 100; attempt++) {
		const value = await read();
		if (done(value)) return value;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("timed out waiting for the projection");
}

describe("jobs: call projection and result", () => {
	it("maps call states", async () => {
		const w = await world("u1");
		try {
			await addSession(w.db, { id: "s1", owner: "u1" });
			await addExternalCall(w.db, { id: "c1", state: "awaiting_approval", handler: "user" });
			const job = await w.jobs.ensure(
				jobOf(
					"call",
					"call-1",
					{ type: "external_call", id: "c1" },
					{ type: "extension_tool", extension: "github", tool: "create_issue" },
				),
			);
			expect(await w.jobs.project(job)).toMatchObject({ state: "waiting", wait: "approval" });

			await w.db.updateTable("external_calls").set({ state: "succeeded" }).where("id", "=", "c1").execute();
			let projected = await w.jobs.project(job);
			expect(projected?.state).toBe("settled");
			expect(JSON.parse(projected?.outcome ?? "null")).toEqual({ kind: "succeeded", failed: false });

			await addExternalCall(w.db, { id: "c2", state: "failed" });
			const failed = await w.jobs.ensure(jobOf("call", "call-2", { type: "external_call", id: "c2" }));
			projected = await w.jobs.project(failed);
			expect(JSON.parse(projected?.outcome ?? "null")).toEqual({ kind: "error", failed: true });
		} finally {
			await w.db.destroy();
		}
	});

	it("stores the rendered result and returns it from render", async () => {
		const w = await world("u1");
		try {
			await addSession(w.db, { id: "s1", owner: "u1" });
			await addExternalCall(w.db, { id: "c1", state: "succeeded" });
			const job = await w.jobs.ensure(jobOf("call", "call-1", { type: "external_call", id: "c1" }));
			await w.jobs.callResult(
				"call-1",
				textResult([{ output: "issue 42\n", note: "[external result from github/create_issue]" }], { isError: false }),
			);
			const stored = await w.jobs.get(job.id);
			expect(stored?.result).not.toBeNull();
			const rendered = await w.jobs.render(stored as JobRow, {} as never);
			expect(rendered.content.map((block) => block.text)).toEqual([
				"issue 42\n",
				"[external result from github/create_issue]",
			]);
			expect(rendered.isError).toBe(false);
		} finally {
			await w.db.destroy();
		}
	});

	it("holds a call job's wait to its deadline", async () => {
		vi.useFakeTimers();
		const w = await world("u1");
		try {
			await addSession(w.db, { id: "s1", owner: "u1" });
			await addExternalCall(w.db, { id: "c1", state: "running" });
			const job = await w.jobs.ensure(
				jobOf(
					"call",
					"call-wait",
					{ type: "external_call", id: "c1" },
					{ type: "extension_tool", extension: "github", tool: "create_issue" },
				),
			);
			let settled = false;
			// `attention` is the subagent's: a call approval is the user's and never ends the wait early.
			const waiting = w.jobs.waitJob(job, 2, { attention: true }).then((row) => {
				settled = true;
				return row;
			});
			await vi.advanceTimersByTimeAsync(1_999);
			expect(settled).toBe(false);
			await vi.advanceTimersByTimeAsync(1);
			expect((await waiting)?.state).toBe("running");
		} finally {
			vi.useRealTimers();
			await w.db.destroy();
		}
	});
});

describe("jobs: subagent projection", () => {
	function fakeRuntime(run: {
		state: "idle" | "running" | "awaiting";
		wait: "quota" | "decision" | "approval" | null;
		outcome: unknown;
	}): SubagentJobRuntime {
		return {
			project: async () => run as never,
			wait: async () => ({ status: "done" as const }),
			cancel: async () => true,
			answer: async () => "the answer",
			requestsBlock: async () => undefined,
			noticeBusy: () => false,
			noticeWakeAvailable: async () => true,
		};
	}

	it("settles only when the child is idle and owns no unsettled job or undelivered notice", async () => {
		const w = await world("u1");
		try {
			await addSession(w.db, { id: "s1", owner: "u1" });
			await addSession(w.db, { id: "child", owner: "u1", parent: "s1", state: "idle" });
			w.jobs.attachSubagent(fakeRuntime({ state: "idle", wait: null, outcome: { kind: "succeeded", failed: false } }));
			// A child that started background work is not finished: the parent job stays running. Its job exists
			// before the parent's first projection, so this never depends on a settled job reopening.
			const childJob = await w.jobs.ensure({
				kind: "exec",
				callKey: "child-call",
				actor: { type: "subagent", id: "child", onBehalfOfUserId: "u1" },
				sessionId: "child",
				resourceType: "task",
				resourceId: "t1",
				action: EXEC_ACTION,
			});
			expect(childJob.state).not.toBe("settled");
			const parent = await w.jobs.ensure(
				jobOf("subagent", "call-sub", { type: "session", id: "child" }, { type: "subagent", task: "do work" }),
			);
			expect(parent.state).toBe("running");

			// Its run ended and its job settled, but the notice that wakes it is still pending: unsettled.
			await w.setTask(task({ id: "t1", state: "exited" }));
			const settledChild = await w.jobs.project(childJob);
			expect(settledChild?.state).toBe("settled");
			expect(settledChild?.notice).toBe("pending");
			expect((await w.jobs.project(parent))?.state).toBe("running");

			// job_wait collects the notice; now the child owns only settled, delivered work.
			await w.jobs.collect(childJob.id);
			expect((await w.jobs.project(parent))?.state).toBe("settled");

			// A settled job never reopens, even when its child starts a new job.
			const later = await w.jobs.ensure({
				kind: "exec",
				callKey: "child-later",
				actor: { type: "subagent", id: "child", onBehalfOfUserId: "u1" },
				sessionId: "child",
				resourceType: "task",
				resourceId: "t2",
				action: EXEC_ACTION,
			});
			expect(later.state).not.toBe("settled");
			expect((await w.jobs.project(parent))?.state).toBe("settled");
		} finally {
			await w.db.destroy();
		}
	});

	it("keeps a subagent job_wait open while the child owns an unsettled job", async () => {
		vi.useFakeTimers();
		const w = await world("u1");
		try {
			await addSession(w.db, { id: "s1", owner: "u1" });
			await addSession(w.db, { id: "child", owner: "u1", parent: "s1", state: "idle" });
			w.jobs.attachSubagent(fakeRuntime({ state: "idle", wait: null, outcome: { kind: "succeeded", failed: false } }));
			const childJob = await w.jobs.ensure({
				kind: "exec",
				callKey: "wait-child",
				actor: { type: "subagent", id: "child", onBehalfOfUserId: "u1" },
				sessionId: "child",
				resourceType: "task",
				resourceId: "t1",
				action: EXEC_ACTION,
			});
			const parent = await w.jobs.ensure(
				jobOf("subagent", "wait-parent", { type: "session", id: "child" }, { type: "subagent", task: "do work" }),
			);
			expect(parent.state).toBe("running");

			let finished = false;
			const waiting = w.jobs.waitJob(parent, 600, { attention: true }).then((row) => {
				finished = true;
				return row;
			});
			await vi.advanceTimersByTimeAsync(1_000);
			// The child's run is done, but its job is not: the wait must not return yet.
			expect(finished).toBe(false);
			await vi.advanceTimersByTimeAsync(100_000);
			expect(finished).toBe(false);

			await w.setTask(task({ id: "t1", state: "exited" }));
			await w.jobs.project(childJob);
			await w.jobs.collect(childJob.id);
			await w.jobs.project(parent);
			await vi.advanceTimersByTimeAsync(1_000);
			expect((await waiting)?.state).toBe("settled");
		} finally {
			vi.useRealTimers();
			await w.db.destroy();
		}
	});

	it("maps a waiting child's wait kind and a cancelled run", async () => {
		const w = await world("u1");
		try {
			await addSession(w.db, { id: "s1", owner: "u1" });
			await addSession(w.db, { id: "child", owner: "u1", parent: "s1", state: "awaiting" });
			w.jobs.attachSubagent(fakeRuntime({ state: "awaiting", wait: "quota", outcome: null }));
			const job = await w.jobs.ensure(
				jobOf("subagent", "call-sub", { type: "session", id: "child" }, { type: "subagent", task: "do work" }),
			);
			expect(await w.jobs.project(job)).toMatchObject({ state: "waiting", wait: "quota" });

			w.jobs.attachSubagent(fakeRuntime({ state: "idle", wait: null, outcome: { kind: "cancelled", failed: false } }));
			expect(await w.jobs.project(job)).toMatchObject({ state: "settled" });
		} finally {
			await w.db.destroy();
		}
	});
});

describe("jobs: ownership", () => {
	it("lets a session, its ancestors and the same token through, and nobody else", async () => {
		const w = await world("u1");
		try {
			await addSession(w.db, { id: "root", owner: "u1" });
			await addSession(w.db, { id: "a", owner: "u1", parent: "root" });
			await addSession(w.db, { id: "b", owner: "u1", parent: "root" });
			const job = await w.jobs.ensure({
				kind: "exec",
				callKey: "owned",
				actor: { type: "session", id: "a", onBehalfOfUserId: "u1" },
				sessionId: "a",
				resourceType: "task",
				resourceId: "t1",
				action: EXEC_ACTION,
			});
			const ctx = (actorId: string, type: "session" | "subagent" | "api_token" = "session") =>
				({
					db: w.db,
					jobs: w.jobs,
					user: { userId: "u1", username: "u1", kind: "member", sessionId: `session:${actorId}` },
					actor: { type, id: actorId, onBehalfOfUserId: "u1" },
				}) as never;
			const { mayReachJob } = await import("../src/jobs/ownership.ts");
			expect(await mayReachJob(ctx("a"), job)).toBe(true);
			expect(await mayReachJob(ctx("root"), job)).toBe(true);
			expect(await mayReachJob(ctx("b"), job)).toBe(false);
			expect(await mayReachJob(ctx("other-token", "api_token"), job)).toBe(false);

			const tokenJob = await w.jobs.ensure({
				kind: "exec",
				callKey: "token-call",
				actor: { type: "api_token", id: "tok-1", onBehalfOfUserId: "u1" },
				sessionId: null,
				resourceType: "task",
				resourceId: "t2",
				action: EXEC_ACTION,
			});
			expect(await mayReachJob(ctx("tok-1", "api_token"), tokenJob)).toBe(true);
			expect(await mayReachJob(ctx("tok-2", "api_token"), tokenJob)).toBe(false);
			// Another session of the same user never reaches a token's job either.
			expect(await mayReachJob(ctx("a"), tokenJob)).toBe(false);
		} finally {
			await w.db.destroy();
		}
	});
});
