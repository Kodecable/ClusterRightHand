import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AssistantMessage,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { GenerationTimings, MAX_PENDING_TIMINGS, stepTiming } from "../src/agent/latency.ts";
import { meteredModels } from "../src/agent/metering.ts";
import { ModelConfig } from "../src/agent/models.ts";
import { budgetUsedTokens, chargeCall, sessionStats } from "../src/agent/quota.ts";
import { AgentRuntime } from "../src/agent/runtime.ts";
import { backfillUsageTokens, cacheReadTokensOf, historyCounts, promptTokensOf } from "../src/agent/usage-backfill.ts";
import { Audit } from "../src/audit/audit.ts";
import type { SessionUser } from "../src/auth/sessions.ts";
import { Cluster } from "../src/cluster/cluster.ts";
import { TaskGroups } from "../src/cluster/task-groups.ts";
import { MasterKey } from "../src/keys/master-key.ts";
import type { Db } from "../src/storage/db.ts";
import { openDb } from "../src/storage/db.ts";
import { migrateToLatest } from "../src/storage/migrate.ts";
import { createUser } from "../src/users/service.ts";
import { openTestDb } from "./helpers/db.ts";
import { waitSubmission } from "./helpers/runtime.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/**
 * Per-session generation statistics (doc/agent-runtime.md#会话统计): turns are submissions that produced a step,
 * steps are main-agent assistant messages, and TTFT/decode come from the provider stream itself (a
 * `meteredModels` tap on `streamSimple`), so no viewer has to watch the session. The prompt/cache buckets are
 * the tree's.
 */
let db: Db;
let runtime: AgentRuntime;
let owner: SessionUser;
const faux = fauxProvider();
/** A provider slow enough that the first content delta and the stream end are clearly apart. */
const slow = fauxProvider({ provider: "faux-slow", tokensPerSecond: 1_000 });
const model = (provider = faux) => ({ provider: provider.provider.id, modelId: provider.getModel().id });

beforeAll(async () => {
	db = await openTestDb("sqlite");
	const audit = new Audit(db);
	const cluster = new Cluster(db, { audit });
	const models = new ModelConfig(db, MasterKey.generate());
	models.addProvider(faux.provider);
	models.addProvider(slow.provider);
	await models.reload();
	runtime = await AgentRuntime.open({
		db,
		storage: new MemoryStorage(),
		models,
		cluster,
		taskGroups: new TaskGroups(db, cluster, { audit }),
		audit,
	});
	const user = await createUser(db, { username: "owner", kind: "member", password: "password-123" });
	owner = { sessionId: "test", userId: user.id, username: user.username, kind: "member" };
});

afterAll(async () => {
	await runtime.close();
	await db.destroy();
});

it("counts one turn per submission and one step per assistant message", async () => {
	const session = await runtime.createSession(owner, { model: model(), rulePreset: "yolo", title: "steps" });
	// Two submissions, each with a tool round and a final answer: two steps each, four steps in total.
	for (const [index, requestId] of ["stats-1", "stats-2"].entries()) {
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("list_nodes", {}, { id: `stats-tool-${index}` })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxText(`answer ${index}`)]),
		]);
		const submission = await runtime.submit(session.id, owner, `input ${index}`, requestId);
		expect((await waitSubmission(runtime, session.id, submission)).status).toBe("done");
	}
	const view = await runtime.getSession(session.id);
	expect(view?.stats.turns).toBe(2);
	expect(view?.stats.steps).toBe(4);
	// A retry or a follow-up step of one submission does not add a turn; the counted submission is the last.
	const row = await db
		.selectFrom("sessions")
		.select(["counted_submission_id", "last_submission_id"])
		.where("id", "=", session.id)
		.executeTakeFirstOrThrow();
	expect(row.counted_submission_id).toBe(row.last_submission_id);
});

it("counts a subagent's own submission as its turn, not its parent's", async () => {
	const root = await runtime.createSession(owner, { model: model(), rulePreset: "yolo", title: "parent" });
	const child = await runtime.createSubagent(root.id, {
		callKey: "stats-subagent-child",
		task: "child work",
		rules: { default: "inherit", rules: [] },
		quota: null,
	});
	faux.setResponses([fauxAssistantMessage([fauxText("child answer")])]);
	await runtime.startSubagent(child.id, "work", "stats-subagent-1");
	expect(await runtime.waitSubagent(child.id)).toEqual({ status: "done", answer: "child answer" });
	// Each session's turns and steps are its own; the parent's tree totals are not its own counters.
	const childView = await runtime.getSession(child.id);
	const rootView = await runtime.getSession(root.id);
	expect(childView?.stats.turns).toBe(1);
	expect(childView?.stats.steps).toBe(1);
	expect(rootView?.stats.turns).toBe(0);
	expect(rootView?.stats.steps).toBe(0);
});

it("accumulates prompt and cache-read tokens up the tree, not down it", async () => {
	const root = await runtime.createSession(owner, { model: model(), rulePreset: "yolo", title: "cache tree" });
	const child = await runtime.createSubagent(root.id, {
		callKey: "stats-cache-child",
		task: "child work",
		rules: { default: "inherit", rules: [] },
		quota: null,
	});
	// The child's call adds its own input and cache read to the child and to every ancestor.
	await chargeCall(db, child.id, { budget: 10, usage: 80, context: 70, cacheRead: 30 });
	expect((await sessionStats(db, child.id)).promptTokens).toBe(70);
	expect((await sessionStats(db, child.id)).cacheReadTokens).toBe(30);
	expect((await sessionStats(db, root.id)).promptTokens).toBe(70);
	expect((await sessionStats(db, root.id)).cacheReadTokens).toBe(30);
	expect((await sessionStats(db, root.id)).steps).toBe(0);
	// The root's own call adds to the root only.
	await chargeCall(db, root.id, { budget: 20, usage: 180, context: 160, cacheRead: 60 });
	expect((await sessionStats(db, root.id)).promptTokens).toBe(230);
	expect((await sessionStats(db, root.id)).cacheReadTokens).toBe(90);
	expect((await sessionStats(db, child.id)).promptTokens).toBe(70);
	expect((await sessionStats(db, child.id)).cacheReadTokens).toBe(30);
});

it("times a generation at the provider stream with no viewer watching", async () => {
	const session = await runtime.createSession(owner, { model: model(slow), rulePreset: "yolo", title: "latency" });
	// No `runtime.watch` anywhere: the metered provider stream times the request itself, so a scheduled or
	// API-token run, and a session no browser has open, get TTFT and decode statistics too.
	slow.setResponses([() => fauxAssistantMessage([fauxText("x".repeat(2_000))])]);
	const submission = await runtime.submit(session.id, owner, "slow answer", "stats-latency-1");
	expect((await waitSubmission(runtime, session.id, submission)).status).toBe("done");
	const stats = (await runtime.getSession(session.id))?.stats;
	expect(stats?.steps).toBe(1);
	expect(stats?.ttftSteps).toBe(1);
	expect(stats?.decodeTokens).toBe(await budgetUsedTokens(db, session.id));
	// The faux provider delays every chunk, so the first delta and the end are clearly after the start.
	expect(stats?.ttftMs).toBeGreaterThan(0);
	expect(stats?.decodeMs).toBeGreaterThan(0);
	// The metrics survive the message: they are persisted counters, not the in-memory timing map.
	expect(runtime.pendingTimingCount).toBe(0);
});

it("computes TTFT and decode from the attempt's start, first and end", () => {
	// start 6s, first content 7.2s, end 10s: 1.2s of TTFT and 2.8s of decode.
	expect(stepTiming({ start: 6_000, first: 7_200, end: 10_000 }, 40)).toEqual({
		ttftMs: 1_200,
		decodeMs: 2_800,
		outputTokens: 40,
	});
	// A first delta before the start clamps at zero rather than going negative.
	expect(stepTiming({ start: 6_000, first: 5_000, end: 10_000 }, 40)).toEqual({
		ttftMs: 0,
		decodeMs: 5_000,
		outputTokens: 40,
	});
	// No attempt, no observed content, no observed end, or no output: no timing; the step is still counted.
	expect(stepTiming(undefined, 40)).toBeUndefined();
	expect(stepTiming({ start: 6_000, end: 10_000 }, 40)).toBeUndefined();
	expect(stepTiming({ start: 6_000, first: 7_200 }, 40)).toBeUndefined();
	expect(stepTiming({ start: 6_000, first: 7_200, end: 10_000 }, 0)).toBeUndefined();
});

/** A `Models` whose requests are the given streams and completion, enough for `meteredModels` to wrap. */
function fakeModels(streams: AssistantMessageEventStream[], completion: AssistantMessage): Models {
	let next = 0;
	return {
		stream: () => streams[next++] as AssistantMessageEventStream,
		streamSimple: () => streams[next++] as AssistantMessageEventStream,
		completeSimple: async () => completion,
	} as unknown as Models;
}

/** Lets the forwarding stream's consumer observe what was pushed. */
function settle(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 2));
}

it("taps the provider stream: it forwards events and result, records timing and keeps durationMs", async () => {
	const timings = new GenerationTimings();
	const source = createAssistantMessageEventStream();
	const proxy = meteredModels(
		fakeModels([source], fauxAssistantMessage([fauxText("unused")])),
		async () => {},
		() => timings,
	);
	const message = fauxAssistantMessage([fauxText("answer")]);
	const empty: AssistantMessage = { ...message, content: [] };
	const opening: AssistantMessage = { ...message, content: [{ type: "text", text: "" }] };

	const forwarded = proxy.streamSimple(faux.getModel(), { messages: [] }, { sessionId: "provider-one" });
	source.push({ type: "start", partial: empty });
	source.push({ type: "text_start", contentIndex: 0, partial: opening });
	await settle();
	source.push({ type: "text_delta", contentIndex: 0, delta: "ans", partial: message });
	await settle();
	source.push({ type: "done", reason: "stop", message });
	source.end(message);
	const result = await forwarded.result();
	expect(result).toBe(message);
	// The source timed the response; the forwarding stream must not replace that measurement.
	expect(result.durationMs).toBeDefined();
	expect(result.durationMs).toBe(message.durationMs);

	const attempt = timings.take("provider-one");
	if (!attempt || attempt.first === undefined || attempt.end === undefined) {
		throw new Error("the attempt must be timed start/first/end");
	}
	expect(attempt.first).toBeGreaterThan(attempt.start);
	expect(attempt.end).toBeGreaterThan(attempt.first);
	// Taking forgets the entry.
	expect(timings.size).toBe(0);
});

it("forwards a source that ends through end(result) without a terminal event", async () => {
	const timings = new GenerationTimings();
	const source = createAssistantMessageEventStream();
	const proxy = meteredModels(
		fakeModels([source], fauxAssistantMessage([])),
		async () => {},
		() => timings,
	);
	const message = fauxAssistantMessage([fauxText("done")]);

	const forwarded = proxy.streamSimple(faux.getModel(), { messages: [] }, { sessionId: "provider-end" });
	source.push({ type: "start", partial: { ...message, content: [] } });
	source.push({ type: "text_delta", contentIndex: 0, delta: "d", partial: message });
	source.end(message);
	expect(await forwarded.result()).toBe(message);
	// No done/error event means no observed end: the attempt has a first delta but contributes no timing.
	const attempt = timings.take("provider-end");
	expect(attempt?.first).toBeDefined();
	expect(attempt?.end).toBeUndefined();
	expect(stepTiming(attempt, 10)).toBeUndefined();
});

it("lets a retry replace the provider session's attempt", async () => {
	const timings = new GenerationTimings();
	const first = createAssistantMessageEventStream();
	const second = createAssistantMessageEventStream();
	const proxy = meteredModels(
		fakeModels([first, second], fauxAssistantMessage([])),
		async () => {},
		() => timings,
	);
	const message = fauxAssistantMessage([fauxText("first")]);

	const firstForward = proxy.streamSimple(faux.getModel(), { messages: [] }, { sessionId: "provider-retry" });
	first.push({ type: "start", partial: { ...message, content: [] } });
	first.push({ type: "text_delta", contentIndex: 0, delta: "f", partial: message });
	first.push({ type: "done", reason: "stop", message });
	first.end(message);
	await firstForward.result();

	// The retry's call begins a new attempt: the failed one's timestamps are gone before its stream ends.
	const beforeRetry = performance.now();
	const secondForward = proxy.streamSimple(faux.getModel(), { messages: [] }, { sessionId: "provider-retry" });
	const attempt = timings.take("provider-retry");
	expect(attempt).toBeDefined();
	expect(attempt?.start).toBeGreaterThanOrEqual(beforeRetry);
	expect(attempt?.first).toBeUndefined();
	expect(timings.size).toBe(0);
	second.push({ type: "done", reason: "stop", message });
	second.end(message);
	await secondForward.result();
});

it("records no first delta for a message without content, so the step has no timing", async () => {
	const timings = new GenerationTimings();
	const source = createAssistantMessageEventStream();
	const proxy = meteredModels(
		fakeModels([source], fauxAssistantMessage([])),
		async () => {},
		() => timings,
	);
	const message = fauxAssistantMessage([fauxText("")]);

	const forwarded = proxy.streamSimple(faux.getModel(), { messages: [] }, { sessionId: "provider-empty" });
	source.push({ type: "start", partial: { ...message, content: [] } });
	source.push({ type: "text_start", contentIndex: 0, partial: message });
	await settle();
	source.push({ type: "done", reason: "stop", message });
	source.end(message);
	await forwarded.result();
	const attempt = timings.take("provider-empty");
	if (!attempt) throw new Error("the attempt must exist even without content");
	expect(attempt.first).toBeUndefined();
	// Even if the provider reported output, a call with no observed content contributes no timing.
	expect(stepTiming(attempt, 10)).toBeUndefined();
});

it("does not time a completeSimple call, so compaction cannot become a step's timing", async () => {
	const timings = new GenerationTimings();
	let completed = 0;
	const completion = fauxAssistantMessage([fauxText("summary")]);
	const proxy = meteredModels(
		fakeModels([], completion),
		async () => {
			completed++;
		},
		() => timings,
	);
	const answer = await proxy.completeSimple(faux.getModel(), { messages: [] }, { sessionId: "provider-compaction" });
	expect(answer).toBe(completion);
	// Compaction is still metered, but it starts no timing entry for afterResponse to read.
	expect(completed).toBe(1);
	expect(timings.size).toBe(0);
	expect(timings.take("provider-compaction")).toBeUndefined();
});

it("bounds attempts whose stream never ended", () => {
	const timings = new GenerationTimings();
	for (let index = 0; index <= MAX_PENDING_TIMINGS; index++) timings.begin(`provider-${index}`);
	expect(timings.size).toBe(MAX_PENDING_TIMINGS);
	// The oldest entry is evicted; the newest is still held.
	expect(timings.take("provider-0")).toBeUndefined();
	expect(timings.take(`provider-${MAX_PENDING_TIMINGS}`)).toBeDefined();
});

it("counts a step without timing when nothing could be measured", async () => {
	const session = await runtime.createSession(owner, { model: model(), rulePreset: "yolo", title: "no timing" });
	await chargeCall(
		db,
		session.id,
		{ budget: 10, usage: 110, context: 100, cacheRead: 40 },
		{ timing: stepTiming(undefined, 10) },
	);
	const stats = await sessionStats(db, session.id);
	expect(stats.steps).toBe(1);
	expect(stats.turns).toBe(0);
	expect(stats.ttftSteps).toBe(0);
	expect(stats.ttftMs).toBe(0);
	expect(stats.decodeMs).toBe(0);
	expect(stats.decodeTokens).toBe(0);
	// The token buckets grew even though the step had no timing; nothing is written to ancestors.
	expect(stats.promptTokens).toBe(100);
	expect(stats.cacheReadTokens).toBe(40);
});

it("reads the prompt and cache-read halves of durable's usage and counts history", () => {
	const state = {
		models: {
			"faux/one": {
				input: 100,
				output: 20,
				cacheRead: 5,
				cacheWrite: 15,
				totalTokens: 140,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		},
		tools: {
			exec: {
				input: 10,
				output: 5,
				cacheRead: 2,
				cacheWrite: 0,
				totalTokens: 17,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		},
	};
	expect(promptTokensOf(state)).toBe(132);
	expect(cacheReadTokensOf(state)).toBe(7);
	expect(promptTokensOf(undefined)).toBe(0);
	expect(cacheReadTokensOf(undefined)).toBe(0);

	// user, assistant, tool result, assistant (one turn, two steps); a compaction summary is not user input.
	expect(
		historyCounts([
			{ kind: "pi.user" },
			{ kind: "pi.assistant" },
			{ kind: "pi.tool-result" },
			{ kind: "pi.assistant" },
			{ kind: "pi.compaction" },
			{ kind: "pi.user" },
			{ kind: "pi.assistant" },
		]),
	).toEqual({ steps: 3, turns: 2 });
	// An input the run never turned into a message is not a turn.
	expect(historyCounts([{ kind: "pi.user" }, { kind: "pi.user" }, { kind: "pi.assistant" }])).toEqual({
		steps: 1,
		turns: 1,
	});
});

it("backfills steps, turns and the prompt/cache tree buckets once", async () => {
	const dir = await mkdtemp(join(tmpdir(), "crh-session-stats-"));
	const localDb = openDb({ driver: "sqlite", path: join(dir, "crhs.db") });
	await migrateToLatest(localDb);
	const user = await createUser(localDb, { username: "owner", kind: "member", password: "password-123" });
	const localOwner: SessionUser = { sessionId: "test", userId: user.id, username: user.username, kind: "member" };
	const audit = new Audit(localDb);
	const cluster = new Cluster(localDb, { audit });
	const models = new ModelConfig(localDb, MasterKey.generate());
	models.addProvider(faux.provider);
	await models.reload();
	const options = {
		db: localDb,
		models,
		cluster,
		taskGroups: new TaskGroups(localDb, cluster, { audit }),
		audit,
	};
	const first = await AgentRuntime.open({
		...options,
		storage: await openNodeSqliteStorage(join(dir, "durable.sqlite"), { prefix: "pi_" }),
	});
	let second: AgentRuntime | undefined;
	try {
		const root = await first.createSession(localOwner, { model: model(), rulePreset: "yolo", title: "persisted" });
		const child = await first.createSubagent(root.id, {
			callKey: "stats-backfill-child",
			task: "child work",
			rules: { default: "inherit", rules: [] },
			quota: null,
		});
		const usage = (input: number, output: number, cacheRead: number) => ({
			input,
			output,
			cacheRead,
			cacheWrite: 0,
			totalTokens: input + output + cacheRead,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		});
		faux.setResponses([
			{
				...fauxAssistantMessage([fauxToolCall("list_nodes", {}, { id: "backfill-tool" })]),
				stopReason: "toolUse",
				usage: usage(50, 5, 10),
			},
			{ ...fauxAssistantMessage([fauxText("root answer")]), usage: usage(70, 20, 15) },
		]);
		const submission = await first.submit(root.id, localOwner, "go", "stats-backfill-1");
		expect((await waitSubmission(first, root.id, submission)).status).toBe("done");
		faux.setResponses([{ ...fauxAssistantMessage([fauxText("child answer")]), usage: usage(40, 10, 30) }]);
		await first.startSubagent(child.id, "work", "stats-backfill-child-1");
		expect(await first.waitSubagent(child.id)).toEqual({ status: "done", answer: "child answer" });

		const expectedRoot = await first.getSession(root.id);
		const expectedChild = await first.getSession(child.id);
		if (!expectedRoot || !expectedChild) throw new Error("the sessions must exist");
		expect(expectedRoot.stats.steps).toBe(2);
		expect(expectedRoot.stats.turns).toBe(1);
		// The provider stream timed both live steps, with no viewer.
		expect(expectedRoot.stats.ttftSteps).toBe(2);
		expect(expectedChild.stats.steps).toBe(1);
		// Pretend the sessions predate the measures: every counter is 0 and the backfill has not run.
		await localDb
			.updateTable("sessions")
			.set({
				usage_tokens: 0,
				prompt_tokens: 0,
				cache_read_tokens: 0,
				stat_steps: 0,
				stat_turns: 0,
				stat_ttft_ms: 0,
				stat_ttft_steps: 0,
				stat_decode_ms: 0,
				stat_decode_tokens: 0,
			})
			.execute();
		await localDb.deleteFrom("server_meta").where("key", "=", "session_stats_backfilled_at").execute();
		await first.close();

		// The next start reads durable's per-conversation usage and history; timing cannot be recovered.
		second = await AgentRuntime.open({
			...options,
			storage: await openNodeSqliteStorage(join(dir, "durable.sqlite"), { prefix: "pi_" }),
		});
		const backfilledRoot = await second.getSession(root.id);
		const backfilledChild = await second.getSession(child.id);
		if (!backfilledRoot || !backfilledChild) throw new Error("the sessions must exist after the backfill");
		expect(backfilledRoot.stats.steps).toBe(expectedRoot.stats.steps);
		expect(backfilledRoot.stats.turns).toBe(expectedRoot.stats.turns);
		expect(backfilledRoot.stats.promptTokens).toBe(expectedRoot.stats.promptTokens);
		expect(backfilledRoot.stats.cacheReadTokens).toBe(expectedRoot.stats.cacheReadTokens);
		expect(backfilledRoot.usageTokens).toBe(expectedRoot.usageTokens);
		expect(backfilledChild.stats.steps).toBe(expectedChild.stats.steps);
		expect(backfilledChild.stats.promptTokens).toBe(expectedChild.stats.promptTokens);
		expect(backfilledChild.stats.cacheReadTokens).toBe(expectedChild.stats.cacheReadTokens);
		// Timing is left at 0: it is measured live and cannot be recovered from durable's history.
		expect(backfilledRoot.stats.ttftSteps).toBe(0);
		expect(backfilledRoot.stats.decodeMs).toBe(0);
		// The flag is set: a second backfill does nothing.
		expect(await backfillUsageTokens(localDb, async () => undefined)).toBe(0);
	} finally {
		await second?.close().catch(() => {});
		await first.close().catch(() => {});
		await localDb.destroy();
		await rm(dir, { recursive: true, force: true });
	}
});
