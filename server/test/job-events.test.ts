import type { JobView, SessionEvent } from "@crh/api";
import { OpenAPIHono } from "@hono/zod-openapi";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { AgentRuntime } from "../src/agent/runtime.ts";
import type { AppEnv } from "../src/api/context.ts";
import { apiErrorHandler } from "../src/api/errors.ts";
import { SessionStreams, sessionEventRoutes } from "../src/api/session-events-routes.ts";
import type { Audit as AuditType } from "../src/audit/audit.ts";
import { Audit } from "../src/audit/audit.ts";
import type { SessionUser } from "../src/auth/sessions.ts";
import { Cluster } from "../src/cluster/cluster.ts";
import { TaskGroups } from "../src/cluster/task-groups.ts";
import { CallRunner } from "../src/extensions/call-runner.ts";
import { createJobs, type Jobs } from "../src/jobs/jobs.ts";
import type { Db } from "../src/storage/db.ts";
import { defaultOrgId } from "../src/storage/org.ts";
import { execJobRenderers } from "../src/tools/job-renderers.ts";
import { createUser } from "../src/users/service.ts";
import { newId } from "../src/util/id.ts";
import { openTestDb } from "./helpers/db.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/**
 * `job.changed` on a session's event stream (doc/design/jobs.md "API"): the stream starts with the snapshot,
 * then a job of that session that is created or settles arrives as one `job.changed` event carrying `JobView`.
 * The runtime is faked: only the stream's contract with it matters here, not an agent run.
 */
let db: Db;
let jobs: Jobs;
let app: OpenAPIHono<AppEnv>;
let audit: AuditType;
let owner: SessionUser;
let sessionId = "";
let otherSessionId = "";

/** A stream reader that resolves the next `events` batch of a server-sent event stream. */
async function nextBatch(reader: ReadableStreamDefaultReader<Uint8Array>, buffer: { text: string }) {
	const decoder = new TextDecoder();
	for (;;) {
		const end = buffer.text.indexOf("\n\n");
		if (end >= 0) {
			const message = buffer.text.slice(0, end);
			buffer.text = buffer.text.slice(end + 2);
			const data = message.split("\n").find((line) => line.startsWith("data:"));
			if (!data) continue;
			const parsed = JSON.parse(data.slice(5)) as SessionEvent[];
			if (parsed.length > 0) return parsed;
			continue;
		}
		const chunk = await reader.read();
		if (chunk.done) throw new Error("the stream ended");
		buffer.text += decoder.decode(chunk.value, { stream: true });
	}
}

beforeAll(async () => {
	db = await openTestDb("sqlite");
	audit = new Audit(db);
	const cluster = new Cluster(db, { audit, nodeOfflineGraceMs: 10 });
	const groups = new TaskGroups(db, cluster, { audit });
	jobs = createJobs({
		callRunner: new CallRunner(),
		db,
		cluster,
		taskGroups: groups,
		execRenderers: execJobRenderers,
		audit,
	});
	const user = await createUser(db, { username: "stream-owner", kind: "member", password: "password-123" });
	owner = { sessionId: "test-stream-owner", userId: user.id, username: user.username, kind: user.kind };
	for (const id of ["stream-session", "stream-other"]) {
		const now = new Date().toISOString();
		await db
			.insertInto("sessions")
			.values({
				id,
				org_id: await defaultOrgId(db),
				owner_user_id: user.id,
				conversation_id: `conv-${id}`,
				parent_session_id: null,
				root_session_id: id,
				title: null,
				title_pending: 0,
				model: JSON.stringify({ provider: "p", modelId: "m" }),
				status: "active",
				created_at: now,
				updated_at: now,
				archived_at: null,
				last_submission_id: null,
				disabled_extensions: null,
				state: "idle",
				waiting_kind: null,
				waiting_level_id: null,
				waiting_handler_id: null,
				state_changed_at: now,
				quota_tokens: null,
			})
			.execute();
	}
	sessionId = "stream-session";
	otherSessionId = "stream-other";
	// Only the parts of the runtime the route touches: access lookup, the snapshot watch and stream bookkeeping.
	const runtime = {
		getSession: async (id: string) => ({ id }),
		watch: async (_id: string, onEvents: (events: SessionEvent[]) => Promise<void> | void) => {
			await onEvents([{ type: "snapshot", snapshot: { entries: [], tools: [], inbox: [] } }]);
			return () => {};
		},
		sessionList: { onVisibilityChanged: () => () => {}, close: () => {} },
	} as unknown as AgentRuntime;
	const streams = new SessionStreams(db, runtime);
	app = new OpenAPIHono<AppEnv>();
	app.onError(apiErrorHandler());
	app.use("/api/*", async (c, next) => {
		c.set("user", owner);
		c.set("audit", audit);
		await next();
	});
	app.route("/api", sessionEventRoutes(db, { runtime, streams, jobs }));
});

afterAll(async () => {
	await jobs.drain();
	await db.destroy();
});

it("sends job.changed with the JobView when a job of the session changes", async () => {
	const res = await app.request(`/api/sessions/${sessionId}/events`);
	expect(res.status).toBe(200);
	const reader = res.body?.getReader();
	if (!reader) throw new Error("no stream body");
	const buffer = { text: "" };
	try {
		const snapshot = await nextBatch(reader, buffer);
		expect(snapshot[0]?.type).toBe("snapshot");

		const job = await jobs.ensure({
			kind: "exec",
			callKey: newId(),
			actor: { type: "session", id: sessionId, onBehalfOfUserId: owner.userId },
			sessionId,
			resourceType: "task",
			resourceId: "missing-task",
			action: { type: "exec", command: "true" },
		});
		// The job layer projects before ensure returns, so the event is queued by the time this is read.
		const created = await nextBatch(reader, buffer);
		expect(created).toHaveLength(1);
		expect(created[0]?.type).toBe("job.changed");
		const view = (created[0] as { type: "job.changed"; job: JobView }).job;
		expect(view).toMatchObject({
			id: job.id,
			kind: "exec",
			state: "running",
			sessionId,
			resource: { type: "task", id: "missing-task" },
			action: { type: "exec", command: "true" },
		});
		expect(view.settledAt).toBeNull();
	} finally {
		void reader.cancel();
	}
});

it("does not carry another session's job", async () => {
	const res = await app.request(`/api/sessions/${sessionId}/events`);
	expect(res.status).toBe(200);
	const reader = res.body?.getReader();
	if (!reader) throw new Error("no stream body");
	const buffer = { text: "" };
	try {
		await nextBatch(reader, buffer);
		// A job of the other session must not reach this stream; the unrelated job after it proves the stream is live.
		await jobs.ensure({
			kind: "exec",
			callKey: newId(),
			actor: { type: "session", id: otherSessionId, onBehalfOfUserId: owner.userId },
			sessionId: otherSessionId,
			resourceType: "task",
			resourceId: "other-task",
			action: { type: "exec", command: "other" },
		});
		const job = await jobs.ensure({
			kind: "exec",
			callKey: newId(),
			actor: { type: "session", id: sessionId, onBehalfOfUserId: owner.userId },
			sessionId,
			resourceType: "task",
			resourceId: "this-task",
			action: { type: "exec", command: "mine" },
		});
		const batch = await nextBatch(reader, buffer);
		const changed = batch.find((event): event is Extract<SessionEvent, { type: "job.changed" }> => {
			return event.type === "job.changed";
		});
		expect(changed?.job.id).toBe(job.id);
		expect(changed?.job.resource.id).toBe("this-task");
	} finally {
		void reader.cancel();
	}
});
