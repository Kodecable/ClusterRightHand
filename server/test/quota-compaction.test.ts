import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { ModelConfig } from "../src/agent/models.ts";
import { budgetUsedTokens, contextTokens, exhaustedLevel, usageTokens } from "../src/agent/quota.ts";
import { AgentRuntime } from "../src/agent/runtime.ts";
import { sessionStateOf } from "../src/agent/session-state.ts";
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
 * Context compaction is a model call too: durable's CompactionTask summarizes through `completeSimple`, and its
 * output is charged to the session like a response. The tiny context window forces a blocking compaction
 * before the second request.
 */
let db: Db;
let runtime: AgentRuntime;
let owner: SessionUser;
const faux = fauxProvider({ models: [{ id: "tiny-1", contextWindow: 64, maxTokens: 32 }] });
const model = () => ({ provider: faux.provider.id, modelId: faux.getModel().id });

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
		compaction: { reserveTokens: 8, keepRecentTokens: 1, backgroundTokens: 0 },
	});
	const user = await createUser(db, { username: "owner", kind: "member", password: "password-123" });
	owner = { sessionId: "test", userId: user.id, username: user.username, kind: "member" };
});

afterAll(async () => {
	await runtime.close();
	await db.destroy();
});

it("charges compaction's summary and pauses the next tool call when it empties the quota", async () => {
	const session = await runtime.createSession(owner, {
		model: model(),
		rulePreset: "yolo",
		title: "compacted",
		budgetRemaining: 5,
	});
	let seen = "";
	const stop = await runtime.watch(session.id, (events) => {
		seen += JSON.stringify(events);
	});
	try {
		faux.setResponses([fauxAssistantMessage([fauxText("hi")])]);
		const first = await runtime.submit(session.id, owner, "first message", "compaction-1");
		expect((await waitSubmission(runtime, session.id, first)).status).toBe("done");
		expect(await budgetUsedTokens(db, session.id)).toBe(1);
		// For a call the upstream accounted for, the context fill is exactly the usage minus the output.
		const mainContext = await contextTokens(db, session.id);
		expect(mainContext).toBeGreaterThan(0);
		expect(mainContext).toBe((await usageTokens(db, session.id)) - (await budgetUsedTokens(db, session.id)));

		// The system prompt already exceeds the tiny window, so the next run compacts the history before its request.
		faux.setResponses([
			fauxAssistantMessage([fauxText("summary text")]),
			fauxAssistantMessage([fauxToolCall("list_nodes", {}, { id: "compaction-tool" })], { stopReason: "toolUse" }),
			// The run after the grant starts with a new prepare, which compacts the grown history again.
			fauxAssistantMessage([fauxText("summary two")]),
			fauxAssistantMessage([fauxText("after the grant")]),
		]);
		const second = await runtime.submit(session.id, owner, "second message", "compaction-2");
		await waitFor("the quota wait after the compaction", async () =>
			(await sessionStateOf(db, session.id)) === "awaiting" ? true : undefined,
		);
		// A compaction ran, and its summary was charged: hi (1) + summary (3) + the tool call (4).
		expect(seen).toContain("compaction_start");
		expect(seen).toContain("compaction_end");
		expect(await budgetUsedTokens(db, session.id)).toBe(8);
		expect(await exhaustedLevel(db, session.id)).toBe(session.id);
		// The compaction's own call counts in the usage measure (input + output), while the context fill is
		// written by main-agent calls only (`chargeCompaction` never sets it).
		expect(await usageTokens(db, session.id)).toBeGreaterThan(8);

		expect(await runtime.decideRootQuota(session.id, "approve", 1_000)).toContain(session.id);
		expect(await waitSubmission(runtime, session.id, second)).toEqual({ status: "done", answer: "after the grant" });
		expect(faux.getPendingResponseCount()).toBe(0);
	} finally {
		stop();
	}
});

async function waitFor<T>(what: string, probe: () => Promise<T | undefined>, timeoutMs = 5000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await probe();
		if (value !== undefined) return value;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 25));
	}
}
