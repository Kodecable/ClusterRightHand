import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { type ConversationId, type Cursor, MemoryStorage, type Storage } from "@earendil-works/pi-durable";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { ModelConfig } from "../src/agent/models.ts";
import { AgentRuntime } from "../src/agent/runtime.ts";
import { OUTLINE_SCAN_BUDGET, outlineTurn } from "../src/agent/runtime-sessions.ts";
import { Audit } from "../src/audit/audit.ts";
import type { SessionUser } from "../src/auth/sessions.ts";
import { Cluster } from "../src/cluster/cluster.ts";
import { TaskGroups } from "../src/cluster/task-groups.ts";
import { CallRunner } from "../src/extensions/call-runner.ts";
import { MasterKey } from "../src/keys/master-key.ts";
import type { Db } from "../src/storage/db.ts";
import { createUser } from "../src/users/service.ts";
import { type App, call, login, makeApp } from "./helpers/api.ts";
import { openTestDb } from "./helpers/db.ts";
import { waitSubmission } from "./helpers/runtime.ts";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const faux = fauxProvider();
const PASSWORD = "history-password";
const model = () => ({ provider: faux.provider.id, modelId: faux.getModel().id });

let db: Db;
let app: App;
let runtime: AgentRuntime;
let storage: Storage;
let alice: SessionUser;
let cookie = "";
let otherCookie = "";
let seq = 0;

const shown = (entry: { model?: { role?: string }[] }) =>
	!(entry.model ?? []).some((message) => message.role === "system");

/** Every entry of a conversation, oldest first, including system entries (the durable store is the source). */
async function allEntries(sessionId: string): Promise<{ id: number; model?: { role?: string }[] }[]> {
	const row = await db.selectFrom("sessions").select("conversation_id").where("id", "=", sessionId).executeTakeFirst();
	if (!row) throw new Error("no session");
	const conversationId = Number(row.conversation_id) as unknown as ConversationId;
	const entries: { id: number; model?: { role?: string }[] }[] = [];
	let cursor: Cursor | undefined;
	for (;;) {
		const page = await storage.scanEntries({ conversationId, order: "descending" }, 50, cursor, BACKGROUND_CONTEXT);
		entries.push(...(page.items as unknown as { id: number; model?: { role?: string }[] }[]));
		if (!page.next) break;
		cursor = page.next;
	}
	return entries.reverse();
}

async function answer(sessionId: string, text: string): Promise<void> {
	faux.setResponses([fauxAssistantMessage([fauxText(`answer ${++seq}`)])]);
	const submissionId = await runtime.submit(sessionId, alice, text, `history-${++seq}`);
	const settled = await waitSubmission(runtime, sessionId, submissionId);
	expect(settled.status).toBe("done");
}

/** The snapshot event of a session's `/events` stream, read from its first message. */
async function snapshotOf(sessionId: string): Promise<{
	entries: { id: number; model?: { role?: string }[] }[];
	historyCursor: string | null;
}> {
	const res = await call(app, `/api/sessions/${sessionId}/events`, { cookie });
	expect(res.status).toBe(200);
	const reader = res.body?.getReader();
	if (!reader) throw new Error("no stream body");
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) throw new Error("the stream ended before the snapshot");
			buffer += decoder.decode(chunk.value, { stream: true });
			const end = buffer.indexOf("\n\n");
			if (end < 0) continue;
			const data = buffer
				.slice(0, end)
				.split("\n")
				.find((line) => line.startsWith("data:"));
			if (!data) continue;
			const events = JSON.parse(data.slice(5)) as {
				type: string;
				snapshot?: { entries: { id: number; model?: { role?: string }[] }[]; historyCursor?: string | null };
			}[];
			const snapshot = events.find((event) => event.type === "snapshot")?.snapshot;
			if (snapshot) return { entries: snapshot.entries, historyCursor: snapshot.historyCursor ?? null };
		}
	} finally {
		void reader.cancel();
	}
}

type EntriesPage = {
	entries: { id: number; model?: { role?: string }[] }[];
	historyCursor: string | null;
};

const entries = async (sessionId: string, before?: string, limit?: number): Promise<EntriesPage> => {
	const params = new URLSearchParams();
	if (before !== undefined) params.set("before", before);
	if (limit !== undefined) params.set("limit", String(limit));
	const query = params.size > 0 ? `?${params}` : "";
	const res = await call(app, `/api/sessions/${sessionId}/entries${query}`, { cookie });
	expect(res.status).toBe(200);
	return (await res.json()) as EntriesPage;
};

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
		// A manual compaction may cut this short history; the automatic background one stays off.
		compaction: { keepRecentTokens: 1, backgroundTokens: 0 },
	});
	app = makeApp(db, undefined, { cluster, audit, masterKey, agent: { runtime, models } });
	const created = await createUser(db, { username: "alice", kind: "member", password: PASSWORD });
	alice = { sessionId: "history", userId: created.id, username: created.username, kind: "member" };
	cookie = await login(app, "alice", PASSWORD);
	await createUser(db, { username: "bob", kind: "member", password: PASSWORD });
	otherCookie = await login(app, "bob", PASSWORD);
});

afterAll(async () => {
	await runtime.close();
	await db.destroy();
});

const createSession = async (title: string) => {
	const session = await runtime.createSession(alice, { title, model: model(), rulePreset: "ask" });
	return session.id;
};

it("sends only the newest 100 shown entries and pages all the way back without gaps or duplicates", async () => {
	const sessionId = await createSession("long history");
	const exchanges = 120; // ~240 transcript entries plus the system prompt
	for (let index = 0; index < exchanges; index++) await answer(sessionId, `message ${index}`);

	const full = await allEntries(sessionId);
	const fullShown = full.filter(shown);
	expect(fullShown.length).toBeGreaterThan(200);

	const snapshot = await snapshotOf(sessionId);
	expect(snapshot.entries).toHaveLength(100);
	expect(snapshot.entries.every(shown)).toBe(true);
	// The snapshot is the newest page of the conversation, as the store sees it.
	expect(snapshot.entries.map((entry) => entry.id)).toEqual(fullShown.slice(-100).map((entry) => entry.id));
	expect(snapshot.historyCursor).not.toBeNull();

	// Without `before`, the endpoint starts at the newest end with its default page size of 100.
	const newest = await entries(sessionId);
	expect(newest.entries.map((entry) => entry.id)).toEqual(fullShown.slice(-100).map((entry) => entry.id));
	expect(newest.entries.map((entry) => entry.id)).toEqual(snapshot.entries.map((entry) => entry.id));

	// Page backwards, stopping once halfway to append new entries; the older pages must not move.
	const pages: { id: number }[] = [];
	let before = snapshot.historyCursor ?? undefined;
	let pageCount = 0;
	for (;;) {
		const page = await entries(sessionId, before, 37);
		expect(page.entries.length).toBeLessThanOrEqual(37);
		expect(page.entries.every(shown)).toBe(true);
		pages.unshift(...page.entries);
		pageCount++;
		if (pageCount === 2) await answer(sessionId, "appended while paging");
		if (!page.historyCursor) break;
		before = page.historyCursor;
		if (pageCount > 50) throw new Error("paging did not finish");
	}
	const combined = [...pages, ...snapshot.entries];
	expect(combined.map((entry) => entry.id)).toEqual(fullShown.map((entry) => entry.id));
	expect(new Set(combined.map((entry) => entry.id)).size).toBe(combined.length);

	// The appended entries are newer than the snapshot and do not appear in the pages above.
	const afterAppend = await allEntries(sessionId);
	expect(afterAppend.length).toBeGreaterThan(full.length);
	const appended = afterAppend.slice(full.length).filter(shown);
	expect(appended.length).toBeGreaterThan(0);
	const older = await entries(sessionId, snapshot.historyCursor ?? undefined, 200);
	const olderIds = new Set(older.entries.map((entry) => entry.id));
	expect(appended.every((entry) => !olderIds.has(entry.id))).toBe(true);
});

it("returns history oldest first, immediately before the cursor, with the default page size", async () => {
	const sessionId = await createSession("ordered history");
	for (let index = 0; index < 5; index++) await answer(sessionId, `ordered ${index}`);
	const full = (await allEntries(sessionId)).filter(shown);
	const snapshot = await snapshotOf(sessionId);
	// Five exchanges fit in the snapshot, and there is nothing older than its first entry.
	expect(snapshot.entries.map((entry) => entry.id)).toEqual(full.map((entry) => entry.id));
	expect(snapshot.historyCursor).toBeNull();

	// A page without `before` starts at the newest end and returns the default 100 at most.
	const page = await entries(sessionId);
	expect(page.entries.map((entry) => entry.id)).toEqual(full.slice(-100).map((entry) => entry.id));
	expect(page.entries.map((entry) => entry.id)).toEqual(
		[...page.entries.map((entry) => entry.id)].sort((a, b) => a - b),
	);
	expect(page.historyCursor).toBeNull();
});

it("validates the cursor, the limit and the visibility of the session", async () => {
	const sessionId = await createSession("validated history");
	await answer(sessionId, "hello");
	for (const query of ["?before=garbage", "?before=", "?limit=0", "?limit=201", "?limit=1.5"]) {
		expect((await call(app, `/api/sessions/${sessionId}/entries${query}`, { cookie })).status, query).toBe(400);
	}
	expect((await call(app, `/api/sessions/${sessionId}/entries`, { cookie: otherCookie })).status).toBe(404);
	expect((await call(app, "/api/sessions/does-not-exist/entries", { cookie })).status).toBe(404);
});

type OutlinePage = { turns: { entryId: number; text: string; truncated: boolean }[]; cursor: string | null };

const outline = async (sessionId: string, before?: string, limit?: number): Promise<OutlinePage> => {
	const params = new URLSearchParams();
	if (before !== undefined) params.set("before", before);
	if (limit !== undefined) params.set("limit", String(limit));
	const query = params.size > 0 ? `?${params}` : "";
	const res = await call(app, `/api/sessions/${sessionId}/outline${query}`, { cookie });
	expect(res.status).toBe(200);
	return (await res.json()) as OutlinePage;
};

/** The ids of the user-message entries, oldest first, as the store has them. */
async function userEntryIds(sessionId: string): Promise<number[]> {
	return (await allEntries(sessionId))
		.filter((entry) => (entry as { kind?: string }).kind !== "pi.compaction" && entry.model?.[0]?.role === "user")
		.map((entry) => entry.id);
}

it("outlines the user messages oldest first and pages back from a history cursor without gaps", async () => {
	const sessionId = await createSession("outlined history");
	for (let index = 0; index < 60; index++) await answer(sessionId, `question ${index}`);
	const ids = await userEntryIds(sessionId);
	expect(ids).toHaveLength(60);

	// Without `before`, the newest user messages; the default page holds all 60.
	const whole = await outline(sessionId);
	expect(whole.turns.map((turn) => turn.entryId)).toEqual(ids);
	expect(whole.turns.map((turn) => turn.text)).toEqual(ids.map((_, index) => `question ${index}`));
	expect(whole.turns.every((turn) => !turn.truncated)).toBe(true);
	expect(whole.cursor).toBeNull();

	// From the snapshot's history cursor: only the messages before the loaded window, paged by 7.
	const snapshot = await snapshotOf(sessionId);
	expect(snapshot.historyCursor).not.toBeNull();
	const oldestLoaded = snapshot.entries[0]?.id ?? 0;
	const collected: number[] = [];
	let before = snapshot.historyCursor ?? undefined;
	for (let pages = 0; ; pages++) {
		const page = await outline(sessionId, before, 7);
		expect(page.turns.length).toBeLessThanOrEqual(7);
		collected.unshift(...page.turns.map((turn) => turn.entryId));
		if (page.cursor === null) break;
		before = page.cursor;
		if (pages > 20) throw new Error("outline paging did not finish");
	}
	expect(collected).toEqual(ids.filter((id) => id < oldestLoaded));
	// A page that fills its limit exactly at the start of history ends there.
	const exact = await outline(sessionId, undefined, 60);
	expect(exact.turns).toHaveLength(60);
	expect(exact.cursor).toBeNull();
	const short = await outline(sessionId, undefined, 59);
	expect(short.turns[0]?.entryId).toBe(ids[1]);
	expect(short.cursor).not.toBeNull();
});

it("cuts a message to 50 code points with whitespace collapsed and leaves out a compaction", async () => {
	const sessionId = await createSession("outlined text");
	const long = `  line one\n\n\tline   two ${"😀".repeat(30)}${"字".repeat(30)}`;
	await answer(sessionId, long);
	await answer(sessionId, "short");
	faux.setResponses([fauxAssistantMessage([fauxText("the summary")])]);
	expect(await runtime.compact(sessionId, alice, undefined)).toMatchObject({ outcome: "started" });
	await vi.waitFor(
		async () => {
			const { entries: page } = await runtime.entriesPage(sessionId, undefined, 100);
			expect(page.some((entry) => entry.kind === "pi.compaction")).toBe(true);
		},
		{ timeout: 15_000, interval: 50 },
	);
	await answer(sessionId, "after the summary");

	const page = await outline(sessionId);
	expect(page.turns.map((turn) => turn.text)).toEqual([
		`line one line two ${"😀".repeat(30)}字字`,
		"short",
		"after the summary",
	]);
	expect(Array.from(page.turns[0]?.text ?? "")).toHaveLength(50);
	expect(page.turns.map((turn) => turn.truncated)).toEqual([true, false, false]);
});

it("stops one outline request at its scan budget and continues from the oldest entry it read", async () => {
	expect(OUTLINE_SCAN_BUDGET).toBe(2000);
	const sessionId = await createSession("budgeted outline");
	for (let index = 0; index < 6; index++) await answer(sessionId, `budget ${index}`);
	const ids = await userEntryIds(sessionId);
	// Each exchange is a user and an assistant entry, so 5 entries reach at most 3 user messages.
	const first = await runtime.outlinePage(sessionId, undefined, 200, 5);
	expect(first.turns.length).toBeLessThan(6);
	expect(first.cursor).not.toBeNull();
	const all: number[] = first.turns.map((turn) => turn.entryId);
	let before = first.cursor;
	while (before !== null) {
		const id = Number(JSON.parse(Buffer.from(before, "base64url").toString()).id);
		const next = await runtime.outlinePage(sessionId, id, 200, 5);
		all.unshift(...next.turns.map((turn) => turn.entryId));
		before = next.cursor;
	}
	expect(all).toEqual(ids);
});

it("treats only user messages as outline turns: no notices, compactions, hidden or assistant entries", () => {
	const user = (kind: string, content: unknown) =>
		outlineTurn({ id: "7", kind, model: [{ role: "user", content }] } as never);
	expect(
		user("crh.user_input", [
			{ type: "text", text: "typed" },
			{ type: "text", text: "attachment" },
		]),
	).toEqual({
		entryId: 7,
		text: "typed",
		truncated: false,
	});
	expect(user("crh.user_input", [{ type: "image", data: "", mimeType: "image/png" }])).toEqual({
		entryId: 7,
		text: "",
		truncated: false,
	});
	expect(user("pi.message", "plain")?.text).toBe("plain");
	expect(user("pi.message", "字".repeat(50))).toMatchObject({ text: "字".repeat(50), truncated: false });
	expect(user("pi.message", "字".repeat(51))).toMatchObject({ text: "字".repeat(50), truncated: true });
	expect(user("crh.notice", "a job finished")).toBeUndefined();
	expect(user("pi.compaction", "summary")).toBeUndefined();
	expect(
		outlineTurn({ id: "8", kind: "pi.message", model: [{ role: "assistant", content: [] }] } as never),
	).toBeUndefined();
	expect(
		outlineTurn({ id: "9", kind: "pi.message", model: [{ role: "system", content: "prompt" }] } as never),
	).toBeUndefined();
});

it("validates the outline's cursor, limit and the visibility of the session", async () => {
	const sessionId = await createSession("validated outline");
	await answer(sessionId, "hello");
	for (const query of ["?before=garbage", "?limit=0", "?limit=201"]) {
		expect((await call(app, `/api/sessions/${sessionId}/outline${query}`, { cookie })).status, query).toBe(400);
	}
	expect((await call(app, `/api/sessions/${sessionId}/outline`, { cookie: otherCookie })).status).toBe(404);
});
