import type { EntryRecord } from "@crh/api";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxThinking,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { type AgentState, type ConversationId, MemoryStorage, type Storage } from "@earendil-works/pi-durable";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { ModelConfig } from "../src/agent/models.ts";
import { AgentRuntime } from "../src/agent/runtime.ts";
import { streamSessionId } from "../src/agent/stream-session-id.ts";
import { Audit } from "../src/audit/audit.ts";
import type { SessionUser } from "../src/auth/sessions.ts";
import { Cluster } from "../src/cluster/cluster.ts";
import { TaskGroups } from "../src/cluster/task-groups.ts";
import { MasterKey } from "../src/keys/master-key.ts";
import type { Rule, RulePreset } from "../src/policy/rules.ts";
import { appendRule, getRuleSet, setRules } from "../src/policy/store.ts";
import { createSchedule, scheduleRuleSet } from "../src/scheduler/store.ts";
import { shareSession } from "../src/sessions/sharing.ts";
import type { Db } from "../src/storage/db.ts";
import { defaultOrgId } from "../src/storage/org.ts";
import { createUser } from "../src/users/service.ts";
import { patchUserSettings } from "../src/users/settings.ts";
import { newId } from "../src/util/id.ts";
import { type App, call, login, makeApp } from "./helpers/api.ts";
import { openTestDb } from "./helpers/db.ts";
import { waitSubmission } from "./helpers/runtime.ts";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

/**
 * Forking a session at one of its final replies (doc/design/agent-runtime.md "Forking"): a new independent root
 * whose history is the source's history up to and including that reply, with fresh provider identities, a copied
 * rule set and the source's agent configuration, and none of the source's runtime state.
 */

const PASSWORD = "fork-password";
const faux = fauxProvider({ models: [{ id: "faux-fork", name: "Faux Fork", reasoning: true }] });
const model = (thinkingLevel?: "low" | "medium" | "high") => ({
	provider: faux.provider.id,
	modelId: faux.getModel().id,
	...(thinkingLevel === undefined ? {} : { thinkingLevel }),
});

let db: Db;
let app: App;
let runtime: AgentRuntime;
let storage: Storage;
let audit: Audit;
let owner: SessionUser;
let bob: SessionUser;
let aliceCookie = "";
let bobCookie = "";
let adminCookie = "";
let seq = 0;

function sessionUser(user: { id: string; username: string; kind: string }, sessionId: string): SessionUser {
	return { sessionId, userId: user.id, username: user.username, kind: user.kind as SessionUser["kind"] };
}

/** A source session whose title is settled, so no background title generation consumes a faux response. */
async function createSource(
	title: string | null,
	options: { instructions?: string; rulePreset?: RulePreset; thinkingLevel?: "low" | "medium" | "high" } = {},
): Promise<string> {
	const session = await runtime.createSession(owner, {
		title: title ?? "settled",
		model: model(options.thinkingLevel),
		rulePreset: options.rulePreset ?? "ask",
		...(options.instructions === undefined ? {} : { instructions: options.instructions }),
	});
	if (title === null) {
		// An untitled source that never generates a title: it is still a real untitled session, but the fork test
		// must not race the title generation model call.
		await db.updateTable("sessions").set({ title: null, title_pending: 0 }).where("id", "=", session.id).execute();
	}
	return session.id;
}

/** Runs one turn and returns the assistant answer's text. */
async function answer(sessionId: string, text: string, answerText: string, by: SessionUser = owner): Promise<void> {
	faux.setResponses([fauxAssistantMessage([fauxText(answerText)])]);
	const submissionId = await runtime.submit(sessionId, by, text, `fork-test-${++seq}`);
	const settled = await waitSubmission(runtime, sessionId, submissionId);
	expect(settled.status).toBe("done");
	await runtime.waitForIdle();
	await vi.waitFor(async () => expect((await runtime.getSession(sessionId))?.state).toBe("idle"));
}

async function conversationIdOf(sessionId: string): Promise<ConversationId> {
	const row = await db.selectFrom("sessions").select("conversation_id").where("id", "=", sessionId).executeTakeFirst();
	if (!row) throw new Error(`no session ${sessionId}`);
	return Number(row.conversation_id) as unknown as ConversationId;
}

/** Durable entries oldest first, including system entries: the store is the source of truth here. */
async function durableEntries(sessionId: string): Promise<EntryRecord[]> {
	return (await runtime.transcriptEntries(String(await conversationIdOf(sessionId)))) as unknown as EntryRecord[];
}

function assistantText(entry: EntryRecord): string {
	const message = entry.model?.[0];
	if (message?.role !== "assistant") return "";
	return message.content
		.flatMap((block) => {
			const text = (block as { type: string; text?: string }).text;
			return block.type === "text" && typeof text === "string" ? [text] : [];
		})
		.join("");
}

/** The entry id of the final reply whose text contains `text`. */
function replyEntryId(entries: EntryRecord[], text: string): number {
	const entry = entries.find(
		(candidate) => candidate.kind === "pi.assistant" && assistantText(candidate).includes(text),
	);
	if (entry === undefined) throw new Error(`no assistant entry containing ${text}`);
	return Number(entry.id);
}

function entryOfKind(entries: EntryRecord[], kind: string): number {
	const entry = entries.find((candidate) => candidate.kind === kind);
	if (entry === undefined) throw new Error(`no ${kind} entry`);
	return Number(entry.id);
}

async function providerSessionId(sessionId: string): Promise<string> {
	const conversationId = await conversationIdOf(sessionId);
	const record = await storage.findDocument(
		{ kind: "pi.provider", scope: { kind: "conversation", conversationId } },
		"current",
		BACKGROUND_CONTEXT,
	);
	if (record === undefined) throw new Error("no provider document");
	const document = await storage.document(record.id, "current", BACKGROUND_CONTEXT);
	const sessionIdValue = (document?.value as { sessionId?: unknown } | undefined)?.sessionId;
	if (typeof sessionIdValue !== "string") throw new Error("no provider session id");
	return sessionIdValue;
}

async function agentState(sessionId: string): Promise<AgentState> {
	const conversationId = await conversationIdOf(sessionId);
	const record = await storage.findDocument(
		{ kind: "pi.agent", scope: { kind: "conversation", conversationId } },
		"current",
		BACKGROUND_CONTEXT,
	);
	if (record === undefined) throw new Error("no agent document");
	const document = await storage.document(record.id, "current", BACKGROUND_CONTEXT);
	return (document?.value ?? {}) as AgentState;
}

interface ForkResult {
	status: number;
	session?: {
		id: string;
		title: string | null;
		forkedFrom: { sessionId: string; title: string; entryId: number } | null;
	};
}

async function fork(cookie: string, sourceId: string, entryId: number, requestId: string): Promise<ForkResult> {
	const res = await call(app, `/api/sessions/${sourceId}/fork`, {
		cookie,
		body: { entryId, requestId },
	});
	const body = (await res.json()) as { session?: ForkResult["session"]; error?: string };
	return { status: res.status, ...(body.session === undefined ? {} : { session: body.session }) };
}

async function sessionRow(id: string) {
	return db.selectFrom("sessions").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
}

async function setLocale(locale: "en" | "zh-CN" | null): Promise<void> {
	await patchUserSettings(db, owner.userId, { locale });
}

beforeAll(async () => {
	db = await openTestDb("sqlite");
	audit = new Audit(db);
	const cluster = new Cluster(db, { audit });
	const masterKey = MasterKey.generate();
	const models = new ModelConfig(db, masterKey);
	models.addProvider(faux.provider);
	await models.reload();
	storage = new MemoryStorage();
	runtime = await AgentRuntime.open({
		db,
		storage,
		models,
		cluster,
		taskGroups: new TaskGroups(db, cluster, { audit }),
		audit,
	});
	app = makeApp(db, undefined, { cluster, audit, masterKey, agent: { runtime, models } });
	const alice = await createUser(db, { username: "alice", kind: "member", password: PASSWORD });
	const bobUser = await createUser(db, { username: "bob", kind: "member", password: PASSWORD });
	await createUser(db, { username: "root", kind: "admin", password: PASSWORD });
	owner = sessionUser(alice, "alice");
	bob = sessionUser(bobUser, "bob");
	aliceCookie = await login(app, "alice", PASSWORD);
	bobCookie = await login(app, "bob", PASSWORD);
	adminCookie = await login(app, "root", PASSWORD);
});

afterAll(async () => {
	await runtime.waitForIdle();
	await runtime.close();
	await db.destroy();
});

it("creates a new root session with the fork origin and every runtime counter reset", async () => {
	await setLocale("en");
	const sourceId = await createSource("Deploy plan");
	await answer(sourceId, "first", "deployable");
	const sourceEntries = await durableEntries(sourceId);
	const entryId = replyEntryId(sourceEntries, "deployable");

	// Give the source the runtime state a fork must not inherit. It stays idle so the turn counts as ended.
	const now = new Date().toISOString();
	await db
		.updateTable("sessions")
		.set({
			quota_tokens: 123,
			budget_used_tokens: 456,
			usage_tokens: 789,
			context_tokens: 321,
			stat_turns: 4,
			stat_steps: 5,
			stat_ttft_ms: 6,
			stat_ttft_steps: 7,
			stat_decode_ms: 8,
			stat_decode_tokens: 9,
			prompt_tokens: 10,
			cache_read_tokens: 11,
			last_submission_id: "submission-source",
			counted_submission_id: "counted-source",
			last_used_from: "web",
			reply_at: now,
			owner_read_at: now,
			archived_at: now,
			waiting_kind: "approval",
			waiting_level_id: sourceId,
			waiting_handler_id: owner.userId,
			state_changed_at: now,
		})
		.where("id", "=", sourceId)
		.execute();

	const requestId = "fork-row";
	const result = await fork(aliceCookie, sourceId, entryId, requestId);
	expect(result.status).toBe(201);
	const forkId = result.session?.id;
	if (forkId === undefined) throw new Error("no session in the fork response");

	const source = await sessionRow(sourceId);
	const row = await sessionRow(forkId);
	expect(row).toMatchObject({
		id: forkId,
		org_id: source.org_id,
		owner_user_id: owner.userId,
		parent_session_id: null,
		forked_from_session_id: sourceId,
		root_session_id: forkId,
		schedule_id: null,
		title: "Deploy plan (fork)",
		title_pending: 0,
		create_request_id: requestId,
		status: "active",
		archived_at: null,
		last_submission_id: null,
		state: "idle",
		waiting_kind: null,
		waiting_level_id: null,
		waiting_handler_id: null,
		reply_at: null,
		owner_read_at: null,
		last_used_from: null,
		quota_tokens: null,
		budget_used_tokens: 0,
		usage_tokens: 0,
		context_tokens: null,
		stat_turns: 0,
		stat_steps: 0,
		stat_ttft_ms: 0,
		stat_ttft_steps: 0,
		stat_decode_ms: 0,
		stat_decode_tokens: 0,
		counted_submission_id: null,
		prompt_tokens: 0,
		cache_read_tokens: 0,
	});
	expect(row.conversation_id).not.toBe(source.conversation_id);
	expect(Number(row.forked_from_entry_id)).toBe(entryId);
	expect(row.state_changed_at).not.toBeNull();
	// The response resolves the source title for display.
	expect(result.session?.forkedFrom).toEqual({ sessionId: sourceId, title: "Deploy plan", entryId });
});

it("titles a fork with the owner's language: en, zh-CN and both untitled cases", async () => {
	const cases: {
		locale: "en" | "zh-CN";
		sourceTitle: string | null;
		expected: string;
	}[] = [
		{ locale: "en", sourceTitle: "Plan", expected: "Plan (fork)" },
		{ locale: "en", sourceTitle: null, expected: "New session (fork)" },
		{ locale: "zh-CN", sourceTitle: "部署计划", expected: "部署计划（分叉）" },
		{ locale: "zh-CN", sourceTitle: null, expected: "新会话（分叉）" },
	];
	for (const [index, testCase] of cases.entries()) {
		await setLocale(testCase.locale);
		const sourceId = await createSource(testCase.sourceTitle);
		await answer(sourceId, "title turn", `title answer ${index}`);
		const entryId = replyEntryId(await durableEntries(sourceId), `title answer ${index}`);
		const result = await fork(aliceCookie, sourceId, entryId, `fork-title-${index}`);
		expect(result.status).toBe(201);
		expect(result.session?.title).toBe(testCase.expected);
		expect((await sessionRow(result.session?.id ?? "")).title).toBe(testCase.expected);
		if (testCase.sourceTitle === null) {
			// An untitled source is displayed with the same fallback the WebUI uses.
			expect(result.session?.forkedFrom?.title).toBe(testCase.locale === "zh-CN" ? "新会话" : "New session");
		}
	}
	await setLocale(null);
});

it("forks the history up to and including the reply, and the two sessions never see each other's later turns", async () => {
	await setLocale("en");
	const sourceId = await createSource("History");
	await answer(sourceId, "first question", "first answer");
	await answer(sourceId, "second question", "second answer");
	const sourceEntries = await durableEntries(sourceId);
	const firstReply = replyEntryId(sourceEntries, "first answer");
	const firstReplyIndex = sourceEntries.findIndex((entry) => Number(entry.id) === firstReply);
	expect(firstReplyIndex).toBeGreaterThan(0);

	const result = await fork(aliceCookie, sourceId, firstReply, "fork-history");
	expect(result.status).toBe(201);
	const forkId = result.session?.id ?? "";
	expect((await durableEntries(forkId)).map((entry) => entry.id)).toEqual(
		sourceEntries.slice(0, firstReplyIndex + 1).map((entry) => entry.id),
	);

	// A later source turn is invisible to the fork, and the fork's own turn is invisible to the source.
	const sourceIdsBefore = new Set((await durableEntries(sourceId)).map((entry) => Number(entry.id)));
	await answer(sourceId, "third question", "third answer");
	const sourceAfter = await durableEntries(sourceId);
	const forkBefore = await durableEntries(forkId);
	const forkIdsBefore = new Set(forkBefore.map((entry) => Number(entry.id)));
	const newSourceIds = sourceAfter.map((entry) => Number(entry.id)).filter((id) => !sourceIdsBefore.has(id));
	expect(newSourceIds.length).toBeGreaterThan(0);
	expect(newSourceIds.some((id) => forkIdsBefore.has(id))).toBe(false);
	expect(forkBefore.some((entry) => assistantText(entry).includes("third answer"))).toBe(false);

	let seen: string[] = [];
	faux.setResponses([
		(context) => {
			seen = context.messages.map((message) => JSON.stringify(message));
			return fauxAssistantMessage([fauxText("fork answer")]);
		},
	]);
	const submissionId = await runtime.submit(forkId, owner, "branch question", `fork-branch-${++seq}`);
	expect((await waitSubmission(runtime, forkId, submissionId)).status).toBe("done");
	const forkAfter = await durableEntries(forkId);
	const sourceIdsAfterFork = new Set((await durableEntries(sourceId)).map((entry) => Number(entry.id)));
	const forkOnly = forkAfter.map((entry) => Number(entry.id)).filter((id) => !forkIdsBefore.has(id));
	expect(forkOnly.length).toBeGreaterThan(0);
	expect(forkOnly.some((id) => sourceIdsAfterFork.has(id))).toBe(false);

	// The fork's next request carries the inherited history and not the source's later turns.
	const contextText = seen.join("\n");
	expect(contextText).toContain("first question");
	expect(contextText).toContain("first answer");
	expect(contextText).toContain("branch question");
	expect(contextText).not.toContain("second answer");
	expect(contextText).not.toContain("third answer");
});

it("gives the fork fresh main, review, title and compaction provider session ids", async () => {
	await setLocale("en");
	const sourceId = await createSource("Streams");
	await answer(sourceId, "streams", "streams answer");
	const sourceEntries = await durableEntries(sourceId);
	const entryId = replyEntryId(sourceEntries, "streams answer");
	const result = await fork(aliceCookie, sourceId, entryId, "fork-streams");
	const forkId = result.session?.id ?? "";

	const main = { source: await providerSessionId(sourceId), fork: await providerSessionId(forkId) };
	expect(main.fork).not.toBe(main.source);
	// `pi.provider` forks as initial, so the fork starts a new durable provider identity.
	for (const id of [main.source, main.fork]) expect(id).toMatch(/^[0-9a-f-]{36}$/);

	const purposes = ["review", "title", "compaction"] as const;
	const sourceDerived = purposes.map((purpose) => streamSessionId(sourceId, purpose));
	const forkDerived = purposes.map((purpose) => streamSessionId(forkId, purpose));
	expect(new Set([main.source, ...sourceDerived, main.fork, ...forkDerived]).size).toBe(8);
	expect(forkDerived).not.toEqual(sourceDerived);
	// A compaction whose conversation is not mapped yet derives from the durable provider session id, which is fresh.
	expect(streamSessionId(main.fork, "compaction")).not.toBe(streamSessionId(main.source, "compaction"));
});

it("copies the source root's preset and custom rules, and later edits are independent both ways", async () => {
	await setLocale("en");
	const sourceId = await createSource("Rules", { rulePreset: "ask" });
	const sourceRule: Rule = { action: "allow", method: "exec", prefix: "uptime" };
	await setRules(db, { type: "session", id: sourceId }, [sourceRule]);
	await answer(sourceId, "rules", "rules answer");
	const entryId = replyEntryId(await durableEntries(sourceId), "rules answer");

	const result = await fork(aliceCookie, sourceId, entryId, "fork-rules");
	const forkId = result.session?.id ?? "";
	const sourceRules = await getRuleSet(db, { type: "session", id: sourceId });
	const forkRules = await getRuleSet(db, { type: "session", id: forkId });
	expect(forkRules).toBeDefined();
	expect(forkRules?.rulePreset).toBe("ask");
	expect(forkRules?.rules).toEqual(sourceRules?.rules);
	expect(forkRules?.default).toBe(sourceRules?.default);
	expect(forkRules?.scope).toEqual({ type: "session", id: forkId });
	expect(forkRules?.updatedAt).toBeDefined();

	// Editing the source leaves the fork alone.
	const forkRule: Rule = { action: "deny", method: "exec", prefix: "rm " };
	await setRules(db, { type: "session", id: sourceId }, [sourceRule, forkRule]);
	expect((await getRuleSet(db, { type: "session", id: forkId }))?.rules).toEqual([sourceRule]);

	// Editing the fork leaves the source alone.
	const newForkRule: Rule = { action: "allow", method: "file.read" };
	await setRules(db, { type: "session", id: forkId }, [newForkRule]);
	expect((await getRuleSet(db, { type: "session", id: sourceId }))?.rules).toEqual([sourceRule, forkRule]);
});

it("copies a scheduled run session's own root rules, including rules added during the run", async () => {
	await setLocale("en");
	const schedule = await createSchedule(db, owner.userId, {
		name: "Scheduled fork source",
		prompt: "Check everything",
		model: model(),
		rulePreset: "yolo",
		tokenBudget: null,
		cron: "0 3 * * *",
		timezone: "UTC",
		catchUp: false,
		enabled: true,
	});
	// The schedule's template holds a custom rule the run session copies at creation.
	const templateRule: Rule = { action: "deny", method: "exec", exact: "rm -rf /" };
	await setRules(db, { type: "schedule", id: schedule.id }, [templateRule]);
	const template = await scheduleRuleSet(db, schedule.id);
	const session = await runtime.createScheduledSession(owner, {
		id: `scheduled-fork-${newId()}`,
		title: "Scheduled fork source",
		model: model(),
		budgetRemaining: null,
		scheduleId: schedule.id,
		rulePreset: template?.rulePreset ?? "yolo",
		rules: template?.rules ?? [],
	});
	faux.setResponses([fauxAssistantMessage([fauxText("scheduled answer")])]);
	const submissionId = await runtime.submitAsSchedule(
		session.id,
		schedule.id,
		schedule.prompt,
		`scheduled-fork-${++seq}`,
	);
	expect((await waitSubmission(runtime, session.id, submissionId)).status).toBe("done");
	await runtime.waitForIdle();
	await vi.waitFor(async () => expect((await runtime.getSession(session.id))?.state).toBe("idle"));

	// A rule the run added for itself is part of the copy too.
	const runRule: Rule = { action: "allow", method: "exec", exact: "echo during run" };
	await appendRule(db, { type: "session", id: session.id }, runRule);
	expect((await getRuleSet(db, { type: "session", id: session.id }))?.rulePreset).toBe("yolo");

	const entryId = replyEntryId(await durableEntries(session.id), "scheduled answer");
	const result = await fork(aliceCookie, session.id, entryId, "fork-scheduled");
	expect(result.status).toBe(201);
	const forkRules = await getRuleSet(db, { type: "session", id: result.session?.id ?? "" });
	expect(forkRules).toMatchObject({ rulePreset: "yolo", rules: [templateRule, runRule] });
	expect((await sessionRow(result.session?.id ?? "")).schedule_id).toBeNull();
});

it("copies the current model, thinking level, enabled extensions and instructions", async () => {
	await setLocale("en");
	const sourceId = await createSource("Agent config", {
		instructions: "Always answer in one line.",
		thinkingLevel: "high",
		rulePreset: "yolo",
	});
	// Turn one extension off in the source's conversation and row.
	await runtime.configure(sourceId, { disabledExtensions: ["crhs-docs"] });
	await answer(sourceId, "config", "config answer");
	const entryId = replyEntryId(await durableEntries(sourceId), "config answer");

	const result = await fork(aliceCookie, sourceId, entryId, "fork-config");
	expect(result.status).toBe(201);
	const forkId = result.session?.id ?? "";
	const forkRow = await sessionRow(forkId);
	expect(JSON.parse(forkRow.disabled_extensions ?? "[]")).toEqual(["crhs-docs"]);

	const state = await agentState(forkId);
	expect(state.model).toEqual({ provider: faux.provider.id, modelId: faux.getModel().id });
	expect(state.thinkingLevel).toBe("high");
	expect(state.instructions).toBe("Always answer in one line.");
	const extensions = state.extensions as string[];
	expect(extensions).toEqual(expect.arrayContaining(["crh", "ext:crhs-api"]));
	expect(extensions).not.toContain("ext:crhs-docs");
});

it("does not copy shares, waiting work, external calls or subagents", async () => {
	await setLocale("en");
	const sourceId = await createSource("Not inherited");
	await answer(sourceId, "work", "work answer");
	const entryId = replyEntryId(await durableEntries(sourceId), "work answer");
	await shareSession(db, {
		sessionId: sourceId,
		granteeType: "user",
		granteeId: bob.userId,
		access: "view",
		createdBy: owner.userId,
	});

	const orgId = await defaultOrgId(db);
	const now = new Date().toISOString();
	const taskId = newId();
	await db
		.insertInto("tasks")
		.values({
			id: taskId,
			org_id: orgId,
			node_id: newId(),
			task_group_id: null,
			kind: "exec",
			spec: JSON.stringify({ kind: "exec", command: { argv: ["true"] }, env: {}, cwd: "", stdin: null }),
			input_size: null,
			input_sha256: null,
			privileged: 0,
			attempt: 1,
			timeout_ms: null,
			output_mode: "full",
			state: "awaiting_approval",
			exit_code: null,
			signal: null,
			timed_out: 0,
			error_code: null,
			error_message: null,
			actor_type: "session",
			actor_id: sourceId,
			on_behalf_of_user_id: owner.userId,
			created_at: now,
			dispatched_at: null,
			accepted_at: null,
			finished_at: null,
			output_bytes: 0,
			output_head: null,
			output_tail: null,
			notice: null,
			output_file: null,
			result: null,
			late_result: null,
			rule_chain: null,
			approval: null,
			pending_input: null,
			root_session_id: sourceId,
			handler_type: "user",
			handler_session_id: null,
		})
		.execute();
	await db
		.insertInto("task_groups")
		.values({
			id: newId(),
			org_id: orgId,
			targets: JSON.stringify([{ kind: "node", id: newId() }]),
			node_ids: JSON.stringify([newId()]),
			kind: "exec",
			parallel: 1,
			fail_fast: 0,
			output_mode: "head",
			node_max_lines: null,
			node_max_bytes: null,
			privileged: 0,
			skipped: "[]",
			state: "awaiting_approval",
			actor_type: "session",
			actor_id: sourceId,
			on_behalf_of_user_id: owner.userId,
			created_at: now,
			finished_at: null,
			spec: null,
			timeout_ms: null,
			purpose: null,
			source_call_id: null,
			transfer: null,
			rule_chain: null,
			approval: null,
			pending_input: null,
			root_session_id: sourceId,
			handler_type: "user",
			handler_session_id: null,
		})
		.execute();
	await db
		.insertInto("external_calls")
		.values({
			id: newId(),
			org_id: orgId,
			actor_type: "session",
			actor_id: sourceId,
			on_behalf_of_user_id: owner.userId,
			extension_name: "fake",
			tool_name: "do",
			arguments: "{}",
			operation: JSON.stringify({ method: "ext.write", target: "fake/do" }),
			annotations: null,
			source_call_id: null,
			state: "awaiting_approval",
			created_at: now,
			finished_at: null,
			rule_chain: null,
			approval: null,
			pending_input: null,
			root_session_id: sourceId,
			handler_type: "user",
			handler_session_id: null,
		})
		.execute();

	const result = await fork(aliceCookie, sourceId, entryId, "fork-not-inherited");
	const forkId = result.session?.id ?? "";
	expect((await sessionRow(forkId)).parent_session_id).toBeNull();
	expect(await db.selectFrom("shares").select("id").where("resource_id", "=", forkId).execute()).toEqual([]);
	expect(await db.selectFrom("tasks").select("id").where("actor_id", "=", forkId).execute()).toEqual([]);
	expect(await db.selectFrom("task_groups").select("id").where("actor_id", "=", forkId).execute()).toEqual([]);
	expect(await db.selectFrom("external_calls").select("id").where("actor_id", "=", forkId).execute()).toEqual([]);
	expect(await db.selectFrom("sessions").select("id").where("parent_session_id", "=", forkId).execute()).toEqual([]);
	// The source keeps its work; the fork is a separate root.
	expect(await db.selectFrom("tasks").select("id").where("actor_id", "=", sourceId).execute()).toHaveLength(1);
	// Bob sees the shared source but not the unshared fork.
	expect((await call(app, `/api/sessions/${forkId}`, { cookie: bobCookie })).status).toBe(404);
});

it("refuses every non-owner, including share viewers and administrators", async () => {
	await setLocale("en");
	const sourceId = await createSource("Ownership");
	await answer(sourceId, "owner only", "owner answer");
	const entryId = replyEntryId(await durableEntries(sourceId), "owner answer");

	// Nobody but the owner can see it yet: 404 like a missing session.
	expect((await fork(bobCookie, sourceId, entryId, "fork-bob")).status).toBe(404);
	// An administrator may see it but not act in it.
	expect((await fork(adminCookie, sourceId, entryId, "fork-admin")).status).toBe(403);
	await shareSession(db, {
		sessionId: sourceId,
		granteeType: "user",
		granteeId: bob.userId,
		access: "chat",
		createdBy: owner.userId,
	});
	expect((await fork(bobCookie, sourceId, entryId, "fork-shared")).status).toBe(403);
	// The owner still can.
	expect((await fork(aliceCookie, sourceId, entryId, "fork-owner")).status).toBe(201);
});

it("refuses process entries, thinking, tool results, user entries and unknown or foreign entry ids", async () => {
	await setLocale("en");
	// A turn with an intermediate message that carries text and a tool call, then its result and a final answer.
	const sourceId = await createSource("Kinds", { rulePreset: "yolo" });
	faux.setResponses([
		fauxAssistantMessage([fauxThinking("working"), fauxText("working"), fauxToolCall("list_nodes", {})], {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage([fauxText("kinds answer")]),
	]);
	const submissionId = await runtime.submit(sourceId, owner, "kinds", `fork-kinds-${++seq}`);
	expect((await waitSubmission(runtime, sourceId, submissionId)).status).toBe("done");
	await runtime.waitForIdle();
	await vi.waitFor(async () => expect((await runtime.getSession(sourceId))?.state).toBe("idle"));
	const entries = await durableEntries(sourceId);
	const processId = entries.find(
		(entry) =>
			entry.kind === "pi.assistant" &&
			(entry.model?.[0] as { content?: { type: string }[] } | undefined)?.content?.some(
				(block) => block.type === "toolCall",
			),
	)?.id;
	expect(processId).toBeDefined();
	const toolResultId = entryOfKind(entries, "pi.tool-result");
	const userEntryId = entryOfKind(entries, "pi.user");
	const finalId = replyEntryId(entries, "kinds answer");

	for (const [entryId, label] of [
		[Number(processId), "process text"],
		[toolResultId, "tool result"],
		[userEntryId, "user entry"],
		[9_999_999_999, "unknown id"],
	] as const) {
		const result = await fork(aliceCookie, sourceId, entryId, `fork-bad-${label}`);
		expect(result.status, label).toBe(400);
	}

	// A thinking-only message ends its turn but has no answer text: not a final reply.
	const thinkingId = await createSource("Thinking only");
	faux.setResponses([fauxAssistantMessage([fauxThinking("just a thought")])]);
	const thoughtSubmission = await runtime.submit(thinkingId, owner, "think", `fork-think-${++seq}`);
	expect((await waitSubmission(runtime, thinkingId, thoughtSubmission)).status).toBe("done");
	await runtime.waitForIdle();
	await vi.waitFor(async () => expect((await runtime.getSession(thinkingId))?.state).toBe("idle"));
	const thoughtEntry = (await durableEntries(thinkingId)).find(
		(entry) =>
			entry.kind === "pi.assistant" &&
			(entry.model?.[0] as { content?: { type: string }[] } | undefined)?.content?.some(
				(block) => block.type === "thinking",
			),
	);
	expect(thoughtEntry).toBeDefined();
	expect((await fork(aliceCookie, thinkingId, Number(thoughtEntry?.id), "fork-thinking")).status).toBe(400);

	// Another session's entry is not visible from this conversation.
	const otherId = await createSource("Other");
	await answer(otherId, "other", "other answer");
	const otherEntry = replyEntryId(await durableEntries(otherId), "other answer");
	expect((await fork(aliceCookie, sourceId, otherEntry, "fork-foreign")).status).toBe(400);

	// The actual final reply still works.
	expect((await fork(aliceCookie, sourceId, finalId, "fork-kinds-good")).status).toBe(201);
});

it("refuses a final reply of a running turn, but allows an earlier ended turn", async () => {
	await setLocale("en");
	const sourceId = await createSource("Running");
	await answer(sourceId, "one", "answer one");
	await answer(sourceId, "two", "answer two");
	const entries = await durableEntries(sourceId);
	const firstReply = replyEntryId(entries, "answer one");
	const secondReply = replyEntryId(entries, "answer two");

	// The session's stored state says it is still working; the last turn therefore has not ended.
	await db.updateTable("sessions").set({ state: "running" }).where("id", "=", sourceId).execute();
	expect((await fork(aliceCookie, sourceId, secondReply, "fork-running-last")).status).toBe(400);
	// A later user turn exists after the first reply, so that turn had ended even while the session runs.
	expect((await fork(aliceCookie, sourceId, firstReply, "fork-running-earlier")).status).toBe(201);
	await db.updateTable("sessions").set({ state: "idle" }).where("id", "=", sourceId).execute();
});

it("forks a fork from its direct source", async () => {
	await setLocale("en");
	const sourceId = await createSource("First source");
	await answer(sourceId, "one", "answer one");
	const firstReply = replyEntryId(await durableEntries(sourceId), "answer one");
	const firstFork = await fork(aliceCookie, sourceId, firstReply, "fork-first");
	const firstForkId = firstFork.session?.id ?? "";
	await answer(firstForkId, "branch", "branch answer");
	const branchReply = replyEntryId(await durableEntries(firstForkId), "branch answer");
	const secondFork = await fork(aliceCookie, firstForkId, branchReply, "fork-second");
	expect(secondFork.status).toBe(201);
	const secondForkId = secondFork.session?.id ?? "";
	const row = await sessionRow(secondForkId);
	expect(row).toMatchObject({
		parent_session_id: null,
		forked_from_session_id: firstForkId,
		root_session_id: secondForkId,
		title: "First source (fork)",
	});
	expect(Number(row.forked_from_entry_id)).toBe(branchReply);
	// The fork of a fork still carries the source's inherited history plus the first fork's own turn.
	const ids = (await durableEntries(secondForkId)).map((entry) => Number(entry.id));
	expect(ids).toContain(firstReply);
	expect(ids).toContain(branchReply);
});

it("returns the same fork for a repeated requestId, sequentially and concurrently", async () => {
	await setLocale("en");
	const sourceId = await createSource("Idempotent");
	await answer(sourceId, "idempotent", "idempotent answer");
	const entryId = replyEntryId(await durableEntries(sourceId), "idempotent answer");

	const first = await fork(aliceCookie, sourceId, entryId, "fork-idempotent");
	const second = await fork(aliceCookie, sourceId, entryId, "fork-idempotent");
	expect(first.status).toBe(201);
	expect(second.status).toBe(200);
	expect(second.session?.id).toBe(first.session?.id);
	expect(
		await db.selectFrom("sessions").select("id").where("create_request_id", "=", "fork-idempotent").execute(),
	).toHaveLength(1);

	const [left, right] = await Promise.all([
		fork(aliceCookie, sourceId, entryId, "fork-concurrent"),
		fork(aliceCookie, sourceId, entryId, "fork-concurrent"),
	]);
	expect([left.status, right.status].sort()).toEqual([200, 201]);
	expect(left.session?.id).toBe(right.session?.id);
	expect(
		await db.selectFrom("sessions").select("id").where("create_request_id", "=", "fork-concurrent").execute(),
	).toHaveLength(1);
});

it("records session.forked and resolves forkedFrom only while the source is visible", async () => {
	await setLocale("en");
	const sourceId = await createSource("Audited");
	await answer(sourceId, "audit", "audit answer");
	const entryId = replyEntryId(await durableEntries(sourceId), "audit answer");
	const result = await fork(aliceCookie, sourceId, entryId, "fork-audit");
	const forkId = result.session?.id ?? "";
	await audit.flush();

	const event = await db
		.selectFrom("audit_events")
		.selectAll()
		.where("action", "=", "session.forked")
		.where("target_id", "=", forkId)
		.executeTakeFirst();
	expect(event).toBeDefined();
	expect(JSON.parse(event?.detail ?? "{}")).toEqual({
		source_session_id: sourceId,
		entry_id: entryId,
		session_id: forkId,
	});

	// Share the fork without the source: the caller sees the fork but not where it came from.
	await shareSession(db, {
		sessionId: forkId,
		granteeType: "user",
		granteeId: bob.userId,
		access: "view",
		createdBy: owner.userId,
	});
	const bobView = (await (await call(app, `/api/sessions/${forkId}`, { cookie: bobCookie })).json()) as {
		session: { forkedFrom: unknown };
	};
	expect(bobView.session.forkedFrom).toBeNull();

	// Removing the source leaves the fork without an origin rather than a dangling one.
	await db.deleteFrom("sessions").where("id", "=", sourceId).execute();
	const ownerView = (await (await call(app, `/api/sessions/${forkId}`, { cookie: aliceCookie })).json()) as {
		session: { forkedFrom: unknown };
	};
	expect(ownerView.session.forkedFrom).toBeNull();
});

it("validates the request body and repeats a fork after a deleted source", async () => {
	await setLocale("en");
	const sourceId = await createSource("Validate body");
	await answer(sourceId, "validate", "validate answer");
	const entryId = replyEntryId(await durableEntries(sourceId), "validate answer");

	for (const body of [
		{ entryId, requestId: "" },
		{ entryId, requestId: "   " },
		{ entryId, requestId: "x".repeat(129) },
		{ entryId: 1.5, requestId: "fork-float" },
		{ entryId: "1", requestId: "fork-string" },
	]) {
		expect((await call(app, `/api/sessions/${sourceId}/fork`, { cookie: aliceCookie, body })).status).toBe(400);
	}
	expect(
		(
			await call(app, "/api/sessions/does-not-exist/fork", {
				cookie: aliceCookie,
				body: { entryId, requestId: "fork-missing" },
			})
		).status,
	).toBe(404);

	const created = await fork(aliceCookie, sourceId, entryId, "fork-before-delete");
	expect(created.status).toBe(201);
	await db.deleteFrom("sessions").where("id", "=", sourceId).execute();
	// The idempotent retry still finds the fork even though the source is gone.
	const retry = await fork(aliceCookie, sourceId, entryId, "fork-before-delete");
	expect(retry.status).toBe(200);
	expect(retry.session?.id).toBe(created.session?.id);
});
