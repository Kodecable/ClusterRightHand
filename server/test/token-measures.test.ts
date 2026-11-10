import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { ModelConfig } from "../src/agent/models.ts";
import { budgetUsedTokens, contextTokens, usageTokens } from "../src/agent/quota.ts";
import { AgentRuntime } from "../src/agent/runtime.ts";
import {
	accountedInputTokens,
	accountedOutputTokens,
	callTokens,
	ESTIMATED_TOKENS_PER_BYTE,
	estimateRequestTokens,
	estimateTokens,
	RequestEstimates,
	requestBytes,
} from "../src/agent/tokens.ts";
import { subtreeUsage, usageTokensOf } from "../src/agent/usage-backfill.ts";
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
 * The two token measures (doc/design/agent-runtime.md "Quota and token accounting"): the budget counts output only and stops a run, the
 * usage statistic counts input + output and never stops anything. The context fill is the last main-agent call's
 * input, never a compaction's or a review's.
 */
let db: Db;
let runtime: AgentRuntime;
let owner: SessionUser;
const faux = fauxProvider();
const model = () => ({ provider: faux.provider.id, modelId: faux.getModel().id });

const USAGE = (input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({
	input,
	output,
	cacheRead,
	cacheWrite,
	totalTokens: input + output + cacheRead + cacheWrite,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

beforeAll(async () => {
	db = await openTestDb("sqlite");
	const audit = new Audit(db);
	const cluster = new Cluster(db, { audit });
	const models = new ModelConfig(db, MasterKey.generate());
	models.addProvider(faux.provider);
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

it("both measures share one estimate constant", () => {
	expect(ESTIMATED_TOKENS_PER_BYTE).toBe(0.3);
	expect(estimateTokens(0)).toBe(0);
	expect(estimateTokens(4)).toBe(2);
	expect(estimateTokens(5)).toBe(2);
	expect(estimateTokens(100)).toBe(30);
});

it("the usage measure is input + output, cache included in the input; the budget is output only", () => {
	const message = { usage: USAGE(100, 20, 5, 15), content: [{ type: "text", text: "x".repeat(1_000) }] };
	expect(accountedOutputTokens(message)).toBe(20);
	expect(accountedInputTokens(message, 999)).toBe(120);
	expect(callTokens(message, 999)).toEqual({ budget: 20, usage: 140, context: 120, cacheRead: 5 });
	// No reported usage: both halves are estimated from bytes, and the input estimate is the caller's basis.
	const estimated = callTokens({ content: [{ type: "text", text: "abcd" }] }, 40);
	expect(estimated).toEqual({ budget: 2, usage: 42, context: 40, cacheRead: 0 });
});

it("estimates a request's input from the bytes of its serialized context", () => {
	const bytes = requestBytes({ messages: [{ role: "user", content: "hi" }] });
	expect(bytes).toBeGreaterThan(0);
	expect(estimateRequestTokens({ messages: [{ role: "user", content: "hi" }] })).toBe(Math.ceil(bytes * 0.3));
	expect(estimateRequestTokens(undefined)).toBe(0);
	// A circular value cannot be serialized: it counts as nothing instead of throwing.
	const circular: Record<string, unknown> = {};
	circular.self = circular;
	expect(requestBytes(circular)).toBe(0);
});

it("keeps one input estimate per conversation and drops it when the response reads it", () => {
	const estimates = new RequestEstimates();
	estimates.set("1", 10);
	// A retry (or a request that failed without a response) overwrites; the map never gains a second entry.
	estimates.set("1", 20);
	expect(estimates.size).toBe(1);
	expect(estimates.take("1")).toBe(20);
	// The response took the estimate: nothing is left for a later response to read.
	expect(estimates.size).toBe(0);
	expect(estimates.take("1")).toBe(0);
	// A request that fails without a response leaves at most one entry for its conversation.
	estimates.set("2", 5);
	expect(estimates.size).toBe(1);
});

it("a session accumulates both measures independently, and the context follows its last main call", async () => {
	const session = await runtime.createSession(owner, { model: model(), rulePreset: "yolo", title: "measures" });
	faux.setResponses([fauxAssistantMessage([fauxText("first answer")])]);
	const first = await runtime.submit(session.id, owner, "one", "measures-1");
	expect((await waitSubmission(runtime, session.id, first)).status).toBe("done");
	const budget1 = await budgetUsedTokens(db, session.id);
	const usage1 = await usageTokens(db, session.id);
	const context1 = await contextTokens(db, session.id);
	if (context1 === null) throw new Error("the first main call must record a context fill");
	// The upstream (faux) reports usage: the budget takes the output, the usage the input plus the output.
	expect(budget1).toBeGreaterThan(0);
	expect(context1).toBeGreaterThan(0);
	expect(usage1).toBeGreaterThan(budget1);
	expect(context1).toBe(usage1 - budget1);

	faux.setResponses([fauxAssistantMessage([fauxText("second answer")])]);
	const second = await runtime.submit(session.id, owner, "two", "measures-2");
	expect((await waitSubmission(runtime, session.id, second)).status).toBe("done");
	// The budget grew by the output only, the usage by input + output; the context is the newer call's input.
	const budget2 = await budgetUsedTokens(db, session.id);
	const usage2 = await usageTokens(db, session.id);
	const context2 = await contextTokens(db, session.id);
	if (context2 === null) throw new Error("the second main call must record a context fill");
	expect(budget2).toBeGreaterThan(budget1);
	expect(usage2).toBeGreaterThan(usage1);
	expect(context2).not.toBe(context1);
	// Each call adds its input (the new context) plus its output (the budget's growth).
	expect(usage2).toBe(usage1 + context2 + (budget2 - budget1));
	expect((await runtime.getSession(session.id))?.budgetRemaining).toBeNull();
	expect((await runtime.getSession(session.id))?.usageTokens).toBe(usage2);
	expect((await runtime.getSession(session.id))?.contextTokens).toBe(context2);
});

it("estimates both measures from a message the upstream reported no usage for", async () => {
	// faux reports its own estimate for a generation; a compaction's summarizer goes through `completeSimple`,
	// where the message keeps the zero usage the scripted response carries. The estimate is the shared one.
	const session = await runtime.createSession(owner, {
		model: model(),
		rulePreset: "yolo",
		title: "estimated",
		budgetRemaining: 1_000_000,
	});
	faux.setResponses([
		fauxAssistantMessage([fauxText("hello")]),
		// A compaction before the second request summarizes with the scripted zero-usage response.
		fauxAssistantMessage([fauxText("summary of the earlier work")]),
		fauxAssistantMessage([fauxText("after the compaction")]),
	]);
	const first = await runtime.submit(session.id, owner, "say hello", "estimated-1");
	expect((await waitSubmission(runtime, session.id, first)).status).toBe("done");
	const budgetBefore = await budgetUsedTokens(db, session.id);
	const usageBefore = await usageTokens(db, session.id);
	const contextBefore = await contextTokens(db, session.id);

	const second = await runtime.submit(session.id, owner, "keep going", "estimated-2");
	expect((await waitSubmission(runtime, session.id, second)).status).toBe("done");
	const budgetAfter = await budgetUsedTokens(db, session.id);
	const usageAfter = await usageTokens(db, session.id);
	// The estimation never charges the context fill to a compaction: only the main call after it moves it.
	expect(budgetAfter).toBeGreaterThan(budgetBefore);
	expect(usageAfter).toBeGreaterThan(usageBefore);
	expect(await contextTokens(db, session.id)).not.toBe(contextBefore);
});

it("usage accumulates up the tree, so a root shows its whole tree", async () => {
	const root = await runtime.createSession(owner, { model: model(), rulePreset: "yolo", title: "tree" });
	const child = await runtime.createSubagent(root.id, {
		callKey: "measures-child",
		task: "child work",
		rules: { default: "inherit", rules: [] },
		quota: null,
	});
	faux.setResponses([fauxAssistantMessage([fauxText("child answer")])]);
	await runtime.startSubagent(child.id, "work", "measures-child-1");
	expect(await runtime.waitSubagent(child.id)).toEqual({ status: "done", answer: "child answer" });
	const childBudget = await budgetUsedTokens(db, child.id);
	const childUsage = await usageTokens(db, child.id);
	expect(childBudget).toBeGreaterThan(0);
	expect(await budgetUsedTokens(db, root.id)).toBe(childBudget);
	expect(await usageTokens(db, root.id)).toBe(childUsage);
	// The context fill is the session's own last main call, not a subagent's.
	expect(await contextTokens(db, root.id)).toBeNull();
	expect(await contextTokens(db, child.id)).toBe(childUsage - childBudget);
});

it("backfills a session that predates token measures from durable's persisted usage at the next start", async () => {
	const dir = await mkdtemp(join(tmpdir(), "crh-usage-backfill-"));
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
			callKey: "backfill-child",
			task: "child work",
			rules: { default: "inherit", rules: [] },
			quota: null,
		});
		faux.setResponses([
			{ ...fauxAssistantMessage([fauxText("root answer")]), usage: USAGE(100, 20) },
			{ ...fauxAssistantMessage([fauxText("child answer")]), usage: USAGE(40, 10) },
		]);
		const submission = await first.submit(root.id, localOwner, "go", "backfill-1");
		expect((await waitSubmission(first, root.id, submission)).status).toBe("done");
		await first.startSubagent(child.id, "work", "backfill-child-1");
		expect(await first.waitSubagent(child.id)).toEqual({ status: "done", answer: "child answer" });
		const expectedRoot = await usageTokens(localDb, root.id);
		const expectedChild = await usageTokens(localDb, child.id);
		const budgetRoot = await budgetUsedTokens(localDb, root.id);
		expect(expectedChild).toBeGreaterThan(0);
		expect(expectedRoot).toBeGreaterThan(expectedChild);
		// Pretend the session predates the measure: the column is 0 and the backfill has not run.
		await localDb.updateTable("sessions").set({ usage_tokens: 0 }).execute();
		await localDb.deleteFrom("server_meta").where("key", "=", "session_stats_backfilled_at").execute();
		await first.close();

		// The next start reads durable's per-conversation usage and raises each session to its subtree total.
		second = await AgentRuntime.open({
			...options,
			storage: await openNodeSqliteStorage(join(dir, "durable.sqlite"), { prefix: "pi_" }),
		});
		expect(await usageTokens(localDb, root.id)).toBe(expectedRoot);
		expect(await usageTokens(localDb, child.id)).toBe(expectedChild);
		// The backfilled value is the statistics measure only; the budget counted the calls live.
		expect(await budgetUsedTokens(localDb, root.id)).toBe(budgetRoot);
	} finally {
		await second?.close().catch(() => {});
		await first.close().catch(() => {});
		await localDb.destroy();
		await rm(dir, { recursive: true, force: true });
	}
});

it("sums a conversation's persisted usage and a tree's subtree totals", () => {
	const state = {
		models: { "faux/one": USAGE(100, 20, 5, 15) },
		tools: { exec: USAGE(10, 5) },
	};
	expect(usageTokensOf(state)).toBe(155);
	expect(usageTokensOf(undefined)).toBe(0);
	expect(usageTokensOf({ models: {}, tools: {} })).toBe(0);

	const rows = [
		{ id: "root", parentSessionId: null },
		{ id: "child", parentSessionId: "root" },
		{ id: "grandchild", parentSessionId: "child" },
		{ id: "other", parentSessionId: null },
	];
	const own = new Map([
		["root", 100],
		["child", 20],
		["grandchild", 3],
	]);
	expect(subtreeUsage(rows, own)).toEqual(
		new Map([
			["root", 123],
			["child", 23],
			["grandchild", 3],
			["other", 0],
		]),
	);
});
