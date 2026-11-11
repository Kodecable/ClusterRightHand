import {
	type AssistantMessage,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { GenerationTimings, MAX_PENDING_TIMINGS, stepTiming } from "../src/agent/latency.ts";
import { meteredModels } from "../src/agent/metering.ts";
import { ModelConfig } from "../src/agent/models.ts";
import { budgetUsedTokens, chargeCall, sessionStats } from "../src/agent/quota.ts";
import { AgentRuntime } from "../src/agent/runtime.ts";
import { Audit } from "../src/audit/audit.ts";
import type { SessionUser } from "../src/auth/sessions.ts";
import { Cluster } from "../src/cluster/cluster.ts";
import { TaskGroups } from "../src/cluster/task-groups.ts";
import { MasterKey } from "../src/keys/master-key.ts";
import type { Db } from "../src/storage/db.ts";
import { createUser } from "../src/users/service.ts";
import { openTestDb } from "./helpers/db.ts";
import { waitSubmission } from "./helpers/runtime.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/**
 * Per-session generation statistics (doc/design/agent-runtime.md "Session statistics"): turns are submissions that produced a step,
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
