import { randomBytes } from "node:crypto";
import type { SessionSearchItem, SessionSearchPage } from "@crh/api";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import {
	type ConversationId,
	type EntryId,
	MemoryStorage,
	type Storage,
	type StorageWrite,
} from "@earendil-works/pi-durable";
import { sql } from "kysely";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ModelConfig } from "../src/agent/models.ts";
import { AgentRuntime } from "../src/agent/runtime.ts";
import {
	parseSearchKeywords,
	parseSearchLimit,
	SESSION_SEARCH_LIMIT_MAX,
	snippet,
} from "../src/agent/session-search.ts";
import { shareSession } from "../src/agent/sharing.ts";
import { Audit } from "../src/audit/audit.ts";
import type { SessionUser } from "../src/auth/sessions.ts";
import { Cluster } from "../src/cluster/cluster.ts";
import { TaskGroups } from "../src/cluster/task-groups.ts";
import { MasterKey } from "../src/keys/master-key.ts";
import type { Db } from "../src/storage/db.ts";
import { PgStorage } from "../src/storage/pg-durable/index.ts";
import { advisoryKey, applyMigrations, createMigrations, createSchema } from "../src/storage/pg-durable/schema.ts";
import { createUser, defaultOrgId } from "../src/users/service.ts";
import { UserError } from "../src/util/errors.ts";
import { newId } from "../src/util/id.ts";
import { type App, call, login, makeApp } from "./helpers/api.ts";
import { type Backend, describeBackends, openTestDb, withDdlLock, withDdlLockOn } from "./helpers/db.ts";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const pgUrl = process.env.CRH_TEST_PG_URL;
const PASSWORD = "session-search-password";
const faux = fauxProvider();
const model = () => ({ provider: faux.provider.id, modelId: faux.getModel().id });
const modelJson = JSON.stringify(model());
const AT = 1_700_000_000_000;
const ENTRIES_TABLE = "pi_entries";

interface Fixture {
	db: Db;
	storage: Storage;
	runtime: AgentRuntime;
	app: App;
	close(): Promise<void>;
}

/** A crhs database plus an agent storage on the same one, as production opens them (storage/db.ts). */
async function openFixture(backend: Backend): Promise<Fixture> {
	if (backend === "sqlite") {
		const db = await openTestDb("sqlite");
		const storage = new MemoryStorage();
		const opened = await openRuntime(db, storage);
		return {
			db,
			storage,
			...opened,
			close: async () => {
				await opened.runtime.close();
				await db.destroy();
			},
		};
	}
	const db = await openTestDb("postgres");
	const schema = (await sql<{ schema: string }>`select current_schema() as schema`.execute(db)).rows[0]?.schema;
	if (schema === undefined) throw new Error("the test database has no current schema");
	const pool = new pg.Pool({ connectionString: pgUrl, options: `-c search_path=${schema}`, max: 4 });
	let storage: PgStorage;
	try {
		storage = await withDdlLockOn("postgres", () => PgStorage.open(pool, { prefix: "pi_" }));
	} catch (error) {
		await pool.end();
		throw error;
	}
	const opened = await openRuntime(db, storage);
	return {
		db,
		storage,
		...opened,
		close: async () => {
			await opened.runtime.close();
			await storage.close(BACKGROUND_CONTEXT);
			await pool.end();
			await db.destroy();
		},
	};
}

async function openRuntime(
	db: Db,
	storage: Storage,
): Promise<{ runtime: AgentRuntime; app: App; audit: Audit; cluster: Cluster; masterKey: MasterKey }> {
	const audit = new Audit(db);
	const cluster = new Cluster(db, { audit });
	const masterKey = MasterKey.generate();
	const models = new ModelConfig(db, masterKey);
	models.addProvider(faux.provider);
	await models.reload();
	const runtime = await AgentRuntime.open({
		db,
		storage,
		models,
		cluster,
		taskGroups: new TaskGroups(db, cluster, { audit }),
		audit,
	});
	const app = makeApp(db, undefined, { cluster, audit, masterKey, agent: { runtime, models } });
	return { runtime, app, audit, cluster, masterKey };
}

interface SeedOptions {
	id?: string;
	conversationId?: string;
	parentSessionId?: string;
	rootSessionId?: string;
}

describeBackends("session search", (backend) => {
	let fixture: Fixture;
	let db: Db;
	let storage: Storage;
	let app: App;
	let orgId = "";
	let users: Record<"alice" | "bob" | "admin", SessionUser>;
	const cookie: Record<string, string> = {};

	beforeAll(async () => {
		fixture = await openFixture(backend);
		db = fixture.db;
		storage = fixture.storage;
		app = fixture.app;
		orgId = await defaultOrgId(db);
		users = {} as typeof users;
		for (const [name, kind] of [
			["alice", "member"],
			["bob", "member"],
			["admin", "admin"],
		] as const) {
			const created = await createUser(db, { username: name, kind, password: PASSWORD });
			users[name] = { sessionId: `search-${name}`, userId: created.id, username: created.username, kind };
			cookie[name] = await login(app, name, PASSWORD);
		}
	});

	afterAll(async () => {
		await fixture.close();
	});

	/** Inserts a session row directly, so title, state and updated_at are exactly what the test needs. */
	async function seed(
		owner: string,
		title: string | null,
		updatedAt: string,
		options: SeedOptions = {},
	): Promise<string> {
		const sessionId = options.id ?? newId();
		await db
			.insertInto("sessions")
			.values({
				id: sessionId,
				org_id: orgId,
				owner_user_id: owner,
				conversation_id: options.conversationId ?? `conv-${sessionId}`,
				parent_session_id: options.parentSessionId ?? null,
				root_session_id: options.rootSessionId ?? options.parentSessionId ?? sessionId,
				schedule_id: null,
				title,
				model: modelJson,
				status: "active",
				created_at: updatedAt,
				updated_at: updatedAt,
				archived_at: null,
				last_submission_id: null,
				state: "idle",
				waiting_kind: null,
				waiting_level_id: null,
				waiting_handler_id: null,
				state_changed_at: updatedAt,
				quota_tokens: null,
			})
			.execute();
		return sessionId;
	}

	const search = async (who: string, params: Record<string, string | number> = {}): Promise<SessionSearchPage> => {
		const query = new URLSearchParams();
		for (const [key, value] of Object.entries(params)) query.set(key, String(value));
		const res = await call(app, `/api/sessions/search?${query}`, { cookie: cookie[who] });
		expect(res.status).toBe(200);
		return (await res.json()) as SessionSearchPage;
	};

	const searchStatus = async (who: string, path: string): Promise<number> =>
		(await call(app, `/api/sessions/search${path}`, { cookie: cookie[who] })).status;

	const byTitle = (page: SessionSearchPage, title: string): SessionSearchItem | undefined =>
		page.items.find((item) => item.title === title);

	it("requires q, bounds the limit to 1..50, and rejects unknown scopes", async () => {
		expect(await searchStatus("alice", "")).toBe(400);
		expect(await searchStatus("alice", "?q=")).toBe(400);
		expect(await searchStatus("alice", "?q=%20%20%20")).toBe(400);
		expect(await searchStatus("alice", "?q=x&limit=0")).toBe(400);
		expect(await searchStatus("alice", `?q=x&limit=${SESSION_SEARCH_LIMIT_MAX + 1}`)).toBe(400);
		expect(await searchStatus("alice", "?q=x&limit=abc")).toBe(400);
		expect(await searchStatus("alice", "?q=x&cursor=not-a-cursor")).toBe(400);
		expect(await searchStatus("alice", "?q=x&scope=everything")).toBe(400);
		// `all` is the administrators' scope, on the list and in its search.
		expect(await searchStatus("alice", "?q=x&scope=all")).toBe(403);
		expect(await searchStatus("admin", "?q=x&scope=all")).toBe(200);

		expect(parseSearchKeywords("a b c")).toEqual(["a", "b", "c"]);
		expect(() => parseSearchKeywords("  ")).toThrow(UserError);
		expect(parseSearchKeywords("1 2 3 4 5 6 7 8 9")).toEqual(["1", "2", "3", "4", "5", "6", "7", "8"]);
		expect(parseSearchLimit(undefined)).toBe(20);
		expect(parseSearchLimit("50")).toBe(50);
		expect(() => parseSearchLimit("51")).toThrow(UserError);
	});

	it("matches every keyword in the title, case-insensitively, with the list's item shape", async () => {
		const first = await seed(users.alice.userId, "TitleSearch alpha notes", "2026-01-01T00:00:01.000Z");
		const second = await seed(users.alice.userId, "TitleSearch beta plan", "2026-01-01T00:00:02.000Z");
		await seed(users.alice.userId, "Gamma only", "2026-01-01T00:00:03.000Z");

		const page = await search("alice", { q: "titlesearch" });
		expect(page.contentSearch).toBe(backend === "postgres");
		expect(page.items.map((item) => item.id)).toEqual([second, first]);
		expect(page.nextCursor).toBeNull();
		for (const item of page.items) {
			expect(item.titleMatch).toBe(true);
			expect(item.hitCount).toBe(0);
			expect(item.hits).toEqual([]);
			expect(item.ownerUserId).toBe(users.alice.userId);
			expect(item.state).toBe("idle");
			expect(item.shared).toBe(false);
		}

		// AND, and the list's order (updated_at desc, id desc).
		const narrowed = await search("alice", { q: "TITLESEARCH alpha" });
		expect(narrowed.items.map((item) => item.id)).toEqual([first]);
		expect((await search("alice", { q: "titlesearch missing" })).items).toEqual([]);
	});

	it("matches LIKE metacharacters literally", async () => {
		await seed(users.alice.userId, "EscapePercent 100% ready", "2026-01-02T00:00:01.000Z");
		await seed(users.alice.userId, "EscapePercent 100x ready", "2026-01-02T00:00:02.000Z");
		await seed(users.alice.userId, "EscapeUnderscore under_score plan", "2026-01-02T00:00:03.000Z");
		await seed(users.alice.userId, "EscapeUnderscore underXscore plan", "2026-01-02T00:00:04.000Z");
		await seed(users.alice.userId, "EscapeBackslash path \\to file", "2026-01-02T00:00:05.000Z");

		expect((await search("alice", { q: "escapepercent 100%" })).items.map((item) => item.title)).toEqual([
			"EscapePercent 100% ready",
		]);
		expect((await search("alice", { q: "escapepercent 100_" })).items).toEqual([]);
		expect((await search("alice", { q: "escapepercent%" })).items).toEqual([]);
		expect((await search("alice", { q: "escapeunderscore under_score" })).items.map((item) => item.title)).toEqual([
			"EscapeUnderscore under_score plan",
		]);
		expect((await search("alice", { q: "escapebackslash \\to" })).items.map((item) => item.title)).toEqual([
			"EscapeBackslash path \\to file",
		]);
	});

	it("uses the list's scopes and visibility", async () => {
		const own = await seed(users.alice.userId, "VisibilityCase own", "2026-01-03T00:00:01.000Z");
		const shared = await seed(users.bob.userId, "VisibilityCase shared", "2026-01-03T00:00:02.000Z");
		const hidden = await seed(users.bob.userId, "VisibilityCase hidden", "2026-01-03T00:00:03.000Z");
		await shareSession(db, {
			sessionId: shared,
			granteeType: "user",
			granteeId: users.alice.userId,
			access: "view",
			createdBy: users.bob.userId,
		});

		expect((await search("alice", { q: "visibilitycase" })).items.map((item) => item.id)).toEqual([own]);
		const visible = await search("alice", { q: "visibilitycase", scope: "visible" });
		expect(visible.items.map((item) => item.id)).toEqual([shared, own]);
		expect(byTitle(visible, "VisibilityCase shared")?.shared).toBe(true);
		expect(byTitle(visible, "VisibilityCase own")?.shared).toBe(false);
		expect((await search("alice", { q: "visibilitycase", scope: "shared" })).items.map((item) => item.id)).toEqual([
			shared,
		]);
		expect((await search("bob", { q: "visibilitycase" })).items.map((item) => item.id)).toEqual([hidden, shared]);
		expect((await search("admin", { q: "visibilitycase", scope: "all" })).items.map((item) => item.id)).toEqual([
			hidden,
			shared,
			own,
		]);
		// The admin's default scope is still their own list.
		expect((await search("admin", { q: "visibilitycase" })).items).toEqual([]);
	});

	it("pages with the session list's updated_at/id keyset", async () => {
		const older = await seed(users.alice.userId, "PageCase oldest", "2026-01-04T00:00:01.000Z");
		const sameA = await seed(users.alice.userId, "PageCase same a", "2026-01-04T00:00:02.000Z", { id: "page-a" });
		const sameB = await seed(users.alice.userId, "PageCase same b", "2026-01-04T00:00:02.000Z", { id: "page-b" });
		const newer = await seed(users.alice.userId, "PageCase newer", "2026-01-04T00:00:03.000Z");
		const newest = await seed(users.alice.userId, "PageCase newest", "2026-01-04T00:00:04.000Z");
		const sameOrder = sameA < sameB ? [sameB, sameA] : [sameA, sameB];

		const seen: string[] = [];
		let cursor: string | undefined;
		for (;;) {
			const page = await search("alice", {
				q: "pagecase",
				limit: 2,
				...(cursor === undefined ? {} : { cursor }),
			});
			seen.push(...page.items.map((item) => item.id));
			if (page.nextCursor === null) break;
			cursor = page.nextCursor;
		}
		expect(seen).toEqual([newest, newer, ...sameOrder, older]);
		expect(new Set(seen).size).toBe(seen.length);
	});

	it("snippets around the first keyword, collapsed and cut", () => {
		const long = `${"x".repeat(200)}\n\n  needle  ${"y".repeat(200)}`;
		const text = snippet(long, ["needle"]);
		expect(text.startsWith("…")).toBe(true);
		expect(text.endsWith("…")).toBe(true);
		expect(text).toContain("needle");
		expect(text).not.toContain("\n");
		// The first keyword that occurs in the entry wins.
		expect(snippet("beta then alpha", ["alpha", "beta"])).toContain("alpha");
		expect(snippet("short text", ["short"])).toBe("short text");
	});

	if (backend === "postgres") {
		let durable = 10_000;
		const durableId = (): number => durable++;

		const userRecord = (id: number, conversationId: number, content: unknown, timestamp = AT) => ({
			id,
			conversationId,
			kind: "pi.user",
			model: [{ role: "user", content, timestamp }],
		});
		const assistantRecord = (
			id: number,
			conversationId: number,
			content: unknown[],
			timestamp = AT,
		): {
			id: number;
			conversationId: number;
			kind: string;
			model: unknown[];
		} => ({ id, conversationId, kind: "pi.assistant", model: [{ role: "assistant", content, timestamp }] });

		async function storeEntries(conversationId: number, entries: { id: number; kind: string; model: unknown[] }[]) {
			const writes = [
				{ type: "conversation", value: { id: conversationId as ConversationId } },
				...entries.map((entry) => ({
					type: "entry",
					value: {
						id: entry.id as EntryId,
						conversationId: conversationId as ConversationId,
						kind: entry.kind,
						model: entry.model,
					},
				})),
			] as unknown as StorageWrite[];
			await storage.commit(writes, BACKGROUND_CONTEXT);
		}

		async function searchTextOf(entryId: number): Promise<string | null | undefined> {
			const { rows } = await sql<{ search_text: string | null }>`
				select search_text from ${sql.ref(ENTRIES_TABLE)} where id = ${entryId}
			`.execute(db);
			return rows[0]?.search_text;
		}

		async function generatedText(record: unknown): Promise<string | null> {
			const { rows } = await sql<{ text: string | null }>`
				select ${sql.ref("pi_entry_search_text")}(${JSON.stringify(record)}) as text
			`.execute(db);
			return rows[0]?.text ?? null;
		}

		it("generates search_text from user strings, user text blocks and assistant text blocks only", async () => {
			const conversationId = durableId();
			const userString = durableId();
			const userArray = durableId();
			const assistant = durableId();
			const toolResult = durableId();
			const system = durableId();
			const compaction = durableId();
			const capped = durableId();
			await storeEntries(conversationId, [
				{ ...userRecord(userString, conversationId, "user string content") },
				{
					...userRecord(userArray, conversationId, [
						{ type: "text", text: "user array first" },
						{ type: "image", data: "AAAA", mimeType: "image/png" },
						{ type: "text", text: "user array second" },
					]),
				},
				assistantRecord(assistant, conversationId, [
					{ type: "thinking", thinking: "thinking only" },
					{ type: "text", text: "assistant visible one" },
					{ type: "toolCall", id: "tc-1", name: "shell", arguments: { command: "echo tool" } },
					{ type: "text", text: "assistant visible two" },
				]),
				{
					id: toolResult,
					kind: "pi.tool-result",
					model: [
						{
							role: "toolResult",
							toolCallId: "tc-1",
							toolName: "shell",
							content: [{ type: "text", text: "tool result hidden" }],
							isError: false,
							timestamp: AT,
						},
					],
				},
				{ id: system, kind: "pi.system", model: [{ role: "system", content: "system hidden" }] },
				{ ...userRecord(compaction, conversationId, "compaction hidden"), kind: "pi.compaction" },
				{ ...userRecord(capped, conversationId, "z".repeat(40_000)) },
			]);

			expect(await searchTextOf(userString)).toBe("user string content");
			expect(await searchTextOf(userArray)).toBe("user array first\nuser array second");
			expect(await searchTextOf(assistant)).toBe("assistant visible one\nassistant visible two");
			expect(await searchTextOf(toolResult)).toBeNull();
			expect(await searchTextOf(system)).toBeNull();
			expect(await searchTextOf(compaction)).toBeNull();
			const { rows } = await sql<{ length: number }>`
				select length(search_text) as length from ${sql.ref(ENTRIES_TABLE)} where id = ${capped}
			`.execute(db);
			expect(rows[0]?.length).toBe(32_768);

			// The function itself accepts unexpected shapes instead of throwing.
			expect(await generatedText({ kind: "pi.user", model: "not an array" })).toBeNull();
			expect(await generatedText({ kind: "pi.user", model: [{ role: "user", content: 42 }] })).toBeNull();
			expect(
				await generatedText({ kind: "pi.user", model: [{ role: "user", content: [{ type: "text", text: 42 }] }] }),
			).toBeNull();
			expect(
				await generatedText({ kind: "pi.assistant", model: [{ role: "user", content: "wrong role" }] }),
			).toBeNull();
			expect(await generatedText({ kind: "pi.user", model: [{ role: "user", content: "" }] })).toBeNull();
			expect(
				await generatedText({
					kind: "pi.user",
					model: [
						{ role: "user", content: "one" },
						{ role: "user", content: "two" },
					],
				}),
			).toBe("one\ntwo");
		});

		it("returns hits, snippets and counts across a session tree", async () => {
			const owned = users.alice.userId;
			const convA = durableId();
			const rootA = await seed(owned, "Kangaroo project", "2026-01-05T00:00:04.000Z", {
				conversationId: String(convA),
			});
			const a1 = durableId();
			const a2 = durableId();
			const a3 = durableId();
			const a4 = durableId();
			const a5 = durableId();
			const a6 = durableId();
			const a7 = durableId();
			await storeEntries(convA, [
				userRecord(a1, convA, "The quick brown kangaroo jumps", AT + 1000),
				assistantRecord(
					a2,
					convA,
					[
						{ type: "thinking", thinking: "thinkingsecret hidden kangaroo thought" },
						{ type: "text", text: "A kangaroo appears in the field" },
						{ type: "toolCall", id: "tc-2", name: "toolcallsecret", arguments: { command: "toolcallsecret" } },
					],
					AT + 2000,
				),
				userRecord(a3, convA, [{ type: "text", text: "second kangaroo message" }], AT + 3000),
				userRecord(a4, convA, "fourth kangaroo message", AT + 4000),
				{
					id: a5,
					kind: "pi.tool-result",
					model: [
						{
							role: "toolResult",
							toolCallId: "tc-2",
							toolName: "shell",
							content: [{ type: "text", text: "toolresultsecret" }],
							isError: false,
							timestamp: AT + 5000,
						},
					],
				},
				{ id: a6, kind: "pi.system", model: [{ role: "system", content: "systemsecret" }] },
				{ ...userRecord(a7, convA, "compactionsecret"), kind: "pi.compaction" },
			]);

			const rootB = await seed(owned, "Kangaroo title only", "2026-01-05T00:00:03.000Z");

			const convC = durableId();
			const rootC = await seed(owned, "Subagent parent", "2026-01-05T00:00:02.000Z", {
				conversationId: String(convC),
			});
			const c1 = durableId();
			await storeEntries(convC, [userRecord(c1, convC, "parent kangaroo note", AT + 6000)]);
			const convChild = durableId();
			const childC = await seed(owned, "Helper agent", "2026-01-05T00:00:01.000Z", {
				conversationId: String(convChild),
				parentSessionId: rootC,
				rootSessionId: rootC,
			});
			const childEntry = durableId();
			await storeEntries(convChild, [
				assistantRecord(childEntry, convChild, [{ type: "text", text: "child kangaroo answer" }], AT + 7000),
			]);

			const convD = durableId();
			const rootD = await seed(owned, "Needle notes", "2026-01-05T00:00:05.000Z", {
				conversationId: String(convD),
			});
			const d1 = durableId();
			await storeEntries(convD, [
				userRecord(d1, convD, `${"x".repeat(200)}\n\n  needle  ${"y".repeat(200)}`, AT + 8000),
			]);

			// Someone else's root: invisible to alice's list, visible in the admin's `all` scope.
			const convBob = durableId();
			const bobRoot = await seed(users.bob.userId, "Bob hidden kangaroo", "2026-01-05T00:00:06.000Z", {
				conversationId: String(convBob),
			});
			const bobEntry = durableId();
			await storeEntries(convBob, [userRecord(bobEntry, convBob, "kangaroo hidden by bob", AT + 9000)]);

			const page = await search("alice", { q: "kangaroo" });
			expect(page.contentSearch).toBe(true);
			expect(page.items.map((item) => item.id)).toEqual([rootA, rootB, rootC]);

			const itemA = page.items[0] as SessionSearchItem;
			expect(itemA.titleMatch).toBe(true);
			expect(itemA.hitCount).toBe(4);
			expect(itemA.hits.map((hit) => hit.entryId)).toEqual([a4, a3, a2]);
			expect(itemA.hits.map((hit) => hit.role)).toEqual(["user", "user", "assistant"]);
			for (const hit of itemA.hits) {
				expect(hit.sessionId).toBe(rootA);
				expect(hit.sessionTitle).toBe("Kangaroo project");
				expect(hit.snippet).toContain("kangaroo");
			}
			expect(itemA.hits[2]?.at).toBe(new Date(AT + 2000).toISOString());

			const itemB = byTitle(page, "Kangaroo title only") as SessionSearchItem;
			expect(itemB.titleMatch).toBe(true);
			expect(itemB.hitCount).toBe(0);
			expect(itemB.hits).toEqual([]);

			const itemC = byTitle(page, "Subagent parent") as SessionSearchItem;
			expect(itemC.titleMatch).toBe(false);
			expect(itemC.hitCount).toBe(2);
			expect(itemC.hits.map((hit) => hit.entryId)).toEqual([childEntry, c1]);
			expect(itemC.hits[0]?.sessionId).toBe(childC);
			expect(itemC.hits[0]?.sessionTitle).toBe("Helper agent");

			// AND across different messages of one tree; hitCount counts entries with at least one keyword.
			const across = await search("alice", { q: "quick field" });
			expect(across.items.map((item) => item.id)).toEqual([rootA]);
			expect(across.items[0]?.hitCount).toBe(2);
			expect(across.items[0]?.hits.map((hit) => hit.entryId)).toEqual([a2, a1]);

			// The entry with the most keywords comes first, then the newest.
			const both = await search("alice", { q: "quick kangaroo" });
			expect(both.items.map((item) => item.id)).toEqual([rootA]);
			expect(both.items[0]?.hits.map((hit) => hit.entryId)).toEqual([a1, a4, a3]);
			expect(both.items[0]?.hitCount).toBe(4);

			const needle = await search("alice", { q: "needle" });
			const needleHit = needle.items[0]?.hits[0];
			expect(needle.items.map((item) => item.id)).toEqual([rootD]);
			expect(needleHit?.snippet.startsWith("…")).toBe(true);
			expect(needleHit?.snippet.endsWith("…")).toBe(true);
			expect(needleHit?.snippet).toContain("needle");
			expect(needleHit?.snippet).not.toContain("\n");
			expect(needleHit?.at).toBe(new Date(AT + 8000).toISOString());

			for (const secret of [
				"thinkingsecret",
				"toolcallsecret",
				"toolresultsecret",
				"systemsecret",
				"compactionsecret",
			]) {
				expect((await search("alice", { q: secret })).items).toEqual([]);
			}
			expect((await search("alice", { q: "kangaroo toolresultsecret" })).items).toEqual([]);

			// `all` reaches bob's root and its content hit; `visible` does not (no share here).
			const admin = await search("admin", { q: "kangaroo", scope: "all" });
			expect(admin.items.map((item) => item.id)).toContain(bobRoot);
			expect(byTitle(admin, "Bob hidden kangaroo")?.hits[0]?.entryId).toBe(bobEntry);
			expect((await search("alice", { q: "kangaroo", scope: "visible" })).items.map((item) => item.id)).toEqual([
				rootA,
				rootB,
				rootC,
			]);
		});

		it("finds content in a shared root but not in another user's unshared root", async () => {
			const shared = await seed(users.bob.userId, "PrivateSearch shared", "2026-01-06T00:00:02.000Z");
			const sharedConv = durableId();
			const sharedEntry = durableId();
			await db
				.updateTable("sessions")
				.set({ conversation_id: String(sharedConv) })
				.where("id", "=", shared)
				.execute();
			await storeEntries(sharedConv, [userRecord(sharedEntry, sharedConv, "privatesearch shared body")]);
			await shareSession(db, {
				sessionId: shared,
				granteeType: "user",
				granteeId: users.alice.userId,
				access: "view",
				createdBy: users.bob.userId,
			});
			const hidden = await seed(users.bob.userId, "PrivateSearch hidden", "2026-01-06T00:00:01.000Z");
			const hiddenConv = durableId();
			const hiddenEntry = durableId();
			await db
				.updateTable("sessions")
				.set({ conversation_id: String(hiddenConv) })
				.where("id", "=", hidden)
				.execute();
			await storeEntries(hiddenConv, [userRecord(hiddenEntry, hiddenConv, "privatesearch hidden body")]);

			expect((await search("alice", { q: "privatesearch" })).items).toEqual([]);
			const visible = await search("alice", { q: "privatesearch", scope: "visible" });
			expect(visible.items.map((item) => item.id)).toEqual([shared]);
			expect(visible.items[0]?.hits.map((hit) => hit.entryId)).toEqual([sharedEntry]);
			expect(visible.items[0]?.shared).toBe(true);
			const all = await search("admin", { q: "privatesearch", scope: "all" });
			expect(all.items.map((item) => item.id)).toEqual([shared, hidden]);
			expect(byTitle(all, "PrivateSearch hidden")?.hits[0]?.entryId).toBe(hiddenEntry);
		});
	}
});

describe.skipIf(!pgUrl)("pg-durable search schema upgrade", () => {
	it("adds the function and generated column to an existing version-1 store, computing existing rows", async () => {
		const schema = `t_${randomBytes(6).toString("hex")}`;
		const admin = new pg.Pool({ connectionString: pgUrl });
		const pool = new pg.Pool({ connectionString: pgUrl, options: `-c search_path=${schema}`, max: 2 });
		try {
			const layout = createSchema(schema, "pi_");
			const migrations = createMigrations(layout);
			const first = migrations[0];
			if (first === undefined) throw new Error("expected a version-1 migration");
			// Create the store at version 1 under the same DDL lock openTestDb uses, so no Kysely
			// migrator in a parallel test file introspects the schema mid-creation.
			await withDdlLock(async () => {
				await admin.query(`create schema "${schema}"`);
				await applyMigrations(pool, layout, [first], advisoryKey("migrate", schema, "pi_"));
			});
			const legacy = JSON.stringify({
				id: 1,
				conversationId: 1,
				kind: "pi.user",
				model: [{ role: "user", content: "legacy hello", timestamp: AT }],
			});
			await pool.query(
				`insert into ${layout.tables.entries} (id, conversation_id, head, commit_seq, record) values (1, 1, null, 1, $1)`,
				[legacy],
			);
			const before = await pool.query(
				`select 1 from information_schema.columns
					where table_schema = $1 and table_name = 'pi_entries' and column_name = 'search_text'`,
				[schema],
			);
			expect(before.rowCount).toBe(0);

			const storage = await withDdlLockOn("postgres", () => PgStorage.open(pool, { prefix: "pi_" }));
			try {
				const { rows } = await pool.query<{ search_text: string | null }>(
					`select search_text from ${layout.tables.entries} where id = 1`,
				);
				expect(rows[0]?.search_text).toBe("legacy hello");
				const version = await pool.query<{ version: number }>(
					`select version from ${layout.tables.durableSchema} where singleton = 1`,
				);
				expect(version.rows[0]?.version).toBe(2);
				const fn = await pool.query<{ text: string | null }>(`select ${layout.functions.entrySearchText}($1) as text`, [
					JSON.stringify({
						kind: "pi.assistant",
						model: [{ role: "assistant", content: [{ type: "text", text: "function works" }] }],
					}),
				]);
				expect(fn.rows[0]?.text).toBe("function works");
			} finally {
				await storage.close(BACKGROUND_CONTEXT);
			}

			// A second open finds version 2 and leaves it there.
			const reopened = await withDdlLockOn("postgres", () => PgStorage.open(pool, { prefix: "pi_" }));
			try {
				const version = await pool.query<{ version: number }>(
					`select version from ${layout.tables.durableSchema} where singleton = 1`,
				);
				expect(version.rows[0]?.version).toBe(2);
			} finally {
				await reopened.close(BACKGROUND_CONTEXT);
			}
		} finally {
			await pool.end();
			await withDdlLock(async () => {
				await admin.query(`drop schema "${schema}" cascade`);
			});
			await admin.end();
		}
	});
});
