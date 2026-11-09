import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { CompiledQuery } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ModelConfig } from "../src/agent/models.ts";
import { AgentRuntime } from "../src/agent/runtime.ts";
import {
	SessionListHub,
	type SessionListItem,
	type SessionListSubscriber,
	sessionChildrenQuery,
	sessionListQuery,
} from "../src/agent/session-list.ts";
import { markSessionsIdle, setSessionState } from "../src/agent/session-state.ts";
import { shareSession, unshareSession } from "../src/agent/sharing.ts";
import { RequestDrain } from "../src/api/drain.ts";
import { Audit } from "../src/audit/audit.ts";
import type { SessionUser } from "../src/auth/sessions.ts";
import { Cluster } from "../src/cluster/cluster.ts";
import { TaskGroups } from "../src/cluster/task-groups.ts";
import { MasterKey } from "../src/keys/master-key.ts";
import { deleteSchedule, getSchedule } from "../src/scheduler/store.ts";
import type { Db } from "../src/storage/db.ts";
import { createUser, defaultOrgId } from "../src/users/service.ts";
import { addUserGroupMember, createUserGroup } from "../src/users/user-groups.ts";
import { newId } from "../src/util/id.ts";
import { type App, call, login, makeApp } from "./helpers/api.ts";
import { openTestDb } from "./helpers/db.ts";
import { waitSubmission } from "./helpers/runtime.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const PASSWORD = "session-list-password";
const faux = fauxProvider();
const model = () => ({ provider: faux.provider.id, modelId: faux.getModel().id });
const modelJson = JSON.stringify(model());

let db: Db;
let app: App;
let runtime: AgentRuntime;
let audit: Audit;
let drain: RequestDrain;
let orgId = "";
let groupId = "";
const cookie: Record<string, string> = {};
const id: Record<string, string> = {};
const user: Record<string, SessionUser> = {};

type ListResponse = { items: SessionListItem[]; nextCursor: string | null };

const list = async (who: string, query = ""): Promise<ListResponse> => {
	const res = await call(app, `/api/sessions${query}`, { cookie: cookie[who] });
	expect(res.status).toBe(200);
	return (await res.json()) as ListResponse;
};

/** `GET /api/sessions/:id/children`: one cursor page of a session's direct child sessions. */
const children = async (who: string, sessionId: string, query = ""): Promise<ListResponse> => {
	const res = await call(app, `/api/sessions/${sessionId}/children${query}`, { cookie: cookie[who] });
	expect(res.status).toBe(200);
	return (await res.json()) as ListResponse;
};

/** Inserts a session row directly, so title, state and updated_at are exactly what the test needs. */
async function seed(
	owner: string,
	title: string,
	updatedAt: string,
	extra: { id?: string; scheduleId?: string; parentSessionId?: string; rootSessionId?: string } = {},
): Promise<string> {
	const sessionId = extra.id ?? newId();
	await db
		.insertInto("sessions")
		.values({
			id: sessionId,
			org_id: orgId,
			owner_user_id: owner,
			conversation_id: `conv-${sessionId}`,
			parent_session_id: extra.parentSessionId ?? null,
			root_session_id: extra.rootSessionId ?? extra.parentSessionId ?? sessionId,
			schedule_id: extra.scheduleId ?? null,
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

const newSession = async (who: string, title: string): Promise<string> => {
	// Setup only: the HTTP create route now always submits a first message (D117), while most list tests just
	// need a session; the runtime creates it without a run.
	const owner = user[who];
	if (!owner) throw new Error("unknown user");
	return (await runtime.createSession(owner, { title, model: model(), rulePreset: "ask" })).id;
};

/** Shares a session as its owner, alice, and returns the share id. */
const share = async (sessionId: string, body: Record<string, unknown>): Promise<string> => {
	const res = await call(app, `/api/sessions/${sessionId}/shares`, { method: "PUT", cookie: cookie.alice, body });
	expect(res.status).toBe(200);
	return ((await res.json()) as { share: { id: string } }).share.id;
};

const unshare = async (sessionId: string, shareId: string) => {
	const res = await call(app, `/api/sessions/${sessionId}/shares/${shareId}`, {
		method: "DELETE",
		cookie: cookie.alice,
		body: {},
	});
	expect(res.status).toBe(200);
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(
	what: string,
	fn: () => T | Promise<T | undefined> | undefined | false,
	timeoutMs = 5_000,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await fn();
		if (value) return value;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await sleep(5);
	}
}

type SseEvent = { event: string; data: string };

/** One `/api/sessions/stream` connection: a background pump feeds `next` and `drain`. */
async function openStream(who: string, query = "") {
	const res = await call(app, `/api/sessions/stream${query}`, { cookie: cookie[who] });
	expect(res.status).toBe(200);
	const reader = res.body?.getReader();
	if (!reader) throw new Error("no stream body");
	const decoder = new TextDecoder();
	const events: SseEvent[] = [];
	const waiters: (() => void)[] = [];
	let ended = false;
	let buffer = "";
	const wake = () => {
		for (const waiter of waiters.splice(0)) waiter();
	};
	void (async () => {
		try {
			for (;;) {
				const chunk = await reader.read();
				if (chunk.done) break;
				buffer += decoder.decode(chunk.value, { stream: true });
				for (;;) {
					const end = buffer.indexOf("\n\n");
					if (end < 0) break;
					const raw = buffer.slice(0, end);
					buffer = buffer.slice(end + 2);
					let event = "message";
					const data: string[] = [];
					for (const line of raw.split("\n")) {
						if (line.startsWith("event:")) event = line.slice(6).trim();
						else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
					}
					if (event !== "ping") events.push({ event, data: data.join("\n") });
				}
				wake();
			}
		} finally {
			ended = true;
			wake();
		}
	})();
	return {
		async next(timeoutMs = 2_000): Promise<SseEvent | undefined> {
			const deadline = Date.now() + timeoutMs;
			for (;;) {
				const event = events.shift();
				if (event) return event;
				if (ended) return undefined;
				const left = deadline - Date.now();
				if (left <= 0) return undefined;
				await new Promise<void>((resolve) => {
					const timer = setTimeout(resolve, left);
					waiters.push(() => {
						clearTimeout(timer);
						resolve();
					});
				});
			}
		},
		async collected(windowMs = 300): Promise<SseEvent[]> {
			const out: SseEvent[] = [];
			const deadline = Date.now() + windowMs;
			for (;;) {
				const left = deadline - Date.now();
				if (left <= 0) return out;
				const event = await this.next(left);
				if (!event) return out;
				out.push(event);
			}
		},
		async ended(timeoutMs = 2_000): Promise<boolean> {
			const deadline = Date.now() + timeoutMs;
			while (!ended) {
				const left = deadline - Date.now();
				if (left <= 0) return false;
				await new Promise<void>((resolve) => {
					const timer = setTimeout(resolve, left);
					waiters.push(() => {
						clearTimeout(timer);
						resolve();
					});
				});
			}
			return true;
		},
		close: () => reader.cancel(),
	};
}

const upsertIds = (events: SseEvent[]) =>
	events.filter((event) => event.event === "upsert").map((event) => (JSON.parse(event.data) as SessionListItem).id);

beforeAll(async () => {
	db = await openTestDb("sqlite");
	audit = new Audit(db);
	const cluster = new Cluster(db, { audit });
	const masterKey = MasterKey.generate();
	const models = new ModelConfig(db, masterKey);
	models.addProvider(faux.provider);
	await models.reload();
	runtime = await AgentRuntime.open({
		db,
		storage: new MemoryStorage(),
		models,
		cluster,
		taskGroups: new TaskGroups(db, cluster, { audit }),
		audit,
		// Short enough to keep the stream tests fast; the production default is 150 ms.
		sessionList: { coalesceMs: 10 },
	});
	drain = new RequestDrain();
	app = makeApp(db, undefined, { cluster, audit, masterKey, agent: { runtime, models }, drain });
	orgId = await defaultOrgId(db);
	for (const [name, kind] of [
		["alice", "member"],
		["bob", "member"],
		["carol", "member"],
		["dave", "member"],
		["root", "admin"],
	] as const) {
		const created = await createUser(db, {
			username: name,
			displayName: name === "alice" ? "Alice A." : undefined,
			kind,
			password: PASSWORD,
		});
		id[name] = created.id;
		user[name] = {
			sessionId: `test-${name}`,
			userId: created.id,
			username: created.username,
			kind: created.kind,
		};
		cookie[name] = await login(app, name, PASSWORD);
	}
	const group = await createUserGroup(db, "list-ops");
	groupId = group.id;
	await addUserGroupMember(db, groupId, id.bob as string);
	await addUserGroupMember(db, groupId, id.carol as string);
});

afterAll(async () => {
	await runtime.close();
	await db.destroy();
});

describe("GET /api/sessions", () => {
	it("lists the caller's root sessions newest first with the contract's item shape", async () => {
		const a1 = await newSession("alice", "alice one");
		await sleep(5);
		const a2 = await newSession("alice", "alice two");
		const b1 = await newSession("bob", "bob one");

		const mine = await list("alice");
		expect(mine.items.map((item) => item.id)).toEqual([a2, a1]);
		expect(mine.nextCursor).toBeNull();
		expect(mine.items[0]).toEqual({
			id: a2,
			title: "alice two",
			ownerUserId: id.alice,
			ownerName: "Alice A.",
			scheduleId: null,
			shared: false,
			state: "idle",
			waitingKind: null,
			unread: false,
			updatedAt: expect.any(String) as string,
		});
		expect(mine.items[0]).not.toHaveProperty("rules");
		expect(mine.items[0]).not.toHaveProperty("budgetUsedTokens");
		expect(mine.items[0]).not.toHaveProperty("usageTokens");

		// A subagent is a child session and never appears in the list.
		const child = await runtime.createSubagent(a1, {
			callKey: "list-child",
			task: "child task",
			rules: { default: "inherit", rules: [] },
			quota: null,
		});
		expect((await list("alice")).items.map((item) => item.id)).not.toContain(child.id);

		// ownerName falls back to the username when the display name is empty.
		await db
			.updateTable("users")
			.set({ display_name: "" })
			.where("id", "=", id.bob as string)
			.execute();
		expect((await list("root", "?scope=all")).items.find((item) => item.id === b1)?.ownerName).toBe("bob");
		await db
			.updateTable("users")
			.set({ display_name: "bob" })
			.where("id", "=", id.bob as string)
			.execute();

		expect((await list("bob")).items.map((item) => item.id)).toEqual([b1]);
		expect((await list("bob", "?scope=shared")).items).toEqual([]);
		// A member never sees everyone's sessions.
		expect((await call(app, "/api/sessions?scope=all", { cookie: cookie.bob })).status).toBe(403);
		// An administrator sees everything in `all` but only their own in `mine`.
		expect((await list("root", "?scope=all")).items.map((item) => item.id)).toEqual(
			expect.arrayContaining([a1, a2, b1]),
		);
		expect((await list("root")).items).toEqual([]);
		// `GET /sessions/:id` still returns the full session view.
		const full = (await (await call(app, `/api/sessions/${a1}`, { cookie: cookie.alice })).json()) as {
			session: {
				rules: { rulePreset: string } | null;
				budgetUsedTokens: number;
				usageTokens: number;
				contextTokens: number | null;
				capabilities: { view: boolean };
			};
		};
		expect(full.session.capabilities.view).toBe(true);
		expect(full.session.budgetUsedTokens).toBe(0);
		expect(full.session.usageTokens).toBe(0);
		expect(full.session.contextTokens).toBeNull();
		expect(full.session.rules?.rulePreset).toBe("ask");
	});

	it("aggregates a tree's state and waiting kind into its root's item", async () => {
		const rootId = await seed(id.alice as string, "aggregate root", "2026-07-10T00:00:00.000Z");
		const child = await seed(id.alice as string, "aggregate child", "2026-07-10T00:00:00.000Z", {
			parentSessionId: rootId,
			rootSessionId: rootId,
		});
		const second = await seed(id.alice as string, "aggregate child two", "2026-07-10T00:00:00.000Z", {
			parentSessionId: rootId,
			rootSessionId: rootId,
		});
		const item = async () => (await list("alice")).items.find((candidate) => candidate.id === rootId);

		// A background subagent running while its root is idle makes the tree running.
		await db.updateTable("sessions").set({ state: "running" }).where("id", "=", child).execute();
		expect(await item()).toMatchObject({ state: "running", waitingKind: null });

		// Any awaiting session makes the tree awaiting; its kind is the tree's.
		await db
			.updateTable("sessions")
			.set({ state: "awaiting", waiting_kind: "authorization" })
			.where("id", "=", child)
			.execute();
		expect(await item()).toMatchObject({ state: "awaiting", waitingKind: "authorization" });

		// Overlapping waits resolve by priority: quota > approval > authorization.
		await db
			.updateTable("sessions")
			.set({ state: "awaiting", waiting_kind: "approval" })
			.where("id", "=", second)
			.execute();
		expect(await item()).toMatchObject({ state: "awaiting", waitingKind: "approval" });
		await db
			.updateTable("sessions")
			.set({ state: "awaiting", waiting_kind: "quota", waiting_level_id: rootId })
			.where("id", "=", second)
			.execute();
		expect(await item()).toMatchObject({ state: "awaiting", waitingKind: "quota" });

		await db
			.updateTable("sessions")
			.set({ state: "running", waiting_kind: null, waiting_level_id: null })
			.where("id", "in", [child, second])
			.execute();
		expect(await item()).toMatchObject({ state: "running", waitingKind: null });
		await db.updateTable("sessions").set({ state: "idle" }).where("id", "in", [child, second]).execute();
		expect(await item()).toMatchObject({ state: "idle", waitingKind: null });
	});

	it("scopes shared sessions to direct and group shares, not ownership", async () => {
		const a1 = await newSession("alice", "share direct");
		await sleep(5);
		const a2 = await newSession("alice", "share group");
		await share(a1, { granteeType: "user", granteeId: id.bob, access: "view" });
		const groupShare = await share(a2, { granteeType: "user_group", granteeId: groupId, access: "view" });

		const bob = await list("bob", "?scope=shared");
		expect(bob.items.map((item) => item.id)).toEqual([a2, a1]);
		expect(bob.items.every((item) => item.shared)).toBe(true);
		expect(bob.items.every((item) => item.ownerName === "Alice A.")).toBe(true);
		expect((await list("bob")).items.map((item) => item.id)).not.toContain(a1);
		// Carol is in the group too; dave is not.
		expect((await list("carol", "?scope=shared")).items.map((item) => item.id)).toEqual([a2]);
		expect((await list("dave", "?scope=shared")).items).toEqual([]);
		// The owner's `shared` scope does not include what they own.
		expect((await list("alice", "?scope=shared")).items.map((item) => item.id)).not.toContain(a1);

		// Removing the group share takes the session out of carol's list but not bob's direct one.
		await unshare(a2, groupShare);
		expect((await list("carol", "?scope=shared")).items).toEqual([]);
		expect((await list("bob", "?scope=shared")).items.map((item) => item.id)).toEqual([a1]);
	});

	it("filters by ownerId, usable with the admin all scope", async () => {
		const aliceOne = await newSession("alice", "owner filter alice");
		await sleep(5);
		const bobOne = await newSession("bob", "owner filter bob");

		const adminAlice = await list("root", `?scope=all&ownerId=${id.alice}`);
		expect(adminAlice.items.map((item) => item.id)).toContain(aliceOne);
		expect(adminAlice.items.map((item) => item.id)).not.toContain(bobOne);
		expect(adminAlice.items.every((item) => item.ownerUserId === id.alice)).toBe(true);

		const adminBob = await list("root", `?scope=all&ownerId=${id.bob}`);
		expect(adminBob.items.map((item) => item.id)).toContain(bobOne);
		expect(adminBob.items.map((item) => item.id)).not.toContain(aliceOne);

		// Harmless for a non-admin: the scope already limits the list, so a foreign owner is an empty page.
		expect((await list("bob", `?ownerId=${id.alice}`)).items).toEqual([]);
		expect((await list("bob", `?ownerId=${id.bob}`)).items.map((item) => item.id)).toContain(bobOne);
		expect((await call(app, `/api/sessions?scope=all&ownerId=${id.alice}`, { cookie: cookie.bob })).status).toBe(403);
	});

	it("scope=visible is the owner-and-shared union, without an administrator override", async () => {
		const own = await newSession("bob", "visible own");
		const other = await newSession("alice", "visible other");
		const shared = await newSession("alice", "visible shared");
		await share(shared, { granteeType: "user", granteeId: id.bob, access: "view" });

		const bob = await list("bob", "?scope=visible");
		expect(bob.items.map((item) => item.id)).toEqual(expect.arrayContaining([own, shared]));
		expect(bob.items.map((item) => item.id)).not.toContain(other);
		expect(bob.items.find((item) => item.id === own)?.shared).toBe(false);
		expect(bob.items.find((item) => item.id === shared)?.shared).toBe(true);

		// An administrator's `visible` list is their own roots plus shares too, not everyone's sessions.
		const rootOwn = await newSession("root", "visible admin own");
		const root = await list("root", "?scope=visible");
		expect(root.items.map((item) => item.id)).toContain(rootOwn);
		expect(root.items.map((item) => item.id)).not.toContain(other);
		expect(root.items.map((item) => item.id)).not.toContain(shared);
		// `all` still exists for administrators and the other callers.
		expect((await list("root", "?scope=all")).items.map((item) => item.id)).toEqual(
			expect.arrayContaining([own, other, shared]),
		);
	});

	it("flags `shared` only when a share reaches the viewer, not for every foreign session", async () => {
		const foreign = await newSession("alice", "admin sees unshared");
		const sharedWithAdmin = await newSession("alice", "admin sees shared");
		const sharedWithBob = await newSession("alice", "bob sees shared");
		const own = await newSession("root", "root's own");
		await share(sharedWithAdmin, { granteeType: "user", granteeId: id.root, access: "view" });
		await share(sharedWithBob, { granteeType: "user", granteeId: id.bob, access: "view" });

		// An administrator browses everyone's sessions in `all`, but only a share reaching them is `shared`.
		const all = new Map((await list("root", "?scope=all")).items.map((item) => [item.id, item]));
		expect(all.get(foreign)?.shared).toBe(false);
		expect(all.get(sharedWithAdmin)?.shared).toBe(true);
		expect(all.get(sharedWithBob)?.shared).toBe(false);
		expect(all.get(own)?.shared).toBe(false);
		// The owner never gets `shared`, even if a group share reaches them.
		const mine = new Map((await list("alice", "?scope=mine")).items.map((item) => [item.id, item]));
		expect(mine.get(foreign)?.shared).toBe(false);
		// The grantee sees the session through a share, so it is `shared` for them.
		const shared = new Map((await list("bob", "?scope=shared")).items.map((item) => [item.id, item]));
		expect(shared.get(sharedWithBob)?.shared).toBe(true);
		expect((await list("bob", "?scope=shared")).items.some((item) => item.id === foreign)).toBe(false);
	});

	it("searches titles case-insensitively and escapes LIKE wildcards", async () => {
		await seed(id.alice as string, "Alpha One", "2026-03-01T00:00:00.000Z");
		await seed(id.alice as string, "beta two", "2026-03-01T00:00:01.000Z");
		await seed(id.alice as string, "100% done", "2026-03-01T00:00:02.000Z");
		await seed(id.alice as string, "under_score", "2026-03-01T00:00:03.000Z");
		await seed(id.alice as string, "back\\slash", "2026-03-01T00:00:04.000Z");

		expect((await list("alice", "?q=alpha")).items.map((item) => item.title)).toEqual(["Alpha One"]);
		expect((await list("alice", "?q=ALPHA")).items.map((item) => item.title)).toEqual(["Alpha One"]);
		expect((await list("alice", `?q=${encodeURIComponent("%")}`)).items.map((item) => item.title)).toEqual([
			"100% done",
		]);
		expect((await list("alice", "?q=_")).items.map((item) => item.title)).toEqual(["under_score"]);
		expect((await list("alice", "?q=%5C")).items.map((item) => item.title)).toEqual(["back\\slash"]);
		expect((await list("alice", "?q=nothing-like-it")).items).toEqual([]);
	});

	it("keeps the schedule filter", async () => {
		const now = "2026-04-01T00:00:00.000Z";
		await db
			.insertInto("schedules")
			.values({
				id: "sch-list",
				org_id: orgId,
				owner_user_id: id.alice as string,
				name: "list schedule",
				prompt: "do it",
				model: modelJson,
				token_budget: null,
				cron: "0 * * * *",
				timezone: "UTC",
				catch_up: 0,
				enabled: 1,
				next_run_at: null,
				created_at: now,
				updated_at: now,
			})
			.execute();
		const scheduled = await seed(id.alice as string, "from a schedule", "2026-04-01T00:00:01.000Z", {
			scheduleId: "sch-list",
		});
		await seed(id.alice as string, "not from a schedule", "2026-04-01T00:00:02.000Z");
		const filtered = await list("alice", "?scheduleId=sch-list");
		expect(filtered.items.map((item) => item.id)).toEqual([scheduled]);
		expect(filtered.items[0]?.scheduleId).toBe("sch-list");
	});

	it("pages with a keyset cursor across ties without skipping or repeating", async () => {
		const sameTime = "2026-05-01T00:00:00.000Z";
		const seeded: string[] = [];
		for (let index = 0; index < 10; index++) {
			seeded.push(
				await seed(id.dave as string, `tie ${index}`, sameTime, { id: `tie-${String(index).padStart(2, "0")}` }),
			);
		}
		const expected = [...seeded].sort().reverse();
		const seen: string[] = [];
		let cursor: string | undefined;
		for (let guard = 0; guard < 20; guard++) {
			const page = await list("dave", `?limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
			seen.push(...page.items.map((item) => item.id));
			if (!page.nextCursor) break;
			cursor = page.nextCursor;
		}
		// Newest first: all ties share updated_at, so the id decides.
		expect(seen.filter((sessionId) => sessionId.startsWith("tie-"))).toEqual(expected);
		expect(new Set(seen).size).toBe(seen.length);
	});

	it("rejects bad scopes, cursors, limits and schedule filters", async () => {
		for (const query of ["?scope=everyone", "?cursor=garbage", "?cursor=", "?limit=0", "?limit=201", "?limit=1.5"]) {
			expect((await call(app, `/api/sessions${query}`, { cookie: cookie.alice })).status, query).toBe(400);
		}
	});

	it("bumps updated_at on a title change, on messages and on a state change", async () => {
		const sessionId = await newSession("alice", "activity");
		const updatedAt = async () =>
			(await db.selectFrom("sessions").select("updated_at").where("id", "=", sessionId).executeTakeFirstOrThrow())
				.updated_at;
		const created = await updatedAt();

		await sleep(10);
		await call(app, `/api/sessions/${sessionId}`, {
			method: "PATCH",
			cookie: cookie.alice,
			body: { title: "activity renamed" },
		});
		const titled = await updatedAt();
		expect(Date.parse(titled)).toBeGreaterThan(Date.parse(created));
		expect((await list("alice", "?q=activity renamed")).items.map((item) => item.id)).toContain(sessionId);

		await sleep(10);
		faux.setResponses([fauxAssistantMessage([fauxText("an answer")])]);
		const sent = await call(app, `/api/sessions/${sessionId}/messages`, {
			cookie: cookie.alice,
			body: { text: "hello", requestId: "updated-at-message" },
		});
		const submitted = await updatedAt();
		expect(Date.parse(submitted)).toBeGreaterThan(Date.parse(titled));
		const { submissionId } = (await sent.json()) as { submissionId: string };
		await waitSubmission(runtime, sessionId, submissionId);
		// The assistant message moves it at run end, not on every streamed token.
		const ended = await waitFor<string>("the run end to be recorded", async () => {
			const value = await updatedAt();
			return value > submitted ? value : undefined;
		});
		expect(Date.parse(ended)).toBeGreaterThanOrEqual(Date.parse(submitted));

		await sleep(10);
		await setSessionState(db, sessionId, "awaiting", { kind: "quota", levelId: sessionId });
		const waiting = await updatedAt();
		expect(Date.parse(waiting)).toBeGreaterThan(Date.parse(ended));
		await setSessionState(db, sessionId, "idle", null);
	});

	it("bumps updated_at when a deleted schedule unlinks its sessions", async () => {
		const now = "2026-06-01T00:00:00.000Z";
		await db
			.insertInto("schedules")
			.values({
				id: "sch-unlink",
				org_id: orgId,
				owner_user_id: id.alice as string,
				name: "unlink",
				prompt: "p",
				model: modelJson,
				token_budget: null,
				cron: "0 * * * *",
				timezone: "UTC",
				catch_up: 0,
				enabled: 1,
				next_run_at: null,
				created_at: now,
				updated_at: now,
			})
			.execute();
		const sessionId = await seed(id.alice as string, "unlinked", "2026-06-01T00:00:01.000Z", {
			scheduleId: "sch-unlink",
		});
		await deleteSchedule(db, (await getSchedule(db, "sch-unlink")) as never);
		const row = await db
			.selectFrom("sessions")
			.select(["schedule_id", "updated_at"])
			.where("id", "=", sessionId)
			.executeTakeFirstOrThrow();
		expect(row.schedule_id).toBeNull();
		expect(row.updated_at > "2026-06-01T00:00:01.000Z").toBe(true);
	});

	it("uses the index for mine and all instead of sorting every root session", async () => {
		const plan = async (who: SessionUser, scope: "mine" | "all"): Promise<string> => {
			const query = await sessionListQuery(db, who, { scope });
			const compiled = query.limit(51).compile();
			const result = await db.executeQuery<{ detail: string }>(
				CompiledQuery.raw(`EXPLAIN QUERY PLAN ${compiled.sql}`, [...compiled.parameters]),
			);
			return result.rows.map((row) => row.detail).join("\n");
		};
		const mine = await plan(user.alice as SessionUser, "mine");
		expect(mine).toContain("sessions_owner_parent_updated_idx");
		expect(mine).not.toContain("TEMP B-TREE");
		const all = await plan(user.root as SessionUser, "all");
		expect(all).toContain("sessions_parent_updated_idx");
		expect(all).not.toContain("TEMP B-TREE");
	});
});

describe("unread sessions and the read endpoint", () => {
	const readRow = (sessionId: string) =>
		db
			.selectFrom("sessions")
			.select(["state", "reply_at", "owner_read_at", "updated_at"])
			.where("id", "=", sessionId)
			.executeTakeFirstOrThrow();

	it("sets reply_at when a tree leaves running for idle or awaiting", async () => {
		const root = await seed(id.alice as string, "reply root", "2026-09-01T00:00:00.000Z");
		const child = await seed(id.alice as string, "reply child", "2026-09-01T00:00:01.000Z", {
			parentSessionId: root,
			rootSessionId: root,
		});
		await db.updateTable("sessions").set({ state: "running" }).where("id", "in", [root, child]).execute();
		// A child ending while the root still runs leaves the tree running: no reply yet.
		await setSessionState(db, child, "idle", null);
		expect((await readRow(root)).reply_at).toBeNull();
		// The root ending is the tree's reply.
		await setSessionState(db, root, "idle", null);
		expect((await readRow(root)).reply_at).not.toBeNull();
		// running -> awaiting is a reply too.
		await db.updateTable("sessions").set({ state: "running", reply_at: null }).where("id", "=", root).execute();
		await setSessionState(db, root, "awaiting", { kind: "approval", levelId: null });
		expect((await readRow(root)).reply_at).not.toBeNull();
	});

	it("does not set reply_at when the tree was already awaiting", async () => {
		const root = await seed(id.alice as string, "already awaiting root", "2026-09-01T01:00:00.000Z");
		const child = await seed(id.alice as string, "already awaiting child", "2026-09-01T01:00:01.000Z", {
			parentSessionId: root,
			rootSessionId: root,
		});
		await db
			.updateTable("sessions")
			.set({ state: "awaiting", waiting_kind: "approval" })
			.where("id", "=", child)
			.execute();
		await db.updateTable("sessions").set({ state: "running" }).where("id", "=", root).execute();
		await setSessionState(db, root, "idle", null);
		expect((await readRow(root)).reply_at).toBeNull();
		// A second awaiting session does not make the running -> awaiting of another one a fresh reply.
		await db.updateTable("sessions").set({ state: "running" }).where("id", "=", root).execute();
		await setSessionState(db, root, "awaiting", { kind: "approval", levelId: null });
		expect((await readRow(root)).reply_at).toBeNull();
	});

	it("records the reply when markSessionsIdle ends a running tree", async () => {
		const root = await seed(id.alice as string, "aborted reply", "2026-09-01T02:00:00.000Z");
		await db.updateTable("sessions").set({ state: "running" }).where("id", "=", root).execute();
		await markSessionsIdle(db, [root]);
		expect((await readRow(root)).reply_at).not.toBeNull();
	});

	it("computes unread for the owner only", async () => {
		const root = await seed(id.alice as string, "unread root", "2026-09-02T00:00:00.000Z");
		await db.updateTable("sessions").set({ reply_at: "2026-09-02T00:00:00.000Z" }).where("id", "=", root).execute();
		expect((await list("alice")).items.find((item) => item.id === root)?.unread).toBe(true);

		const shareId = await share(root, { granteeType: "user", granteeId: id.bob, access: "view" });
		expect((await list("bob", "?scope=visible")).items.find((item) => item.id === root)).toMatchObject({
			shared: true,
			unread: false,
		});
		await unshare(root, shareId);

		await db
			.updateTable("sessions")
			.set({ owner_read_at: "2026-09-03T00:00:00.000Z" })
			.where("id", "=", root)
			.execute();
		expect((await list("alice")).items.find((item) => item.id === root)?.unread).toBe(false);
	});

	it("marks a tree read through any of its sessions and does not reorder the list", async () => {
		const root = await seed(id.alice as string, "read root", "2026-09-04T00:00:00.000Z");
		const child = await seed(id.alice as string, "read child", "2026-09-04T00:00:01.000Z", {
			parentSessionId: root,
			rootSessionId: root,
		});
		await db.updateTable("sessions").set({ reply_at: "2026-09-04T00:00:00.000Z" }).where("id", "=", root).execute();
		const before = await readRow(root);
		const res = await call(app, `/api/sessions/${child}/read`, { method: "POST", cookie: cookie.alice, body: {} });
		expect(res.status).toBe(204);
		const after = await readRow(root);
		expect(after.owner_read_at).not.toBeNull();
		expect(after.updated_at).toBe(before.updated_at);
		expect((await list("alice")).items.find((item) => item.id === root)?.unread).toBe(false);

		// A viewer the session is shared with is not its owner and cannot mark it read.
		const shareId = await share(root, { granteeType: "user", granteeId: id.bob, access: "view" });
		const denied = await call(app, `/api/sessions/${root}/read`, { method: "POST", cookie: cookie.bob, body: {} });
		expect(denied.status).toBe(403);
		await unshare(root, shareId);
	});

	it("sends unread in the list stream upsert, false for a shared viewer", async () => {
		const root = await seed(id.alice as string, "stream unread", "2026-09-05T00:00:00.000Z");
		await db.updateTable("sessions").set({ reply_at: "2026-09-05T00:00:00.000Z" }).where("id", "=", root).execute();
		const shareId = await share(root, { granteeType: "user", granteeId: id.bob, access: "view" });
		await sleep(50);
		const alice = await openStream("alice");
		const bob = await openStream("bob");
		await waitFor("two streams subscribed", () => runtime.sessionList.subscriberCount === 2);
		try {
			runtime.sessionList.publishSession(root);
			const ownerEvent = await alice.next(1_000);
			expect(JSON.parse(ownerEvent?.data ?? "{}")).toMatchObject({ id: root, unread: true });
			const sharedEvent = await bob.next(1_000);
			expect(JSON.parse(sharedEvent?.data ?? "{}")).toMatchObject({ id: root, shared: true, unread: false });
		} finally {
			alice.close();
			bob.close();
			await unshare(root, shareId);
		}
	});
});

describe("GET /api/sessions/:id/children", () => {
	it("lists the direct children newest first with their own state and parent", async () => {
		const rootId = await seed(id.alice as string, "children root", "2026-08-01T00:00:00.000Z");
		const first = await seed(id.alice as string, "child one", "2026-08-01T00:00:01.000Z", {
			parentSessionId: rootId,
			rootSessionId: rootId,
		});
		const second = await seed(id.alice as string, "child two", "2026-08-01T00:00:02.000Z", {
			parentSessionId: rootId,
			rootSessionId: rootId,
		});
		// A grandchild is not a direct child of the root.
		const grandchild = await seed(id.alice as string, "grandchild", "2026-08-01T00:00:03.000Z", {
			parentSessionId: second,
			rootSessionId: rootId,
		});
		// The child's own state, not the tree's: a waiting grandchild leaves its parent's item running.
		await db.updateTable("sessions").set({ state: "running" }).where("id", "=", first).execute();
		await db
			.updateTable("sessions")
			.set({ state: "awaiting", waiting_kind: "approval" })
			.where("id", "=", grandchild)
			.execute();

		const page = await children("alice", rootId);
		expect(page.items.map((item) => item.id)).toEqual([second, first]);
		expect(page.nextCursor).toBeNull();
		expect(page.items[0]).toEqual({
			id: second,
			title: "child two",
			ownerUserId: id.alice,
			ownerName: "Alice A.",
			scheduleId: null,
			shared: false,
			state: "idle",
			waitingKind: null,
			unread: false,
			updatedAt: "2026-08-01T00:00:02.000Z",
			parentSessionId: rootId,
		});
		expect(page.items[1]).toMatchObject({ id: first, state: "running", waitingKind: null, parentSessionId: rootId });
		// A subagent's own children are its direct children, and its state is what that list shows.
		expect((await children("alice", second)).items).toEqual([
			expect.objectContaining({
				id: grandchild,
				parentSessionId: second,
				state: "awaiting",
				waitingKind: "approval",
			}),
		]);
		expect((await children("alice", grandchild)).items).toEqual([]);
	});

	it("checks visibility on the session itself: owner, grantee, administrator, unrelated user", async () => {
		const rootId = await seed(id.alice as string, "visible root", "2026-08-02T00:00:00.000Z");
		const child = await seed(id.alice as string, "visible child", "2026-08-02T00:00:01.000Z", {
			parentSessionId: rootId,
			rootSessionId: rootId,
		});
		expect((await children("alice", rootId)).items.map((item) => item.id)).toEqual([child]);
		// Unrelated users get the same answer as `GET /sessions/:id`: not found, never 403.
		expect((await call(app, `/api/sessions/${rootId}/children`, { cookie: cookie.dave })).status).toBe(404);
		expect((await call(app, `/api/sessions/${rootId}/children`, { cookie: cookie.bob })).status).toBe(404);
		expect((await call(app, "/api/sessions/no-such-session/children", { cookie: cookie.alice })).status).toBe(404);

		// A direct share on the root reaches its subagents; the child is not the viewer's, so it is `shared`.
		await share(rootId, { granteeType: "user", granteeId: id.bob, access: "view" });
		const asBob = await children("bob", rootId);
		expect(asBob.items.map((item) => item.id)).toEqual([child]);
		expect(asBob.items[0]).toMatchObject({ shared: true, ownerUserId: id.alice });
		// A group share reaches its members too; the group is the test's own, so it cannot leak into the
		// stream tests' group membership changes below.
		const childGroup = await createUserGroup(db, "children-ops");
		await addUserGroupMember(db, childGroup.id, id.carol as string);
		await share(rootId, { granteeType: "user_group", granteeId: childGroup.id, access: "view" });
		expect((await children("carol", rootId)).items.map((item) => item.id)).toEqual([child]);
		expect((await call(app, `/api/sessions/${rootId}/children`, { cookie: cookie.dave })).status).toBe(404);
		// An administrator sees every session, but without a share the item is not `shared`.
		const asAdmin = await children("root", rootId);
		expect(asAdmin.items.map((item) => item.id)).toEqual([child]);
		expect(asAdmin.items[0]?.shared).toBe(false);
		// The child itself inherits the root's share, so a grantee can list the child's children.
		const grandchild = await seed(id.alice as string, "visible grandchild", "2026-08-02T00:00:02.000Z", {
			parentSessionId: child,
			rootSessionId: rootId,
		});
		expect((await children("bob", child)).items.map((item) => item.id)).toEqual([grandchild]);
	});

	it("pages with a keyset cursor across ties without skipping or repeating", async () => {
		const rootId = await seed(id.dave as string, "paged root", "2026-08-03T00:00:00.000Z");
		const sameTime = "2026-08-03T00:00:01.000Z";
		const seeded: string[] = [];
		for (let index = 0; index < 10; index++) {
			seeded.push(
				await seed(id.dave as string, `page child ${index}`, sameTime, {
					id: `child-${String(index).padStart(2, "0")}`,
					parentSessionId: rootId,
					rootSessionId: rootId,
				}),
			);
		}
		const expected = [...seeded].sort().reverse();
		const seen: string[] = [];
		let cursor: string | undefined;
		for (let guard = 0; guard < 20; guard++) {
			const page = await children("dave", rootId, `?limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
			seen.push(...page.items.map((item) => item.id));
			if (!page.nextCursor) break;
			cursor = page.nextCursor;
		}
		// All ties share updated_at, so the id decides; every child appears exactly once.
		expect(seen).toEqual(expected);
		expect(new Set(seen).size).toBe(seen.length);
	});

	it("rejects bad cursors and limits", async () => {
		const rootId = await seed(id.alice as string, "bad cursor root", "2026-08-04T00:00:00.000Z");
		for (const query of ["?cursor=garbage", "?cursor=", "?limit=0", "?limit=201", "?limit=1.5"]) {
			expect((await call(app, `/api/sessions/${rootId}/children${query}`, { cookie: cookie.alice })).status).toBe(400);
		}
	});

	it("summarizes the direct children's own states, for the compact children bar", async () => {
		const rootId = await seed(id.alice as string, "summary root", "2026-08-05T00:00:00.000Z");
		const running = await seed(id.alice as string, "running child", "2026-08-05T00:00:01.000Z", {
			parentSessionId: rootId,
			rootSessionId: rootId,
		});
		const awaiting = await seed(id.alice as string, "awaiting child", "2026-08-05T00:00:02.000Z", {
			parentSessionId: rootId,
			rootSessionId: rootId,
		});
		await seed(id.alice as string, "idle child", "2026-08-05T00:00:03.000Z", {
			parentSessionId: rootId,
			rootSessionId: rootId,
		});
		await seed(id.alice as string, "idle child two", "2026-08-05T00:00:04.000Z", {
			parentSessionId: rootId,
			rootSessionId: rootId,
		});
		// A grandchild is not a direct child, so it is not counted.
		await seed(id.alice as string, "summary grandchild", "2026-08-05T00:00:05.000Z", {
			parentSessionId: running,
			rootSessionId: rootId,
		});
		await db.updateTable("sessions").set({ state: "running" }).where("id", "=", running).execute();
		await db.updateTable("sessions").set({ state: "awaiting" }).where("id", "=", awaiting).execute();

		const res = await call(app, `/api/sessions/${rootId}/children/summary`, { cookie: cookie.alice });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ total: 4, states: { idle: 2, running: 1, awaiting: 1 } });
		// Visibility is the children list's: unrelated users get 404, a grantee sees the same counts.
		expect((await call(app, `/api/sessions/${rootId}/children/summary`, { cookie: cookie.dave })).status).toBe(404);
		expect((await call(app, "/api/sessions/no-such-session/children/summary", { cookie: cookie.alice })).status).toBe(
			404,
		);
		await share(rootId, { granteeType: "user", granteeId: id.bob, access: "view" });
		expect((await call(app, `/api/sessions/${rootId}/children/summary`, { cookie: cookie.bob })).status).toBe(200);
		// A session without children reports zeros, not a 404.
		const empty = await seed(id.alice as string, "no children", "2026-08-05T00:00:06.000Z");
		const none = await call(app, `/api/sessions/${empty}/children/summary`, { cookie: cookie.alice });
		expect(await none.json()).toEqual({ total: 0, states: { idle: 0, running: 0, awaiting: 0 } });
	});

	it("uses the parent index instead of sorting a session's children", async () => {
		const compiled = sessionChildrenQuery(db, "any-session").limit(51).compile();
		const result = await db.executeQuery<{ detail: string }>(
			CompiledQuery.raw(`EXPLAIN QUERY PLAN ${compiled.sql}`, [...compiled.parameters]),
		);
		const plan = result.rows.map((row) => row.detail).join("\n");
		expect(plan).toContain("sessions_parent_updated_idx");
		expect(plan).not.toContain("TEMP B-TREE");
	});
});

describe("GET /api/sessions/stream", () => {
	it("answers HEAD without opening a stream", async () => {
		expect(runtime.sessionList.subscriberCount).toBe(0);
		const visible = await call(app, "/api/sessions/stream?scope=visible", { method: "HEAD", cookie: cookie.alice });
		expect(visible.status).toBe(200);
		expect(await visible.text()).toBe("");
		expect(runtime.sessionList.subscriberCount).toBe(0);
		// A stream would still hold the drain after the response returned.
		expect(await Promise.race([drain.waitForIdle().then(() => true), sleep(100).then(() => false)])).toBe(true);

		expect((await call(app, "/api/sessions/stream?scope=all", { method: "HEAD", cookie: cookie.bob })).status).toBe(
			403,
		);
		expect((await call(app, "/api/sessions/stream", { method: "HEAD" })).status).toBe(401);
	});

	it("sends an upsert only to subscribers who can see the session, and a remove on unshare", async () => {
		const shared = await newSession("alice", "stream shared");
		const hidden = await newSession("bob", "stream hidden");
		// Let the creations' coalesced upserts fire before anyone subscribes.
		await sleep(50);
		const streams = {
			alice: await openStream("alice"),
			bob: await openStream("bob"),
			carol: await openStream("carol"),
			root: await openStream("root"),
		};
		await waitFor("all four streams subscribed", () => runtime.sessionList.subscriberCount === 4);
		try {
			// The owner's change reaches the owner and every administrator, nobody else.
			const renamed = await call(app, `/api/sessions/${shared}`, {
				method: "PATCH",
				cookie: cookie.alice,
				body: { title: "stream renamed" },
			});
			expect(renamed.status).toBe(200);
			expect(upsertIds((await streams.alice.collected(500)).slice(0, 1))).toEqual([shared]);
			expect(upsertIds((await streams.root.collected(500)).slice(0, 1))).toEqual([shared]);
			expect(upsertIds(await streams.bob.collected(300))).not.toContain(shared);
			expect(await streams.carol.next(300)).toBeUndefined();
			// Nothing about bob's other session leaks either.
			expect(upsertIds(await streams.alice.collected(200))).not.toContain(hidden);
			const rootSeen = upsertIds(await streams.root.collected(300));
			expect(rootSeen).not.toContain(shared);

			// Sharing with bob reaches bob (with shared: true), not carol.
			const shown = await call(app, `/api/sessions/${shared}/shares`, {
				method: "PUT",
				cookie: cookie.alice,
				body: { granteeType: "user", granteeId: id.bob, access: "view" },
			});
			expect(shown.status).toBe(200);
			const shareId = ((await shown.json()) as { share: { id: string } }).share.id;
			const toBob = await streams.bob.next(1_000);
			expect(toBob?.event).toBe("upsert");
			expect(JSON.parse(toBob?.data ?? "{}")).toMatchObject({ id: shared, shared: true, ownerName: "Alice A." });
			expect(await streams.carol.next(300)).toBeUndefined();

			// Drain the owner again, then unshare: only the former grantee hears `remove`.
			await streams.alice.collected(200);
			await call(app, `/api/sessions/${shared}/shares/${shareId}`, {
				method: "DELETE",
				cookie: cookie.alice,
				body: {},
			});
			const removed = await streams.bob.next(1_000);
			expect(removed?.event).toBe("remove");
			expect(JSON.parse(removed?.data ?? "{}")).toEqual({ id: shared });
			expect(await streams.alice.next(300)).toBeUndefined();
			expect(await streams.carol.next(200)).toBeUndefined();
			expect(await streams.root.next(200)).toBeUndefined();
		} finally {
			streams.alice.close();
			streams.bob.close();
			streams.carol.close();
			streams.root.close();
		}
	});

	it("scope=visible streams only the owner-and-shared union, for administrators too", async () => {
		const own = await newSession("bob", "visible stream own");
		const shared = await newSession("alice", "visible stream shared");
		const hidden = await newSession("alice", "visible stream hidden");
		const shareId = await share(shared, { granteeType: "user", granteeId: id.bob, access: "view" });
		// Let the creations' coalesced upserts fire before anyone subscribes.
		await sleep(50);
		const bob = await openStream("bob", "?scope=visible");
		const root = await openStream("root", "?scope=visible");
		await waitFor("two streams subscribed", () => runtime.sessionList.subscriberCount === 2);
		try {
			// The owner's change reaches the owner.
			await call(app, `/api/sessions/${own}`, {
				method: "PATCH",
				cookie: cookie.bob,
				body: { title: "visible stream own 2" },
			});
			expect(upsertIds((await bob.collected(500)).slice(0, 1))).toEqual([own]);

			// A change to the shared session reaches the grantee, with `shared: true`.
			await call(app, `/api/sessions/${shared}`, {
				method: "PATCH",
				cookie: cookie.alice,
				body: { title: "visible stream shared 2" },
			});
			const toBob = await bob.collected(500);
			const sharedUpsert = toBob.find(
				(event) => event.event === "upsert" && (JSON.parse(event.data) as SessionListItem).id === shared,
			);
			expect(JSON.parse(sharedUpsert?.data ?? "{}")).toMatchObject({ id: shared, shared: true });

			// The administrator's stream is narrowed too: a change to a session only they can see, to the
			// member's own one and to the shared one never reaches it.
			await call(app, `/api/sessions/${hidden}`, {
				method: "PATCH",
				cookie: cookie.alice,
				body: { title: "visible stream hidden 2" },
			});
			const rootEvents = await root.collected(500);
			expect(upsertIds(rootEvents)).not.toContain(hidden);
			expect(upsertIds(rootEvents)).not.toContain(own);
			expect(upsertIds(rootEvents)).not.toContain(shared);

			// Revoking the share removes it from the grantee's list.
			await call(app, `/api/sessions/${shared}/shares/${shareId}`, {
				method: "DELETE",
				cookie: cookie.alice,
				body: {},
			});
			const removed = await bob.next(1_000);
			expect(removed?.event).toBe("remove");
			expect(JSON.parse(removed?.data ?? "{}")).toEqual({ id: shared });
		} finally {
			bob.close();
			root.close();
		}
	});

	it("follows group membership: joining grants an upsert, leaving grants a remove", async () => {
		const session = await newSession("alice", "group stream");
		await call(app, `/api/sessions/${session}/shares`, {
			method: "PUT",
			cookie: cookie.alice,
			body: { granteeType: "user_group", granteeId: groupId, access: "view" },
		});
		await sleep(50);
		const bob = await openStream("bob");
		const dave = await openStream("dave");
		await waitFor("two streams subscribed", () => runtime.sessionList.subscriberCount === 2);
		try {
			// Bob is already in the group: a change is an ordinary upsert for him, nothing for dave.
			await call(app, `/api/sessions/${session}`, {
				method: "PATCH",
				cookie: cookie.alice,
				body: { title: "group stream 2" },
			});
			expect(upsertIds((await bob.collected(500)).slice(0, 1))).toEqual([session]);
			expect(await dave.next(200)).toBeUndefined();

			// Dave joins the group: the session becomes visible to him.
			await call(app, `/api/user-groups/${groupId}/members/${id.dave}`, {
				method: "PUT",
				cookie: cookie.root,
				body: {},
			});
			const joined = await dave.next(1_000);
			expect(joined?.event).toBe("upsert");
			expect(JSON.parse(joined?.data ?? "{}")).toMatchObject({ id: session, shared: true });

			// Dave leaves again: remove, not a silent disappearance.
			await call(app, `/api/user-groups/${groupId}/members/${id.dave}`, {
				method: "DELETE",
				cookie: cookie.root,
				body: {},
			});
			const left = await dave.next(1_000);
			expect(left?.event).toBe("remove");
			expect(JSON.parse(left?.data ?? "{}")).toEqual({ id: session });

			// A group deletion removes it from the remaining member's list too.
			await call(app, `/api/user-groups/${groupId}`, { method: "DELETE", cookie: cookie.root, body: {} });
			const removed = await bob.next(1_000);
			expect(removed?.event).toBe("remove");
			expect(JSON.parse(removed?.data ?? "{}")).toEqual({ id: session });
		} finally {
			bob.close();
			dave.close();
		}
	});

	it("carries `shared` per subscriber: true for the grantee, false for the owner and an administrator", async () => {
		await waitFor("no leftover streams", () => runtime.sessionList.subscriberCount === 0);
		const session = await newSession("alice", "shared flag");
		await share(session, { granteeType: "user", granteeId: id.bob, access: "view" });
		// Let the creation's coalesced upsert fire before anyone subscribes.
		await sleep(50);
		const alice = await openStream("alice");
		const bob = await openStream("bob");
		const root = await openStream("root");
		await waitFor("three streams subscribed", () => runtime.sessionList.subscriberCount === 3);
		try {
			const renamed = await call(app, `/api/sessions/${session}`, {
				method: "PATCH",
				cookie: cookie.alice,
				body: { title: "shared flag changed" },
			});
			expect(renamed.status).toBe(200);
			const itemOf = async (stream: Awaited<ReturnType<typeof openStream>>): Promise<SessionListItem> => {
				const events = await stream.collected(500);
				const event = events.find(
					(candidate) => candidate.event === "upsert" && (JSON.parse(candidate.data) as SessionListItem).id === session,
				);
				if (!event) throw new Error("no upsert for the session");
				return JSON.parse(event.data) as SessionListItem;
			};
			const asAlice = await itemOf(alice);
			const asBob = await itemOf(bob);
			const asRoot = await itemOf(root);
			expect(asAlice).toMatchObject({ shared: false, title: "shared flag changed" });
			expect(asBob).toMatchObject({ shared: true, title: "shared flag changed" });
			// An administrator sees the session in `all` without a share reaching them: not `shared`.
			expect(asRoot).toMatchObject({ shared: false, title: "shared flag changed" });
		} finally {
			alice.close();
			bob.close();
			root.close();
		}
	});

	it("coalesces a burst of writes to one session into one upsert", async () => {
		await waitFor("no leftover streams", () => runtime.sessionList.subscriberCount === 0);
		const session = await newSession("alice", "coalesced");
		await sleep(50);
		const alice = await openStream("alice");
		await waitFor("one stream subscribed", () => runtime.sessionList.subscriberCount === 1);
		try {
			for (let index = 0; index < 10; index++) runtime.sessionList.publishSession(session);
			const events = await alice.collected(400);
			expect(upsertIds(events).filter((sessionId) => sessionId === session)).toHaveLength(1);
			expect(events.every((event) => event.event === "upsert")).toBe(true);
		} finally {
			alice.close();
		}
	});

	it("ends a disabled user's stream", async () => {
		await waitFor("no leftover streams", () => runtime.sessionList.subscriberCount === 0);
		const dave = await openStream("dave");
		await waitFor("dave's stream subscribed", () => runtime.sessionList.subscriberCount === 1);
		const disabled = await call(app, `/api/users/${id.dave}`, {
			method: "PATCH",
			cookie: cookie.root,
			body: { status: "disabled" },
		});
		expect(disabled.status).toBe(200);
		expect(await dave.ended()).toBe(true);
		expect(runtime.sessionList.subscriberCount).toBe(0);
	});

	it("is closed by shutdown and lets the drain go idle", async () => {
		// re-enable dave first so login still works (the test above disabled the account)
		await db
			.updateTable("users")
			.set({ status: "active" })
			.where("id", "=", id.dave as string)
			.execute();
		await waitFor("no leftover streams", () => runtime.sessionList.subscriberCount === 0);
		const stream = await openStream("carol");
		await waitFor("a stream subscribed", () => runtime.sessionList.subscriberCount === 1);
		drain.begin();
		expect(await stream.ended()).toBe(true);
		await drain.waitForIdle();
	});
});

describe("SessionListHub coalescing and shares", () => {
	type HubEvent = { event: "upsert" | "remove"; data: SessionListItem | { id: string } };

	/** One hub subscriber that records what it would have written to its SSE connection. */
	const hubStream = (who: string) => {
		const events: HubEvent[] = [];
		const subscriber: SessionListSubscriber = {
			user: user[who] as SessionUser,
			send: (event, data) => {
				events.push({ event, data });
			},
			close: () => {},
		};
		return { events, subscriber };
	};

	const upsertsOf = (events: HubEvent[], sessionId: string): SessionListItem[] =>
		events
			.filter((event) => event.event === "upsert")
			.map((event) => event.data as SessionListItem)
			.filter((item) => item.id === sessionId);

	const bump = async (sessionId: string, title: string, updatedAt: string) => {
		await db.updateTable("sessions").set({ title, updated_at: updatedAt }).where("id", "=", sessionId).execute();
	};

	it("publishes a subagent's change as its root's item", async () => {
		const rootId = await seed(id.alice as string, "tree root", "2026-07-11T00:00:00.000Z");
		const child = await seed(id.alice as string, "tree child", "2026-07-11T00:00:00.000Z", {
			parentSessionId: rootId,
			rootSessionId: rootId,
		});
		const hub = new SessionListHub({ db, coalesceMs: 10 });
		const alice = hubStream("alice");
		hub.subscribe(alice.subscriber);
		try {
			await db
				.updateTable("sessions")
				.set({ state: "awaiting", waiting_kind: "approval" })
				.where("id", "=", child)
				.execute();
			hub.publishSession(child);
			await sleep(80);
			// The child never appears in the list; its change arrives as the root's aggregated item.
			expect(upsertsOf(alice.events, rootId)).toEqual([
				expect.objectContaining({ id: rootId, state: "awaiting", waitingKind: "approval" }),
			]);
			expect(alice.events.some((event) => event.data.id === child)).toBe(false);
		} finally {
			hub.close();
		}
	});

	it("publishes a state change a share removal takes over, and only `remove` to the former grantee", async () => {
		const sessionId = await seed(id.alice as string, "before removal", "2026-07-01T00:00:00.000Z");
		const shared = await shareSession(db, {
			sessionId,
			granteeType: "user",
			granteeId: id.bob as string,
			access: "view",
			createdBy: id.alice as string,
		});
		// A long enough window that the unshare below lands well inside it.
		const hub = new SessionListHub({ db, coalesceMs: 300 });
		const alice = hubStream("alice");
		const bob = hubStream("bob");
		const root = hubStream("root");
		for (const stream of [alice, bob, root]) hub.subscribe(stream.subscriber);
		try {
			await bump(sessionId, "after removal", "2026-07-01T00:00:01.000Z");
			hub.publishSession(sessionId);
			await unshareSession(db, sessionId, shared.id);
			await hub.publishShareRemoved(sessionId, [id.bob as string]);

			await sleep(500); // past the coalescing window
			// The former grantee hears the removal and never a late upsert.
			expect(bob.events).toEqual([{ event: "remove", data: { id: sessionId } }]);
			// The owner and the administrator still get the state change the timer would have published.
			expect(upsertsOf(alice.events, sessionId)).toEqual([
				expect.objectContaining({ title: "after removal", shared: false }),
			]);
			expect(upsertsOf(root.events, sessionId)).toEqual([expect.objectContaining({ shared: false })]);
		} finally {
			hub.close();
		}
	});

	it("publishes a state change a share addition takes over, once, to the new grantee", async () => {
		const sessionId = await seed(id.alice as string, "before addition", "2026-07-02T00:00:00.000Z");
		const hub = new SessionListHub({ db, coalesceMs: 300 });
		const alice = hubStream("alice");
		const bob = hubStream("bob");
		const root = hubStream("root");
		for (const stream of [alice, bob, root]) hub.subscribe(stream.subscriber);
		try {
			await bump(sessionId, "after addition", "2026-07-02T00:00:01.000Z");
			hub.publishSession(sessionId);
			await shareSession(db, {
				sessionId,
				granteeType: "user",
				granteeId: id.bob as string,
				access: "view",
				createdBy: id.alice as string,
			});
			await hub.publishShareAdded(sessionId, { granteeType: "user", granteeId: id.bob as string });

			await sleep(500); // the targeted upsert must not be duplicated when the timer would have fired
			expect(upsertsOf(bob.events, sessionId)).toEqual([
				expect.objectContaining({ title: "after addition", shared: true }),
			]);
			expect(upsertsOf(alice.events, sessionId)).toEqual([
				expect.objectContaining({ title: "after addition", shared: false }),
			]);
			expect(upsertsOf(root.events, sessionId)).toEqual([expect.objectContaining({ shared: false })]);
		} finally {
			hub.close();
		}
	});
});
