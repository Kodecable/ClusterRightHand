import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelConfig } from "../src/agent/models.ts";
import { AgentRuntime } from "../src/agent/runtime.ts";
import { Audit } from "../src/audit/audit.ts";
import { ChannelManager } from "../src/channels/manager.ts";
import { Cluster } from "../src/cluster/cluster.ts";
import { TaskGroups } from "../src/cluster/task-groups.ts";
import { decideExternalCall } from "../src/extensions/external-calls.ts";
import { MasterKey } from "../src/keys/master-key.ts";
import { createLibraryBackend, type LibraryBackend } from "../src/library/backend.ts";
import { beginLibraryUpload } from "../src/library/files.ts";
import { findUserLibrary } from "../src/library/library.ts";
import type { Db } from "../src/storage/db.ts";
import { defaultOrgId } from "../src/storage/org.ts";
import { createUser } from "../src/users/service.ts";
import { type App, call, login, makeApp } from "./helpers/api.ts";
import { openTestDb } from "./helpers/db.ts";
import { type FakeCall, type FakeTelegram, sentText, startFakeTelegram } from "./helpers/fake-telegram.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let db: Db;
let cluster: Cluster;
let taskGroups: TaskGroups;
let masterKey: MasterKey;
let audit: Audit;
let runtime: AgentRuntime;
let orgId = "";
let app: App;
let fake: FakeTelegram;
let channels: ChannelManager;
let backend: LibraryBackend;
let root: string;
let adminCookie = "";
let aliceCookie = "";
let aliceId = "";
let adminId = "";
const faux = fauxProvider();
const titleFaux = fauxProvider({ provider: "title-faux" });
const slowFaux = fauxProvider({ provider: "slow-faux", tokensPerSecond: 1 });
const model = () => ({ provider: faux.provider.id, modelId: faux.getModel().id });
const slowModel = () => ({ provider: slowFaux.provider.id, modelId: slowFaux.getModel().id });

beforeAll(async () => {
	db = await openTestDb("sqlite");
	root = await mkdtemp(join(tmpdir(), "crhs-channels-"));
	backend = createLibraryBackend({ backend: "local" }, root);
	audit = new Audit(db);
	orgId = await defaultOrgId(db);
	cluster = new Cluster(db, { audit, libraryBackend: backend });
	taskGroups = new TaskGroups(db, cluster, { audit });
	masterKey = MasterKey.generate();
	const models = new ModelConfig(db, masterKey);
	models.addProvider(faux.provider);
	models.addProvider(titleFaux.provider);
	models.addProvider(slowFaux.provider);
	await models.reload();
	const storage = new MemoryStorage();
	runtime = await AgentRuntime.open({ db, storage, models, cluster, taskGroups, audit });
	// Titles use their own faux model, so a title request cannot consume a test's scripted answers.
	await runtime.modelPresets.update("title", {
		model: { provider: titleFaux.provider.id, modelId: titleFaux.getModel().id },
	});
	const admin = await createUser(db, { username: "admin", kind: "admin", password: "password-123" });
	adminId = admin.id;
	const alice = await createUser(db, { username: "alice", kind: "member", password: "password-123" });
	aliceId = alice.id;
	fake = await startFakeTelegram({ token: "123456:TEST_TOKEN" });
	channels = new ChannelManager({
		db,
		masterKey,
		runtime,
		cluster,
		taskGroups,
		audit,
		libraryBackend: backend,
		publicUrl: "https://crh.example",
		telegramApiRoot: fake.apiRoot,
		pollTimeoutSeconds: 1,
		backoffBaseMs: 20,
		backoffMaxMs: 100,
		progressIntervalMs: 0,
		draftKeepaliveMs: 50,
	});
	await channels.start();
	app = makeApp(db, undefined, {
		cluster,
		taskGroups,
		audit,
		masterKey,
		libraryBackend: backend,
		agent: { runtime, models },
		channels,
	});
	adminCookie = await login(app, "admin", "password-123");
	aliceCookie = await login(app, "alice", "password-123");
	const created = await call(app, "/api/channels/testbot", {
		method: "PUT",
		cookie: adminCookie,
		body: {
			kind: "telegram",
			token: fake.token,
			defaultModel: model(),
			defaultRulePreset: "yolo",
		},
	});
	expect(created.status).toBe(200);
	await fake.waitFor("getMe");
});

afterAll(async () => {
	await channels.stop();
	await runtime.waitForIdle();
	await runtime.close();
	await fake.close();
	await db.destroy();
	await rm(root, { recursive: true, force: true });
});

const linkAs = async (cookie: string, userId: number, expected: string): Promise<void> => {
	const existing = await db
		.selectFrom("channel_accounts")
		.select("id")
		.where("platform_user_id", "=", String(userId))
		.executeTakeFirst();
	if (existing) return;
	const res = await call(app, "/api/channel-link-codes", { method: "POST", cookie, body: {} });
	expect(res.status).toBe(200);
	const { code } = (await res.json()) as { code: string };
	fake.text(userId, `/link ${code}`);
	await fake.waitForSent((call) => sentText(call).includes(expected));
};

const link = (userId: number): Promise<void> => linkAs(aliceCookie, userId, "Linked.");

const threadFor = async (userId: number) =>
	db
		.selectFrom("channel_threads")
		.selectAll()
		.where("chat_id", "=", String(userId))
		.where("topic_id", "is", null)
		.executeTakeFirst();

/** Where the session's latest user message came from, as the channels record it. */
const lastUsed = async (sessionId: string): Promise<string | null> =>
	(await db.selectFrom("sessions").select("last_used_from").where("id", "=", sessionId).executeTakeFirst())
		?.last_used_from ?? null;

/** Waits out a run and the title generation it starts, which also uses the faux model. */
const settle = async (): Promise<void> => {
	await runtime.waitForIdle();
	await new Promise((resolve) => setTimeout(resolve, 50));
};

const waitIdle = () => runtime.waitForIdle();

describe("channels", () => {
	beforeEach(() => {
		// Calls are per test: a wait must never match a message an earlier test received.
		fake.calls.length = 0;
	});

	it("answers an unknown command with the strictness hint", async () => {
		const userId = 9201;
		await link(userId);
		fake.text(userId, "/nope");
		const reply = await fake.waitForSent((call) => sentText(call).includes("Unknown command /nope."));
		expect(sentText(reply)).toBe(
			'Unknown command /nope. Send /help for the list of commands. To send a message that starts with "/", begin it with another character.',
		);
	});

	it("runs a command in a file caption without downloading or sending the file", async () => {
		const userId = 9202;
		await link(userId);
		fake.addFile("caption-photo", { bytes: new Uint8Array([1, 2, 3]) });
		const getFiles = fake.callsOf("getFile").length;
		const downloads = fake.callsOf("fileDownload").length;
		fake.photo(userId, "caption-photo", { caption: "/new" });
		const notice = await fake.waitForSent((call) => sentText(call).includes("Started a new session."));
		const filesNote = await fake.waitForSent((call) => sentText(call).includes("attached files were not sent"));
		expect(fake.calls.indexOf(notice)).toBeLessThan(fake.calls.indexOf(filesNote));
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(fake.callsOf("getFile").length).toBe(getFiles);
		expect(fake.callsOf("fileDownload").length).toBe(downloads);
		expect(fake.callsOf("sendMessageDraft").length).toBe(0);
		expect(await threadFor(userId)).toBeDefined();
	});

	it("announces every session a chat starts and names a replaced one", async () => {
		const userId = 9203;
		await link(userId);

		// The first ordinary message starts a session; its notice precedes the model's answer.
		faux.setResponses([fauxAssistantMessage("first notice answer")]);
		fake.text(userId, "first");
		const firstNotice = await fake.waitForSent((call) => sentText(call).includes("Started a new session."));
		const firstAnswer = await fake.waitForSent((call) => sentText(call).includes("first notice answer"));
		expect(fake.calls.indexOf(firstNotice)).toBeLessThan(fake.calls.indexOf(firstAnswer));
		expect(sentText(firstNotice)).toContain("https://crh.example/sessions/");
		await runtime.waitForIdle();

		// /new sends the same notice.
		fake.text(userId, "/new");
		await waitForMessage("Started a new session.", 2);

		// A new topic starts its own session too.
		faux.setResponses([fauxAssistantMessage("topic answer")]);
		fake.text(userId, "topic first", { topicId: 31 });
		await waitForMessage("Started a new session.", 3);
		await fake.waitForSent((call) => sentText(call).includes("topic answer"));
		await runtime.waitForIdle();

		// A bound session that was archived is replaced, and the notice says why.
		const current = await threadFor(userId);
		if (!current) throw new Error("no thread");
		await db.updateTable("sessions").set({ status: "archived" }).where("id", "=", current.session_id).execute();
		faux.setResponses([fauxAssistantMessage("archived answer")]);
		fake.text(userId, "after archive");
		const replaced = await fake.waitForSent((call) => sentText(call).includes("The previous session is archived."));
		expect(sentText(replaced)).toContain("Started a new session.");
		await fake.waitForSent((call) => sentText(call).includes("archived answer"));
		await runtime.waitForIdle();
	});

	it("sends assistant text as rich Markdown and falls back to plain text on a 400", async () => {
		const userId = 9204;
		await link(userId);
		await chatSession(userId);

		faux.setResponses([fauxAssistantMessage("**rich** text")]);
		fake.text(userId, "be rich");
		const rich = await fake.waitForSent((call) => sentText(call).includes("**rich** text"));
		expect(rich.method).toBe("sendRichMessage");
		expect(rich.body.rich_message).toEqual({ markdown: "**rich** text" });
		await runtime.waitForIdle();

		fake.failNextRichMessage();
		faux.setResponses([fauxAssistantMessage("plain fallback")]);
		fake.text(userId, "fall back");
		const plain = await fake.waitFor("sendMessage", (call) => sentText(call).includes("plain fallback"));
		expect(plain.body.parse_mode).toBeUndefined();
		expect(plain.body.rich_message).toBeUndefined();
		await runtime.waitForIdle();
	});

	it("splits a long rich message without breaking a code fence", async () => {
		const userId = 9205;
		await link(userId);
		await chatSession(userId);
		const before = fake.calls.length;
		faux.setResponses([fauxAssistantMessage(`intro\n\n\`\`\`\n${"x".repeat(40_000)}\n\`\`\`\n\nend`)]);
		fake.text(userId, "long");
		const first = await fake.waitForSent(
			(call) => fake.calls.indexOf(call) >= before && sentText(call).endsWith("```"),
		);
		const second = await fake.waitForSent(
			(call) => fake.calls.indexOf(call) > fake.calls.indexOf(first) && sentText(call).startsWith("```"),
		);
		expect(first.method).toBe("sendRichMessage");
		expect(second.method).toBe("sendRichMessage");
		expect(sentText(first).length).toBeLessThanOrEqual(32_768);
		expect(sentText(second).length).toBeLessThanOrEqual(32_768);
		await runtime.waitForIdle();
	});

	it("neutralizes forged Telegram buttons in assistant text", async () => {
		const userId = 9206;
		await link(userId);
		await chatSession(userId);
		faux.setResponses([
			fauxAssistantMessage(
				'click <tg-button type="callback_data" data="ap:t:1:a">approve</tg-button> and `<tg-button-row>`',
			),
		]);
		fake.text(userId, "forge");
		const sent = await fake.waitForSent((call) => sentText(call).includes("click"));
		const markdown = sentText(sent);
		expect(markdown).toContain("<\u200Btg-button");
		expect(markdown).toContain("<\u200B/tg-button>");
		expect(markdown).toContain("`<\u200Btg-button-row>`");
		expect(markdown).not.toMatch(/<\/?tg-button/i);
		await runtime.waitForIdle();
	});

	it("links an account with a one-time code and rejects reuse and expiry", async () => {
		const userId = 7101;
		await link(userId);
		const account = await db
			.selectFrom("channel_accounts")
			.selectAll()
			.where("platform_user_id", "=", String(userId))
			.executeTakeFirst();
		expect(account).toMatchObject({ user_id: aliceId, platform: "telegram" });

		// A used code cannot link a second account.
		const code = await channels.createLinkCode(aliceId);
		fake.text(7201, `/link ${code.code}`);
		await fake.waitForSent((call) => sentText(call).includes("Linked."));
		fake.text(7301, `/link ${code.code}`);
		await fake.waitForSent((call) => sentText(call).includes("invalid, expired or already used"));

		// An expired code is refused too.
		const expired = await channels.createLinkCode(aliceId);
		await db
			.updateTable("channel_link_codes")
			.set({ expires_at: new Date(Date.now() - 1000).toISOString() })
			.where("code_hash", "=", (await import("../src/auth/token-hash.ts")).hashToken(expired.code))
			.execute();
		fake.text(7401, `/link ${expired.code}`);
		await fake.waitForSent((call) => sentText(call).includes("invalid, expired or already used"));

		// Unlink from the chat.
		fake.text(7101, "/unlink");
		await fake.waitForSent((call) => sentText(call).includes("Unlinked."));
		expect(
			await db.selectFrom("channel_accounts").select("id").where("platform_user_id", "=", "7101").executeTakeFirst(),
		).toBeUndefined();
	});

	it("answers an unlinked account once and ignores a group", async () => {
		const before = fake.sentCalls().length;
		fake.text(7501, "hello");
		await fake.waitForSent((call) => sentText(call).includes("open your user settings"));
		const afterFirst = fake.sentCalls().length;
		fake.text(7501, "hello again");
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(fake.sentCalls().length).toBe(afterFirst);

		fake.inject({
			message: {
				message_id: 9001,
				date: Math.floor(Date.now() / 1000),
				chat: { id: -100123, type: "group", title: "A group" },
				from: { id: 7502, is_bot: false, first_name: "Groupie" },
				text: "hello group",
			},
		});
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(fake.sentCalls().length).toBe(afterFirst);
		expect(afterFirst - before).toBeGreaterThan(0);
	});

	it("never fetches a file from an unlinked account or a group", async () => {
		const getFiles = fake.callsOf("getFile").length;
		const downloads = fake.callsOf("fileDownload").length;
		fake.addFile("unlinked-doc", { bytes: new Uint8Array([1, 2, 3]), name: "a.txt", mediaType: "text/plain" });
		fake.addFile("group-doc", { bytes: new Uint8Array([4, 5, 6]), name: "b.txt", mediaType: "text/plain" });
		fake.document(7511, "unlinked-doc", "a.txt");
		fake.photo(7511, "unlinked-doc");
		fake.inject({
			message: {
				message_id: 9002,
				date: Math.floor(Date.now() / 1000),
				chat: { id: -100124, type: "supergroup", title: "Another group" },
				from: { id: 7512, is_bot: false, first_name: "Groupie" },
				document: { file_id: "group-doc", file_unique_id: "u-group-doc", file_name: "b.txt", file_size: 3 },
			},
		});
		await fake.waitForSent((call) => sentText(call).includes("open your user settings"));
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(fake.callsOf("getFile").length).toBe(getFiles);
		expect(fake.callsOf("fileDownload").length).toBe(downloads);
	});

	it("creates one session per topic and switches with /sessions and history replay", async () => {
		const userId = 7601;
		await link(userId);
		faux.setResponses([fauxAssistantMessage("the answer")]);
		fake.text(userId, "hello", { topicId: 11 });
		await fake.waitForSent((call) => sentText(call).includes("the answer"));
		const topicThread = await db
			.selectFrom("channel_threads")
			.selectAll()
			.where("chat_id", "=", String(userId))
			.where("topic_id", "=", "11")
			.executeTakeFirst();
		expect(topicThread).toBeDefined();
		expect(await threadFor(userId)).toBeUndefined();

		await newSession(userId, { topicId: 11 });
		const afterNew = await db
			.selectFrom("channel_threads")
			.selectAll()
			.where("chat_id", "=", String(userId))
			.where("topic_id", "=", "11")
			.executeTakeFirst();
		expect(afterNew?.session_id).not.toBe(topicThread?.session_id);

		fake.text(userId, "/sessions", { topicId: 11 });
		const list = await fake.waitForSent((call) => sentText(call).includes("Switch this chat to a session"));
		const buttons = (list.body.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] })
			.inline_keyboard;
		const oldButton = buttons.flat().find((button) => button.callback_data === `switch:${topicThread?.session_id}`);
		expect(oldButton).toBeDefined();
		fake.callback(userId, `switch:${topicThread?.session_id}`, { topicId: 11 });
		await fake.waitForSent((call) => sentText(call).includes("You: hello"));
		await fake.waitForSent((call) => sentText(call).includes("Assistant: the answer"));
		const reattached = await db
			.selectFrom("channel_threads")
			.selectAll()
			.where("chat_id", "=", String(userId))
			.where("topic_id", "=", "11")
			.executeTakeFirst();
		expect(reattached?.session_id).toBe(topicThread?.session_id);
	});

	it("pages /sessions five at a time and edits the list message on a page press", async () => {
		const userId = 9001;
		const pager = await createUser(db, { username: "pager", kind: "member", password: "password-123" });
		const cookie = await login(app, "pager", "password-123");
		await linkAs(cookie, userId, "Linked.");
		const owner = { sessionId: "test", userId: pager.id, username: "pager", kind: "member" as const };
		const sessions: string[] = [];
		for (let index = 1; index <= 12; index++) {
			const session = await runtime.createSession(owner, {
				title: `paged ${index}`,
				model: model(),
				rulePreset: "yolo",
			});
			sessions.push(session.id);
		}

		fake.text(userId, "/sessions");
		const first = await fake.waitForSent((call) => sentText(call).includes("page 1 of 3"));
		const firstButtons = buttonsOf(first);
		expect(firstButtons.filter((button) => button.callback_data.startsWith("switch:"))).toHaveLength(5);
		expect(firstButtons.filter((button) => button.text.includes("Previous"))).toHaveLength(0);
		expect(firstButtons.find((button) => button.text === "Next ›")?.callback_data).toBe("sessions:2");

		const second = await pressPage(userId, "sessions:2");
		expect(second.body.message_id).toBe(7777);
		expect(sentText(second)).toContain("page 2 of 3");
		const secondButtons = buttonsOf(second);
		expect(secondButtons.some((button) => button.text === "‹ Previous")).toBe(true);
		expect(secondButtons.some((button) => button.text === "Next ›")).toBe(true);

		const last = await pressPage(userId, "sessions:3");
		expect(last.body.message_id).toBe(7777);
		expect(sentText(last)).toContain("page 3 of 3");
		const lastButtons = buttonsOf(last);
		expect(lastButtons.filter((button) => button.callback_data.startsWith("switch:"))).toHaveLength(2);
		expect(lastButtons.some((button) => button.text === "‹ Previous")).toBe(true);
		expect(lastButtons.some((button) => button.text === "Next ›")).toBe(false);

		// A page past the end is clamped to the last page.
		const clamped = await pressPage(userId, "sessions:9");
		expect(sentText(clamped)).toContain("page 3 of 3");

		// Five or fewer sessions have no page row and no page in the text.
		await db.updateTable("sessions").set({ status: "archived" }).where("id", "in", sessions.slice(0, 10)).execute();
		const beforeSecondList = fake.calls.length;
		fake.text(userId, "/sessions");
		const small = await fake.waitForSent(
			(call) =>
				fake.calls.indexOf(call) >= beforeSecondList && sentText(call).startsWith("Switch this chat to a session"),
		);
		const smallButtons = buttonsOf(small);
		expect(smallButtons.filter((button) => button.callback_data.startsWith("switch:"))).toHaveLength(2);
		expect(smallButtons.some((button) => button.callback_data.startsWith("sessions:"))).toBe(false);
		expect(sentText(small)).not.toContain("page");

		// With no sessions left, a stale page button edits the message to say so.
		await db.updateTable("sessions").set({ status: "archived" }).where("owner_user_id", "=", pager.id).execute();
		const empty = await pressPage(userId, "sessions:1");
		expect(empty.body.message_id).toBe(7777);
		expect(sentText(empty)).toContain("You have no sessions yet");
	});

	it("uses one current session without topics", async () => {
		const userId = 7701;
		await link(userId);
		faux.setResponses([fauxAssistantMessage("plain answer")]);
		fake.text(userId, "plain hello");
		await fake.waitForSent((call) => sentText(call).includes("plain answer"));
		const first = await threadFor(userId);
		expect(first?.current).toBe(1);
		expect(first?.topic_id).toBeNull();
		await newSession(userId);
		const rows = await db.selectFrom("channel_threads").selectAll().where("chat_id", "=", String(userId)).execute();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.session_id).not.toBe(first?.session_id);
		expect(rows[0]?.current).toBe(1);
	});

	it("sends each assistant text piece as its own message and shows a progress draft", async () => {
		const userId = 7801;
		await settle();
		await link(userId);
		faux.setResponses([
			fauxAssistantMessage([fauxText("checking the cluster"), fauxToolCall("subagent_list", {})], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("all done"),
		]);
		fake.text(userId, "please check");
		await fake.waitForSent((call) => sentText(call).includes("checking the cluster"));
		await fake.waitForSent((call) => sentText(call).includes("all done"));
		const checking = fake.sentCalls().filter((call) => sentText(call).includes("checking the cluster"));
		const done = fake.sentCalls().filter((call) => sentText(call).includes("all done"));
		expect(checking).toHaveLength(1);
		expect(done).toHaveLength(1);
		expect(fake.callsOf("sendMessageDraft").length).toBeGreaterThan(0);
		await waitIdle();
	});

	it("stores an inbound photo in the user's library as a chat attachment", async () => {
		const userId = 7901;
		await settle();
		await link(userId);
		fake.addFile("photo-1", {
			bytes: Buffer.from(
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
				"base64",
			),
			name: "photo.png",
			mediaType: "image/png",
		});
		faux.setResponses([fauxAssistantMessage("nice photo")]);
		fake.photo(userId, "photo-1", { caption: "look at this" });
		await fake.waitForSent((call) => sentText(call).includes("nice photo"));
		await waitIdle();
		const file = await db
			.selectFrom("library_files")
			.selectAll()
			.where("path", "like", "attachments/%")
			.executeTakeFirst();
		expect(file).toBeDefined();
		const session = await db
			.selectFrom("sessions")
			.select("id")
			.where("owner_user_id", "=", aliceId)
			.orderBy("created_at", "desc")
			.executeTakeFirst();
		expect(session).toBeDefined();
		expect(file?.media_type).toBe("image/png");
		const entries = await runtime.entriesPage(session?.id ?? "", undefined, 20);
		const input = entries.entries.find((entry) => entry.kind === "crh.user_input");
		expect(input?.data).toMatchObject({ attachments: [{ path: file?.path }] });
	});

	it("shows a waiting external call, decides it from a button and by command, and only for its owner", async () => {
		const userId = 8001;
		await link(userId);
		const thread = await chatSession(userId);
		await linkAs(adminCookie, 8101, "Linked.");
		const ownedCall = await insertExternalCall(thread.sessionId, "call-owner");
		fake.text(8101, `/approve ${ownedCall}`);
		await fake.waitForSent((call) => sentText(call).includes("No waiting approval"));
		await db.updateTable("external_calls").set({ state: "rejected" }).where("id", "=", ownedCall).execute();

		const callId = await insertExternalCall(thread.sessionId, "call-button");
		await wakeWait(thread.sessionId);
		const approval = await fake.waitForSent((call) => sentText(call).includes("Approval needed for an extension call"));
		const buttons = (approval.body.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] })
			.inline_keyboard;
		fake.callback(userId, buttons.flat()[0]?.callback_data ?? "", {});
		await fake.waitFor("editMessageText", (call) => sentText(call).includes("Approved."));
		const decided = await db.selectFrom("external_calls").select(["state"]).where("id", "=", callId).executeTakeFirst();
		expect(decided?.state).toBe("running");

		const secondId = await insertExternalCall(thread.sessionId, "call-command");
		await wakeWait(thread.sessionId);
		await fake.waitForSent((call) => sentText(call).includes(`/approve ${secondId}`));
		fake.text(userId, `/approve ${secondId}`);
		await fake.waitForSent((call) => sentText(call).includes("Approved."));
		const commandDecided = await db
			.selectFrom("external_calls")
			.select(["state"])
			.where("id", "=", secondId)
			.executeTakeFirst();
		expect(commandDecided?.state).toBe("running");

		const thirdId = await insertExternalCall(thread.sessionId, "call-reject");
		await wakeWait(thread.sessionId);
		await fake.waitForSent((call) => sentText(call).includes(`/approve ${thirdId}`));
		fake.text(userId, `/reject ${thirdId} not needed`);
		await fake.waitForSent((call) => sentText(call).includes("Rejected."));
		const rejected = await db
			.selectFrom("external_calls")
			.select(["state", "approval"])
			.where("id", "=", thirdId)
			.executeTakeFirst();
		expect(rejected?.state).toBe("rejected");
		expect(rejected?.approval).toContain("not needed");

		// Decided elsewhere (the WebUI): the chat message is edited to say how it ended.
		const elsewhereId = await insertExternalCall(thread.sessionId, "call-elsewhere");
		await wakeWait(thread.sessionId);
		await fake.waitForSent((call) => sentText(call).includes(`/approve ${elsewhereId}`));
		const editsBefore = fake.callsOf("editMessageText").length;
		await decideExternalCall(db, elsewhereId, {
			decision: "approved",
			by: { type: "user", id: aliceId, onBehalfOfUserId: aliceId },
			at: new Date().toISOString(),
		});
		await channels.refreshWaits(thread.sessionId);
		await fake.waitFor("editMessageText", () => fake.callsOf("editMessageText").length > editsBefore);
		const ended = fake.callsOf("editMessageText").at(-1);
		if (!ended) throw new Error("no ended wait edit");
		expect(sentText(ended)).toContain("Approved.");
	});

	it("sends a signature wait as a WebUI link and handles quota commands", async () => {
		const userId = 8201;
		await link(userId);
		const thread = await chatSession(userId);
		await insertSignatureTask(thread.sessionId, "sign-task");
		await wakeWait(thread.sessionId);
		const linkMessage = await fake.waitForSent((call) => sentText(call).includes("waits for your signature"));
		expect(sentText(linkMessage)).toContain("https://crh.example/approvals/tasks/sign-task");

		await db
			.updateTable("sessions")
			.set({
				quota_tokens: -1,
				state: "awaiting",
				waiting_kind: "quota",
				waiting_level_id: thread.sessionId,
				waiting_handler_id: null,
				state_changed_at: new Date().toISOString(),
			})
			.where("id", "=", thread.sessionId)
			.execute();
		await channels.refreshWaits(thread.sessionId);
		await fake.waitForSent((call) => sentText(call).includes("is used up"));

		fake.text(userId, "/quota add 100");
		await fake.waitForSent((call) => sentText(call).includes("Added 100 tokens"));
		const root = await db
			.selectFrom("sessions")
			.select("quota_tokens")
			.where("id", "=", thread.sessionId)
			.executeTakeFirst();
		expect(Number(root?.quota_tokens)).toBeGreaterThan(0);

		// A second session: /quota stop ends the turn.
		fake.text(userId, "/new");
		await waitForMessage("Started a new session.", 2);
		const next = await threadFor(userId);
		faux.setResponses([fauxAssistantMessage("second session ready")]);
		fake.text(userId, "second session");
		await fake.waitForSent((call) => sentText(call).includes("second session ready"));
		await runtime.waitForIdle();
		await db
			.updateTable("sessions")
			.set({
				quota_tokens: -1,
				state: "awaiting",
				waiting_kind: "quota",
				waiting_level_id: next?.session_id ?? "",
				waiting_handler_id: null,
				state_changed_at: new Date().toISOString(),
			})
			.where("id", "=", next?.session_id ?? "")
			.execute();
		await channels.refreshWaits(next?.session_id ?? "");
		await waitForMessage("is used up", 2);
		fake.text(userId, "/quota stop");
		await fake.waitForSent((call) => sentText(call).includes("Ended the turn."));
		const stopped = await db
			.selectFrom("sessions")
			.select("state")
			.where("id", "=", next?.session_id ?? "")
			.executeTakeFirst();
		expect(stopped?.state).toBe("idle");
	});

	it("records the WebUI only when a user message is submitted there", async () => {
		const alice = { sessionId: "test", userId: aliceId, username: "alice", kind: "member" as const };
		const session = await runtime.createSession(alice, { model: model(), rulePreset: "yolo" });
		// Opening the session and reading its history do not record where a message came from.
		expect((await call(app, `/api/sessions/${session.id}`, { cookie: aliceCookie })).status).toBe(200);
		expect((await call(app, `/api/sessions/${session.id}/entries`, { cookie: aliceCookie })).status).toBe(200);
		expect(await lastUsed(session.id)).toBeNull();
		expect(channels.presence.online(aliceId)).toBe(true);

		// Deciding an approval in the WebUI is not a message either.
		const callId = await insertExternalCall(session.id, "call-web-source");
		const decided = await call(app, `/api/external-calls/${callId}/approval`, {
			method: "POST",
			cookie: aliceCookie,
			body: { decision: "approve" },
		});
		expect(decided.status).toBe(200);
		expect(await lastUsed(session.id)).toBeNull();

		// A WebUI message records the WebUI.
		faux.setResponses([fauxAssistantMessage("web answer")]);
		const sent = await call(app, `/api/sessions/${session.id}/messages`, {
			method: "POST",
			cookie: aliceCookie,
			body: { text: "from the WebUI", requestId: "web-message-source" },
		});
		expect(sent.status).toBe(202);
		await settle();
		expect(await lastUsed(session.id)).toBe("web");

		// Stopping a running turn does not change it.
		await runtime.configure(session.id, { model: slowModel() });
		try {
			slowFaux.setResponses([fauxAssistantMessage("slow web answer")]);
			const running = await call(app, `/api/sessions/${session.id}/messages`, {
				method: "POST",
				cookie: aliceCookie,
				body: { text: "a slow message", requestId: "web-message-slow" },
			});
			expect(running.status).toBe(202);
			const aborted = await call(app, `/api/sessions/${session.id}/abort`, {
				method: "POST",
				cookie: aliceCookie,
				body: {},
			});
			expect(aborted.status).toBe(200);
			expect(await lastUsed(session.id)).toBe("web");
		} finally {
			await runtime.waitForIdle();
			await runtime.configure(session.id, { model: model() });
		}

		// Creating a session with its first message records it too.
		faux.setResponses([fauxAssistantMessage("created answer")]);
		const created = await call(app, "/api/sessions", {
			method: "POST",
			cookie: aliceCookie,
			body: {
				requestId: "web-create-source",
				model: model(),
				rulePreset: "yolo",
				message: "the first message",
			},
		});
		expect(created.status).toBe(201);
		const createdId = ((await created.json()) as { session: { id: string } }).session.id;
		await settle();
		expect(await lastUsed(createdId)).toBe("web");
		channels.presence.forget(aliceId);
	});

	it("records a chat message as the source and leaves it alone for /sessions, /new and switching", async () => {
		const userId = 8701;
		await link(userId);
		faux.setResponses([fauxAssistantMessage("the first answer")]);
		fake.text(userId, "the first message");
		await fake.waitForSent((call) => sentText(call).includes("the first answer"));
		const first = await threadFor(userId);
		if (!first) throw new Error("no thread");
		expect(await lastUsed(first.session_id)).toBe(first.id);

		// Listing sessions does not change it.
		fake.text(userId, "/sessions");
		await fake.waitForSent((call) => sentText(call).includes("Switch this chat to a session"));
		expect(await lastUsed(first.session_id)).toBe(first.id);

		// Starting a session without a message leaves it without a source.
		await newSession(userId);
		const next = await threadFor(userId);
		expect(next?.session_id).not.toBe(first.session_id);
		expect(await lastUsed(next?.session_id ?? "")).toBeNull();

		// Attaching the first session again does not change it either.
		fake.text(userId, "/sessions");
		await waitForMessage("Switch this chat to a session", 2);
		const list = fake
			.sentCalls()
			.filter((call) => sentText(call).includes("Switch this chat to a session"))
			.at(-1);
		if (!list) throw new Error("no sessions list");
		const buttons = (list.body.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] })
			.inline_keyboard;
		const old = buttons.flat().find((button) => button.callback_data === `switch:${first.session_id}`);
		expect(old).toBeDefined();
		fake.callback(userId, old?.callback_data ?? "", {});
		await fake.waitForSent((call) => sentText(call).includes("You: the first message"));
		expect(await lastUsed(first.session_id)).toBe(first.id);
	});

	it("records no source for a scheduled message", async () => {
		const alice = { sessionId: "test", userId: aliceId, username: "alice", kind: "member" as const };
		const session = await runtime.createSession(alice, { model: model(), rulePreset: "yolo" });
		await db.updateTable("sessions").set({ last_used_from: "web" }).where("id", "=", session.id).execute();
		faux.setResponses([fauxAssistantMessage("scheduled answer")]);
		await runtime.submitAsSchedule(session.id, "schedule-source", "a scheduled prompt", "schedule-source-1");
		await settle();
		expect(await lastUsed(session.id)).toBeNull();
	});

	it("routes notifications to the thread, the default channel, or nowhere while the WebUI is online", async () => {
		const userId = 8301;
		await link(userId);
		const thread = await chatSession(userId);

		// Last used from the thread: the approval goes there.
		const inThread = await insertExternalCall(thread.sessionId, "call-thread");
		await wakeWait(thread.sessionId);
		await fake.waitForSent((call) => sentText(call).includes(`/approve ${inThread}`));
		await db.updateTable("external_calls").set({ state: "rejected" }).where("id", "=", inThread).execute();

		// A session never used from the chat, with the account as the default notification channel.
		const alice = { sessionId: "test", userId: aliceId, username: "alice", kind: "member" as const };
		const plain = await runtime.createSession(alice, { model: model(), rulePreset: "yolo" });
		const account = await db
			.selectFrom("channel_accounts")
			.select("id")
			.where("platform_user_id", "=", String(userId))
			.executeTakeFirst();
		await channels.saveSettings(alice, { defaultAccountId: account?.id ?? null, showProgress: false });
		channels.presence.touch(aliceId);
		await db.updateTable("sessions").set({ state: "running" }).where("id", "=", plain.id).execute();
		const onlineCall = await insertExternalCall(plain.id, "call-online");
		await wakeWait(plain.id);
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(fake.sentCalls().some((call) => sentText(call).includes(`/approve ${onlineCall}`))).toBe(false);
		await db.updateTable("external_calls").set({ state: "rejected" }).where("id", "=", onlineCall).execute();

		// Offline: a topic is created on the default channel and the message goes there.
		channels.presence.forget(aliceId);
		const offlineCall = await insertExternalCall(plain.id, "call-offline");
		await wakeWait(plain.id);
		const sent = await fake.waitForSent((call) => sentText(call).includes(`/approve ${offlineCall}`));
		expect(fake.callsOf("createForumTopic").length).toBeGreaterThan(0);
		expect(sent.body.message_thread_id).toBeDefined();
		await channels.saveSettings(alice, { defaultAccountId: null, showProgress: true });
	});

	it("stops the running turn when the draft's stop control is pressed", async () => {
		const userId = 8601;
		await link(userId);
		const thread = await chatSession(userId);
		await runtime.configure(thread.sessionId, {
			model: { provider: slowFaux.provider.id, modelId: slowFaux.getModel().id },
		});
		try {
			slowFaux.setResponses([fauxAssistantMessage("slow answer")]);
			fake.text(userId, "take your time");
			await fake.waitFor("sendMessageDraft");
			fake.stopGeneration(userId);
			const deadline = Date.now() + 5_000;
			let state: string | undefined;
			while (Date.now() < deadline) {
				state = (await db.selectFrom("sessions").select("state").where("id", "=", thread.sessionId).executeTakeFirst())
					?.state;
				if (state === "idle") break;
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
			expect(state).toBe("idle");
		} finally {
			await runtime.configure(thread.sessionId, { model: model() });
		}
	});

	it("sends a delivered file as a WebUI link", async () => {
		const userId = 8401;
		await link(userId);
		const library = await findUserLibrary(db, aliceId);
		if (!library) throw new Error("alice has no library");
		const upload = beginLibraryUpload(db, backend, {
			library: library.row,
			path: "docs/a.txt",
			overwrite: false,
			rename: false,
			createdBy: aliceId,
		});
		await upload.write(Buffer.from("hello"));
		await upload.finish();
		await upload.commit();
		const thread = await chatSession(userId);
		faux.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("copy_file", {
						source: { library: "user:alice", path: "docs/a.txt" },
						destination: { user_interface: true },
					}),
				],
				{
					stopReason: "toolUse",
				},
			),
			fauxAssistantMessage("delivered"),
		]);
		fake.text(userId, "deliver it");
		await fake.waitForSent((call) => sentText(call).includes("delivered"));
		const delivery = await fake.waitForSent((call) => sentText(call).includes("File offered: a.txt"));
		expect(sentText(delivery)).toContain("https://crh.example/library/user%3Aalice?path=docs%2Fa.txt");
		expect(thread.sessionId).toBeDefined();
		expect(fake.callsOf("sendMessageDraft").length).toBeGreaterThan(0);
		// A delivery goes out after the run, so no draft follows it.
		await settle();
		expect(
			fake.callsOf("sendMessageDraft").filter((call) => fake.calls.indexOf(call) > fake.calls.indexOf(delivery)),
		).toHaveLength(0);
	});

	it("re-sends the progress draft after a wait message and returns to the step when the wait ends", async () => {
		const userId = 8801;
		await settle();
		await link(userId);
		const thread = await chatSession(userId);
		const alice = { sessionId: "test", userId: aliceId, username: "alice", kind: "member" as const };
		await runtime.configure(thread.sessionId, { model: slowModel() });
		try {
			slowFaux.setResponses([fauxAssistantMessage("slow draft answer")]);
			fake.text(userId, "keep the draft");
			await fake.waitFor("sendMessageDraft");

			// A direct command reply clears the draft too; it is shown again at once.
			fake.text(userId, "/quota");
			const quota = await fake.waitForSent((call) => sentText(call).includes("no token quota"));
			const quotaDraft = await fake.waitFor(
				"sendMessageDraft",
				(call) => fake.calls.indexOf(call) > fake.calls.indexOf(quota),
			);
			expect(String(quotaDraft.body.text).length).toBeGreaterThan(0);

			// An approval request clears the chat's draft; the waiting status is sent again at once.
			const callId = await insertExternalCall(thread.sessionId, "call-draft-approval");
			await wakeWait(thread.sessionId);
			const approval = await fake.waitForSent((call) => sentText(call).includes(`/approve ${callId}`));
			const approvalDraft = await fake.waitFor(
				"sendMessageDraft",
				(call) =>
					fake.calls.indexOf(call) > fake.calls.indexOf(approval) && sentText(call).includes("Waiting for approval"),
			);
			expect(String(approvalDraft.body.text)).toContain("Waiting for approval…");

			// A signature wait reads differently.
			await insertSignatureTask(thread.sessionId, "sign-draft");
			await wakeWait(thread.sessionId);
			const signature = await fake.waitForSent((call) => sentText(call).includes("waits for your signature"));
			const signatureDraft = await fake.waitFor(
				"sendMessageDraft",
				(call) =>
					fake.calls.indexOf(call) > fake.calls.indexOf(signature) &&
					sentText(call).includes("Waiting for a signature"),
			);
			expect(String(signatureDraft.body.text)).toContain("Waiting for a signature…");

			// Both waits end: the draft falls back to the step the run is on.
			await db.updateTable("external_calls").set({ state: "rejected" }).where("id", "=", callId).execute();
			await db.updateTable("tasks").set({ state: "rejected" }).where("id", "=", "sign-draft").execute();
			await channels.refreshWaits(thread.sessionId);
			const stepDraft = await fake.waitFor(
				"sendMessageDraft",
				(call) =>
					fake.calls.indexOf(call) > fake.calls.indexOf(signatureDraft) && !sentText(call).includes("Waiting for"),
			);
			expect(String(stepDraft.body.text)).not.toContain("Waiting for");
		} finally {
			await runtime.abort(thread.sessionId, alice).catch(() => {});
			await runtime.waitForIdle();
			await runtime.configure(thread.sessionId, { model: model() });
		}
	});

	it("starts a new draft after a mid-turn text but keeps the id across status changes", async () => {
		const userId = 8901;
		await settle();
		await link(userId);
		await chatSession(userId);
		let release = (): void => {};
		const paused = new Promise<void>((resolve) => {
			release = resolve;
		});
		faux.setResponses([
			fauxAssistantMessage([fauxText("checking first"), fauxToolCall("subagent_list", {})], { stopReason: "toolUse" }),
			async () => {
				await paused;
				return fauxAssistantMessage("the final answer");
			},
		]);
		const before = fake.calls.length;
		fake.text(userId, "say two pieces");
		const working = await fake.waitFor("sendMessageDraft", (call) => fake.calls.indexOf(call) >= before);
		const thinking = await fake.waitFor(
			"sendMessageDraft",
			(call) => fake.calls.indexOf(call) > fake.calls.indexOf(working) && sentText(call).includes("Thinking"),
		);
		// A status change without a real message updates the same draft.
		expect(thinking.body.draft_id).toBe(working.body.draft_id);
		const midway = await fake.waitForSent(
			(call) => fake.calls.indexOf(call) >= before && sentText(call).includes("checking first"),
		);
		// The text message ended the draft; it is shown again as a new preview while the run goes on.
		const draft = await fake.waitFor(
			"sendMessageDraft",
			(call) => fake.calls.indexOf(call) > fake.calls.indexOf(midway) && call.body.draft_id !== working.body.draft_id,
		);
		expect(String(draft.body.text).length).toBeGreaterThan(0);
		const running = await fake.waitFor(
			"sendMessageDraft",
			(call) => fake.calls.indexOf(call) > fake.calls.indexOf(draft) && sentText(call).includes("Running"),
		);
		// A status change after the real message still updates the same new draft.
		expect(running.body.draft_id).toBe(draft.body.draft_id);
		release();
		const final = await fake.waitForSent((call) => sentText(call).includes("the final answer"));
		await settle();
		// The final text cleared the draft for good: the turn is over, so nothing is shown after it.
		expect(
			fake.callsOf("sendMessageDraft").filter((call) => fake.calls.indexOf(call) > fake.calls.indexOf(final)),
		).toHaveLength(0);
	});

	it("keeps a shown draft alive while the run is blocked and stops after it ends", async () => {
		const userId = 8902;
		await settle();
		await link(userId);
		await chatSession(userId);
		let release = (): void => {};
		const paused = new Promise<void>((resolve) => {
			release = resolve;
		});
		faux.setResponses([
			async () => {
				await paused;
				return fauxAssistantMessage("kept alive");
			},
		]);
		const before = fake.calls.length;
		fake.text(userId, "wait a while");
		const first = await fake.waitFor("sendMessageDraft", (call) => fake.calls.indexOf(call) >= before);
		// Nothing changes while the model is gated, so the next draft is the keep-alive: same id and text.
		const kept = await fake.waitFor(
			"sendMessageDraft",
			(call) =>
				fake.calls.indexOf(call) > fake.calls.indexOf(first) &&
				call.body.draft_id === first.body.draft_id &&
				call.body.text === first.body.text,
		);
		expect(kept.body.draft_id).toBe(first.body.draft_id);
		release();
		await fake.waitForSent((call) => sentText(call).includes("kept alive"));
		await settle();
		const sent = fake.callsOf("sendMessageDraft").length;
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(fake.callsOf("sendMessageDraft").length).toBe(sent);
	});

	it("keeps the handled update id across a restart and backs off on a rejected token", async () => {
		const userId = 8501;
		await link(userId);
		faux.setResponses([fauxAssistantMessage("restart answer")]);
		fake.text(userId, "restart hello");
		await fake.waitForSent((call) => sentText(call).includes("restart answer"));
		const count = fake.sentCalls().filter((call) => String(call.body.chat_id) === String(userId)).length;
		const row = await db.selectFrom("channels").select("cursor").where("name", "=", "testbot").executeTakeFirst();
		expect(Number(row?.cursor)).toBeGreaterThan(0);
		await channels.stop();
		channels = new ChannelManager({
			db,
			masterKey,
			runtime,
			cluster,
			taskGroups,
			audit,
			libraryBackend: backend,
			publicUrl: "https://crh.example",
			telegramApiRoot: fake.apiRoot,
			pollTimeoutSeconds: 1,
			backoffBaseMs: 20,
			backoffMaxMs: 100,
		});
		await channels.start();
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(fake.sentCalls().filter((call) => String(call.body.chat_id) === String(userId)).length).toBe(count);

		const admin = { sessionId: "test", userId: adminId, username: "admin", kind: "admin" as const };
		const bad = await channels.saveChannel(admin, "badbot", {
			kind: "telegram",
			token: "bad-token",
			defaultModel: model(),
		});
		expect(bad.name).toBe("badbot");
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(channels.status("badbot").lastError).not.toBeNull();
		expect(channels.status("badbot").nextAttemptAt).not.toBeNull();
		fake.calls.length = 0;
		await channels.saveChannel(admin, "badbot", { token: fake.token });
		await fake.waitFor("getMe");
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(channels.status("badbot").lastError).toBeNull();
	});
});

/** Sends /new and waits for the notice it sends, not for an earlier session's notice. */
async function newSession(userId: number, options?: { topicId?: number }): Promise<void> {
	const before = fake.calls.length;
	fake.text(userId, "/new", options);
	await fake.waitForSent(
		(call) => fake.calls.indexOf(call) >= before && sentText(call).includes("Started a new session."),
	);
}

/** Waits for the nth message containing `needle`; earlier tests' calls are cleared, this test's are not. */
async function waitForMessage(needle: string, occurrence = 1): Promise<void> {
	const deadline = Date.now() + 5_000;
	for (;;) {
		const found = fake.sentCalls().filter((call) => sentText(call).includes(needle));
		if (found.length >= occurrence) return;
		if (Date.now() > deadline) throw new Error(`timed out waiting for message ${occurrence} containing ${needle}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

type FakeButton = { text: string; callback_data: string };

/** The inline buttons of a sent or edited message, row by row flattened. */
function buttonsOf(call: FakeCall): FakeButton[] {
	const markup = call.body.reply_markup as { inline_keyboard: FakeButton[][] } | undefined;
	return markup?.inline_keyboard.flat() ?? [];
}

/** Presses a session list page button on message 7777 and returns the edit it made. */
async function pressPage(userId: number, data: string): Promise<FakeCall> {
	const before = fake.calls.length;
	fake.callback(userId, data, { messageId: 7777 });
	return fake.waitFor("editMessageText", (call) => fake.calls.indexOf(call) >= before);
}

/** Creates a chat session with one message and returns its thread row, with that message as the session's source. */
async function chatSession(userId: number) {
	await newSession(userId);
	const thread = await threadFor(userId);
	if (!thread) throw new Error("no thread");
	// A message makes the thread the source of the session's latest user message, as a real chat would.
	faux.setResponses([fauxAssistantMessage("chat session ready")]);
	fake.text(userId, "ready");
	await fake.waitForSent((call) => sentText(call).includes("chat session ready"));
	await runtime.waitForIdle();
	return { ...thread, sessionId: thread.session_id };
}

/** Wakes the runtime's state computation so the channel manager sees a newly inserted wait. */
async function wakeWait(sessionId: string): Promise<void> {
	await db
		.updateTable("sessions")
		.set({ state: "running", waiting_kind: null, waiting_level_id: null })
		.where("id", "=", sessionId)
		.execute();
	await channels.refreshWaits(sessionId);
}

async function insertExternalCall(sessionId: string, id: string): Promise<string> {
	await db
		.insertInto("external_calls")
		.values({
			id,
			org_id: orgId,
			actor_type: "session",
			actor_id: sessionId,
			on_behalf_of_user_id: aliceId,
			extension_name: "test",
			tool_name: "echo",
			arguments: "{}",
			operation: JSON.stringify({ method: "ext.write", target: "test/echo" }),
			annotations: null,
			rule_chain: JSON.stringify([{ type: "user", id: aliceId }]),
			approval: null,
			pending_input: null,
			root_session_id: sessionId,
			handler_type: "user",
			handler_session_id: null,
			state: "awaiting_approval",
			created_at: new Date().toISOString(),
			finished_at: null,
		})
		.execute();
	return id;
}

async function insertSignatureTask(sessionId: string, id: string): Promise<string> {
	await db
		.insertInto("tasks")
		.values({
			id,
			org_id: orgId,
			node_id: "node-x",
			task_group_id: null,
			kind: "exec",
			spec: JSON.stringify({ kind: "exec", command: { argv: ["true"] } }),
			input_size: null,
			input_sha256: null,
			attempt: 1,
			rev: 1,
			privileged: 0,
			authorization: null,
			timeout_ms: null,
			output_mode: "full",
			max_lines: null,
			max_bytes: null,
			state: "awaiting_authorization",
			exit_code: null,
			signal: null,
			timed_out: 0,
			cancelled: 0,
			error_code: null,
			error_message: null,
			actor_type: "session",
			actor_id: sessionId,
			on_behalf_of_user_id: aliceId,
			created_at: new Date().toISOString(),
			dispatched_at: null,
			accepted_at: null,
			finished_at: null,
			output_bytes: 0,
			output_head: null,
			output_tail: null,
			notice: null,
			output_lines: null,
			output_file: null,
			result: null,
			late_result: null,
			transfer: null,
			purpose: null,
			rule_chain: JSON.stringify([{ type: "user", id: aliceId }]),
			approval: null,
			pending_input: null,
			root_session_id: sessionId,
			handler_type: "user",
			handler_session_id: null,
		})
		.execute();
	return id;
}
