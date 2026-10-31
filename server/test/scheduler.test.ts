import type { TaskSpec } from "@crh/protocol";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { ModelConfig } from "../src/agent/models.ts";
import { sessionStateOf } from "../src/agent/quota.ts";
import { setReviewModel } from "../src/agent/review.ts";
import { AgentRuntime } from "../src/agent/runtime.ts";
import { Audit } from "../src/audit/audit.ts";
import type { SessionUser } from "../src/auth/sessions.ts";
import { Cluster } from "../src/cluster/cluster.ts";
import { TaskGroups } from "../src/cluster/task-groups.ts";
import { MasterKey } from "../src/keys/master-key.ts";
import { Scheduler } from "../src/scheduler/scheduler.ts";
import {
	createSchedule,
	getRun,
	getSchedule,
	listRuns,
	nextRunAfter,
	previewRuns,
	type Schedule,
} from "../src/scheduler/store.ts";
import type { Db } from "../src/storage/db.ts";
import { createUser, defaultOrgId } from "../src/users/service.ts";
import { derivedId, newId } from "../src/util/id.ts";
import { type App, call, login, makeApp } from "./helpers/api.ts";
import { openTestDb } from "./helpers/db.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/**
 * Schedules (doc/scheduling.md): a cron fires a pending run in one transaction, a submitter preempts the previous
 * instance and creates + submits a session, and the run follows its submission to an end. The clock and timer are
 * injected, so firing is driven by the test instead of by wall time.
 */
let db: Db;
let cluster: Cluster;
let audit: Audit;
let runtime: AgentRuntime;
let models: ModelConfig;
let masterKey: MasterKey;
let app: App;
let scheduler: Scheduler;
const faux = fauxProvider();
const model = () => ({ provider: faux.provider.id, modelId: faux.getModel().id });

/** A clock and timer the test controls. */
class FakeClock {
	#timers = new Map<number, { at: number; fn: () => void }>();
	#next = 0;
	current: Date;
	constructor(start: string) {
		this.current = new Date(start);
	}
	now = () => new Date(this.current);
	setTimer = (fn: () => void, ms: number): (() => void) => {
		const id = ++this.#next;
		this.#timers.set(id, { at: this.current.getTime() + ms, fn });
		return () => this.#timers.delete(id);
	};
	get timerCount(): number {
		return this.#timers.size;
	}
	reset(start: string): void {
		this.#timers.clear();
		this.current = new Date(start);
	}
	/** Moves time forward and fires the timers that fall inside, giving their async work a moment. */
	async advance(ms: number): Promise<void> {
		const target = this.current.getTime() + ms;
		for (;;) {
			const due = [...this.#timers.entries()]
				.filter(([, timer]) => timer.at <= target)
				.sort((a, b) => a[1].at - b[1].at)[0];
			if (!due) break;
			this.#timers.delete(due[0]);
			this.current = new Date(due[1].at);
			due[1].fn();
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		this.current = new Date(target);
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

const clock = new FakeClock("2026-01-05T09:01:00.000Z");

async function waitFor<T>(what: string, probe: () => Promise<T | undefined>, timeoutMs = 10_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await probe();
		if (value !== undefined) return value;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

async function newOwner(username: string, kind: "member" | "admin" = "member"): Promise<SessionUser> {
	const user = await createUser(db, { username, kind, password: "password-123" });
	return { sessionId: "test", userId: user.id, username: user.username, kind };
}

const makeSchedule = (
	owner: SessionUser,
	overrides: Partial<Parameters<typeof createSchedule>[2]> = {},
): Promise<Schedule> =>
	createSchedule(db, owner.userId, {
		name: "nightly check",
		prompt: "Check the nodes",
		model: model(),
		preset: "yolo",
		tokenBudget: null,
		cron: "*/5 * * * *",
		timezone: "UTC",
		catchUp: false,
		enabled: true,
		...overrides,
	});

/** Makes the schedule due at `at`, as a restart after downtime would leave it. */
async function setNextRun(scheduleId: string, at: Date): Promise<void> {
	await db.updateTable("schedules").set({ next_run_at: at.toISOString() }).where("id", "=", scheduleId).execute();
}

const runOf = (id: string) => getRun(db, id);
const runsOf = async (scheduleId: string) => await listRuns(db, scheduleId, 100);
const sessionRow = (id: string) => db.selectFrom("sessions").selectAll().where("id", "=", id).executeTakeFirstOrThrow();

const cookies = new Map<string, string>();
async function cookieOf(user: SessionUser): Promise<string> {
	const existing = cookies.get(user.userId);
	if (existing) return existing;
	const cookie = await login(app, user.username, "password-123");
	cookies.set(user.userId, cookie);
	return cookie;
}

async function addNode(owner: SessionUser): Promise<string> {
	const id = newId();
	const now = new Date().toISOString();
	await db
		.insertInto("nodes")
		.values({
			id,
			org_id: await defaultOrgId(db),
			owner_user_id: owner.userId,
			name: `node-${id.slice(-8)}`,
			transport: "client",
			status: "active",
			public_key: null,
			hostname: null,
			facts: null,
			client_version: null,
			privileged_mode: null,
			last_seen_at: null,
			created_at: now,
			approved_at: now,
			approved_by_user_id: null,
			ssh_host: null,
			ssh_port: null,
			ssh_user: null,
			ssh_host_key: null,
			ssh_credential_id: null,
			ssh_jumps: null,
		})
		.execute();
	return id;
}

const execSpec: TaskSpec = { kind: "exec", command: { argv: ["echo", "hi"] }, env: {}, cwd: "", stdin: null };

/** Starts the scheduler at a fixed fake time. */
async function startAt(time: string): Promise<void> {
	clock.reset(time);
	await scheduler.start();
}

beforeAll(async () => {
	db = await openTestDb("sqlite");
	audit = new Audit(db);
	cluster = new Cluster(db, { audit });
	masterKey = MasterKey.generate();
	models = new ModelConfig(db, masterKey);
	models.addProvider(faux.provider);
	await models.reload();
	runtime = await AgentRuntime.open({
		db,
		storage: new MemoryStorage(),
		models,
		cluster,
		groups: new TaskGroups(db, cluster, { audit }),
		audit,
	});
	scheduler = new Scheduler({ db, runtime, audit, now: clock.now, setTimer: clock.setTimer });
	app = makeApp(db, undefined, { cluster, audit, masterKey, agent: { runtime, models }, scheduler });
});

afterEach(async () => {
	await scheduler.stop();
	await runtime.waitForIdle();
});

afterAll(async () => {
	await runtime.close();
	await cluster.close();
	await db.destroy();
});

it("fires a due schedule once, creates the run's session and advances next_run_at", async () => {
	const owner = await newOwner("owner-fire");
	const schedule = await makeSchedule(owner);
	const due = new Date("2026-01-05T09:00:00.000Z");
	await setNextRun(schedule.id, due);
	faux.setResponses([fauxAssistantMessage([fauxText("checked")])]);

	await startAt("2026-01-05T09:01:00.000Z");
	const run = await waitFor("the run", async () => {
		const runs = await runsOf(schedule.id);
		return runs[0]?.status === "succeeded" ? runs[0] : undefined;
	});
	expect(run.fireTime).toBe(due.toISOString());
	expect(run.manual).toBe(false);
	expect(run.sessionId).toBe(derivedId(`schedule-run:${run.id}`));
	// The next trigger follows the fired one, and the run's session is the schedule's only one.
	expect((await getSchedule(db, schedule.id))?.nextRunAt).toBe("2026-01-05T09:05:00.000Z");
	const sessions = await db.selectFrom("sessions").selectAll().where("schedule_id", "=", schedule.id).execute();
	expect(sessions.map((s) => s.id)).toEqual([run.sessionId]);
	expect(JSON.parse(sessions[0]?.model ?? "{}")).toEqual(model());
	// The run's session has an inherit-only rule set below the schedule's root.
	const rules = await db
		.selectFrom("rule_sets")
		.selectAll()
		.where("scope_type", "=", "session")
		.where("scope_id", "=", run.sessionId as string)
		.executeTakeFirstOrThrow();
	expect(rules).toMatchObject({ preset: null, default_action: "inherit" });
	const fired = await db
		.selectFrom("audit_events")
		.selectAll()
		.where("action", "=", "schedule.fired")
		.where("target_id", "=", schedule.id)
		.execute();
	expect(fired).toHaveLength(1);
	expect(JSON.parse(fired[0]?.detail ?? "{}")).toMatchObject({ run_id: run.id, manual: false });
	const finished = await db
		.selectFrom("audit_events")
		.selectAll()
		.where("action", "=", "schedule.run_finished")
		.where("target_id", "=", schedule.id)
		.execute();
	expect(JSON.parse(finished[0]?.detail ?? "{}")).toMatchObject({ run_id: run.id, status: "succeeded" });
});

it("wakes at the next trigger and fires without a manual tick", async () => {
	const owner = await newOwner("owner-wake");
	const schedule = await makeSchedule(owner);
	const due = new Date("2026-01-05T09:02:00.000Z");
	await setNextRun(schedule.id, due);
	faux.setResponses([fauxAssistantMessage([fauxText("woken")])]);
	await startAt("2026-01-05T09:01:30.000Z");
	// The loop armed a timer for the 30 s until the next trigger.
	expect(clock.timerCount).toBe(1);
	await clock.advance(30_000);
	const run = await waitFor("the fired run", async () => {
		const runs = await runsOf(schedule.id);
		return runs[0]?.status === "succeeded" ? runs[0] : undefined;
	});
	expect(run.fireTime).toBe(due.toISOString());
});

it("rejects a duplicate fire: the unique (schedule_id, fire_time) index keeps one run", async () => {
	const owner = await newOwner("owner-duplicate");
	const schedule = await makeSchedule(owner);
	const due = new Date("2026-01-05T09:00:00.000Z");
	await setNextRun(schedule.id, due);
	// A run for this fire time already exists; firing again must not add a second one.
	await db
		.insertInto("schedule_runs")
		.values({
			id: newId(),
			schedule_id: schedule.id,
			fire_time: due.toISOString(),
			manual: 0,
			status: "succeeded",
			session_id: null,
			reason: null,
			created_at: due.toISOString(),
			started_at: null,
			finished_at: due.toISOString(),
		})
		.execute();
	await startAt("2026-01-05T09:01:00.000Z");
	await waitFor("the next time to advance", async () =>
		(await getSchedule(db, schedule.id))?.nextRunAt === "2026-01-05T09:05:00.000Z" ? true : undefined,
	);
	expect(await runsOf(schedule.id)).toHaveLength(1);
	// The constraint itself refuses the duplicate row, which is what makes a retried fire harmless.
	await expect(
		db
			.insertInto("schedule_runs")
			.values({
				id: newId(),
				schedule_id: schedule.id,
				fire_time: due.toISOString(),
				manual: 1,
				status: "pending",
				session_id: null,
				reason: null,
				created_at: due.toISOString(),
				started_at: null,
				finished_at: null,
			})
			.execute(),
	).rejects.toThrow(/unique|duplicate/i);
});

it("skips missed triggers without catch-up and runs only the most recent one with it", async () => {
	const owner = await newOwner("owner-missed");
	const skipping = await makeSchedule(owner, { name: "skipping", catchUp: false });
	const catching = await makeSchedule(owner, { name: "catching", catchUp: true });
	// Both missed several triggers: from 11:05 and 11:00 respectively.
	await setNextRun(skipping.id, new Date("2026-01-05T11:05:00.000Z"));
	await setNextRun(catching.id, new Date("2026-01-05T11:00:00.000Z"));
	faux.setResponses([fauxAssistantMessage([fauxText("caught up")])]);
	await startAt("2026-01-05T12:00:00.000Z");

	await waitFor("the catch-up run", async () =>
		(await runsOf(catching.id))[0]?.status === "succeeded" ? true : undefined,
	);
	expect(await runsOf(skipping.id)).toHaveLength(0);
	const skipped = await db
		.selectFrom("audit_events")
		.selectAll()
		.where("action", "=", "schedule.skipped")
		.where("target_id", "=", skipping.id)
		.execute();
	expect(skipped).toHaveLength(1);
	expect(JSON.parse(skipped[0]?.detail ?? "{}")).toMatchObject({
		reason: "missed",
		fire_time: "2026-01-05T11:05:00.000Z",
	});
	// Both recomputed their next trigger from now.
	expect((await getSchedule(db, skipping.id))?.nextRunAt).toBe("2026-01-05T12:05:00.000Z");
	expect((await getSchedule(db, catching.id))?.nextRunAt).toBe("2026-01-05T12:05:00.000Z");
	// Catch-up fired only the most recent missed time.
	const runs = await runsOf(catching.id);
	expect(runs).toHaveLength(1);
	expect(runs[0]?.fireTime).toBe("2026-01-05T12:00:00.000Z");
});

it("turns a manual run into a session through the same path, with the user as actor", async () => {
	const owner = await newOwner("owner-manual");
	const schedule = await makeSchedule(owner);
	faux.setResponses([fauxAssistantMessage([fauxText("manual answer")])]);
	await startAt("2026-01-05T09:01:00.000Z");
	const res = await call(app, `/api/schedules/${schedule.id}/run`, {
		method: "POST",
		cookie: await cookieOf(owner),
		body: {},
	});
	expect(res.status).toBe(202);
	const body = (await res.json()) as { run: { id: string; manual: boolean; status: string; sessionId: string } };
	expect(body.run.manual).toBe(true);
	expect(body.run.status).toBe("running");
	expect(body.run.sessionId).toBe(derivedId(`schedule-run:${body.run.id}`));
	await waitFor("the manual run to succeed", async () =>
		(await runOf(body.run.id))?.status === "succeeded" ? true : undefined,
	);
	const fired = await db
		.selectFrom("audit_events")
		.selectAll()
		.where("action", "=", "schedule.fired")
		.where("target_id", "=", schedule.id)
		.execute();
	expect(fired).toHaveLength(1);
	expect(fired[0]).toMatchObject({ actor_type: "user", actor_id: owner.userId });
	// The history endpoint returns it newest first, with its session.
	const history = await call(app, `/api/schedules/${schedule.id}/runs`, { cookie: await cookieOf(owner) });
	const listed = (await history.json()) as { items: { id: string; status: string; sessionId: string }[] };
	expect(listed.items).toHaveLength(1);
	expect(listed.items[0]).toMatchObject({ id: body.run.id, status: "succeeded", sessionId: body.run.sessionId });
});

it("builds the [schedule, session] chain for approvals and Auto Review", async () => {
	const owner = await newOwner("owner-chain");
	const schedule = await makeSchedule(owner, { preset: "ask" });
	faux.setResponses([fauxAssistantMessage([fauxText("waiting")])]);
	await startAt("2026-01-05T09:01:00.000Z");
	const scheduleRun = await scheduler.runNow(schedule.id, owner);
	const sessionId = scheduleRun.sessionId as string;
	await waitFor("the run to settle", async () =>
		(await runOf(scheduleRun.id))?.status === "succeeded" ? true : undefined,
	);
	const nodeId = await addNode(owner);
	const task = await cluster.createTask({
		nodeId,
		spec: execSpec,
		chain: [
			{ type: "schedule", id: schedule.id },
			{ type: "session", id: sessionId },
		],
		actor: { type: "session", id: sessionId, onBehalfOfUserId: owner.userId },
	});
	expect(task.state).toBe("awaiting_approval");
	// The schedule is the chain root: the request goes to its owner, grouped under the run's session.
	const row = await db
		.selectFrom("tasks")
		.select(["root_session_id", "handler_type", "handler_session_id"])
		.where("id", "=", task.id)
		.executeTakeFirstOrThrow();
	expect(row).toMatchObject({ root_session_id: sessionId, handler_type: "user", handler_session_id: null });

	// Auto Review reads the preset and the model from the schedule root of the chain.
	await setReviewModel(db, model());
	const auto = await makeSchedule(owner, { name: "auto", preset: "auto_review" });
	faux.setResponses([fauxAssistantMessage([fauxText("scheduled")])]);
	const autoRun = await scheduler.runNow(auto.id, owner);
	await waitFor("the Auto Review run to settle", async () =>
		(await runOf(autoRun.id))?.status === "succeeded" ? true : undefined,
	);
	faux.setResponses([fauxAssistantMessage([fauxText('{"decision":"approve","reason":"only lists nodes"}')])]);
	const reviewed = await cluster.createTask({
		nodeId,
		spec: execSpec,
		chain: [
			{ type: "schedule", id: auto.id },
			{ type: "session", id: autoRun.sessionId as string },
		],
		actor: { type: "session", id: autoRun.sessionId as string, onBehalfOfUserId: owner.userId },
	});
	await waitFor("Auto Review's decision", async () => {
		const current = await cluster.getTask(reviewed.id);
		const approval = current?.approval as { decision?: { by: { type: string } } } | null;
		return approval?.decision ? true : undefined;
	});
	const decided = await cluster.getTask(reviewed.id);
	const approval = decided?.approval as { decision?: { by: { type: string; id: string } } } | null;
	expect(approval?.decision?.by).toEqual({ type: "system", id: "auto-review" });
	await setReviewModel(db, null);
});

it("builds the [schedule, session] chain for a scheduled session's own tool calls", async () => {
	const owner = await newOwner("owner-agent-chain");
	const nodeId = await addNode(owner);
	const schedule = await makeSchedule(owner, { preset: "ask" });
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("exec", { node: nodeId, cmd: "echo hi" }, { id: "chain-tool" })], {
			stopReason: "toolUse",
		}),
	]);
	await startAt("2026-01-05T09:01:00.000Z");
	const run = await scheduler.runNow(schedule.id, owner);
	const task = await waitFor("the agent's task", async () => {
		const row = await db
			.selectFrom("tasks")
			.selectAll()
			.where("actor_id", "=", run.sessionId as string)
			.executeTakeFirst();
		return row && row.state === "awaiting_approval" ? row : undefined;
	});
	// The runtime's chain construction put the schedule before the run's session.
	expect(JSON.parse(task.rule_chain ?? "[]")).toEqual([
		{ type: "schedule", id: schedule.id },
		{ type: "session", id: run.sessionId },
	]);
	expect(task).toMatchObject({
		actor_type: "session",
		root_session_id: run.sessionId,
		handler_type: "user",
		on_behalf_of_user_id: owner.userId,
	});
	await cluster.decide(task.id, {
		decision: "rejected",
		by: { type: "user", id: owner.userId },
		at: new Date().toISOString(),
	});
	await waitFor("the run to end", async () => ((await runOf(run.id))?.status !== "running" ? true : undefined));
});

it("preempts the previous instance: stops its session, marks the run preempted and audits it", async () => {
	const owner = await newOwner("owner-preempt");
	const schedule = await makeSchedule(owner);
	let started!: () => void;
	const inFlight = new Promise<void>((resolve) => {
		started = resolve;
	});
	faux.setResponses([
		async () => {
			started();
			await new Promise((resolve) => setTimeout(resolve, 1_000));
			return fauxAssistantMessage([fauxText("too late")]);
		},
		fauxAssistantMessage([fauxText("second run")]),
	]);
	await startAt("2026-01-05T09:01:00.000Z");
	const first = await scheduler.runNow(schedule.id, owner);
	await inFlight;
	await waitFor("the first run to be running", async () =>
		(await runOf(first.id))?.status === "running" ? true : undefined,
	);
	const firstSession = first.sessionId as string;
	const submission = (await sessionRow(firstSession)).last_submission_id as string;

	// A second click happens at a different instant (fire times are unique per schedule).
	await clock.advance(1_000);
	const second = await scheduler.runNow(schedule.id, owner);
	const preempted = await waitFor("the first run to be preempted", async () =>
		(await runOf(first.id))?.status === "preempted" ? await runOf(first.id) : undefined,
	);
	expect(preempted?.reason).toBeTruthy();
	expect(preempted?.sessionId).toBe(firstSession);
	// The preempted instance's submission ended instead of running on.
	expect(await runtime.waitForSubmission(submission)).toEqual({ status: "unanswered", reason: "aborted" });
	const auditRows = await db
		.selectFrom("audit_events")
		.selectAll()
		.where("action", "=", "schedule.run_preempted")
		.where("target_id", "=", schedule.id)
		.execute();
	expect(auditRows).toHaveLength(1);
	expect(JSON.parse(auditRows[0]?.detail ?? "{}")).toMatchObject({ run_id: first.id, session_id: firstSession });
	await waitFor("the second run to succeed", async () =>
		(await runOf(second.id))?.status === "succeeded" ? true : undefined,
	);
	expect((await runsOf(schedule.id)).map((run) => run.status)).toEqual(["succeeded", "preempted"]);
});

it("marks a run failed when its submission does not end normally", async () => {
	const owner = await newOwner("owner-model-error");
	const schedule = await makeSchedule(owner);
	faux.setResponses([
		async () => {
			throw new Error("the model exploded");
		},
	]);
	await startAt("2026-01-05T09:01:00.000Z");
	const run = await scheduler.runNow(schedule.id, owner);
	const failed = await waitFor("the failed run", async () => {
		const current = await runOf(run.id);
		return current?.status === "failed" ? current : undefined;
	});
	expect(failed.reason).toBe("the model request failed");
	const audits = await db
		.selectFrom("audit_events")
		.selectAll()
		.where("action", "=", "schedule.run_finished")
		.where("target_id", "=", schedule.id)
		.execute();
	expect(JSON.parse(audits[0]?.detail ?? "{}")).toMatchObject({ run_id: run.id, status: "failed" });
});

it("puts token_budget on the run's root session and hands an exhausted quota to the owner", async () => {
	const owner = await newOwner("owner-quota");
	const schedule = await makeSchedule(owner, { tokenBudget: 1 });
	let asked!: () => void;
	const inFlight = new Promise<void>((resolve) => {
		asked = resolve;
	});
	faux.setResponses([
		async () => {
			asked();
			await new Promise((resolve) => setTimeout(resolve, 100));
			return fauxAssistantMessage([fauxToolCall("list_nodes", {}, { id: "budget-tool" })], {
				stopReason: "toolUse",
			});
		},
	]);
	await startAt("2026-01-05T09:01:00.000Z");
	const run = await scheduler.runNow(schedule.id, owner);
	const sessionId = run.sessionId as string;
	await inFlight;
	// The budget became the root session's remaining quota.
	expect((await sessionRow(sessionId)).quota_tokens).toBe(1);
	await waitFor("the root's quota wait", async () =>
		(await sessionStateOf(db, sessionId)) === "awaiting" ? true : undefined,
	);
	const approvals = (await (await call(app, "/api/approvals", { cookie: await cookieOf(owner) })).json()) as {
		quotas: { sessionId: string; levelId: string }[];
	};
	expect(approvals.quotas).toEqual([expect.objectContaining({ sessionId, levelId: sessionId })]);

	const denied = await call(app, `/api/sessions/${sessionId}/quota`, {
		method: "POST",
		cookie: await cookieOf(owner),
		body: { decision: "deny", reason: "spend less" },
	});
	expect(denied.status).toBe(200);
	const failed = await waitFor("the quota-denied run", async () => {
		const current = await runOf(run.id);
		return current?.status === "failed" ? current : undefined;
	});
	expect(failed.reason).toContain("quota denied");
	expect(await sessionStateOf(db, sessionId)).toBe("active");
});

it("recovers a pending run whose submit never happened", async () => {
	const owner = await newOwner("owner-pending");
	const schedule = await makeSchedule(owner);
	const fireTime = "2026-01-05T09:00:00.000Z";
	const runId = newId();
	await db
		.insertInto("schedule_runs")
		.values({
			id: runId,
			schedule_id: schedule.id,
			fire_time: fireTime,
			manual: 0,
			status: "pending",
			session_id: null,
			reason: null,
			created_at: fireTime,
			started_at: fireTime,
			finished_at: null,
		})
		.execute();
	faux.setResponses([fauxAssistantMessage([fauxText("recovered")])]);
	await startAt("2026-01-05T09:06:00.000Z");
	const done = await waitFor("the recovered run", async () => {
		const current = await runOf(runId);
		return current?.status === "succeeded" ? current : undefined;
	});
	expect(done.sessionId).toBe(derivedId(`schedule-run:${runId}`));
	expect((await db.selectFrom("sessions").select("id").where("schedule_id", "=", schedule.id).execute()).length).toBe(
		1,
	);
});

it("recovers a run submitted before it was marked running, without a second session or input", async () => {
	const owner = await newOwner("owner-resubmit");
	const schedule = await makeSchedule(owner);
	const fireTime = "2026-01-05T09:00:00.000Z";
	const runId = newId();
	const sessionId = derivedId(`schedule-run:${runId}`);
	await db
		.insertInto("schedule_runs")
		.values({
			id: runId,
			schedule_id: schedule.id,
			fire_time: fireTime,
			manual: 0,
			status: "pending",
			session_id: null,
			reason: null,
			created_at: fireTime,
			started_at: fireTime,
			finished_at: null,
		})
		.execute();
	faux.setResponses([fauxAssistantMessage([fauxText("only once")])]);
	// The crash left the session created and the prompt submitted, but the run still pending.
	await runtime.createScheduledSession(owner, {
		id: sessionId,
		title: schedule.name,
		model: schedule.model,
		quota: null,
		scheduleId: schedule.id,
	});
	const submission = await runtime.submitAsSchedule(
		sessionId,
		schedule.id,
		schedule.prompt,
		`schedule:${schedule.id}:${fireTime}`,
	);
	await startAt("2026-01-05T09:06:00.000Z");
	const done = await waitFor("the recovered run", async () => {
		const current = await runOf(runId);
		return current?.status === "succeeded" ? current : undefined;
	});
	expect(done.sessionId).toBe(sessionId);
	// The resubmit found the first submission: one session, one input.
	const sessions = await db.selectFrom("sessions").select("id").where("schedule_id", "=", schedule.id).execute();
	expect(sessions.map((row) => row.id)).toEqual([sessionId]);
	expect((await sessionRow(sessionId)).last_submission_id).toBe(submission);
});

it("reconciles a running run whose session finished while the process was down", async () => {
	const owner = await newOwner("owner-reconcile");
	const schedule = await makeSchedule(owner);
	faux.setResponses([fauxAssistantMessage([fauxText("finished while down")])]);
	await startAt("2026-01-05T09:01:00.000Z");
	const run = await scheduler.runNow(schedule.id, owner);
	await waitFor("the run", async () => ((await runOf(run.id))?.status === "succeeded" ? true : undefined));
	// Simulate the row not having been updated before the process died.
	await db
		.updateTable("schedule_runs")
		.set({ status: "running", reason: null, finished_at: null })
		.where("id", "=", run.id)
		.execute();
	await scheduler.stop();
	await startAt("2026-01-05T09:10:00.000Z");
	const done = await waitFor("the reconciled run", async () => {
		const current = await runOf(run.id);
		return current?.status === "succeeded" ? current : undefined;
	});
	expect(done.reason).toBeNull();
});

it("stops the session a crash left running after marking its run preempted, before the next instance", async () => {
	const owner = await newOwner("owner-crash-window");
	const schedule = await makeSchedule(owner);
	let started!: () => void;
	const inFlight = new Promise<void>((resolve) => {
		started = resolve;
	});
	let releaseNext!: () => void;
	const nextGate = new Promise<void>((resolve) => {
		releaseNext = resolve;
	});
	faux.setResponses([
		async () => {
			started();
			await new Promise((resolve) => setTimeout(resolve, 2_000));
			return fauxAssistantMessage([fauxText("too late")]);
		},
		async () => {
			await nextGate;
			return fauxAssistantMessage([fauxText("next instance")]);
		},
	]);
	await startAt("2026-01-05T09:01:00.000Z");
	const first = await scheduler.runNow(schedule.id, owner);
	await inFlight;
	await waitFor("the first run to be running", async () =>
		(await runOf(first.id))?.status === "running" ? true : undefined,
	);
	const firstSession = first.sessionId as string;
	const firstSubmission = (await sessionRow(firstSession)).last_submission_id as string;

	// The next trigger fired; then the crash came after the previous run was marked preempted and before its
	// session was stopped (doc/scheduling.md#调度).
	const fireTime = "2026-01-05T09:02:00.000Z";
	const nextRunId = newId();
	await db
		.insertInto("schedule_runs")
		.values({
			id: nextRunId,
			schedule_id: schedule.id,
			fire_time: fireTime,
			manual: 0,
			status: "pending",
			session_id: null,
			reason: null,
			created_at: fireTime,
			started_at: null,
			finished_at: null,
		})
		.execute();
	await scheduler.stop();
	await db
		.updateTable("schedule_runs")
		.set({ status: "preempted", reason: "preempted by the next run", finished_at: clock.now().toISOString() })
		.where("id", "=", first.id)
		.execute();
	expect(await runOf(first.id)).toMatchObject({ status: "preempted", sessionId: firstSession });

	// A new process over the same database and runtime: recovery must stop the old instance before it submits the
	// leftover pending run.
	scheduler = new Scheduler({ db, runtime, audit, now: clock.now, setTimer: clock.setTimer });
	try {
		await startAt("2026-01-05T09:02:00.000Z");
		// The old session was stopped through its normal stop path, so its submission ended instead of running on.
		await expect(runtime.waitForSubmission(firstSubmission)).resolves.toEqual({
			status: "unanswered",
			reason: "aborted",
		});
		await waitFor("the recovered run to start", async () =>
			(await runOf(nextRunId))?.status === "running" ? true : undefined,
		);
		// Only one instance is running: the new run, not the preempted one.
		const active = await runtime.unsettledSubmissionRequests();
		expect(active.has(`schedule:${schedule.id}:${fireTime}`)).toBe(true);
		expect(active.has(`schedule:${schedule.id}:${first.fireTime}`)).toBe(false);
	} finally {
		releaseNext();
	}
	const next = await waitFor("the next instance", async () => {
		const current = await runOf(nextRunId);
		return current?.status === "succeeded" ? current : undefined;
	});
	expect(next.sessionId).toBe(derivedId(`schedule-run:${nextRunId}`));
	expect((await runsOf(schedule.id)).map((run) => run.status).sort()).toEqual(["preempted", "succeeded"]);
});

it("stops the running instance and unlinks the sessions when the schedule is deleted", async () => {
	const owner = await newOwner("owner-delete");
	const schedule = await makeSchedule(owner, { preset: "yolo" });
	let started!: () => void;
	const inFlight = new Promise<void>((resolve) => {
		started = resolve;
	});
	faux.setResponses([
		async () => {
			started();
			await new Promise((resolve) => setTimeout(resolve, 1_500));
			return fauxAssistantMessage([fauxText("never")]);
		},
	]);
	await startAt("2026-01-05T09:01:00.000Z");
	const run = await scheduler.runNow(schedule.id, owner);
	await inFlight;
	await waitFor("the run to be running", async () => ((await runOf(run.id))?.status === "running" ? true : undefined));
	const sessionId = run.sessionId as string;
	const submission = (await sessionRow(sessionId)).last_submission_id as string;

	const res = await call(app, `/api/schedules/${schedule.id}`, {
		method: "DELETE",
		cookie: await cookieOf(owner),
		body: {},
	});
	expect(res.status).toBe(200);
	expect(await getSchedule(db, schedule.id)).toBeUndefined();
	expect(await runOf(run.id)).toBeUndefined();
	await expect(runtime.waitForSubmission(submission)).resolves.toEqual({ status: "unanswered", reason: "aborted" });
	const session = await sessionRow(sessionId);
	expect(session.schedule_id).toBeNull();
	// The session stays usable: its inherit-only level was promoted to a root with the schedule's preset.
	const rules = await db
		.selectFrom("rule_sets")
		.selectAll()
		.where("scope_type", "=", "session")
		.where("scope_id", "=", sessionId)
		.executeTakeFirstOrThrow();
	expect(rules).toMatchObject({ preset: "yolo", default_action: "allow" });
	const audited = await db
		.selectFrom("audit_events")
		.selectAll()
		.where("action", "=", "schedule.deleted")
		.where("target_id", "=", schedule.id)
		.execute();
	expect(audited).toHaveLength(1);
});

it("disables a disabled owner's schedules", async () => {
	const owner = await newOwner("owner-disabled");
	const admin = await newOwner("admin-disable", "admin");
	const schedule = await makeSchedule(owner);
	expect((await getSchedule(db, schedule.id))?.enabled).toBe(true);
	const res = await call(app, `/api/users/${owner.userId}`, {
		method: "PATCH",
		cookie: await cookieOf(admin),
		body: { status: "disabled" },
	});
	expect(res.status).toBe(200);
	const updated = await getSchedule(db, schedule.id);
	expect(updated?.enabled).toBe(false);
	expect(updated?.nextRunAt).toBeNull();
	const audited = await db
		.selectFrom("audit_events")
		.selectAll()
		.where("action", "=", "schedule.disabled")
		.where("target_id", "=", schedule.id)
		.execute();
	expect(audited).toHaveLength(1);
});

it("validates the API input and keeps schedules owner-only", async () => {
	const owner = await newOwner("owner-api");
	const other = await newOwner("other-api");
	const admin = await newOwner("admin-api", "admin");
	const ownerCookie = await cookieOf(owner);
	await startAt("2026-01-05T09:01:00.000Z");

	const base = {
		name: "api schedule",
		prompt: "do it",
		model: model(),
		preset: "ask",
		tokenBudget: null,
		cron: "*/10 * * * *",
		timezone: "UTC",
		catchUp: false,
		enabled: true,
	};
	for (const bad of [
		{ ...base, cron: "not a cron" },
		{ ...base, cron: "0 0 * * * *" },
		{ ...base, timezone: "Mars/Olympus" },
		{ ...base, name: "" },
		{ ...base, prompt: "" },
		{ ...base, preset: "sometimes" },
		{ ...base, model: { provider: "nope", modelId: "none" } },
	]) {
		const res = await call(app, "/api/schedules", { method: "POST", cookie: ownerCookie, body: bad });
		expect(res.status, JSON.stringify(bad)).toBe(400);
	}
	// A budget is unlimited (null) or at least one token; every other number is a clear 400 (doc/scheduling.md#授权规则与配额).
	for (const tokenBudget of [0, -1, 1.5, "100"]) {
		const res = await call(app, "/api/schedules", {
			method: "POST",
			cookie: ownerCookie,
			body: { ...base, tokenBudget },
		});
		expect(res.status, `tokenBudget ${tokenBudget}`).toBe(400);
		expect(((await res.json()) as { error: string }).error).toContain("tokenBudget must be a positive integer");
	}
	const budgeted = await call(app, "/api/schedules", {
		method: "POST",
		cookie: ownerCookie,
		body: { ...base, name: "one token", tokenBudget: 1 },
	});
	expect(budgeted.status).toBe(201);

	const created = await call(app, "/api/schedules", { method: "POST", cookie: ownerCookie, body: base });
	expect(created.status).toBe(201);
	const view = (await created.json()) as {
		schedule: { id: string; preset: string; nextRunAt: string; preview: string[]; inProgress: boolean };
	};
	expect(view.schedule.preset).toBe("ask");
	expect(view.schedule.nextRunAt).toBe("2026-01-05T09:10:00.000Z");
	expect(view.schedule.preview.slice(0, 2)).toEqual(["2026-01-05T09:10:00.000Z", "2026-01-05T09:20:00.000Z"]);
	expect(view.schedule.inProgress).toBe(false);
	const id = view.schedule.id;

	// The same budget rule applies to PATCH, and a valid one is stored.
	const zeroPatch = await call(app, `/api/schedules/${id}`, {
		method: "PATCH",
		cookie: ownerCookie,
		body: { tokenBudget: 0 },
	});
	expect(zeroPatch.status).toBe(400);
	expect(((await zeroPatch.json()) as { error: string }).error).toContain("tokenBudget must be a positive integer");
	const budgetPatch = await call(app, `/api/schedules/${id}`, {
		method: "PATCH",
		cookie: ownerCookie,
		body: { tokenBudget: 5 },
	});
	expect(budgetPatch.status).toBe(200);
	expect(((await budgetPatch.json()) as { schedule: { tokenBudget: number } }).schedule.tokenBudget).toBe(5);

	// Preview endpoint, also without saving.
	const preview = await call(app, "/api/schedules/preview", {
		method: "POST",
		cookie: ownerCookie,
		body: { cron: "0 3 * * *", timezone: "Europe/Berlin", count: 2 },
	});
	expect(preview.status).toBe(200);
	expect(((await preview.json()) as { times: string[] }).times).toHaveLength(2);

	// Another user, and an administrator, do not see it (schedules are not shared and admin does not bypass).
	for (const user of [other, admin]) {
		const cookie = await cookieOf(user);
		expect((await call(app, `/api/schedules/${id}`, { cookie })).status).toBe(404);
		expect((await call(app, `/api/schedules/${id}/runs`, { cookie })).status).toBe(404);
		expect(
			(await call(app, `/api/schedules/${id}`, { method: "PATCH", cookie, body: { name: "mine now" } })).status,
		).toBe(404);
		expect((await call(app, `/api/schedules/${id}/run`, { method: "POST", cookie, body: {} })).status).toBe(404);
		expect((await call(app, `/api/schedules/${id}`, { method: "DELETE", cookie, body: {} })).status).toBe(404);
	}
	expect(
		((await (await call(app, "/api/schedules", { cookie: await cookieOf(other) })).json()) as { schedules: unknown[] })
			.schedules,
	).toHaveLength(0);

	// A cron change recomputes the next trigger; a prompt change does not.
	const patched = await call(app, `/api/schedules/${id}`, {
		method: "PATCH",
		cookie: ownerCookie,
		body: { cron: "*/15 * * * *" },
	});
	expect(patched.status).toBe(200);
	expect(((await patched.json()) as { schedule: { nextRunAt: string } }).schedule.nextRunAt).toBe(
		"2026-01-05T09:15:00.000Z",
	);
	const prompted = await call(app, `/api/schedules/${id}`, {
		method: "PATCH",
		cookie: ownerCookie,
		body: { prompt: "do it differently", preset: "yolo" },
	});
	const promptedView = (await prompted.json()) as { schedule: { nextRunAt: string; preset: string } };
	expect(promptedView.schedule.nextRunAt).toBe("2026-01-05T09:15:00.000Z");
	expect(promptedView.schedule.preset).toBe("yolo");
	// Disabling clears the next trigger and audits it; sessions can be filtered by the schedule.
	const disabled = await call(app, `/api/schedules/${id}`, {
		method: "PATCH",
		cookie: ownerCookie,
		body: { enabled: false },
	});
	expect(((await disabled.json()) as { schedule: { nextRunAt: string | null } }).schedule.nextRunAt).toBeNull();
	await audit.flush();
	const disabledAudit = await db
		.selectFrom("audit_events")
		.selectAll()
		.where("action", "=", "schedule.disabled")
		.where("target_id", "=", id)
		.execute();
	expect(disabledAudit).toHaveLength(1);
	const filtered = await call(app, `/api/sessions?scheduleId=${id}`, { cookie: ownerCookie });
	expect(((await filtered.json()) as { items: unknown[] }).items).toEqual([]);
});

it("follows croner's DST handling for a 02:30 New York schedule", () => {
	// Spring forward: 02:30 does not exist on 2026-03-08, so croner fires at 03:00 EDT (07:00Z).
	expect(previewRuns("30 2 * * *", "America/New_York", new Date("2026-03-07T00:00:00.000Z"), 3)).toEqual([
		"2026-03-07T07:30:00.000Z",
		"2026-03-08T07:00:00.000Z",
		"2026-03-09T06:30:00.000Z",
	]);
	// Fall back: 02:30 occurs twice on 2026-11-01; croner takes the second (EST, 07:30Z).
	expect(nextRunAfter("30 2 * * *", "America/New_York", new Date("2026-10-31T06:30:00.000Z"))).toBe(
		"2026-11-01T07:30:00.000Z",
	);
	expect(previewRuns("30 2 * * *", "Not/AZone", new Date(), 3)).toEqual([]);
	expect(() => nextRunAfter("bad", "UTC", new Date())).toThrow(/invalid cron/);
});
