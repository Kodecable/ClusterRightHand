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
import { getUserSettings, patchUserSettings } from "../src/users/settings.ts";
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
let models: ModelConfig;
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
let commandMenus: FakeCall[] = [];
const faux = fauxProvider();
const titleFaux = fauxProvider({ provider: "title-faux" });
const slowFaux = fauxProvider({ provider: "slow-faux", tokensPerSecond: 1 });
/** Twelve more offered models, so `/model` and `/extensions` paging have more than one page. */
const manyFaux = fauxProvider({
	provider: "many-faux",
	models: Array.from({ length: 12 }, (_, index) => ({
		id: `many-${index + 1}`,
		name: `Many ${index + 1}`,
		reasoning: index === 0,
	})),
});
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
	models = new ModelConfig(db, masterKey);
	models.addProvider(faux.provider);
	models.addProvider(titleFaux.provider);
	models.addProvider(slowFaux.provider);
	models.addProvider(manyFaux.provider);
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
	// Seven extensions besides the built-ins, so the toggles have a second page.
	for (let index = 1; index <= 7; index++) {
		const name = `ext-${index}`;
		await db
			.insertInto("extensions")
			.values({
				id: `extension-${name}`,
				org_id: orgId,
				name,
				kind: "mcp",
				description: null,
				url: "https://example.test/mcp",
				headers_secret_id: null,
				identity_headers: null,
				enabled: 1,
				list_directly: 0,
				availability: "everyone",
				trust_annotations: null,
				timeout_ms: null,
				created_at: new Date().toISOString(),
				updated_at: new Date().toISOString(),
			})
			.execute();
	}
	fake = await startFakeTelegram({ token: "123456:TEST_TOKEN" });
	channels = new ChannelManager({
		db,
		masterKey,
		runtime,
		models,
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
		},
	});
	expect(created.status).toBe(200);
	await fake.waitFor("getMe");
	// The adapter sets the default English menu and a zh variant once it knows the bot.
	commandMenus = await fake.waitForCount("setMyCommands", 2);
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

const rawThreadFor = async (userId: number, topicId?: number) => {
	let query = db.selectFrom("channel_threads").selectAll().where("chat_id", "=", String(userId));
	query = topicId === undefined ? query.where("topic_id", "is", null) : query.where("topic_id", "=", String(topicId));
	return query.executeTakeFirst();
};

/** The chat's thread; a draft thread (no session yet) is an error here, so a caller can use its session id. */
const threadFor = async (userId: number, topicId?: number) => {
	const row = await rawThreadFor(userId, topicId);
	if (!row) return undefined;
	if (row.session_id === null) throw new Error("the thread holds a draft, not a session");
	return row as typeof row & { session_id: string };
};

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

	it("registers the Telegram command menu in English and Chinese", async () => {
		expect(commandMenus[0]?.body.language_code).toBeUndefined();
		expect(commandMenus[1]?.body.language_code).toBe("zh");
		const menus = commandMenus.map((call) => call.body.commands as { command: string; description: string }[]);
		expect(menus[0]).toContainEqual({ command: "help", description: "List the commands" });
		expect(menus[1]).toContainEqual({ command: "help", description: "列出所有命令" });
	});

	it("answers a zh-CN user in Chinese", async () => {
		const userId = 9204;
		await link(userId);
		await patchUserSettings(db, aliceId, { locale: "zh-CN" });
		try {
			fake.text(userId, "/help");
			const help = await fake.waitForSent((call) => sentText(call).includes("ClusterRightHand 命令："));
			expect(sentText(help)).toContain("/new — 开始新会话");
		} finally {
			await patchUserSettings(db, aliceId, { locale: null });
		}
	});

	it("answers an unlinked user in the platform's Chinese language", async () => {
		const userId = 9205;
		fake.text(userId, "hello", { languageCode: "zh-hans" });
		const reply = await fake.waitForSent((call) => sentText(call).includes("要在聊天中使用 ClusterRightHand"));
		expect(sentText(reply)).toContain("WebUI 的设置");
	});

	it("runs a command in a file caption without downloading or sending the file", async () => {
		const userId = 9202;
		await link(userId);
		fake.addFile("caption-photo", { bytes: new Uint8Array([1, 2, 3]) });
		const getFiles = fake.callsOf("getFile").length;
		const downloads = fake.callsOf("fileDownload").length;
		fake.photo(userId, "caption-photo", { caption: "/new" });
		const draft = await fake.waitForSent((call) => sentText(call).startsWith("New session draft:"));
		const filesNote = await fake.waitForSent((call) => sentText(call).includes("attached files were not sent"));
		expect(fake.calls.indexOf(draft)).toBeLessThan(fake.calls.indexOf(filesNote));
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(fake.callsOf("getFile").length).toBe(getFiles);
		expect(fake.callsOf("fileDownload").length).toBe(downloads);
		expect(fake.callsOf("sendMessageDraft").length).toBe(0);
		const thread = await rawThreadFor(userId);
		expect(thread?.session_id).toBeNull();
		expect(thread?.draft).toContain("rulePreset");
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

		// /new records a draft instead; its first message starts the session and sends the notice.
		fake.text(userId, "/new");
		await fake.waitForSent((call) => sentText(call).startsWith("New session draft:"));
		expect((await rawThreadFor(userId))?.session_id).toBeNull();
		faux.setResponses([fauxAssistantMessage("draft answer")]);
		fake.text(userId, "from the draft");
		await waitForMessage("Started a new session.", 2);
		await fake.waitForSent((call) => sentText(call).includes("draft answer"));
		await runtime.waitForIdle();

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

	it("clears the default notification account when that account is unlinked", async () => {
		const userId = 7251;
		await link(userId);
		const account = await db
			.selectFrom("channel_accounts")
			.select("id")
			.where("platform_user_id", "=", String(userId))
			.executeTakeFirstOrThrow();
		await patchUserSettings(db, aliceId, { defaultChannelAccountId: account.id });
		fake.text(userId, "/unlink");
		await fake.waitForSent((call) => sentText(call).includes("Unlinked."));
		expect((await getUserSettings(db, aliceId)).defaultChannelAccountId).toBeNull();
	});

	it("answers an unlinked account once and ignores a group", async () => {
		const before = fake.sentCalls().length;
		fake.text(7501, "hello");
		await fake.waitForSent((call) => sentText(call).includes("open Settings in the WebUI"));
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
		await fake.waitForSent((call) => sentText(call).includes("open Settings in the WebUI"));
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
		expect((await rawThreadFor(userId, 11))?.session_id).toBeNull();
		faux.setResponses([fauxAssistantMessage("second topic answer")]);
		fake.text(userId, "second topic", { topicId: 11 });
		await fake.waitForSent((call) => sentText(call).includes("second topic answer"));
		await runtime.waitForIdle();
		const afterNew = await rawThreadFor(userId, 11);
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
		expect(sentText(small)).not.toContain("page 2");
		expect(sentText(small)).toContain("Send /sessions and a number to choose.");

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
		const draft = await rawThreadFor(userId);
		expect(draft?.session_id).toBeNull();
		faux.setResponses([fauxAssistantMessage("second plain answer")]);
		fake.text(userId, "plain second");
		await fake.waitForSent((call) => sentText(call).includes("second plain answer"));
		await runtime.waitForIdle();
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
		await fake.waitForSent((call) => sentText(call).startsWith("New session draft:"));
		// A draft has no session to stop or report a quota for.
		fake.text(userId, "/quota");
		await fake.waitForSent((call) => sentText(call).includes("no running session"));
		faux.setResponses([fauxAssistantMessage("second session ready")]);
		fake.text(userId, "second session");
		await waitForMessage("Started a new session.", 2);
		await fake.waitForSent((call) => sentText(call).includes("second session ready"));
		const next = await threadFor(userId);
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

		// A draft replaces the thread but starts no session and records no source.
		await newSession(userId);
		expect((await rawThreadFor(userId))?.session_id).toBeNull();

		// Attaching the first session again discards the draft and does not change its source.
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
		await patchUserSettings(db, aliceId, {
			defaultChannelAccountId: account?.id ?? null,
			showProgress: false,
		});
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
		await patchUserSettings(db, aliceId, { defaultChannelAccountId: null, showProgress: true });
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
			models,
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
		});
		expect(bad.name).toBe("badbot");
		const deadline = Date.now() + 2_000;
		while (
			(channels.status("badbot").lastError === null || channels.status("badbot").nextAttemptAt === null) &&
			Date.now() < deadline
		) {
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		expect(channels.status("badbot").lastError).not.toBeNull();
		expect(channels.status("badbot").nextAttemptAt).not.toBeNull();
		fake.calls.length = 0;
		await channels.saveChannel(admin, "badbot", { token: fake.token });
		await fake.waitFor("getMe");
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(channels.status("badbot").lastError).toBeNull();
		// Leave no second bot polling the same fake server: it would consume later tests' updates.
		await channels.deleteChannel(admin, "badbot");
	});

	it("sends /help as a Markdown list with one command per item", async () => {
		const userId = 9301;
		await link(userId);
		fake.text(userId, "/help");
		const help = await fake.waitForSent((call) => sentText(call).includes("ClusterRightHand commands:"));
		const text = sentText(help);
		expect(text.startsWith("ClusterRightHand commands:\n\n")).toBe(true);
		const items = text.split("\n").filter((line) => line.startsWith("- "));
		expect(items.length).toBeGreaterThanOrEqual(15);
		for (const item of items) expect(item).toMatch(/^- \/[a-z]+/);
		expect(text).toContain("- /model \\[n\\] — choose the session's model by number");
		expect(text).toContain("- /extensions \\[n\\] — turn an extension on or off by number");
	});

	it("pages /model five at a time and sets the selected model on the session", async () => {
		const userId = 9302;
		await link(userId);
		const thread = await chatSession(userId);
		const available = models.available();
		expect(available.length).toBeGreaterThanOrEqual(12);

		fake.text(userId, "/model");
		const first = await fake.waitForSent((call) => sentText(call).includes("Choose a model (page 1 of"));
		const firstButtons = buttonsOf(first);
		const firstModels = firstButtons.filter((button) => button.callback_data.startsWith("model:"));
		expect(firstModels).toHaveLength(5);
		expect(firstButtons.some((button) => button.text === "‹ Previous")).toBe(false);
		const next = firstButtons.find((button) => button.text === "Next ›");
		expect(next?.callback_data).toMatch(/^modelp:2:[0-9a-f]{8}$/);

		const second = await pressButton(userId, next?.callback_data ?? "");
		expect(second.body.message_id).toBe(7777);
		expect(sentText(second)).toContain("page 2 of");
		const secondButtons = buttonsOf(second);
		expect(secondButtons.filter((button) => button.callback_data.startsWith("model:"))).toHaveLength(5);
		expect(secondButtons.some((button) => button.text === "‹ Previous")).toBe(true);

		// The index names the page it appeared on, never the model id, and stays inside Telegram's callback limit.
		const target = available[6];
		if (!target) throw new Error("no seventh offered model");
		const choice = secondButtons.find((button) => button.callback_data.startsWith("model:2:1:"));
		expect(choice).toBeDefined();
		expect(choice?.callback_data.length).toBeLessThanOrEqual(64);
		expect(choice?.callback_data).not.toContain(target.modelId);

		const confirmed = await pressButton(userId, choice?.callback_data ?? "");
		expect(sentText(confirmed)).toContain("Model set to");
		const session = await runtime.getSession(thread.sessionId);
		expect(session?.model).toMatchObject({ provider: target.provider, modelId: target.modelId });
	});

	it("keeps a draft, writes its changes to the user defaults and starts its first message with them", async () => {
		const userId = 9303;
		await link(userId);
		const sessionsBefore = await db.selectFrom("sessions").select("id").where("owner_user_id", "=", aliceId).execute();
		fake.text(userId, "/new");
		const draftMessage = await fake.waitForSent((call) => sentText(call).startsWith("New session draft:"));
		const text = sentText(draftMessage);
		expect(text).toContain("- Model:");
		expect(text).toContain("- Thinking:");
		expect(text).toContain("- Rules: Ask");
		expect(text).toContain("/model, /think, /rules or /extensions");
		const draftThread = await rawThreadFor(userId);
		expect(draftThread?.session_id).toBeNull();
		const draft = JSON.parse(draftThread?.draft ?? "{}") as {
			model: { provider: string; modelId: string };
			rulePreset: string;
			disabledExtensions: string[];
		};
		expect(draft.rulePreset).toBe("ask");
		expect(draft.disabledExtensions).toEqual([]);
		expect(await db.selectFrom("sessions").select("id").where("owner_user_id", "=", aliceId).execute()).toHaveLength(
			sessionsBefore.length,
		);
		// A draft has no running turn to stop.
		fake.text(userId, "/stop");
		await fake.waitForSent((call) => sentText(call).includes("no running session"));

		// /model picks a page and a slot, and the draft's model becomes the user's default.
		const available = models.available();
		const picked = available[3];
		if (!picked) throw new Error("no fourth offered model");
		fake.text(userId, "/model");
		const list = await fake.waitForSent((call) => sentText(call).includes("Choose a model (page 1 of"));
		const choose = buttonsOf(list).find((button) => button.callback_data.startsWith("model:1:3:"));
		expect(choose).toBeDefined();
		await pressButton(userId, choose?.callback_data ?? "");
		expect((await getUserSettings(db, aliceId)).defaultModel).toMatchObject({
			provider: picked.provider,
			modelId: picked.modelId,
		});

		// /think offers only the levels of that model and also writes the user default.
		fake.text(userId, "/think");
		const thinking = await fake.waitForSent((call) => sentText(call).includes("Thinking level for"));
		const medium = buttonsOf(thinking).find((button) => button.text.replace("✓ ", "") === "Medium");
		expect(medium?.callback_data).toMatch(/^think:medium:[0-9a-f]{8}$/);
		const thinkingConfirmed = await pressButton(userId, medium?.callback_data ?? "");
		expect(sentText(thinkingConfirmed)).toContain("Thinking level set to Medium.");
		expect((await getUserSettings(db, aliceId)).defaultModel).toMatchObject({
			provider: picked.provider,
			modelId: picked.modelId,
			thinkingLevel: "medium",
		});

		// /rules writes the draft and the user default.
		fake.text(userId, "/rules");
		const rules = await fake.waitForSent((call) => sentText(call).includes("Rule preset:"));
		expect(buttonsOf(rules).find((button) => button.text === "✓ Ask")).toBeDefined();
		const autoReview = buttonsOf(rules).find((button) => button.callback_data === "rules:auto_review");
		const rulesConfirmed = await pressButton(userId, autoReview?.callback_data ?? "");
		expect(sentText(rulesConfirmed)).toContain("Rule preset set to Auto Review.");
		expect((await getUserSettings(db, aliceId)).defaultRulePreset).toBe("auto_review");

		// /extensions changes only the draft; it toggles in place.
		fake.text(userId, "/extensions");
		const extensions = await fake.waitForSent((call) => sentText(call).includes("Extensions (page 1 of"));
		const ext = buttonsOf(extensions).find((button) => button.text === "✓ ext-1");
		expect(ext?.callback_data).toMatch(/^ext:1:\d+:[0-9a-f]{8}$/);
		const toggled = await pressButton(userId, ext?.callback_data ?? "");
		expect(buttonsOf(toggled).some((button) => button.text === "ext-1")).toBe(true);

		const savedDraft = JSON.parse((await rawThreadFor(userId))?.draft ?? "{}") as {
			model: { provider: string; modelId: string; thinkingLevel?: string };
			rulePreset: string;
			disabledExtensions: string[];
		};
		expect(savedDraft.model).toEqual({ provider: picked.provider, modelId: picked.modelId, thinkingLevel: "medium" });
		expect(savedDraft.rulePreset).toBe("auto_review");
		expect(savedDraft.disabledExtensions).toContain("ext-1");

		// The first ordinary message creates the session with the draft and sends the notice before the answer.
		manyFaux.setResponses([fauxAssistantMessage("draft started answer")]);
		const before = fake.calls.length;
		fake.text(userId, "start it");
		const notice = await fake.waitForSent(
			(call) => fake.calls.indexOf(call) >= before && sentText(call).includes("Started a new session."),
		);
		const answer = await fake.waitForSent(
			(call) =>
				fake.calls.indexOf(call) > fake.calls.indexOf(notice) && sentText(call).includes("draft started answer"),
		);
		expect(fake.calls.indexOf(notice)).toBeLessThan(fake.calls.indexOf(answer));
		await runtime.waitForIdle();
		const thread = await threadFor(userId);
		const session = await runtime.getSession(thread?.session_id ?? "");
		expect(session?.model).toMatchObject({
			provider: picked.provider,
			modelId: picked.modelId,
			thinkingLevel: "medium",
		});
		expect(session?.rules?.rulePreset).toBe("auto_review");
		const row = await db
			.selectFrom("sessions")
			.select("disabled_extensions")
			.where("id", "=", thread?.session_id ?? "")
			.executeTakeFirst();
		expect(JSON.parse(row?.disabled_extensions ?? "[]")).toEqual(["ext-1"]);
		await patchUserSettings(db, aliceId, { defaultModel: null, defaultRulePreset: null });
	});

	it("changes a session's model, thinking level, rules and extensions from chat", async () => {
		const userId = 9304;
		await link(userId);
		const thread = await chatSession(userId);

		// /model on the session.
		const available = models.available();
		const picked = available[3];
		if (!picked) throw new Error("no fourth offered model");
		fake.text(userId, "/model");
		const list = await fake.waitForSent((call) => sentText(call).includes("Choose a model (page 1 of"));
		const choose = buttonsOf(list).find((button) => button.callback_data.startsWith("model:1:3:"));
		await pressButton(userId, choose?.callback_data ?? "");
		expect((await runtime.getSession(thread.sessionId))?.model).toMatchObject({
			provider: picked.provider,
			modelId: picked.modelId,
		});

		// /think of that model; a level press edits the message to confirm.
		fake.text(userId, "/think");
		const thinking = await fake.waitForSent((call) => sentText(call).includes("Thinking level for"));
		const high = buttonsOf(thinking).find((button) => button.text.replace("✓ ", "") === "High");
		const levelConfirmed = await pressButton(userId, high?.callback_data ?? "");
		expect(sentText(levelConfirmed)).toContain("Thinking level set to High.");
		expect((await runtime.getSession(thread.sessionId))?.model.thinkingLevel).toBe("high");

		// A model without levels gets a short message.
		await runtime.configure(thread.sessionId, { model: model() });
		fake.text(userId, "/think");
		await fake.waitForSent((call) => sentText(call).includes("has no thinking levels."));

		// /rules sets the session's preset and is audited like the WebUI's change.
		fake.text(userId, "/rules");
		const rules = await fake.waitForSent((call) => sentText(call).includes("Rule preset:"));
		const yolo = buttonsOf(rules).find((button) => button.callback_data === "rules:yolo");
		const rulesConfirmed = await pressButton(userId, yolo?.callback_data ?? "");
		expect(sentText(rulesConfirmed)).toContain("Rule preset set to Yolo.");
		expect((await runtime.getSession(thread.sessionId))?.rules?.rulePreset).toBe("yolo");
		const changed = await db
			.selectFrom("audit_events")
			.select(["action", "detail"])
			.where("action", "=", "rules.changed")
			.where("target_id", "=", thread.sessionId)
			.executeTakeFirst();
		expect(JSON.parse(changed?.detail ?? "{}")).toMatchObject({ channel: "testbot", via: "telegram" });

		// /extensions pages, toggles in place and writes sessions.disabled_extensions.
		fake.text(userId, "/extensions");
		const first = await fake.waitForSent((call) => sentText(call).includes("Extensions (page 1 of"));
		const next = buttonsOf(first).find((button) => button.text === "Next ›");
		const second = await pressButton(userId, next?.callback_data ?? "");
		expect(sentText(second)).toContain("page 2 of");
		const ext = buttonsOf(second).find((button) => button.text === "✓ ext-4");
		const toggled = await pressButton(userId, ext?.callback_data ?? "");
		expect(buttonsOf(toggled).some((button) => button.text === "ext-4")).toBe(true);
		const row = await db
			.selectFrom("sessions")
			.select("disabled_extensions")
			.where("id", "=", thread.sessionId)
			.executeTakeFirst();
		expect(JSON.parse(row?.disabled_extensions ?? "[]")).toEqual(["ext-4"]);
	});

	it("replies that there is no session yet to commands before a draft or a message", async () => {
		const userId = 9305;
		await link(userId);
		for (const [index, command] of ["/model", "/think", "/rules", "/extensions"].entries()) {
			fake.text(userId, command);
			await waitForMessage("There is no session in this chat yet.", index + 1);
		}
	});

	it("discards a draft when /sessions switches the chat to a session", async () => {
		const userId = 9306;
		await link(userId);
		const alice = { sessionId: "test", userId: aliceId, username: "alice", kind: "member" as const };
		const session = await runtime.createSession(alice, { model: model(), rulePreset: "yolo" });
		fake.text(userId, "/new");
		await fake.waitForSent((call) => sentText(call).startsWith("New session draft:"));
		expect((await rawThreadFor(userId))?.session_id).toBeNull();
		fake.text(userId, "/sessions");
		const list = await fake.waitForSent((call) => sentText(call).includes("Switch this chat to a session"));
		const button = buttonsOf(list).find((entry) => entry.callback_data === `switch:${session.id}`);
		expect(button).toBeDefined();
		fake.callback(userId, button?.callback_data ?? "", {});
		const deadline = Date.now() + 5_000;
		while ((await rawThreadFor(userId))?.session_id !== session.id && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		const thread = await rawThreadFor(userId);
		expect(thread?.session_id).toBe(session.id);
		expect(thread?.draft).toBeNull();
	});

	it("escapes a session title interpolated into a framework text", async () => {
		const userId = 9307;
		await link(userId);
		const thread = await chatSession(userId);
		await db.updateTable("sessions").set({ title: "*x* [a](b)" }).where("id", "=", thread.sessionId).execute();
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
		const wait = await fake.waitForSent((call) => sentText(call).includes("is used up"));
		expect(sentText(wait)).toContain('"\\*x\\* \\[a\\]\\(b\\)"');
	});

	it("numbers model choices across pages and chooses one by number", async () => {
		const userId = 9401;
		await link(userId);
		const thread = await chatSession(userId);
		const available = models.available();
		expect(available.length).toBeGreaterThanOrEqual(12);

		fake.text(userId, "/model");
		const first = await fake.waitForSent((call) => sentText(call).includes("Choose a model (page 1 of"));
		const firstText = sentText(first);
		expect(firstText).toContain(available[0]?.name);
		expect(firstText).toContain(`5. ${available[4]?.name}`);
		expect(firstText).not.toContain("6. ");
		expect(firstText).toContain("Send /model and a number to choose, /model page 2 for the next page.");

		fake.text(userId, "/model page 2");
		const second = await fake.waitForSent((call) => sentText(call).includes("Choose a model (page 2 of"));
		expect(sentText(second)).toContain(`6. ${available[5]?.name}`);
		expect(sentText(second)).toContain(`10. ${available[9]?.name}`);
		expect(sentText(second)).toContain("/model page 3 for the next page.");

		const target = available[6];
		if (!target) throw new Error("no seventh offered model");
		fake.text(userId, "/model 7");
		const confirmed = await fake.waitForSent((call) => sentText(call).includes("Model set to"));
		expect(sentText(confirmed)).toContain(target.name);
		expect((await runtime.getSession(thread.sessionId))?.model).toMatchObject({
			provider: target.provider,
			modelId: target.modelId,
		});

		fake.text(userId, "/model 99");
		await fake.waitForSent((call) => sentText(call).includes("That is not a choice. Send /model for the list."));
		fake.text(userId, "/model page x");
		await waitForMessage("That is not a choice. Send /model for the list.", 2);
	});

	it("switches sessions by number and names the session it chose", async () => {
		const userId = 9402;
		await link(userId);
		const alice = { sessionId: "test", userId: aliceId, username: "alice", kind: "member" as const };
		const session = await runtime.createSession(alice, {
			title: "numbered session",
			model: model(),
			rulePreset: "yolo",
		});
		await db
			.updateTable("sessions")
			.set({ updated_at: "2030-01-01T00:00:00.000Z" })
			.where("id", "=", session.id)
			.execute();
		fake.text(userId, "/sessions");
		const list = await fake.waitForSent((call) => sentText(call).includes("1. numbered session"));
		expect(sentText(list)).toContain("Send /sessions and a number to choose");
		fake.text(userId, "/sessions 1");
		const switched = await fake.waitForSent((call) => sentText(call).includes('Switched to "numbered session".'));
		expect(fake.calls.indexOf(switched)).toBeGreaterThan(fake.calls.indexOf(list));
		const thread = await rawThreadFor(userId);
		expect(thread?.session_id).toBe(session.id);
	});

	it("toggles an extension by its global number", async () => {
		const userId = 9403;
		await link(userId);
		const thread = await chatSession(userId);
		const names = (
			await db.selectFrom("extensions").select("name").where("enabled", "=", 1).orderBy("name").execute()
		).map((row) => row.name);
		expect(names.length).toBeGreaterThanOrEqual(7);
		const sixth = names[5];
		if (!sixth) throw new Error("no sixth extension");

		fake.text(userId, "/extensions page 2");
		const page = await fake.waitForSent((call) => sentText(call).includes("Extensions (page 2 of"));
		expect(sentText(page)).toMatch(new RegExp(`6\\. (✓ )?${sixth}`));
		expect(sentText(page)).toContain(
			"Send /extensions and a number to choose, /extensions page 1 for the previous page.",
		);

		fake.text(userId, "/extensions 6");
		const toggled = await fake.waitForSent((call) => sentText(call).includes(`Extension ${sixth} is now off.`));
		expect(toggled).toBeDefined();
		const row = await db
			.selectFrom("sessions")
			.select("disabled_extensions")
			.where("id", "=", thread.sessionId)
			.executeTakeFirst();
		expect(JSON.parse(row?.disabled_extensions ?? "[]")).toContain(sixth);

		fake.text(userId, "/extensions 99");
		await fake.waitForSent((call) => sentText(call).includes("That is not a choice. Send /extensions for the list."));
	});

	it("sets the thinking level and rule preset by their ids and refuses unknown ones", async () => {
		const userId = 9404;
		await link(userId);
		const thread = await chatSession(userId);
		// The default model has no thinking levels; a model with several is needed to choose one.
		fake.text(userId, "/model 4");
		await fake.waitForSent((call) => sentText(call).includes("Model set to"));

		fake.text(userId, "/think");
		const thinking = await fake.waitForSent((call) => sentText(call).includes("Thinking level for"));
		expect(sentText(thinking)).toContain("- Low (low)");
		expect(sentText(thinking)).toContain("Send /think with a level id");
		fake.text(userId, "/think HIGH");
		const levelSet = await fake.waitForSent((call) => sentText(call).includes("Thinking level set to High."));
		expect(levelSet).toBeDefined();
		expect((await runtime.getSession(thread.sessionId))?.model.thinkingLevel).toBe("high");
		fake.text(userId, "/think louder");
		await fake.waitForSent((call) => sentText(call).includes("That is not a choice. Send /think for the list."));

		fake.text(userId, "/rules");
		const rules = await fake.waitForSent((call) => sentText(call).includes("Rule preset:"));
		expect(sentText(rules)).toContain("Ask (ask)");
		expect(sentText(rules)).toContain("Send /rules with a preset id");
		fake.text(userId, "/rules YOLO");
		const presetSet = await fake.waitForSent((call) => sentText(call).includes("Rule preset set to Yolo."));
		expect(presetSet).toBeDefined();
		expect((await runtime.getSession(thread.sessionId))?.rules?.rulePreset).toBe("yolo");
		fake.text(userId, "/rules chaos");
		await fake.waitForSent((call) => sentText(call).includes("That is not a choice. Send /rules for the list."));
	});

	it("validates Satori gateway settings on the admin route", async () => {
		const invalidUrl = await call(app, "/api/channels/satori-bad-url", {
			method: "PUT",
			cookie: adminCookie,
			body: {
				kind: "satori",
				token: "gateway-token",
				config: { url: "ftp://example.test/satori", platform: "telegram", botId: "424242" },
			},
		});
		expect(invalidUrl.status).toBe(400);
		const emptyPlatform = await call(app, "/api/channels/satori-empty", {
			method: "PUT",
			cookie: adminCookie,
			body: {
				kind: "satori",
				token: "gateway-token",
				config: { url: "http://127.0.0.1:9/satori", platform: " ", botId: "424242" },
			},
		});
		expect(emptyPlatform.status).toBe(400);
		const missingConfig = await call(app, "/api/channels/satori-missing", {
			method: "PUT",
			cookie: adminCookie,
			body: { kind: "satori", token: "gateway-token" },
		});
		expect(missingConfig.status).toBe(400);
		const noKind = await call(app, "/api/channels/no-kind", {
			method: "PUT",
			cookie: adminCookie,
			body: { id: "x" },
		});
		expect(noKind.status).toBe(400);

		const saved = await call(app, "/api/channels/satori-disabled", {
			method: "PUT",
			cookie: adminCookie,
			body: {
				kind: "satori",
				token: "gateway-token",
				config: { url: "http://127.0.0.1:9/satori", platform: "telegram", botId: "424242" },
				linkInstructions: "Open @ops_bot\nThen send /link <code>.",
			},
		});
		expect(saved.status).toBe(200);
		const body = (await saved.json()) as { channel: Record<string, unknown> };
		expect(body.channel).toMatchObject({
			kind: "satori",
			enabled: true,
			hasCredentials: true,
			config: { url: "http://127.0.0.1:9/satori", platform: "telegram", botId: "424242" },
			linkInstructions: "Open @ops_bot\nThen send /link <code>.",
		});

		const accounts = await call(app, "/api/channel-accounts", { cookie: adminCookie });
		const accountsBody = (await accounts.json()) as {
			channels: { name: string; linkInstructions: string | null }[];
		};
		expect(accountsBody.channels.find((channel) => channel.name === "satori-disabled")?.linkInstructions).toBe(
			"Open @ops_bot\nThen send /link <code>.",
		);
		// The kind of an existing channel cannot change under it.
		const changed = await call(app, "/api/channels/satori-disabled", {
			method: "PUT",
			cookie: adminCookie,
			body: { kind: "telegram", token: fake.token },
		});
		expect(changed.status).toBe(400);
		await channels.deleteChannel(
			{ sessionId: "test", userId: adminId, username: "admin", kind: "admin" },
			"satori-disabled",
		);
	});

	it("ignores removed channel defaults and starts chat sessions from the user's settings", async () => {
		const res = await call(app, "/api/channels/testbot", {
			method: "PUT",
			cookie: adminCookie,
			body: { token: fake.token, defaultModel: model(), defaultRulePreset: "yolo" },
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { channel: Record<string, unknown> };
		expect(body.channel).not.toHaveProperty("defaultModel");
		expect(body.channel).not.toHaveProperty("defaultRulePreset");

		await patchUserSettings(db, aliceId, {
			defaultModel: { provider: manyFaux.provider.id, modelId: "many-1", thinkingLevel: "high" },
			defaultRulePreset: "yolo",
		});
		try {
			const userId = 9308;
			await link(userId);
			manyFaux.setResponses([fauxAssistantMessage("user defaults answer")]);
			fake.text(userId, "use my defaults");
			await fake.waitForSent((call) => sentText(call).includes("user defaults answer"));
			await runtime.waitForIdle();
			const thread = await threadFor(userId);
			const session = await runtime.getSession(thread?.session_id ?? "");
			expect(session?.model).toMatchObject({ provider: "many-faux", modelId: "many-1", thinkingLevel: "high" });
			expect(session?.rules?.rulePreset).toBe("yolo");
		} finally {
			await patchUserSettings(db, aliceId, { defaultModel: null, defaultRulePreset: null });
		}
	});
});

/** Sends /new and waits for the draft it records, not for an earlier message. */
async function newSession(userId: number, options?: { topicId?: number }): Promise<void> {
	const before = fake.calls.length;
	fake.text(userId, "/new", options);
	await fake.waitForSent(
		(call) => fake.calls.indexOf(call) >= before && sentText(call).startsWith("New session draft:"),
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

/** Presses a management button on message 7777 and returns the edit it made. */
async function pressButton(userId: number, data: string): Promise<FakeCall> {
	return pressPage(userId, data);
}

/** Creates a chat session with one message and returns its thread row, with that message as the session's source. */
async function chatSession(userId: number) {
	await newSession(userId);
	// The draft's first ordinary message creates its session and makes the thread the message's source.
	faux.setResponses([fauxAssistantMessage("chat session ready")]);
	fake.text(userId, "ready");
	await fake.waitForSent((call) => sentText(call).includes("chat session ready"));
	await runtime.waitForIdle();
	const thread = await threadFor(userId);
	if (!thread) throw new Error("no thread");
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
