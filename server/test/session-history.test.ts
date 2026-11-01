import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { type ConversationId, type Cursor, MemoryStorage, type Storage } from "@earendil-works/pi-durable";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { ModelConfig } from "../src/agent/models.ts";
import { AgentRuntime } from "../src/agent/runtime.ts";
import { Audit } from "../src/audit/audit.ts";
import type { SessionUser } from "../src/auth/sessions.ts";
import { Cluster } from "../src/cluster/cluster.ts";
import { TaskGroups } from "../src/cluster/task-groups.ts";
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
		db,
		storage,
		models,
		cluster,
		groups: new TaskGroups(db, cluster, { audit }),
		audit,
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
	const session = await runtime.createSession(alice, { title, model: model(), preset: "ask" });
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
