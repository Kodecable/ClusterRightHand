import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { Audit } from "../src/audit/audit.ts";
import type { SessionUser } from "../src/auth/sessions.ts";
import { Cluster } from "../src/cluster/cluster.ts";
import { TaskGroups } from "../src/cluster/task-groups.ts";
import {
	createExternalCall,
	decideExternalCall,
	getExternalCall,
	waitExternalCall,
} from "../src/extensions/external-calls.ts";
import type { Db } from "../src/storage/db.ts";
import { defaultOrgId } from "../src/storage/org.ts";
import { createUser } from "../src/users/service.ts";
import { type App, call, login, makeApp } from "./helpers/api.ts";
import { openTestDb } from "./helpers/db.ts";
import { probeDb, tableOf } from "./helpers/db-probe.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/**
 * External calls are audited like tasks (doc/design/extensions.md "External calls"): Auto Review's verdict is
 * `external_call.review`, a user decision is `external_call.approval`, and a call aborted while it waited
 * ends as `external_call.finished` with state cancelled.
 */

let db: Db;
let app: App;
let audit: Audit;
let owner: SessionUser;
let cookie: string;
let orgId: string;

beforeAll(async () => {
	db = await openTestDb("sqlite");
	audit = new Audit(db);
	const cluster = new Cluster(db, { audit });
	const groups = new TaskGroups(db, cluster, { audit });
	app = makeApp(db, undefined, { cluster, taskGroups: groups, audit });
	const user = await createUser(db, { username: "call-owner", kind: "member", password: "password-123" });
	owner = { sessionId: "test", userId: user.id, username: user.username, kind: "member" };
	cookie = await login(app, "call-owner", "password-123");
	orgId = await defaultOrgId(db);
});

afterAll(async () => {
	await db.destroy();
});

let seq = 0;
async function waitingCall(callKey: string) {
	const { row } = await createExternalCall(db, {
		callKey,
		orgId,
		actorType: "session",
		actorId: `session-${callKey}`,
		onBehalfOfUserId: owner.userId,
		extension: "test",
		tool: "echo",
		arguments: {},
		operation: { method: "ext.write", target: "test/echo" },
		annotations: null,
		ruleChain: [{ type: "session", id: `session-${callKey}` }],
		rootSessionId: null,
		sourceToolTask: null,
		approval: { evaluation: { result: "require-approval", levels: [] } },
		state: "awaiting_approval",
	});
	return row;
}

it("does not lose a decision written between the read and the wait", async () => {
	const row = await waitingCall(`wake-${++seq}`);
	const probe = probeDb(db);
	// Decide the call after its row was read but before waitExternalCall resumes: without a registered
	// waiter that wake is lost, and the old code waited forever.
	probe.onNext(
		(node) => tableOf(node) === "external_calls" && node.kind === "SelectQueryNode",
		async () => {
			expect(
				await decideExternalCall(db, row.id, {
					decision: "rejected",
					by: { type: "user", id: owner.userId },
					at: new Date().toISOString(),
				}),
			).toBe(true);
		},
	);
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error("waitExternalCall missed the decision")), 2000);
	});
	try {
		const waited = await Promise.race([waitExternalCall(probe.db, row.id), timeout]);
		expect(waited.state).toBe("rejected");
	} finally {
		clearTimeout(timer);
	}
});

it("records a user decision on an external call", async () => {
	const row = await waitingCall(`decision-${++seq}`);
	const res = await call(app, `/api/external-calls/${row.id}/approval`, {
		cookie,
		body: { decision: "approve", reason: "looks fine" },
	});
	expect(res.status).toBe(200);
	expect((await getExternalCall(db, row.id))?.state).toBe("running");
	await audit.flush();
	const events = await db
		.selectFrom("audit_events")
		.select(["action", "detail"])
		.where("action", "=", "external_call.approval")
		.where("target_id", "=", row.id)
		.execute();
	expect(events).toHaveLength(1);
	expect(JSON.parse(events[0]?.detail ?? "{}")).toMatchObject({
		decision: "approve",
		extension: "test",
		tool: "echo",
		reason: "looks fine",
	});
});

it("audits a waiting call whose tool call was aborted", async () => {
	const row = await waitingCall(`cancel-${++seq}`);
	const controller = new AbortController();
	const waiting = waitExternalCall(db, row.id, {
		signal: controller.signal,
		onCancelled: (cancelled) => {
			void audit.record({
				actor: { type: "session", id: cancelled.actor_id, onBehalfOfUserId: owner.userId },
				action: "external_call.finished",
				target: { type: "external_call", id: cancelled.id },
				detail: {
					extension: cancelled.extension_name,
					tool: cancelled.tool_name,
					state: "cancelled",
					reason: "the tool call was aborted",
				},
			});
		},
	});
	controller.abort();
	const cancelled = await waiting;
	expect(cancelled.state).toBe("cancelled");
	await audit.flush();
	const events = await db
		.selectFrom("audit_events")
		.select(["action", "detail"])
		.where("action", "=", "external_call.finished")
		.where("target_id", "=", row.id)
		.execute();
	expect(events).toHaveLength(1);
	expect(JSON.parse(events[0]?.detail ?? "{}")).toMatchObject({ state: "cancelled" });
});
