import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelConfig } from "../src/agent/models.ts";
import { AgentRuntime } from "../src/agent/runtime.ts";
import { Audit } from "../src/audit/audit.ts";
import { ChannelManager } from "../src/channels/manager.ts";
import { SatoriChannel } from "../src/channels/satori.ts";
import { Cluster } from "../src/cluster/cluster.ts";
import { TaskGroups } from "../src/cluster/task-groups.ts";
import { MasterKey } from "../src/keys/master-key.ts";
import { createLibraryBackend, type LibraryBackend } from "../src/library/backend.ts";
import { updateLibraryLimits } from "../src/library/files.ts";
import { findUserLibrary } from "../src/library/library.ts";
import type { Db } from "../src/storage/db.ts";
import { defaultOrgId } from "../src/storage/org.ts";
import { createUser } from "../src/users/service.ts";
import { patchUserSettings } from "../src/users/settings.ts";
import { type App, call, login, makeApp } from "./helpers/api.ts";
import { openTestDb } from "./helpers/db.ts";
import { type FakeSatori, type FakeSatoriCall, startFakeSatori } from "./helpers/fake-satori.ts";
import { PNG_1PX } from "./helpers/fake-telegram.ts";

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
let fake: FakeSatori;
let channels: ChannelManager;
let backend: LibraryBackend;
let root: string;
let adminCookie = "";
let aliceCookie = "";
let aliceId = "";
let adminId = "";
const faux = fauxProvider();
const titleFaux = fauxProvider({ provider: "title-faux" });
const model = () => ({ provider: faux.provider.id, modelId: faux.getModel().id });

beforeAll(async () => {
	db = await openTestDb("sqlite");
	root = await mkdtemp(join(tmpdir(), "crhs-satori-"));
	backend = createLibraryBackend({ backend: "local" }, root);
	audit = new Audit(db);
	orgId = await defaultOrgId(db);
	cluster = new Cluster(db, { audit, libraryBackend: backend });
	taskGroups = new TaskGroups(db, cluster, { audit });
	masterKey = MasterKey.generate();
	models = new ModelConfig(db, masterKey);
	models.addProvider(faux.provider);
	models.addProvider(titleFaux.provider);
	await models.reload();
	const storage = new MemoryStorage();
	runtime = await AgentRuntime.open({ db, storage, models, cluster, taskGroups, audit });
	await runtime.modelPresets.update("title", {
		model: { provider: titleFaux.provider.id, modelId: titleFaux.getModel().id },
	});
	const admin = await createUser(db, { username: "admin", kind: "admin", password: "password-123" });
	adminId = admin.id;
	const alice = await createUser(db, { username: "alice", kind: "member", password: "password-123" });
	aliceId = alice.id;
	fake = await startFakeSatori({ token: "satori-secret-token", replayOnIdentify: true });
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
		backoffBaseMs: 20,
		backoffMaxMs: 100,
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
	const created = await call(app, "/api/channels/satoribot", {
		method: "PUT",
		cookie: adminCookie,
		body: {
			kind: "satori",
			token: fake.token,
			config: { url: fake.url, platform: "telegram", botId: "424242" },
			linkInstructions: "Open the bot in a private chat.",
		},
	});
	expect(created.status).toBe(200);
	await waitForState("satoribot", "connected");
	await fake.waitForIdentify();
});

afterAll(async () => {
	await channels.stop();
	await runtime.waitForIdle();
	await runtime.close();
	await fake.close();
	await db.destroy();
	await rm(root, { recursive: true, force: true });
});

const waitForState = async (name: string, state: string): Promise<void> => {
	const deadline = Date.now() + 5_000;
	while (channels.status(name).state !== state) {
		if (Date.now() > deadline) {
			throw new Error(`channel ${name} is ${channels.status(name).state}: ${channels.status(name).lastError}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
};

const contentOf = (call: FakeSatoriCall): string => (typeof call.body.content === "string" ? call.body.content : "");

const waitForContent = async (needle: string, timeoutMs = 5_000): Promise<FakeSatoriCall> => {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const found = fake.calls.find((call) => call.method === "create" && contentOf(call).includes(needle));
		if (found) return found;
		if (Date.now() > deadline) throw new Error(`timed out waiting for content containing ${needle}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
};

const link = async (userId: string): Promise<void> => {
	const res = await call(app, "/api/channel-link-codes", { method: "POST", cookie: aliceCookie, body: {} });
	expect(res.status).toBe(200);
	const { code } = (await res.json()) as { code: string };
	fake.message(userId, `/link ${code}`);
	await waitForContent("Linked.");
};

const chatSession = async (userId: string): Promise<{ id: string; session_id: string }> => {
	faux.setResponses([fauxAssistantMessage("chat session ready")]);
	fake.message(userId, "ready");
	await waitForContent("chat session ready");
	await runtime.waitForIdle();
	const thread = await db
		.selectFrom("channel_threads")
		.selectAll()
		.where("chat_id", "=", userId)
		.where("topic_id", "is", null)
		.executeTakeFirstOrThrow();
	expect(thread.session_id).not.toBeNull();
	return { id: thread.id, session_id: thread.session_id ?? "" };
};

beforeEach(() => {
	// Calls are per test: a wait must never match a message an earlier test received.
	fake.calls.length = 0;
	fake.proxyRequests.length = 0;
});

describe("satori channels", () => {
	it("connects with the stored sn, links an account and submits a private message", async () => {
		const userId = "7101";
		expect(channels.status("satoribot").account).toBe("test_bot");
		expect(channels.status("satoribot").logins).toEqual([
			{ platform: "telegram", id: "424242", name: "test_bot", online: true },
		]);
		await link(userId);
		const account = await db
			.selectFrom("channel_accounts")
			.selectAll()
			.where("platform_user_id", "=", userId)
			.where("platform", "=", "satori:telegram")
			.executeTakeFirstOrThrow();
		expect(account.user_id).toBe(aliceId);

		faux.setResponses([fauxAssistantMessage("satori answer")]);
		fake.message(userId, "hello from satori");
		const sent = await waitForContent("satori answer");
		expect(contentOf(sent)).toContain("satori answer");
		expect(sent.headers.authorization).toBe(`Bearer ${fake.token}`);
		expect(sent.headers["satori-platform"]).toBe("telegram");
		expect(sent.headers["satori-user-id"]).toBe("424242");
		expect(sent.headers["x-platform"]).toBe("telegram");
		expect(sent.headers["x-self-id"]).toBe("424242");
		expect(sent.headers["content-type"]).toBe("application/json");
		expect(fake.identifies[0]?.token).toBe(fake.token);
		expect(fake.identifies[0]?.sn).toBe(0);
		await runtime.waitForIdle();
	});

	it("drops guild messages and messages for another login before any file handling", async () => {
		fake.addFile("https://cdn.example/guild.png", { bytes: PNG_1PX, name: "guild.png", mediaType: "image/png" });
		fake.addFile("https://cdn.example/other.png", { bytes: PNG_1PX, name: "other.png", mediaType: "image/png" });
		fake.sendEvent({
			channel: { id: "-100123", type: 0, name: "a guild" },
			user: { id: "7102", name: "Groupie", nick: "Groupie" },
			message: { id: "g-1", content: '<img src="https://cdn.example/guild.png" title="guild.png"/>' },
		});
		const otherId = "999999";
		fake.sendEvent({
			login: {
				sn: 0,
				adapter: "fake",
				platform: "telegram",
				user: { id: otherId, name: "Other Bot", nick: "other_bot", isBot: true },
				selfId: otherId,
				status: 1,
				features: [],
			},
			selfId: otherId,
			platform: "telegram",
			channel: { id: "7103", type: 1 },
			user: { id: "7103", name: "Someone", nick: "Someone" },
			message: { id: "o-1", content: '<img src="https://cdn.example/other.png" title="other.png"/>' },
		});
		await new Promise((resolve) => setTimeout(resolve, 250));
		expect(fake.proxyRequests).toHaveLength(0);
		expect(fake.calls.filter((call) => call.method === "create")).toHaveLength(0);
	});

	it("sends assistant text as escaped plain text and splits long text", async () => {
		const userId = "7104";
		await link(userId);
		await chatSession(userId);

		faux.setResponses([fauxAssistantMessage("use <button> and <b>bold</b>\nthen stop")]);
		fake.message(userId, "show markup");
		const escaped = await waitForContent("&lt;button&gt;");
		expect(contentOf(escaped)).toContain("&lt;b&gt;bold&lt;/b&gt;");
		expect(contentOf(escaped)).not.toContain("<button>");
		expect(contentOf(escaped)).toContain("\nthen stop");
		await runtime.waitForIdle();

		fake.calls.length = 0;
		faux.setResponses([fauxAssistantMessage("x".repeat(5_000))]);
		fake.message(userId, "long text");
		const deadline = Date.now() + 5_000;
		while (fake.calls.filter((call) => call.method === "create").length < 2) {
			if (Date.now() > deadline) throw new Error("timed out waiting for the long text to be split");
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		const chunks = fake.calls.filter((call) => call.method === "create").map(contentOf);
		expect(chunks).toHaveLength(2);
		for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(4_000);
		expect(chunks.join("")).toBe("x".repeat(5_000));
		await runtime.waitForIdle();
	});

	it("downloads a file from another origin only through the gateway proxy", async () => {
		const userId = "7105";
		await link(userId);
		await chatSession(userId);
		const src = "https://cdn.example/photo.png";
		fake.addFile(src, { bytes: PNG_1PX, name: "photo.png", mediaType: "image/png" });
		faux.setResponses([fauxAssistantMessage("nice photo")]);
		fake.sendEvent({
			channel: { id: userId, type: 1 },
			user: { id: userId, name: "Tester", nick: "Tester" },
			message: { id: "p-1", content: `<img src="${src}" title="my-photo.png"/>` },
		});
		await waitForContent("nice photo");
		const proxied = await fake.waitForProxy((path) => path === src);
		expect(proxied.path).toBe(src);
		expect(proxied.headers.authorization).toBe(`Bearer ${fake.token}`);
		const file = await db
			.selectFrom("library_files")
			.selectAll()
			.where("path", "like", "attachments/%")
			.executeTakeFirst();
		expect(file?.path).toContain("my-photo.png");
		await runtime.waitForIdle();
	});

	it("fetches a file on the gateway's own origin directly and decodes a data URL in place", async () => {
		const userId = "7110";
		await link(userId);
		await chatSession(userId);
		const own = `${fake.origin}/telegram/424242/photos/own.png`;
		fake.addFile(own, { bytes: PNG_1PX, name: "own.png", mediaType: "image/png" });
		const inline = `data:image/png;base64,${Buffer.from(PNG_1PX).toString("base64")}`;
		faux.setResponses([fauxAssistantMessage("two photos")]);
		fake.sendEvent({
			channel: { id: userId, type: 1 },
			user: { id: userId, name: "Tester", nick: "Tester" },
			message: { id: "p-2", content: `<img src="${own}" title="own.png"/><img src="${inline}" title="inline.png"/>` },
		});
		await waitForContent("two photos");
		expect(fake.directRequests).toContain("/telegram/424242/photos/own.png");
		expect(fake.proxyRequests).toHaveLength(0);
		const files = await db.selectFrom("library_files").select("path").where("path", "like", "attachments/%").execute();
		expect(files.map((file) => file.path).join(" ")).toContain("inline.png");
		await runtime.waitForIdle();
	});

	it("sends approval hints instead of buttons and links a notification without a thread", async () => {
		const userId = "7106";
		await link(userId);
		const thread = await chatSession(userId);
		const callId = await insertExternalCall(thread.session_id, "satori-call");
		await wakeWait(thread.session_id);
		const approval = await waitForContent(`/approve ${callId}`);
		expect(contentOf(approval)).toContain(`/reject ${callId} [reason]`);
		expect(approval.body.reply_markup).toBeUndefined();

		const account = await db
			.selectFrom("channel_accounts")
			.select("id")
			.where("platform_user_id", "=", userId)
			.executeTakeFirstOrThrow();
		await patchUserSettings(db, aliceId, { defaultChannelAccountId: account.id, showProgress: false });
		try {
			channels.presence.forget(aliceId);
			const alice = { sessionId: "test", userId: aliceId, username: "alice", kind: "member" as const };
			const plain = await runtime.createSession(alice, { model: model(), rulePreset: "yolo" });
			await db.updateTable("sessions").set({ state: "running" }).where("id", "=", plain.id).execute();
			const offlineId = await insertExternalCall(plain.id, "satori-offline");
			await wakeWait(plain.id);
			const note = await waitForContent(`/approve ${offlineId}`);
			expect(contentOf(note)).toContain("Open it in the WebUI: https://crh.example/sessions/");
			expect(note.body.reply_markup).toBeUndefined();
		} finally {
			await patchUserSettings(db, aliceId, { defaultChannelAccountId: null, showProgress: true });
			await db
				.updateTable("external_calls")
				.set({ state: "rejected" })
				.where("state", "=", "awaiting_approval")
				.execute();
		}
	});

	it("deletes a decided approval card, and edits it when the gateway refuses deletion", async () => {
		const userId = "7120";
		await link(userId);
		// Settle cards other tests left waiting so the injected failure hits only this test's card.
		await channels.refreshAllWaits();
		const thread = await chatSession(userId);
		const first = await insertExternalCall(thread.session_id, "satori-delete-ok");
		await wakeWait(thread.session_id);
		await waitForContent(`/approve ${first}`);
		const deletesBefore = fake.callsOf("delete").length;
		fake.message(userId, `/approve ${first}`);
		await fake.waitForCall("delete", () => fake.callsOf("delete").length > deletesBefore);

		const second = await insertExternalCall(thread.session_id, "satori-delete-refused");
		await wakeWait(thread.session_id);
		const secondCard = await waitForContent(`/approve ${second}`);
		fake.failNextDelete();
		fake.message(userId, `/reject ${second} not needed`);
		// The fallback edits the card into the ending (whichever path settles it), keeping what was being approved.
		const edited = await fake.waitForCall("update", (call) => contentOf(call).includes("Rejected"));
		expect(contentOf(edited)).toContain(`/approve ${second}`);
		expect(contentOf(edited)).toContain("not needed");
		expect(contentOf(secondCard)).toContain(`/approve ${second}`);
	});

	it("reports a configured bot that READY does not list as unavailable", async () => {
		const other = await startFakeSatori({
			token: "other-token",
			logins: [{ platform: "telegram", id: "111", name: "Someone Else", status: 1 }],
		});
		try {
			const saved = await call(app, "/api/channels/satori-missing", {
				method: "PUT",
				cookie: adminCookie,
				body: {
					kind: "satori",
					token: other.token,
					config: { url: other.url, platform: "telegram", botId: "424242" },
				},
			});
			expect(saved.status).toBe(200);
			const deadline = Date.now() + 5_000;
			while (channels.status("satori-missing").lastError === null && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
			const status = channels.status("satori-missing");
			expect(status.state).toBe("unavailable");
			expect(status.lastError).toContain("no login for platform telegram and bot 424242");
			expect(status.logins?.[0]).toMatchObject({ platform: "telegram", id: "111", online: true });
			await channels.deleteChannel(
				{ sessionId: "test", userId: adminId, username: "admin", kind: "admin" },
				"satori-missing",
			);
		} finally {
			await other.close();
		}
	});

	it("redacts the gateway token from a connection error", async () => {
		const token = "redact-me-please";
		const other = await startFakeSatori({ token, replayOnIdentify: false });
		try {
			const saved = await call(app, "/api/channels/satori-redact", {
				method: "PUT",
				cookie: adminCookie,
				body: {
					kind: "satori",
					token,
					config: { url: other.url, platform: "telegram", botId: "424242" },
				},
			});
			expect(saved.status).toBe(200);
			await other.waitForIdentify();
			const deadline = Date.now() + 5_000;
			while (channels.status("satori-redact").state !== "connected" && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
			expect(channels.status("satori-redact").state).toBe("connected");
			other.rejectConnections(`the gateway rejected ${token}`);
			const deadline2 = Date.now() + 5_000;
			while (
				(channels.status("satori-redact").lastError === null ||
					!channels.status("satori-redact").lastError?.includes("<satori token>")) &&
				Date.now() < deadline2
			) {
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
			const status = channels.status("satori-redact");
			expect(status.lastError).not.toContain(token);
			expect(status.lastError).toContain("<satori token>");
			await channels.deleteChannel(
				{ sessionId: "test", userId: adminId, username: "admin", kind: "admin" },
				"satori-redact",
			);
		} finally {
			await other.close();
		}
	});

	it("resumes from the stored sn after a reconnect and does not re-handle", async () => {
		const userId = "7107";
		await link(userId);
		faux.setResponses([fauxAssistantMessage("reconnect answer")]);
		fake.message(userId, "reconnect hello");
		await waitForContent("reconnect answer");
		await runtime.waitForIdle();
		const responses = fake.calls.filter(
			(call) => call.method === "create" && contentOf(call).includes("reconnect answer"),
		);
		expect(responses).toHaveLength(1);
		const cursor = Number(
			(await db.selectFrom("channels").select("cursor").where("name", "=", "satoribot").executeTakeFirst())?.cursor,
		);
		expect(cursor).toBeGreaterThan(0);
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
			backoffBaseMs: 20,
			backoffMaxMs: 100,
		});
		await channels.start();
		await waitForState("satoribot", "connected");
		const identify = await fake.waitForIdentify(2);
		expect(identify.sn).toBe(cursor);
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(
			fake.calls.filter((call) => call.method === "create" && contentOf(call).includes("reconnect answer")),
		).toHaveLength(1);
	});

	it("waits for an in-flight event before reconnecting, so the gateway does not replay it", async () => {
		const gateway = await startFakeSatori({ token: "satori-replay-token", replayOnIdentify: true });
		let release = (): void => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const handled: number[] = [];
		const cursors: number[] = [];
		const channel = new SatoriChannel({
			channelId: "replay-bot",
			url: gateway.url,
			token: gateway.token,
			platform: "telegram",
			botId: "424242",
			initialCursor: 0,
			onCursor: async (sn) => {
				cursors.push(sn);
			},
			connection: { baseMs: 5, maxMs: 10, sleep: async () => {} },
		});
		channel.setHandlers({
			onMessage: async (message) => {
				handled.push(message.updateId);
				if (handled.length === 1) await gate;
			},
			onButton: async () => {},
			onGenerationStopped: async () => {},
		});
		channel.start();
		try {
			await gateway.waitForIdentify(1);
			const sn = gateway.message("8301", "slow event");
			await until(() => handled.length === 1);
			// The socket goes while the handler still holds the event; the reconnect must wait for it and send
			// the new sn, or the gateway replays this event and the handler runs it a second time.
			gateway.closeSocket("connection dropped");
			setTimeout(release, 50);
			await gateway.waitForIdentify(2, 3_000);
			expect(gateway.identifies[1]?.sn).toBe(sn);
			await until(() => cursors.length === 1);
			await new Promise((resolve) => setTimeout(resolve, 200));
			expect(handled).toEqual([sn]);
		} finally {
			release();
			await channel.stop();
			await gateway.close();
		}
	});

	it("sends bot texts as plain text without Markdown backslash escapes", async () => {
		await link("7109");
		fake.message("7109", "/help");
		const sent = await waitForContent("/unlink");
		expect(contentOf(sent)).toContain("/link &lt;code&gt;");
		expect(contentOf(sent)).not.toContain("\\");
	});

	it("resets the stored sn when the gateway URL or bot id changes", async () => {
		const admin = { sessionId: "test", userId: adminId, username: "admin", kind: "admin" as const };
		const first = await startFakeSatori({ token: fake.token });
		const second = await startFakeSatori({ token: fake.token });
		try {
			await channels.saveChannel(admin, "satori-reset", {
				kind: "satori",
				token: fake.token,
				config: { url: first.url, platform: "telegram", botId: "424242" },
			});
			await waitForState("satori-reset", "connected");
			expect((await first.waitForIdentify()).sn).toBe(0);

			// A stored sn from the first gateway must not resume a different gateway.
			await db.updateTable("channels").set({ cursor: "77" }).where("name", "=", "satori-reset").execute();
			await channels.saveChannel(admin, "satori-reset", {
				config: { url: second.url, platform: "telegram", botId: "424242" },
			});
			await waitForState("satori-reset", "connected");
			expect((await second.waitForIdentify()).sn).toBe(0);
			const stored = await db
				.selectFrom("channels")
				.select("cursor")
				.where("name", "=", "satori-reset")
				.executeTakeFirst();
			expect(stored?.cursor).toBeNull();

			// The bot id names the login on that gateway; another one is another identity.
			await db.updateTable("channels").set({ cursor: "77" }).where("name", "=", "satori-reset").execute();
			second.setLogins([{ platform: "telegram", id: "555", name: "Other Bot", nick: "other_bot", status: 1 }]);
			await channels.saveChannel(admin, "satori-reset", {
				config: { url: second.url, platform: "telegram", botId: "555" },
			});
			await waitForState("satori-reset", "connected");
			expect((await second.waitForIdentify(2)).sn).toBe(0);
		} finally {
			await channels.deleteChannel(admin, "satori-reset").catch(() => {});
			await first.close();
			await second.close();
		}
	});

	it("limits a proxied or inline file by the user's library single-file limit", async () => {
		const userId = "7201";
		await link(userId);
		await chatSession(userId);
		const library = await findUserLibrary(db, aliceId);
		if (!library) throw new Error("alice has no library");
		const previousLimit = library.row.max_file_bytes;
		await updateLibraryLimits(db, library.row.id, { fileBytes: 1024 });
		try {
			const src = "https://cdn.example/huge.bin";
			fake.addFile(src, {
				bytes: new Uint8Array(2048),
				name: "huge.bin",
				mediaType: "application/octet-stream",
				chunked: true,
			});
			fake.sendEvent({
				channel: { id: userId, type: 1 },
				user: { id: userId, name: "Tester", nick: "Tester" },
				message: { id: "big-1", content: `<file src="${src}" title="huge.bin"/>` },
			});
			await waitForContent("The file is larger than your library's limit of 1 KiB.");
			// The proxy download started but was stopped at the limit, and nothing reached the library.
			await fake.waitForProxy((path) => path === src);
			expect(
				await db.selectFrom("library_files").select("path").where("path", "like", "%huge.bin").executeTakeFirst(),
			).toBeUndefined();

			// A data URL is already in memory; its decoded length is what the limit checks.
			const inline = `data:application/octet-stream;base64,${Buffer.alloc(2048).toString("base64")}`;
			fake.sendEvent({
				channel: { id: userId, type: 1 },
				user: { id: userId, name: "Tester", nick: "Tester" },
				message: { id: "big-2", content: `<file src="${inline}" title="inline.bin"/>` },
			});
			await until(
				() =>
					fake.calls.filter(
						(call) =>
							call.method === "create" && contentOf(call).includes("The file is larger than your library's limit"),
					).length >= 2,
			);

			// Under the limit the file is stored and the message runs.
			const small = "https://cdn.example/small.bin";
			fake.addFile(small, { bytes: new Uint8Array(512), name: "small.bin", mediaType: "application/octet-stream" });
			faux.setResponses([fauxAssistantMessage("small satori file")]);
			fake.sendEvent({
				channel: { id: userId, type: 1 },
				user: { id: userId, name: "Tester", nick: "Tester" },
				message: { id: "small-1", content: `<file src="${small}" title="small.bin"/>` },
			});
			await waitForContent("small satori file");
			const saved = await db
				.selectFrom("library_files")
				.select("path")
				.where("path", "like", "%small.bin")
				.executeTakeFirst();
			expect(saved?.path).toContain("attachments/");
			await runtime.waitForIdle();
		} finally {
			await updateLibraryLimits(db, library.row.id, { fileBytes: previousLimit });
		}
	});

	it("handles events after a gateway restart resets its sn, without treating them as duplicates", async () => {
		const userId = "7108";
		await link(userId);
		faux.setResponses([fauxAssistantMessage("before restart")]);
		for (let i = 0; i < 3; i++) fake.message(userId, `warm up ${i}`);
		await waitForContent("before restart");
		await runtime.waitForIdle();
		const identifies = fake.identifies.length;
		fake.restart();
		await fake.waitForIdentify(identifies + 1);
		faux.setResponses([fauxAssistantMessage("after restart")]);
		const sn = fake.message(userId, "hello again");
		expect(sn).toBe(1);
		await waitForContent("after restart");
		const cursor = Number(
			(await db.selectFrom("channels").select("cursor").where("name", "=", "satoribot").executeTakeFirst())?.cursor,
		);
		expect(cursor).toBe(1);
	});
});

/** Polls a condition until it holds; a test uses it for state that changes after a reply was sent. */
async function until(check: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await check())) {
		if (Date.now() > deadline) throw new Error("timed out waiting for a condition");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
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
