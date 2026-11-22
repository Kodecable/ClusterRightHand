import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { ModelConfig } from "../src/agent/models.ts";
import { AgentRuntime } from "../src/agent/runtime.ts";
import { Audit } from "../src/audit/audit.ts";
import type { SessionUser } from "../src/auth/sessions.ts";
import { Cluster } from "../src/cluster/cluster.ts";
import { TaskGroups } from "../src/cluster/task-groups.ts";
import { CallRunner } from "../src/extensions/call-runner.ts";
import { MasterKey } from "../src/keys/master-key.ts";
import { shareSession } from "../src/sessions/sharing.ts";
import type { Db } from "../src/storage/db.ts";
import { createUser } from "../src/users/service.ts";
import { type App, call, login, makeApp } from "./helpers/api.ts";
import { openTestDb } from "./helpers/db.ts";
import { toolNames, waitSubmission } from "./helpers/runtime.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/**
 * The todo list across the runtime (doc/design/todo.md): root-only availability, the session and share views,
 * forking, and the block a compaction freezes onto its summary.
 */
let db: Db;
let app: App;
let runtime: AgentRuntime;
let storage: MemoryStorage;
let owner: SessionUser;
let ownerCookie = "";
let viewerCookie = "";
let viewerId = "";
let seq = 0;
// A large window keeps automatic compaction away; the tiny keepRecentTokens lets a manual one cut a short history.
const faux = fauxProvider({ models: [{ id: "normal-1", contextWindow: 100_000 }] });
const model = () => ({ provider: faux.provider.id, modelId: faux.getModel().id });

/** A tool call followed by the final answer; the tool runs between them. */
async function writeTodos(sessionId: string, todos: { content: string; status: string }[]): Promise<void> {
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("todo_write", { todos }, { id: `todo-${++seq}` })], {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage([fauxText("list updated")]),
	]);
	const submission = await runtime.submit(sessionId, owner, "plan this", `todo-write-${++seq}`);
	expect((await waitSubmission(runtime, sessionId, submission)).status).toBe("done");
}

/** A plain turn and the model messages its request carried. */
async function captureRequest(sessionId: string, text = "next"): Promise<readonly unknown[]> {
	let captured: readonly unknown[] = [];
	faux.setResponses([
		(context) => {
			captured = context.messages;
			return fauxAssistantMessage([fauxText("ok")]);
		},
	]);
	const submission = await runtime.submit(sessionId, owner, text, `capture-${++seq}`);
	expect((await waitSubmission(runtime, sessionId, submission)).status).toBe("done");
	return captured;
}

const SUMMARY_PREFIX =
	"The conversation history before this point was compacted into the following summary:\n\n<summary>\n";

/** The compaction summary message text in one request, if the request has one. */
function summaryTextOf(messages: readonly unknown[]): string | undefined {
	for (const message of messages) {
		const record = message as { role?: string; content?: unknown };
		if (record.role !== "user") continue;
		const content = record.content;
		const text =
			typeof content === "string"
				? content
				: Array.isArray(content)
					? content
							.flatMap((block) =>
								typeof block === "object" && block !== null && "text" in block
									? [(block as { text?: unknown }).text]
									: [],
							)
							.filter((part): part is string => typeof part === "string")
							.join("")
					: "";
		if (text.startsWith(SUMMARY_PREFIX)) return text;
	}
	return undefined;
}

/** Runs a manual compaction and waits for its summary entry. */
async function compact(sessionId: string, summary = "the summary"): Promise<void> {
	faux.setResponses([fauxAssistantMessage([fauxText(summary)])]);
	const result = await runtime.compact(sessionId, owner, undefined);
	expect(result.outcome).toBe("started");
	await vi.waitFor(
		async () => {
			const { entries } = await runtime.entriesPage(sessionId, undefined, 100);
			expect(entries.some((entry) => entry.kind === "pi.compaction")).toBe(true);
		},
		{ timeout: 15_000, interval: 50 },
	);
}

async function newSession(title: string): Promise<string> {
	const session = await runtime.createSession(owner, { title, model: model(), rulePreset: "yolo" });
	return session.id;
}

beforeAll(async () => {
	db = await openTestDb("sqlite");
	const audit = new Audit(db);
	const cluster = new Cluster(db, { audit });
	const masterKey = MasterKey.generate();
	const models = new ModelConfig(db, masterKey);
	models.addProvider(faux.provider);
	await models.reload();
	storage = new MemoryStorage();
	runtime = await AgentRuntime.open({
		callRunner: new CallRunner(),
		db,
		storage,
		models,
		cluster,
		taskGroups: new TaskGroups(db, cluster, { audit }),
		audit,
		// A manual compaction is the only one this suite needs; keep it cheap.
		compaction: { keepRecentTokens: 1, backgroundTokens: 0 },
	});
	app = makeApp(db, undefined, { cluster, audit, masterKey, agent: { runtime, models } });
	const user = await createUser(db, { username: "todo-owner", kind: "member", password: "password-123" });
	const viewer = await createUser(db, { username: "todo-viewer", kind: "member", password: "password-123" });
	viewerId = viewer.id;
	owner = { sessionId: "test-todo-owner", userId: user.id, username: user.username, kind: user.kind };
	ownerCookie = await login(app, "todo-owner", "password-123");
	viewerCookie = await login(app, "todo-viewer", "password-123");
});

afterAll(async () => {
	await runtime.close();
	await db.destroy();
});

it("offers the tool to a root session and not to a subagent", async () => {
	const root = await newSession("root tools");
	expect(await toolNames(storage, db, root)).toContain("todo_write");
	const child = await runtime.createSubagent(root, {
		callKey: "todo-gate-1",
		task: "one delegated task",
		rules: { default: "inherit", rules: [] },
		quota: null,
	});
	expect(await toolNames(storage, db, child.id)).not.toContain("todo_write");
});

it("stores the list and the session view carries it for the owner and a share viewer", async () => {
	const sessionId = await newSession("todo view");
	await writeTodos(sessionId, [
		{ content: "Back up the config", status: "completed" },
		{ content: "Roll out the new config", status: "in_progress" },
	]);
	await shareSession(db, {
		sessionId,
		granteeType: "user",
		granteeId: viewerId,
		access: "view",
		createdBy: owner.userId,
	});
	const expected = [
		{ content: "Back up the config", status: "completed" },
		{ content: "Roll out the new config", status: "in_progress" },
	];
	for (const cookie of [ownerCookie, viewerCookie]) {
		const res = await call(app, `/api/sessions/${sessionId}`, { cookie });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { session: { todos: unknown } };
		expect(body.session.todos).toEqual(expected);
	}
});

it("a fork copies the list", async () => {
	const sessionId = await newSession("todo fork");
	await writeTodos(sessionId, [{ content: "Roll out the new config", status: "in_progress" }]);
	const { entries } = await runtime.entriesPage(sessionId, undefined, 100);
	const reply = [...entries].reverse().find((entry) => entry.kind === "pi.assistant");
	expect(reply).toBeDefined();
	const forked = await runtime.forkSession(owner, sessionId, {
		entryId: Number(reply?.id),
		requestId: "todo-fork-1",
	});
	expect(forked.session.todos).toEqual([{ content: "Roll out the new config", status: "in_progress" }]);
});

it("freezes the list at compaction time onto the summary message", async () => {
	const sessionId = await newSession("todo compaction");
	const original = [
		{ content: "Back up /etc/nginx on web-1..3", status: "completed" as const },
		{ content: "Roll out the new config to web-1..3", status: "in_progress" as const },
		{ content: "Verify that every node serves 200", status: "pending" as const },
	];
	await writeTodos(sessionId, original);
	await compact(sessionId);

	const first = summaryTextOf(await captureRequest(sessionId));
	expect(first).toBeDefined();
	expect(first).toContain('<todo_list at_compaction="true">');
	expect(first).toContain("[completed] Back up /etc/nginx on web-1..3");
	expect(first).toContain("[in_progress] Roll out the new config to web-1..3");
	expect(first).toContain("[pending] Verify that every node serves 200");

	// A later write changes the session's list, never the block frozen onto the existing summary.
	await writeTodos(sessionId, [{ content: "A completely new plan", status: "pending" }]);
	const second = summaryTextOf(await captureRequest(sessionId));
	expect(second).toBe(first);
	const row = await db.selectFrom("sessions").select(["todos"]).where("id", "=", sessionId).executeTakeFirstOrThrow();
	expect(row.todos).toContain("A completely new plan");
});

it("a later compaction records a newer list and replaces the block", async () => {
	const sessionId = await newSession("todo recompaction");
	await writeTodos(sessionId, [{ content: "First plan", status: "in_progress" }]);
	await compact(sessionId, "first summary");
	expect(summaryTextOf(await captureRequest(sessionId))).toContain("[in_progress] First plan");

	await writeTodos(sessionId, [{ content: "Second plan", status: "pending" }]);
	// A second compaction summarizes the updated history, including the first summary.
	await compact(sessionId, "second summary");
	const text = summaryTextOf(await captureRequest(sessionId));
	expect(text).toContain("[pending] Second plan");
	expect(text).not.toContain("[in_progress] First plan");
});

it("adds no block for an empty list", async () => {
	const sessionId = await newSession("todo empty compaction");
	faux.setResponses([fauxAssistantMessage([fauxText("hello")])]);
	const submission = await runtime.submit(sessionId, owner, "hello", "todo-empty-1");
	expect((await waitSubmission(runtime, sessionId, submission)).status).toBe("done");
	await compact(sessionId);
	const text = summaryTextOf(await captureRequest(sessionId));
	expect(text).toBeDefined();
	expect(text).not.toContain("<todo_list");
});
