import { sql } from "kysely";
import { describe, expect, it, vi } from "vitest";
import type { Cluster, TaskView } from "../src/cluster/cluster.ts";
import { taskOutcome } from "../src/cluster/outcome.ts";
import type { TaskGroups, TaskGroupView } from "../src/cluster/task-groups.ts";
import { TERMINAL } from "../src/cluster/types.ts";
import { CallRunner } from "../src/extensions/call-runner.ts";
import { createJobs, type Jobs } from "../src/jobs/jobs.ts";
import type { SubagentJobRuntime } from "../src/jobs/types.ts";
import type { Db } from "../src/storage/db.ts";
import { defaultOrgId } from "../src/storage/org.ts";
import { callTool } from "../src/tools/adapter.ts";
import { TOOLS, type ToolContext } from "../src/tools/catalog.ts";
import { execJobRenderers } from "../src/tools/job-renderers.ts";
import { execTaskResult } from "../src/tools/task-render.ts";
import type { ToolResult } from "../src/util/tool-result.ts";
import { openTestDb } from "./helpers/db.ts";

type AnyTool = {
	name: string;
	output: "text" | "json";
	handler: (args: never, ctx: ToolContext) => Promise<ToolResult>;
};

const tool = (name: string): AnyTool => {
	const found = TOOLS.find((candidate) => candidate.name === name);
	if (!found) throw new Error(`${name} tool missing`);
	return found as unknown as AnyTool;
};

function texts(result: ToolResult): string[] {
	return result.content.map((block) => block.text);
}

function jsonOf(result: ToolResult): Record<string, unknown> {
	return JSON.parse(result.content[0]?.text ?? "") as Record<string, unknown>;
}

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

interface Harness {
	db: Db;
	jobs: Jobs;
	ctx: ToolContext;
	actor: { type: "session" | "subagent" | "api_token"; id: string; onBehalfOfUserId: string };
	setTask(task: TaskView): void;
	setGroup(group: TaskGroupView): void;
	cancelled: string[];
	removeTask(id: string): void;
}

async function harness(): Promise<Harness> {
	const db = await openTestDb("sqlite");
	await db
		.insertInto("users")
		.values({
			id: "u1",
			org_id: await defaultOrgId(db),
			username: "u1",
			display_name: "u1",
			email: null,
			kind: "member",
			password_hash: null,
			status: "active",
			created_at: new Date().toISOString(),
		})
		.execute();
	await addSession(db, { id: "root", owner: "u1" });
	await addSession(db, { id: "s1", owner: "u1", parent: "root" });
	await addSession(db, { id: "s2", owner: "u1", parent: "root" });
	const tasks = new Map<string, TaskView>();
	const groups = new Map<string, TaskGroupView>();
	const cancelled: string[] = [];
	const taskWaiters = new Map<string, Set<() => void>>();
	const groupWaiters = new Map<string, Set<() => void>>();
	const wake = (waiters: Map<string, Set<() => void>>, id: string) => {
		const waiting = waiters.get(id);
		if (!waiting) return;
		waiters.delete(id);
		for (const wakeUp of [...waiting]) wakeUp();
	};
	/** A cluster wait with the real one's contract: the current view at once for a zero budget, else on change or timeout. */
	const waitFor = <T>(map: Map<string, T>, waiters: Map<string, Set<() => void>>, id: string, ms: number) =>
		new Promise<T | undefined>((resolve) => {
			if (ms <= 0) {
				resolve(map.get(id));
				return;
			}
			const waiting = waiters.get(id) ?? new Set<() => void>();
			waiters.set(id, waiting);
			const finish = () => {
				clearTimeout(timer);
				waiting.delete(finish);
				if (waiting.size === 0 && waiters.get(id) === waiting) waiters.delete(id);
				resolve(map.get(id));
			};
			const timer = setTimeout(finish, ms);
			timer.unref?.();
			waiting.add(finish);
		});
	const cluster = {
		getTask: async (id: string) => tasks.get(id),
		waitTask: async (id: string, ms: number) => waitFor(tasks, taskWaiters, id, ms),
		cancelTask: async (id: string) => {
			const current = tasks.get(id);
			if (!current || TERMINAL.has(current.state)) return false;
			cancelled.push(id);
			tasks.set(id, task({ ...current, state: "cancelled", exitCode: null }));
			wake(taskWaiters, id);
			return true;
		},
		get waitsEnded() {
			return false;
		},
		onTaskChanged: undefined as ((taskId: string) => void) | undefined,
	} as unknown as Cluster;
	const taskGroups = {
		get: async (id: string) => groups.get(id),
		wait: async (id: string, ms: number) => waitFor(groups, groupWaiters, id, ms),
		cancel: async () => false,
		get waitsEnded() {
			return false;
		},
		onGroupSettled: undefined as ((groupId: string) => void) | undefined,
	} as unknown as TaskGroups;
	const jobs = createJobs({ callRunner: new CallRunner(), db, cluster, taskGroups, execRenderers: execJobRenderers });
	const actor: Harness["actor"] = { type: "session", id: "s1", onBehalfOfUserId: "u1" };
	const ctx = {
		db,
		jobs,
		cluster,
		taskGroups,
		user: { sessionId: "s", userId: "u1", username: "u1", kind: "member" },
		actor,
		chain: [],
		approvalUrl: (kind: string, id: string) => `http://crh.test/approvals/${kind}/${id}`,
		taskUrl: (id: string) => `http://crh.test/tasks/${id}`,
		taskGroupUrl: (id: string) => `http://crh.test/task-groups/${id}`,
		externalCallUrl: (id: string) => `http://crh.test/approvals/external-calls/${id}`,
		defaultWaitS: 30,
	} as unknown as ToolContext;
	return {
		db,
		jobs,
		ctx,
		actor,
		cancelled,
		setTask: (value) => {
			tasks.set(value.id, value);
			wake(taskWaiters, value.id);
		},
		setGroup: (value) => {
			groups.set(value.id, value);
			wake(groupWaiters, value.id);
		},
		removeTask: (id) => {
			tasks.delete(id);
			wake(taskWaiters, id);
		},
	};
}

async function addSession(db: Db, input: { id: string; owner: string; parent?: string | null }): Promise<void> {
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
			state: "idle",
			waiting_kind: null,
			waiting_level_id: null,
			waiting_handler_id: null,
			state_changed_at: now,
			quota_tokens: null,
		})
		.execute();
}

async function addExternalCall(db: Db, id: string, state: "awaiting_approval" | "succeeded"): Promise<void> {
	const now = new Date().toISOString();
	await db
		.insertInto("external_calls")
		.values({
			id,
			org_id: await defaultOrgId(db),
			actor_type: "session",
			actor_id: "s1",
			on_behalf_of_user_id: "u1",
			extension_name: "github",
			tool_name: "create_issue",
			arguments: state === "awaiting_approval" ? "{}" : null,
			operation: JSON.stringify({ method: "ext.write", target: "github/create_issue" }),
			annotations: null,
			rule_chain: null,
			approval: JSON.stringify({ evaluation: { result: "require-approval", levels: [] } }),
			pending_input: null,
			root_session_id: null,
			handler_type: state === "awaiting_approval" ? "user" : null,
			handler_session_id: null,
			state,
			created_at: now,
			finished_at: null,
			source_tool_task: null,
			tool_rev: null,
		})
		.execute();
}

async function execJob(h: Harness, taskView: TaskView, callKey = "call-1") {
	h.setTask(taskView);
	return h.jobs.ensure({
		kind: "exec",
		callKey,
		actor: h.actor,
		sessionId: "s1",
		resourceType: "task",
		resourceId: taskView.id,
		action: taskView.action,
	});
}

describe("job tools: job_wait", () => {
	it("returns the same text exec returned for a settled task", async () => {
		const h = await harness();
		try {
			const view = task({
				id: "t1",
				state: "exited",
				exitCode: 0,
				outputTail: "hello\n",
				outputTailLines: 1,
				outputLines: 1,
			});
			const job = await execJob(h, view);
			const result = await tool("job_wait").handler({ job_id: job.id, wait: 0 } as never, h.ctx);
			const direct = execTaskResult(h.ctx, view, "n1");
			expect(texts(result)).toEqual(texts(direct));
			expect(result.isError).toBe(false);
			expect(result.details).toMatchObject({ job_id: job.id, task_id: "t1", node: "n1" });
			expect(texts(result)).not.toContainEqual(expect.stringContaining("task_id"));
		} finally {
			await h.db.destroy();
		}
	});

	it("returns the still-running note with the job id", async () => {
		const h = await harness();
		try {
			const job = await execJob(h, task({ id: "t1", state: "running", exitCode: null }));
			const result = await tool("job_wait").handler({ job_id: job.id, wait: 0 } as never, h.ctx);
			expect(texts(result)).toEqual([`[n1, still running, job ${job.id}: call job_wait with this id]`]);
			expect(result.details).toMatchObject({ job_id: job.id, task_id: "t1" });
		} finally {
			await h.db.destroy();
		}
	});

	it("returns a subagent's pending requests at once with attention", async () => {
		const h = await harness();
		try {
			await addSession(h.db, { id: "child", owner: "u1", parent: "s1" });
			let waits = 0;
			h.jobs.attachSubagent({
				project: async () => ({ state: "awaiting", wait: "decision", outcome: null }) as never,
				wait: async () => {
					waits += 1;
					return { status: "attention" as const };
				},
				cancel: async () => true,
				answer: async () => undefined,
				requestsBlock: async () => "<subagent-requests>request-1</subagent-requests>",
				noticeBusy: () => false,
				noticeWakeAvailable: async () => true,
			});
			const job = await h.jobs.ensure({
				kind: "subagent",
				callKey: "call-sub",
				actor: h.actor,
				sessionId: "s1",
				resourceType: "session",
				resourceId: "child",
				action: { type: "subagent", task: "say hi" },
			});
			const result = await tool("job_wait").handler({ job_id: job.id } as never, h.ctx);
			expect(waits).toBe(1);
			const text = texts(result).join("\n");
			expect(text).toContain("Still waiting for your decision.");
			expect(text).toContain("<subagent-requests>request-1</subagent-requests>");
			expect(text).toContain(`job_wait("${job.id}")`);
		} finally {
			await h.db.destroy();
		}
	});

	it("renders a note when the record behind the job is no longer kept", async () => {
		const h = await harness();
		try {
			const job = await execJob(h, task({ id: "t1", state: "exited", exitCode: 0 }));
			h.removeTask("t1");
			const result = await tool("job_wait").handler({ job_id: job.id, wait: 0 } as never, h.ctx);
			expect(result.isError).toBe(false);
			expect(texts(result)).toEqual(["[the job's details are no longer kept]"]);

			await addExternalCall(h.db, "call-1", "succeeded");
			const callJob = await h.jobs.ensure({
				kind: "call",
				callKey: "call-key-1",
				actor: h.actor,
				sessionId: "s1",
				resourceType: "external_call",
				resourceId: "call-1",
				action: { type: "extension_tool", extension: "github", tool: "create_issue" },
			});
			await h.db.deleteFrom("external_calls").where("id", "=", "call-1").execute();
			const callResult = await tool("job_wait").handler({ job_id: callJob.id, wait: 0 } as never, h.ctx);
			expect(texts(callResult)).toEqual(["[the job's details are no longer kept]"]);
		} finally {
			await h.db.destroy();
		}
	});

	it("answers no_such_job for an unknown job", async () => {
		const h = await harness();
		try {
			const result = await callTool(tool("job_wait") as never, { job_id: "exec-nope", wait: 0 }, h.ctx, { via: "mcp" });
			expect(result.isError).toBe(true);
			expect(texts(result)).toEqual(["[error no_such_job: the job is no longer kept]"]);
		} finally {
			await h.db.destroy();
		}
	});
});

describe("job tools: waiting for approval", () => {
	it("waits at most `wait` through an exec approval in an agent session and pushes its link", async () => {
		vi.useFakeTimers();
		const h = await harness();
		try {
			const statuses: Record<string, unknown>[] = [];
			const ctx = {
				...h.ctx,
				defaultWaitS: 600,
				onStatus: async (status: Record<string, unknown>) => {
					statuses.push(status);
				},
			} as unknown as ToolContext;
			const job = await execJob(h, task({ id: "t1", state: "awaiting_approval", handlerType: "user" }));
			let settled = false;
			const waiting = tool("job_wait")
				.handler({ job_id: job.id, wait: 3 } as never, ctx)
				.then((result) => {
					settled = true;
					return result;
				});
			// Approval is the user's, not this agent's: `attention` (default true) does not end the wait early.
			await vi.advanceTimersByTimeAsync(1_000);
			expect(settled).toBe(false);
			expect(statuses).toContainEqual({
				task_id: "t1",
				state: "awaiting_approval",
				approval_url: "http://crh.test/approvals/task/t1",
			});
			// The decision lands inside the wait: the UI hears the new state and the wait goes on to its end.
			h.setTask(task({ id: "t1", state: "running", exitCode: null }));
			await vi.advanceTimersByTimeAsync(1_000);
			expect(statuses.at(-1)).toEqual({ task_id: "t1", state: "running" });
			expect(settled).toBe(false);
			await vi.advanceTimersByTimeAsync(1_000);
			const result = await waiting;
			expect(texts(result)).toEqual([`[n1, still running, job ${job.id}: call job_wait with this id]`]);
		} finally {
			vi.useRealTimers();
			await h.db.destroy();
		}
	});

	it("returns at once with `wait: 0` while the user has not decided, as a call does", async () => {
		const h = await harness();
		try {
			const ctx = { ...h.ctx, defaultWaitS: 600 } as unknown as ToolContext;
			const job = await execJob(h, task({ id: "t1", state: "awaiting_approval", handlerType: "user" }));
			const result = await tool("job_wait").handler({ job_id: job.id, wait: 0 } as never, ctx);
			expect(texts(result)).toEqual([
				`[n1, waiting for approval: http://crh.test/approvals/task/t1, job ${job.id}: call job_wait with this id]`,
			]);
		} finally {
			await h.db.destroy();
		}
	});

	it("returns after wait over MCP, with the waiting note", async () => {
		vi.useFakeTimers();
		const h = await harness();
		try {
			const job = await execJob(h, task({ id: "t1", state: "awaiting_approval", handlerType: "user" }));
			let settled = false;
			const waiting = tool("job_wait")
				.handler({ job_id: job.id, wait: 2 } as never, h.ctx)
				.then((result) => {
					settled = true;
					return result;
				});
			await vi.advanceTimersByTimeAsync(1_999);
			expect(settled).toBe(false);
			await vi.advanceTimersByTimeAsync(1);
			const result = await waiting;
			expect(texts(result)).toEqual([
				`[n1, waiting for approval: http://crh.test/approvals/task/t1, job ${job.id}: call job_wait with this id]`,
			]);
		} finally {
			vi.useRealTimers();
			await h.db.destroy();
		}
	});

	it("still returns a subagent job at once when attention ends a wait on a decision", async () => {
		const h = await harness();
		try {
			await addSession(h.db, { id: "child", owner: "u1", parent: "s1" });
			let waits = 0;
			h.jobs.attachSubagent({
				project: async () => ({ state: "awaiting", wait: "decision", outcome: null }) as never,
				wait: async () => {
					waits += 1;
					return { status: "attention" as const };
				},
				cancel: async () => true,
				answer: async () => undefined,
				requestsBlock: async () => undefined,
				noticeBusy: () => false,
				noticeWakeAvailable: async () => true,
			});
			const job = await h.jobs.ensure({
				kind: "subagent",
				callKey: "call-sub",
				actor: h.actor,
				sessionId: "s1",
				resourceType: "session",
				resourceId: "child",
				action: { type: "subagent", task: "say hi" },
			});
			await tool("job_wait").handler({ job_id: job.id } as never, h.ctx);
			expect(waits).toBe(1);
		} finally {
			await h.db.destroy();
		}
	});
});

describe("job tools: ownership", () => {
	it("lets the owning session and its ancestors in, and refuses a sibling or another token", async () => {
		const h = await harness();
		try {
			const job = await execJob(h, task({ id: "t1" }), "owned");
			const as = (type: "session" | "api_token", id: string) =>
				({
					...h.ctx,
					user: { ...h.ctx.user, userId: "u1" },
					actor: { type, id, onBehalfOfUserId: "u1" },
				}) as ToolContext;
			expect((await tool("job_wait").handler({ job_id: job.id, wait: 0 } as never, h.ctx)).isError).toBe(false);
			expect(
				(await tool("job_wait").handler({ job_id: job.id, wait: 0 } as never, as("session", "root"))).isError,
			).toBe(false);
			const sibling = await callTool(tool("job_wait") as never, { job_id: job.id, wait: 0 }, as("session", "s2"), {
				via: "mcp",
			});
			expect(sibling.isError).toBe(true);
			expect(texts(sibling)).toEqual(["[error no_such_job: the job is no longer kept]"]);
			const token = await callTool(
				tool("job_wait") as never,
				{ job_id: job.id, wait: 0 },
				as("api_token", "another-token"),
				{ via: "mcp" },
			);
			expect(token.isError).toBe(true);
			expect(texts(token)).toEqual(["[error no_such_job: the job is no longer kept]"]);
		} finally {
			await h.db.destroy();
		}
	});
});

describe("job tools: job_cancel", () => {
	it("cancels an exec task through the cluster", async () => {
		const h = await harness();
		try {
			const job = await execJob(h, task({ id: "t1", state: "running", exitCode: null }));
			const result = await tool("job_cancel").handler({ job_id: job.id } as never, h.ctx);
			expect(h.cancelled).toEqual(["t1"]);
			expect(jsonOf(result)).toMatchObject({
				job_id: job.id,
				kind: "exec",
				state: "settled",
				cancel_sent: true,
				outcome: { kind: "cancelled", failed: false },
			});
		} finally {
			await h.db.destroy();
		}
	});

	it("cancels a call that still waits for approval", async () => {
		const h = await harness();
		try {
			await addExternalCall(h.db, "c1", "awaiting_approval");
			const job = await h.jobs.ensure({
				kind: "call",
				callKey: "call-1",
				actor: h.actor,
				sessionId: "s1",
				resourceType: "external_call",
				resourceId: "c1",
				action: { type: "extension_tool", extension: "github", tool: "create_issue" },
			});
			const result = await tool("job_cancel").handler({ job_id: job.id, reason: "not now" } as never, h.ctx);
			expect(jsonOf(result)).toMatchObject({
				job_id: job.id,
				kind: "call",
				state: "settled",
				cancel_sent: true,
				outcome: { kind: "cancelled", failed: false },
			});
			const row = await h.db
				.selectFrom("external_calls")
				.select("state")
				.where("id", "=", "c1")
				.executeTakeFirstOrThrow();
			expect(row.state).toBe("cancelled");
		} finally {
			await h.db.destroy();
		}
	});

	it("stops a subagent and its subtree", async () => {
		const h = await harness();
		try {
			await addSession(h.db, { id: "child", owner: "u1", parent: "s1" });
			let run: { state: "idle" | "running" | "awaiting"; wait: "approval" | null; outcome: unknown } = {
				state: "running",
				wait: null,
				outcome: null,
			};
			let stopped = "";
			const runtime: SubagentJobRuntime = {
				project: async () => run as never,
				wait: async () => ({ status: "done" as const }),
				cancel: async (childId) => {
					stopped = childId;
					run = { state: "idle", wait: null, outcome: { kind: "cancelled", failed: false } };
					return true;
				},
				answer: async () => undefined,
				requestsBlock: async () => undefined,
				noticeBusy: () => false,
				noticeWakeAvailable: async () => true,
			};
			h.jobs.attachSubagent(runtime);
			const job = await h.jobs.ensure({
				kind: "subagent",
				callKey: "call-sub",
				actor: h.actor,
				sessionId: "s1",
				resourceType: "session",
				resourceId: "child",
				action: { type: "subagent", task: "do work" },
			});
			const result = await tool("job_cancel").handler({ job_id: job.id } as never, h.ctx);
			expect(stopped).toBe("child");
			expect(jsonOf(result)).toMatchObject({
				job_id: job.id,
				kind: "subagent",
				state: "settled",
				cancel_sent: true,
				outcome: { kind: "cancelled", failed: false },
			});
		} finally {
			await h.db.destroy();
		}
	});

	it("returns a settled job's state without cancelling again", async () => {
		const h = await harness();
		try {
			const job = await execJob(h, task({ id: "t1" }));
			const result = await tool("job_cancel").handler({ job_id: job.id } as never, h.ctx);
			expect(h.cancelled).toEqual([]);
			expect(jsonOf(result)).toMatchObject({
				job_id: job.id,
				state: "settled",
				cancel_sent: false,
				outcome: { kind: "succeeded", failed: false },
			});
		} finally {
			await h.db.destroy();
		}
	});
});

describe("job tools: job_list", () => {
	it("lists this session's jobs newest first and filters by state", async () => {
		const h = await harness();
		try {
			const settled = await execJob(h, task({ id: "t1" }), "a");
			const running = await execJob(h, task({ id: "t2", state: "running", exitCode: null }), "b");
			await sql`update jobs set created_at = '2026-01-01T00:00:00.000Z' where id = ${settled.id}`.execute(h.db);
			await sql`update jobs set created_at = '2026-01-02T00:00:00.000Z' where id = ${running.id}`.execute(h.db);
			// A sibling session's job is not this session's.
			h.setTask(task({ id: "t3", actorId: "s2" }));
			await h.jobs.ensure({
				kind: "exec",
				callKey: "sibling",
				actor: { type: "session", id: "s2", onBehalfOfUserId: "u1" },
				sessionId: "s2",
				resourceType: "task",
				resourceId: "t3",
				action: { type: "exec", command: "true" },
			});

			const all = jsonOf(await tool("job_list").handler({} as never, h.ctx));
			expect((all.jobs as { job_id: string }[]).map((job) => job.job_id)).toEqual([running.id, settled.id]);
			expect((all.jobs as { action: string }[])[0]?.action).toBe("true");
			const waiting = jsonOf(await tool("job_list").handler({ state: "waiting" } as never, h.ctx));
			expect(waiting.jobs).toEqual([]);
			const onlyRunning = jsonOf(await tool("job_list").handler({ state: "running" } as never, h.ctx));
			expect((onlyRunning.jobs as { job_id: string }[]).map((job) => job.job_id)).toEqual([running.id]);
		} finally {
			await h.db.destroy();
		}
	});
});
