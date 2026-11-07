import type { AssistantMessage, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_TITLE_PROMPT, TITLE_PROTOCOL } from "../src/agent/model-presets.ts";
import { ModelConfig } from "../src/agent/models.ts";
import { budgetUsedTokens, contextTokens, usageTokens } from "../src/agent/quota.ts";
import { AgentRuntime } from "../src/agent/runtime.ts";
import type { SessionListItem } from "../src/agent/session-list.ts";
import { sessionStateOf } from "../src/agent/session-state.ts";
import { sanitizeTitle, TITLE_TIMEOUT_MS, titleThinking } from "../src/agent/title.ts";
import { Audit } from "../src/audit/audit.ts";
import type { SessionUser } from "../src/auth/sessions.ts";
import { Cluster } from "../src/cluster/cluster.ts";
import { TaskGroups } from "../src/cluster/task-groups.ts";
import { MasterKey } from "../src/keys/master-key.ts";
import type { Db } from "../src/storage/db.ts";
import { createUser, defaultOrgId } from "../src/users/service.ts";
import { newId } from "../src/util/id.ts";
import { openTestDb } from "./helpers/db.ts";
import { waitSubmission } from "./helpers/runtime.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/**
 * Title generation (doc/agent-runtime.md#标题生成): a root without a title gets one in the background after its
 * run ends; a manual rename wins, failures stay pending for the next run, and the call is charged like a review.
 */
const faux = fauxProvider();
const model = () => ({ provider: faux.provider.id, modelId: faux.getModel().id });

let db: Db;
let runtime: AgentRuntime;
let owner: SessionUser;

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
	owner = { sessionId: "title", userId: user.id, username: user.username, kind: "member" };
});

afterAll(async () => {
	await runtime.close();
	await db.destroy();
});

const answer = (text: string) => fauxAssistantMessage([fauxText(text)]);

async function sessionRow(id: string) {
	return db.selectFrom("sessions").select(["title", "title_pending"]).where("id", "=", id).executeTakeFirst();
}

async function waitTitle(id: string, expected: string | null, timeout = 10_000): Promise<void> {
	await vi.waitFor(
		async () => {
			expect((await sessionRow(id))?.title ?? null).toBe(expected);
		},
		{ timeout, interval: 25 },
	);
}

async function waitIdle(id: string, timeout = 10_000): Promise<void> {
	await vi.waitFor(
		async () => {
			expect(await sessionStateOf(db, id)).toBe("idle");
		},
		{ timeout, interval: 25 },
	);
}

describe("sanitizeTitle", () => {
	it("takes the first non-empty line and strips quotes, brackets and punctuation", () => {
		expect(sanitizeTitle('  \n\n  "Deploy the cluster."  \nignored')).toBe("Deploy the cluster");
		expect(sanitizeTitle("“Nightly backup”")).toBe("Nightly backup");
		expect(sanitizeTitle("[Plan the migration]")).toBe("Plan the migration");
		expect(sanitizeTitle("Check the logs!")).toBe("Check the logs");
		expect(sanitizeTitle("“Fix the firewall”.")).toBe("Fix the firewall");
		expect(sanitizeTitle("  \n \n")).toBeUndefined();
		expect(sanitizeTitle('""')).toBeUndefined();
	});

	it("cuts the title to 60 code points", () => {
		const title = sanitizeTitle("x".repeat(70));
		expect(title).toBe("x".repeat(60));
		expect(Array.from(title ?? "")).toHaveLength(60);
	});
});

describe("titleThinking", () => {
	it("uses off when the model supports it", () => {
		const plain = { reasoning: false } as unknown as Model<never>;
		expect(titleThinking(plain)).toEqual({ level: "off", maxTokens: 256 });
	});

	it("falls back to the lowest supported level when off is unsupported", () => {
		const thinkingOnly = {
			reasoning: true,
			thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium" },
		} as unknown as Model<never>;
		expect(titleThinking(thinkingOnly)).toEqual({ level: "low" as ModelThinkingLevel, maxTokens: 2048 });
	});
});

it("generates after the first run and not again after", async () => {
	faux.setResponses([]);
	const session = await runtime.createSession(owner, { model: model(), rulePreset: "yolo" });
	expect(await sessionRow(session.id)).toEqual({ title: null, title_pending: 1 });

	faux.setResponses([answer("Hello there"), answer("Deploy the cluster.")]);
	const first = await runtime.submit(session.id, owner, "Please deploy the cluster", "title-1");
	expect((await waitSubmission(runtime, session.id, first)).status).toBe("done");
	await waitTitle(session.id, "Deploy the cluster");
	expect(await sessionRow(session.id)).toEqual({ title: "Deploy the cluster", title_pending: 0 });

	// The next run sees a settled title: no second generation call is made.
	faux.setResponses([answer("Second answer"), answer("Must not be used")]);
	const second = await runtime.submit(session.id, owner, "One more thing", "title-2");
	expect((await waitSubmission(runtime, session.id, second)).status).toBe("done");
	await waitIdle(session.id);
	expect(await sessionRow(session.id)).toEqual({ title: "Deploy the cluster", title_pending: 0 });
	expect(faux.getPendingResponseCount()).toBe(1);
	faux.setResponses([]);
});

it("lets a manual rename before the run win", async () => {
	faux.setResponses([]);
	const session = await runtime.createSession(owner, { model: model(), rulePreset: "yolo" });
	await runtime.configure(session.id, { title: "Manual name" });
	expect(await sessionRow(session.id)).toEqual({ title: "Manual name", title_pending: 0 });

	faux.setResponses([answer("An answer")]);
	const submission = await runtime.submit(session.id, owner, "Do something", "title-manual-before");
	expect((await waitSubmission(runtime, session.id, submission)).status).toBe("done");
	await waitIdle(session.id);
	expect(await sessionRow(session.id)).toEqual({ title: "Manual name", title_pending: 0 });
	expect(faux.getPendingResponseCount()).toBe(0);
});

it("lets a manual rename while generating win", async () => {
	faux.setResponses([]);
	const session = await runtime.createSession(owner, { model: model(), rulePreset: "yolo" });
	let release: (() => void) | undefined;
	let started: (() => void) | undefined;
	const generationStarted = new Promise<void>((resolve) => {
		started = resolve;
	});
	faux.setResponses([
		answer("Generating an answer"),
		async () => {
			started?.();
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			return answer("Generated title");
		},
	]);
	const submission = await runtime.submit(session.id, owner, "Do something", "title-manual-during");
	expect((await waitSubmission(runtime, session.id, submission)).status).toBe("done");
	await generationStarted;
	const chargedBefore = await budgetUsedTokens(db, session.id);
	await runtime.configure(session.id, { title: "" });
	release?.();
	// The result is discarded by the conditional write; the manual blank title stays null and settled.
	await vi.waitFor(
		async () => {
			expect(await budgetUsedTokens(db, session.id)).toBeGreaterThan(chargedBefore);
		},
		{ timeout: 10_000, interval: 25 },
	);
	// Let the conditional write that follows the charge run.
	await new Promise((resolve) => setTimeout(resolve, 100));
	expect(await sessionRow(session.id)).toEqual({ title: null, title_pending: 0 });
});

it("treats a blank PATCH as no title and stops generating", async () => {
	faux.setResponses([]);
	const session = await runtime.createSession(owner, { model: model(), rulePreset: "yolo" });
	await runtime.configure(session.id, { title: "   " });
	expect(await sessionRow(session.id)).toEqual({ title: null, title_pending: 0 });

	faux.setResponses([answer("An answer")]);
	const submission = await runtime.submit(session.id, owner, "Do something", "title-blank");
	expect((await waitSubmission(runtime, session.id, submission)).status).toBe("done");
	await waitIdle(session.id);
	expect(await sessionRow(session.id)).toEqual({ title: null, title_pending: 0 });
	expect(faux.getPendingResponseCount()).toBe(0);
});

it("never generates for a child session", async () => {
	faux.setResponses([]);
	const parent = await runtime.createSession(owner, { model: model(), rulePreset: "yolo", title: "Parent" });
	const child = await runtime.createSubagent(parent.id, {
		callKey: "title-child",
		task: "Inspect the disk usage on every node",
		rules: { default: "inherit", rules: [] } as never,
		quota: null,
	});
	expect(await sessionRow(child.id)).toEqual({ title: "Inspect the disk usage on every node", title_pending: 0 });

	faux.setResponses([answer("Child answer")]);
	await runtime.startSubagent(child.id, "go", "title-child-run");
	await waitIdle(child.id);
	expect(await sessionRow(child.id)).toEqual({ title: "Inspect the disk usage on every node", title_pending: 0 });
	expect(faux.getPendingResponseCount()).toBe(0);
});

it("never generates for a scheduled run's session", async () => {
	faux.setResponses([]);
	const orgId = await defaultOrgId(db);
	const scheduleId = newId();
	const now = new Date().toISOString();
	await db
		.insertInto("schedules")
		.values({
			id: scheduleId,
			org_id: orgId,
			owner_user_id: owner.userId,
			name: "Nightly sweep",
			prompt: "Run the sweep",
			model: JSON.stringify(model()),
			token_budget: null,
			cron: "0 3 * * *",
			timezone: "UTC",
			catch_up: 0,
			enabled: 1,
			next_run_at: now,
			created_at: now,
			updated_at: now,
		})
		.execute();
	const session = await runtime.createScheduledSession(owner, {
		id: `scheduled-${newId()}`,
		title: "Nightly sweep",
		model: model(),
		budgetRemaining: null,
		scheduleId,
	});
	expect(await sessionRow(session.id)).toEqual({ title: "Nightly sweep", title_pending: 0 });

	faux.setResponses([answer("Scheduled answer")]);
	const submission = await runtime.submit(session.id, owner, "Run it", "title-scheduled");
	expect((await waitSubmission(runtime, session.id, submission)).status).toBe("done");
	await waitIdle(session.id);
	expect(await sessionRow(session.id)).toEqual({ title: "Nightly sweep", title_pending: 0 });
	expect(faux.getPendingResponseCount()).toBe(0);
});

it("keeps pending after a failed generation and retries at the next run end", async () => {
	faux.setResponses([]);
	const session = await runtime.createSession(owner, { model: model(), rulePreset: "yolo" });

	faux.setResponses([answer("First answer"), answer("")]);
	const first = await runtime.submit(session.id, owner, "First input", "title-fail-1");
	expect((await waitSubmission(runtime, session.id, first)).status).toBe("done");
	await vi.waitFor(
		async () => {
			expect(faux.getPendingResponseCount()).toBe(0);
		},
		{ timeout: 10_000, interval: 25 },
	);
	expect(await sessionRow(session.id)).toEqual({ title: null, title_pending: 1 });

	faux.setResponses([answer("Second answer"), answer("Recovered title")]);
	const second = await runtime.submit(session.id, owner, "Second input", "title-fail-2");
	expect((await waitSubmission(runtime, session.id, second)).status).toBe("done");
	await waitTitle(session.id, "Recovered title");
	expect(await sessionRow(session.id)).toEqual({ title: "Recovered title", title_pending: 0 });
});

it("cuts a hanging generation at the title limit and retries at the next run end", async () => {
	faux.setResponses([]);
	const session = await runtime.createSession(owner, { model: model(), rulePreset: "yolo" });
	const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
	const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
		expect(ms).toBe(TITLE_TIMEOUT_MS);
		return originalTimeout(20);
	});
	const errors = vi.spyOn(console, "error").mockImplementation(() => {});
	let titleOptions: { timeoutMs?: number; signal?: AbortSignal } | undefined;
	let started: (() => void) | undefined;
	const generationStarted = new Promise<void>((resolve) => {
		started = resolve;
	});
	try {
		faux.setResponses([
			answer("First answer"),
			(_context, options) => {
				titleOptions = options;
				started?.();
				return new Promise<AssistantMessage>((_resolve, reject) => {
					options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
				});
			},
		]);
		const first = await runtime.submit(session.id, owner, "First input", "title-timeout");
		expect((await waitSubmission(runtime, session.id, first)).status).toBe("done");
		await generationStarted;
		expect(titleOptions?.timeoutMs).toBe(TITLE_TIMEOUT_MS);
		expect(titleOptions?.signal).toBeInstanceOf(AbortSignal);
		await vi.waitFor(
			() => {
				expect(errors.mock.calls.some(([message]) => String(message).includes(`session ${session.id}`))).toBe(true);
			},
			{ timeout: 10_000, interval: 25 },
		);
		// The generating state was cleared and the failed attempt left the title pending.
		expect(await sessionRow(session.id)).toEqual({ title: null, title_pending: 1 });

		faux.setResponses([answer("Second answer"), answer("Recovered title")]);
		const second = await runtime.submit(session.id, owner, "Second input", "title-timeout-retry");
		expect((await waitSubmission(runtime, session.id, second)).status).toBe("done");
		await waitTitle(session.id, "Recovered title");
		expect(await sessionRow(session.id)).toEqual({ title: "Recovered title", title_pending: 0 });
	} finally {
		timeoutSpy.mockRestore();
		errors.mockRestore();
	}
});

it("does not generate while a quota level is exhausted", async () => {
	faux.setResponses([]);
	const session = await runtime.createSession(owner, {
		model: model(),
		rulePreset: "yolo",
		budgetRemaining: 1,
	});
	faux.setResponses([answer("This answer uses up the tiny budget")]);
	const callsBefore = faux.state.callCount;
	const submission = await runtime.submit(session.id, owner, "An input", "title-quota");
	expect((await waitSubmission(runtime, session.id, submission)).status).toBe("done");
	await waitIdle(session.id);
	// Let the run-end background path reach its quota check: only the main call reached the model.
	await new Promise((resolve) => setTimeout(resolve, 100));
	expect(faux.state.callCount).toBe(callsBefore + 1);
	expect(faux.getPendingResponseCount()).toBe(0);
	expect(await sessionRow(session.id)).toEqual({ title: null, title_pending: 1 });
});

it("publishes the generated title to the session list", async () => {
	faux.setResponses([]);
	const items: SessionListItem[] = [];
	const unsubscribe = runtime.sessionList.subscribe({
		user: owner,
		send: (event, data) => {
			if (event === "upsert") items.push(data as SessionListItem);
		},
		close: () => {},
	});
	try {
		const session = await runtime.createSession(owner, { model: model(), rulePreset: "yolo" });
		faux.setResponses([answer("An answer"), answer("Live title")]);
		const submission = await runtime.submit(session.id, owner, "A question", "title-live");
		expect((await waitSubmission(runtime, session.id, submission)).status).toBe("done");
		await waitTitle(session.id, "Live title");
		await vi.waitFor(
			async () => {
				expect(items.some((item) => item.id === session.id && item.title === "Live title")).toBe(true);
			},
			{ timeout: 10_000, interval: 25 },
		);
	} finally {
		unsubscribe();
	}
});

it("uses the custom title prompt and protocol and charges the call without touching the context fill", async () => {
	faux.setResponses([]);
	const custom = "Give this conversation a short name.";
	await runtime.modelPresets.update("title", { systemPrompt: custom });
	let titleRequest: unknown;
	let titleOptions: { reasoning?: string; maxTokens?: number; sessionId?: string } | undefined;
	let release: (() => void) | undefined;
	let started: (() => void) | undefined;
	const generationStarted = new Promise<void>((resolve) => {
		started = resolve;
	});
	const titleText = "Charged title";
	faux.setResponses([
		answer("The assistant's final answer"),
		async (context, options) => {
			titleRequest = context;
			titleOptions = options;
			started?.();
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			return answer(titleText);
		},
	]);
	const session = await runtime.createSession(owner, {
		model: model(),
		rulePreset: "yolo",
		budgetRemaining: 1_000_000,
	});
	const submission = await runtime.submit(session.id, owner, "The latest user input", "title-charge");
	expect((await waitSubmission(runtime, session.id, submission)).status).toBe("done");
	await generationStarted;
	const before = {
		budget: await budgetUsedTokens(db, session.id),
		usage: await usageTokens(db, session.id),
		context: await contextTokens(db, session.id),
	};
	release?.();
	await waitTitle(session.id, titleText);
	const after = {
		budget: await budgetUsedTokens(db, session.id),
		usage: await usageTokens(db, session.id),
		context: await contextTokens(db, session.id),
	};

	const request = titleRequest as { messages: { role: string; content: unknown }[] };
	// The system prompt is normalized into the transcript's system message, like every completeSimple request.
	const promptText = JSON.stringify(request.messages);
	expect(promptText).toContain(custom);
	expect(promptText).toContain(TITLE_PROTOCOL);
	expect(promptText).not.toContain(DEFAULT_TITLE_PROMPT);
	const userMessage = request.messages.filter((message) => message.role === "user").at(-1);
	expect(JSON.stringify(userMessage?.content)).toContain("The latest user input");
	expect(JSON.stringify(userMessage?.content)).toContain("The assistant's final answer");
	// The plain faux model supports only off, so the request asks for no reasoning and a small budget.
	expect(titleOptions).toMatchObject({ maxTokens: 256 });
	expect(typeof titleOptions?.sessionId).toBe("string");
	expect(titleOptions?.reasoning).toBeUndefined();
	expect(after.budget - before.budget).toBe(Math.ceil(titleText.length / 4));
	expect(after.usage).toBeGreaterThan(before.usage);
	// A title call never moves the session's context fill.
	expect(after.context).toBe(before.context);
});
