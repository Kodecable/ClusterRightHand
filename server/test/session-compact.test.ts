import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ModelConfig } from "../src/agent/models.ts";
import { AgentRuntime } from "../src/agent/runtime.ts";
import { sessionStateOf } from "../src/agent/session-state.ts";
import { shareSession } from "../src/agent/sharing.ts";
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

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/**
 * Manual compaction (doc/agent-runtime.md#会话): the user asks for a summary through durable's `compact()`, which
 * makes it in the background and places it when idle; it is charged like any other output and audited.
 */
let db: Db;
let app: App;
let audit: Audit;
let runtime: AgentRuntime;
let owner: SessionUser;
let ownerCookie = "";
let viewerCookie = "";
let viewerId = "";
// A large window keeps automatic compaction away; the tiny keepRecentTokens lets a manual one cut a short history,
// and backgroundTokens: 0 turns the automatic background compaction off.
const faux = fauxProvider({ models: [{ id: "normal-1", contextWindow: 100_000 }] });
const model = () => ({ provider: faux.provider.id, modelId: faux.getModel().id });

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
		compaction: { keepRecentTokens: 1, backgroundTokens: 0 },
	});
	app = makeApp(db, undefined, { cluster, audit, masterKey, agent: { runtime, models } });
	const user = await createUser(db, { username: "owner", kind: "member", password: "password-123" });
	owner = { sessionId: "test", userId: user.id, username: user.username, kind: "member" };
	const viewer = await createUser(db, { username: "viewer", kind: "member", password: "password-123" });
	viewerId = viewer.id;
	ownerCookie = await login(app, "owner", "password-123");
	viewerCookie = await login(app, "viewer", "password-123");
});

afterAll(async () => {
	await runtime.close();
	await db.destroy();
});

it("compacts on request, places a manual summary and audits session.compacted", async () => {
	const session = await runtime.createSession(owner, {
		model: model(),
		preset: "yolo",
		title: "manual compaction",
	});
	faux.setResponses([fauxAssistantMessage([fauxText("hi")])]);
	const first = await runtime.submit(session.id, owner, "hello", "manual-compaction-1");
	expect((await waitSubmission(runtime, session.id, first)).status).toBe("done");

	// The summary is the next model call; the idle conversation places it at once.
	faux.setResponses([fauxAssistantMessage([fauxText("manual summary")])]);
	const result = await runtime.compact(session.id, owner, "keep node names");
	// The summary was produced, so this is a started compaction even when durable settled it within the wait.
	expect(result).toMatchObject({ outcome: "started" });
	const { taskId } = result;
	expect(taskId).not.toBe("");

	await vi.waitFor(
		async () => {
			const { entries } = await runtime.entriesPage(session.id, undefined, 100);
			const compaction = entries.find((entry) => entry.kind === "pi.compaction");
			expect(compaction).toBeDefined();
			expect((compaction?.data as { reason?: string } | undefined)?.reason).toBe("manual");
			expect(JSON.stringify(compaction?.model)).toContain("manual summary");
		},
		{ timeout: 15_000, interval: 50 },
	);
	expect(faux.getPendingResponseCount()).toBe(0);

	await audit.flush();
	const rows = await db.selectFrom("audit_events").selectAll().where("action", "=", "session.compacted").execute();
	const event = rows.find((row) => row.target_id === session.id);
	expect(event).toMatchObject({
		actor_type: "user",
		actor_id: owner.userId,
		on_behalf_of_user_id: owner.userId,
		target_type: "session",
		target_id: session.id,
	});
	expect(JSON.parse(event?.detail ?? "{}")).toEqual({
		task_id: taskId,
		instructions_chars: "keep node names".length,
	});
});

it("refuses an archived session", async () => {
	const session = await runtime.createSession(owner, { model: model(), preset: "yolo", title: "archived" });
	// There is no archive endpoint yet; the row's status is what the runtime refuses (doc/agent-runtime.md#会话).
	await db
		.updateTable("sessions")
		.set({ status: "archived", archived_at: new Date().toISOString() })
		.where("id", "=", session.id)
		.execute();
	await expect(runtime.compact(session.id, owner, undefined)).rejects.toThrow("the session is archived");
});

it("refuses when the session's token quota is used up", async () => {
	const session = await runtime.createSession(owner, {
		model: model(),
		preset: "yolo",
		title: "exhausted",
		budgetRemaining: 0,
	});
	await expect(runtime.compact(session.id, owner, undefined)).rejects.toThrow(
		"the session's token quota is used up; raise it to continue",
	);
});

it("the route rejects too-long instructions and a view-only share", async () => {
	const session = await runtime.createSession(owner, { model: model(), preset: "yolo", title: "route" });
	const path = `/api/sessions/${session.id}/compact`;

	const tooLong = await call(app, path, { cookie: ownerCookie, body: { instructions: "x".repeat(2001) } });
	expect(tooLong.status).toBe(400);
	expect(await tooLong.json()).toEqual({ error: "instructions must be at most 2000 characters" });

	await shareSession(db, {
		sessionId: session.id,
		granteeType: "user",
		granteeId: viewerId,
		access: "view",
		createdBy: owner.userId,
	});
	const forbidden = await call(app, path, { cookie: viewerCookie, body: {} });
	expect(forbidden.status).toBe(403);
	expect(await forbidden.json()).toEqual({ error: "chat access is required" });
});

it("shows a manual compaction as running until its summary is placed", async () => {
	const session = await runtime.createSession(owner, {
		model: model(),
		preset: "yolo",
		title: "compaction state",
	});
	faux.setResponses([fauxAssistantMessage([fauxText("hi")])]);
	const first = await runtime.submit(session.id, owner, "hello", "compaction-state-1");
	expect((await waitSubmission(runtime, session.id, first)).status).toBe("done");
	expect(await sessionStateOf(db, session.id)).toBe("idle");

	// Delaying the summary keeps the run observable before the compaction can finish.
	faux.setResponses([
		async () => {
			await new Promise((resolve) => setTimeout(resolve, 200));
			return fauxAssistantMessage([fauxText("state summary")]);
		},
	]);
	await runtime.compact(session.id, owner, undefined);
	expect(await sessionStateOf(db, session.id)).toBe("running");

	await vi.waitFor(
		async () => {
			const { entries } = await runtime.entriesPage(session.id, undefined, 100);
			expect(entries.some((entry) => entry.kind === "pi.compaction")).toBe(true);
			expect(await sessionStateOf(db, session.id)).toBe("idle");
		},
		{ timeout: 15_000, interval: 50 },
	);
});

it("returns a stopped manual compaction to idle without placing a summary", async () => {
	const session = await runtime.createSession(owner, {
		model: model(),
		preset: "yolo",
		title: "stopped compaction",
	});
	faux.setResponses([fauxAssistantMessage([fauxText("hi")])]);
	const first = await runtime.submit(session.id, owner, "hello", "stopped-compaction-1");
	expect((await waitSubmission(runtime, session.id, first)).status).toBe("done");
	expect(await sessionStateOf(db, session.id)).toBe("idle");

	faux.setResponses([
		async () => {
			await new Promise((resolve) => setTimeout(resolve, 1_000));
			return fauxAssistantMessage([fauxText("stopped summary")]);
		},
	]);
	// The call waits up to 2 s for the summary, so stop it while the summarization request is still live.
	const compaction = runtime.compact(session.id, owner, undefined);
	// Wait until durable made the summarization request, so the stop cancels a live compaction.
	await vi.waitFor(() => expect(faux.getPendingResponseCount()).toBe(0), { timeout: 5_000, interval: 10 });
	await vi.waitFor(async () => expect(await sessionStateOf(db, session.id)).toBe("running"), {
		timeout: 5_000,
		interval: 10,
	});

	await runtime.abort(session.id, owner);
	expect((await compaction).outcome).toBe("failed");
	expect(await sessionStateOf(db, session.id)).toBe("idle");
	// The tracker's conditional write must not revive the session after the stop already made it idle.
	await new Promise((resolve) => setTimeout(resolve, 300));
	expect(await sessionStateOf(db, session.id)).toBe("idle");
	const { entries } = await runtime.entriesPage(session.id, undefined, 100);
	expect(entries.some((entry) => entry.kind === "pi.compaction")).toBe(false);
});

describe("with the default compaction policy", () => {
	let localDb: Db;
	let localRuntime: AgentRuntime;
	let localOwner: SessionUser;
	// The pi defaults: the most recent 20k tokens are kept, so a short conversation has nothing to cut.
	const defaultFaux = fauxProvider({ models: [{ id: "default-1", contextWindow: 100_000 }] });
	const defaultModel = () => ({ provider: defaultFaux.provider.id, modelId: defaultFaux.getModel().id });

	beforeAll(async () => {
		localDb = await openTestDb("sqlite");
		const localAudit = new Audit(localDb);
		const localCluster = new Cluster(localDb, { audit: localAudit });
		const models = new ModelConfig(localDb, MasterKey.generate());
		models.addProvider(defaultFaux.provider);
		await models.reload();
		localRuntime = await AgentRuntime.open({
			db: localDb,
			storage: new MemoryStorage(),
			models,
			cluster: localCluster,
			taskGroups: new TaskGroups(localDb, localCluster, { audit: localAudit }),
			audit: localAudit,
			// keepRecentTokens stays at the 20k default; only the automatic background compaction is off.
			compaction: { backgroundTokens: 0 },
		});
		const user = await createUser(localDb, { username: "owner", kind: "member", password: "password-123" });
		localOwner = { sessionId: "test", userId: user.id, username: user.username, kind: "member" };
	});

	afterAll(async () => {
		await localRuntime.close();
		await localDb.destroy();
	});

	it("reports nothing to compact when the recent window holds the whole conversation", async () => {
		const session = await localRuntime.createSession(localOwner, {
			model: defaultModel(),
			preset: "yolo",
			title: "nothing to compact",
		});
		defaultFaux.setResponses([fauxAssistantMessage([fauxText("hi")])]);
		const first = await localRuntime.submit(session.id, localOwner, "hello", "nothing-to-compact-1");
		expect((await waitSubmission(localRuntime, session.id, first)).status).toBe("done");
		expect(await sessionStateOf(localDb, session.id)).toBe("idle");

		const result = await localRuntime.compact(session.id, localOwner, undefined);
		expect(result.outcome).toBe("nothing");
		expect(result.taskId).not.toBe("");
		// The revived run ends at once: durable completed the compaction without a summary.
		await vi.waitFor(async () => expect(await sessionStateOf(localDb, session.id)).toBe("idle"), {
			timeout: 5_000,
			interval: 50,
		});
	});
});
