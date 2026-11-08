import type { SessionEvent } from "@crh/api";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { SSEStreamingApi } from "hono/streaming";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { ModelConfig } from "../src/agent/models.ts";
import { AgentRuntime } from "../src/agent/runtime.ts";
import { RequestDrain } from "../src/api/drain.ts";
import { SessionStreams } from "../src/api/session-events-routes.ts";
import { Audit } from "../src/audit/audit.ts";
import { resolveWebSession, revokeWebSession, type SessionUser } from "../src/auth/sessions.ts";
import { Cluster } from "../src/cluster/cluster.ts";
import { TaskGroups } from "../src/cluster/task-groups.ts";
import { MasterKey } from "../src/keys/master-key.ts";
import type { Db } from "../src/storage/db.ts";
import { createUser } from "../src/users/service.ts";
import { type App, call, login, makeApp } from "./helpers/api.ts";
import { openTestDb } from "./helpers/db.ts";
import { waitSubmission } from "./helpers/runtime.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const PASSWORD = "session-events-password";
const faux = fauxProvider();
const model = () => ({ provider: faux.provider.id, modelId: faux.getModel().id });

let db: Db;
let app: App;
let runtime: AgentRuntime;
let drain: RequestDrain;
let owner: SessionUser;
let alice = "";
let bob = "";
let sessionId = "";

/** Whether the drain is idle within a short grace period, i.e. no event stream is still holding it. */
async function drainIdle(ms = 100): Promise<boolean> {
	return Promise.race([
		drain.waitForIdle().then(() => true),
		new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
	]);
}

beforeAll(async () => {
	db = await openTestDb("sqlite");
	const audit = new Audit(db);
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
	});
	drain = new RequestDrain();
	app = makeApp(db, undefined, { cluster, audit, masterKey, agent: { runtime, models }, drain });

	const aliceRow = await createUser(db, { username: "alice", kind: "member", password: PASSWORD });
	await createUser(db, { username: "bob", kind: "member", password: PASSWORD });
	alice = await login(app, "alice", PASSWORD);
	bob = await login(app, "bob", PASSWORD);
	const ownerRow: SessionUser = {
		sessionId: "test-alice",
		userId: aliceRow.id,
		username: aliceRow.username,
		kind: aliceRow.kind,
	};
	owner = ownerRow;
	sessionId = (await runtime.createSession(owner, { title: "event stream", model: model(), rulePreset: "ask" })).id;
});

afterAll(async () => {
	drain.begin();
	await runtime.close();
	await db.destroy();
});

it("answers HEAD with the access checks and opens no stream", async () => {
	const visible = await call(app, `/api/sessions/${sessionId}/events`, { method: "HEAD", cookie: alice });
	expect(visible.status).toBe(200);
	expect(await visible.text()).toBe("");
	// A stream would still hold the drain after the response returned.
	expect(await drainIdle()).toBe(true);

	// Invisible and unknown sessions are the same 404 as the GET route; a HEAD with no session is a 401.
	expect((await call(app, `/api/sessions/${sessionId}/events`, { method: "HEAD", cookie: bob })).status).toBe(404);
	expect((await call(app, "/api/sessions/does-not-exist/events", { method: "HEAD", cookie: alice })).status).toBe(404);
	expect((await call(app, `/api/sessions/${sessionId}/events`, { method: "HEAD" })).status).toBe(401);
	expect(await drainIdle()).toBe(true);
});

const writeSSE = SSEStreamingApi.prototype.writeSSE;

/** Runs the 15 s keep-alive ping at once, without touching the writes (for the revocation re-check). */
function fastPings(): () => void {
	const originalSetTimeout = globalThis.setTimeout;
	const timer = vi
		.spyOn(globalThis, "setTimeout")
		.mockImplementation((handler, timeout, ...args) =>
			originalSetTimeout(handler, timeout === 15_000 ? 0 : timeout, ...args),
		);
	return () => timer.mockRestore();
}

/**
 * Reads a stream to its end in the background. `closed()` says whether it ended, so a test can check that
 * one stream stayed open while another was ended without starting a second concurrent read.
 */
function track(reader: ReadableStreamDefaultReader<Uint8Array>): { done: Promise<void>; closed: () => boolean } {
	let closed = false;
	const done = (async () => {
		try {
			for (;;) {
				const { done: ended } = await reader.read();
				if (ended) break;
			}
		} catch {
			// An aborted body rejects a pending read; that is the stream ending too.
		} finally {
			closed = true;
		}
	})();
	return { done, closed: () => closed };
}

/** Resolves true when the promise settled within `ms`. */
async function settlesWithin(promise: Promise<unknown>, ms = 3_000): Promise<boolean> {
	return await Promise.race([
		promise.then(() => true),
		new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
	]);
}

/**
 * Makes the keep-alive ping write throw on the next stream: the 15 s sleep becomes immediate, and only
 * non-ping writes reach the real stream. Returns the restore function.
 */
function failNextPing(): () => void {
	const originalSetTimeout = globalThis.setTimeout;
	const timer = vi
		.spyOn(globalThis, "setTimeout")
		.mockImplementation((handler, timeout, ...args) =>
			originalSetTimeout(handler, timeout === 15_000 ? 0 : timeout, ...args),
		);
	const write = vi.spyOn(SSEStreamingApi.prototype, "writeSSE").mockImplementation(async function (
		this: SSEStreamingApi,
		message,
	) {
		if (message.event === "ping") throw new Error("ping write failed");
		return writeSSE.call(this, message);
	});
	const errors = vi.spyOn(console, "error").mockImplementation(() => {});
	return () => {
		write.mockRestore();
		timer.mockRestore();
		errors.mockRestore();
	};
}

it("stops the watch and drops the live stream when a ping write throws", async () => {
	const stop = vi.fn();
	const watch = vi.spyOn(runtime, "watch").mockImplementation(async (_id, onEvents) => {
		await onEvents([]);
		return stop;
	});
	const remove = vi.spyOn(SessionStreams.prototype, "delete");
	const restore = failNextPing();
	try {
		const res = await call(app, `/api/sessions/${sessionId}/events`, { cookie: alice });
		expect(res.status).toBe(200);
		const reader = res.body?.getReader();
		await reader?.read();
		await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(1), { timeout: 5_000, interval: 25 });
		expect(remove.mock.calls.some(([stream]) => stream.sessionId === sessionId)).toBe(true);
		await reader?.cancel();
	} finally {
		restore();
		watch.mockRestore();
		remove.mockRestore();
	}
});

it("unsubscribes the session list stream when a ping write throws", async () => {
	const realSubscribe = runtime.sessionList.subscribe.bind(runtime.sessionList);
	const unsubscribed = vi.fn();
	const subscribe = vi.spyOn(runtime.sessionList, "subscribe").mockImplementation((subscriber) => {
		const unsubscribe = realSubscribe(subscriber);
		return () => {
			unsubscribed();
			unsubscribe();
		};
	});
	const restore = failNextPing();
	try {
		const res = await call(app, "/api/sessions/stream", { cookie: alice });
		expect(res.status).toBe(200);
		const reader = res.body?.getReader();
		await reader?.read();
		await vi.waitFor(() => expect(unsubscribed).toHaveBeenCalledTimes(1), { timeout: 5_000, interval: 25 });
		await reader?.cancel();
	} finally {
		restore();
		subscribe.mockRestore();
	}
});

it("ends the streams of a revoked WebUI session and keeps the one a password change kept", async () => {
	const carol = await createUser(db, { username: "carol-streams", kind: "member", password: "carol-password-1" });
	const kept = await login(app, "carol-streams", "carol-password-1");
	const revoked = await login(app, "carol-streams", "carol-password-1");
	const ownerRow: SessionUser = {
		sessionId: "test-carol-streams",
		userId: carol.id,
		username: carol.username,
		kind: carol.kind,
	};
	const session = await runtime.createSession(ownerRow, {
		model: model(),
		rulePreset: "yolo",
		title: "revoked stream",
	});

	// Two sessions, each with a per-session event stream and a session-list stream.
	const eventKept = await call(app, `/api/sessions/${session.id}/events`, { cookie: kept });
	const eventRevoked = await call(app, `/api/sessions/${session.id}/events`, { cookie: revoked });
	expect(eventKept.status).toBe(200);
	expect(eventRevoked.status).toBe(200);
	const keptReader = eventKept.body?.getReader();
	const revokedReader = eventRevoked.body?.getReader();
	if (!keptReader || !revokedReader) throw new Error("no stream body");
	await keptReader.read(); // the snapshot
	await revokedReader.read();
	const keptEvents = track(keptReader);
	const revokedEvents = track(revokedReader);

	const listKept = await call(app, "/api/sessions/stream", { cookie: kept });
	const listRevoked = await call(app, "/api/sessions/stream", { cookie: revoked });
	const keptListReader = listKept.body?.getReader();
	const revokedListReader = listRevoked.body?.getReader();
	if (!keptListReader || !revokedListReader) throw new Error("no list stream body");
	const keptList = track(keptListReader);
	const revokedList = track(revokedListReader);

	// The change revokes every other WebUI session of the user and keeps the one that made the request.
	const changed = await call(app, "/api/auth/password", {
		cookie: kept,
		body: { currentPassword: "carol-password-1", newPassword: "carol-password-2" },
	});
	expect(changed.status).toBe(200);
	expect(await settlesWithin(revokedEvents.done)).toBe(true);
	expect(await settlesWithin(revokedList.done)).toBe(true);
	await new Promise((resolve) => setTimeout(resolve, 100));
	expect(keptEvents.closed()).toBe(false);
	expect(keptList.closed()).toBe(false);

	// A logout revokes the session that made it, and ends its streams too.
	const out = await call(app, "/api/auth/logout", { method: "POST", cookie: kept, body: {} });
	expect(out.status).toBe(200);
	expect(await settlesWithin(keptEvents.done)).toBe(true);
	expect(await settlesWithin(keptList.done)).toBe(true);
});

it("re-checks the WebUI session on every ping and ends the stream when the row is gone", async () => {
	const dave = await createUser(db, { username: "dave-streams", kind: "member", password: "dave-password-1" });
	const cookie = await login(app, "dave-streams", "dave-password-1");
	const ownerRow: SessionUser = {
		sessionId: "test-dave-streams",
		userId: dave.id,
		username: dave.username,
		kind: dave.kind,
	};
	const session = await runtime.createSession(ownerRow, { model: model(), rulePreset: "yolo", title: "ping check" });
	const restore = fastPings();
	try {
		const events = await call(app, `/api/sessions/${session.id}/events`, { cookie });
		const list = await call(app, "/api/sessions/stream", { cookie });
		const eventsReader = events.body?.getReader();
		const listReader = list.body?.getReader();
		if (!eventsReader || !listReader) throw new Error("no stream body");
		await eventsReader.read(); // the snapshot
		const eventsTrack = track(eventsReader);
		const listTrack = track(listReader);

		// Bypass logout/password: delete the row directly, so only the ping check can notice it.
		const token = cookie.slice(cookie.indexOf("=") + 1);
		const webSession = await resolveWebSession(db, token);
		if (!webSession) throw new Error("the test session did not resolve");
		await revokeWebSession(db, webSession.sessionId);

		expect(await settlesWithin(eventsTrack.done)).toBe(true);
		expect(await settlesWithin(listTrack.done)).toBe(true);
	} finally {
		restore();
	}
});

it("streams wire-shaped events for a faux-model run: text, a tool call and a snapshot", async () => {
	const session = await runtime.createSession(owner, { model: model(), rulePreset: "yolo", title: "wire shapes" });
	const events: SessionEvent[] = [];
	const stop = await runtime.watch(session.id, (batch) => {
		// Exactly what the SSE route writes: the converted objects, serialized.
		events.push(...(JSON.parse(JSON.stringify(batch)) as SessionEvent[]));
	});
	try {
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("list_nodes", {}, { id: "wire-call" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("all done")]),
		]);
		const submission = await runtime.submit(session.id, owner, "list the nodes", "wire-shapes-1");
		expect(await waitSubmission(runtime, session.id, submission)).toEqual({ status: "done", answer: "all done" });
		await vi.waitFor(() => expect(events.some((event) => event.type === "run_end")).toBe(true), { timeout: 5_000 });
	} finally {
		stop();
	}

	// The events the WebUI's reducer ignores are dropped at the boundary, not serialized.
	const types = events.map((event) => event.type);
	expect(types).not.toContain("agent_changed");
	expect(types).not.toContain("submission");
	expect(types).not.toContain("deferred_poll");

	// The snapshot is the wrapped wire form, with no pi-only live state.
	const snapshot = events.find((event) => event.type === "snapshot");
	if (snapshot?.type !== "snapshot") throw new Error("no snapshot");
	expect(snapshot.snapshot).toMatchObject({ tools: expect.any(Array), inbox: [], historyCursor: null });
	expect(snapshot.snapshot).not.toHaveProperty("nestedTools");
	expect(snapshot.snapshot).not.toHaveProperty("agent");
	expect(snapshot.snapshot).not.toHaveProperty("compactionFailure");

	// A representative assistant message: the wire fields are there, pi's provider bookkeeping is not.
	const startEvent = events.find((event) => event.type === "message_start" && event.message.role === "assistant");
	if (startEvent?.type !== "message_start") throw new Error("no assistant message_start");
	const start = startEvent.message;
	if (start.role !== "assistant") throw new Error("not an assistant message");
	for (const field of [
		"api",
		"provider",
		"model",
		"responseModel",
		"responseId",
		"providerThinkingLevel",
		"thinkingLevel",
		"diagnostics",
		"deferred",
		"rawStopReason",
		"endTurn",
	]) {
		expect(start).not.toHaveProperty(field);
	}
	expect(start.content).toEqual([expect.objectContaining({ type: "toolCall", name: "list_nodes" })]);
	const callBlock = start.content.find((block) => block.type === "toolCall");
	if (callBlock === undefined) throw new Error("no toolCall block");
	expect("thoughtSignature" in callBlock).toBe(false);
	expect("namespace" in callBlock).toBe(false);

	// Tool events carry the call identity and args, not pi's task bookkeeping.
	const toolStart = events.find((event) => event.type === "tool_execution_start");
	expect(toolStart).toMatchObject({
		type: "tool_execution_start",
		toolCallId: "wire-call",
		toolName: "list_nodes",
		args: {},
	});
	expect(toolStart).not.toHaveProperty("taskId");
	expect(toolStart).not.toHaveProperty("parentTaskId");

	// Committed entries keep identity, kind, messages and data; durable bookkeeping stays in the server.
	for (const event of events) {
		const entry = event.type === "message_end" || event.type === "entry_appended" ? event.entry : undefined;
		if (entry === undefined) continue;
		expect(entry).not.toHaveProperty("conversationId");
		expect(entry).not.toHaveProperty("byTaskId");
		expect(entry).not.toHaveProperty("head");
		expect(entry).not.toHaveProperty("edits");
	}

	const toolEnd = events.find((event) => event.type === "tool_execution_end" && event.toolName === "list_nodes");
	if (toolEnd?.type !== "tool_execution_end") throw new Error("no tool_execution_end");
	expect(toolEnd.entry?.kind).toBe("pi.tool-result");
	const result = toolEnd.entry?.model?.[0];
	if (result?.role !== "toolResult") throw new Error("no tool result message");
	expect(result).not.toHaveProperty("nestedCalls");
	expect(result).not.toHaveProperty("usage");

	// A fresh snapshot after the run carries the same converted entries.
	const later: SessionEvent[] = [];
	const stopLater = await runtime.watch(session.id, (batch) => {
		later.push(...(JSON.parse(JSON.stringify(batch)) as SessionEvent[]));
	});
	stopLater();
	const latest = later.find((event) => event.type === "snapshot");
	if (latest?.type !== "snapshot") throw new Error("no snapshot after the run");
	expect(latest.snapshot.entries.map((entry) => entry.kind)).toEqual(
		expect.arrayContaining(["pi.user", "pi.assistant", "pi.tool-result"]),
	);
	const resultEntry = latest.snapshot.entries.find((entry) => entry.kind === "pi.tool-result");
	if (resultEntry === undefined) throw new Error("no tool-result entry");
	expect(resultEntry).not.toHaveProperty("conversationId");
});
