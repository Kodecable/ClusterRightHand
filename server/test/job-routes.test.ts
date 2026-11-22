import type { JobView } from "@crh/api";
import type { TaskSpec } from "@crh/protocol";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Audit } from "../src/audit/audit.ts";
import { Cluster } from "../src/cluster/cluster.ts";
import { TaskGroups } from "../src/cluster/task-groups.ts";
import { CallRunner } from "../src/extensions/call-runner.ts";
import { createJobs, type Jobs } from "../src/jobs/jobs.ts";
import type { JobRow } from "../src/jobs/types.ts";
import { shareSession } from "../src/sessions/sharing.ts";
import type { Db } from "../src/storage/db.ts";
import { defaultOrgId } from "../src/storage/org.ts";
import { execJobRenderers } from "../src/tools/job-renderers.ts";
import { createUser } from "../src/users/service.ts";
import { newId } from "../src/util/id.ts";
import { type App, call, login, makeApp } from "./helpers/api.ts";
import { openTestDb } from "./helpers/db.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/**
 * The job API (doc/design/jobs.md "API"): visibility for the session's owner, its share viewers and
 * administrators; owner-only cancel; active filtering and keyset pagination; `ApprovalRequest.job`; and the
 * projection-change listener behind `job.changed`.
 */
let db: Db;
let app: App;
let cluster: Cluster;
let groups: TaskGroups;
let audit: Audit;
let jobs: Jobs;
const cookies: Record<string, string> = {};
const uid: Record<string, string> = {};
const nodes: string[] = [];
let aliceSession = "";
let bobSession = "";

const execSpec = (...argv: string[]): TaskSpec => ({
	kind: "exec",
	command: { argv },
	env: {},
	cwd: "",
	stdin: null,
});

async function addNode(name: string): Promise<string> {
	const id = newId();
	const now = new Date().toISOString();
	await db
		.insertInto("nodes")
		.values({
			id,
			org_id: await defaultOrgId(db),
			name,
			name_key: name.toLowerCase(),
			transport: "client",
			status: "active",
			public_key: null,
			hostname: name,
			facts: null,
			client_version: null,
			privileged_mode: null,
			last_seen_at: null,
			created_at: now,
			approved_at: now,
			approved_by_user_id: null,
			ssh_host: null,
			ssh_port: null,
			ssh_user: null,
			ssh_host_fingerprint: null,
			ssh_credential_id: null,
			ssh_jumps: null,
		})
		.execute();
	for (const user of ["alice", "bob"]) {
		await db
			.insertInto("node_access_grants")
			.values({
				id: newId(),
				org_id: await defaultOrgId(db),
				grantee_type: "user",
				grantee_id: uid[user] as string,
				target_type: "node",
				target_id: id,
				created_by_user_id: uid[user] as string,
				created_at: now,
			})
			.execute();
	}
	nodes.push(id);
	return id;
}

async function addSession(id: string, owner: string): Promise<void> {
	const now = new Date().toISOString();
	await db
		.insertInto("sessions")
		.values({
			id,
			org_id: await defaultOrgId(db),
			owner_user_id: owner,
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

async function newToken(who: string, rulePreset = "ask"): Promise<string> {
	const res = await call(app, "/api/api-tokens", { cookie: cookies[who], body: { name: "t", rulePreset } });
	return ((await res.json()) as { apiToken: { id: string } }).apiToken.id;
}

async function mkTask(token: string, owner: string, spec = execSpec("echo", "hi"), nodeId = nodes[0] as string) {
	return cluster.createTask({
		nodeId,
		spec,
		chain: [{ type: "api_token", id: token }],
		actor: { type: "api_token", id: token, onBehalfOfUserId: owner },
	});
}

interface JobInput {
	kind: "exec" | "call" | "subagent";
	resourceType: "task" | "task_group" | "external_call" | "session";
	resourceId: string;
	action: JobView["action"];
	owner?: string;
	session?: string;
	callKey?: string;
}

function mkJob(input: JobInput): Promise<JobRow> {
	const owner = input.owner ?? (uid.alice as string);
	const session = input.session ?? aliceSession;
	return jobs.ensure({
		kind: input.kind,
		callKey: input.callKey ?? newId(),
		actor: { type: "session", id: session, onBehalfOfUserId: owner },
		sessionId: session,
		resourceType: input.resourceType,
		resourceId: input.resourceId,
		action: input.action,
	});
}

async function addExternalCall(input: {
	id?: string;
	state?: "awaiting_approval" | "running" | "succeeded";
	handler?: "user" | null;
	owner?: string;
}): Promise<string> {
	const id = input.id ?? newId();
	const now = new Date().toISOString();
	await db
		.insertInto("external_calls")
		.values({
			id,
			org_id: await defaultOrgId(db),
			actor_type: "session",
			actor_id: aliceSession,
			on_behalf_of_user_id: input.owner ?? (uid.alice as string),
			extension_name: "github",
			tool_name: "create_issue",
			arguments: "{}",
			operation: JSON.stringify({ method: "ext.write", target: "github/create_issue" }),
			annotations: null,
			rule_chain: null,
			approval: null,
			pending_input: null,
			root_session_id: null,
			handler_type: input.handler ?? null,
			handler_session_id: null,
			state: input.state ?? "awaiting_approval",
			created_at: now,
			finished_at: null,
			source_tool_task: null,
			tool_rev: null,
		})
		.execute();
	return id;
}

const page = async (who: string, path: string) =>
	(await (await call(app, path, { cookie: cookies[who] })).json()) as {
		items: JobView[];
		nextCursor: string | null;
	};

beforeAll(async () => {
	db = await openTestDb("sqlite");
	audit = new Audit(db);
	cluster = new Cluster(db, { audit, nodeOfflineGraceMs: 10 });
	groups = new TaskGroups(db, cluster, { audit });
	jobs = createJobs({
		callRunner: new CallRunner(),
		db,
		cluster,
		taskGroups: groups,
		execRenderers: execJobRenderers,
		audit,
	});
	app = makeApp(db, undefined, { cluster, taskGroups: groups, audit, jobs });
	for (const [name, kind] of [
		["alice", "member"],
		["bob", "member"],
		["carol", "member"],
		["root", "admin"],
	] as const) {
		uid[name] = (await createUser(db, { username: name, kind, password: "password-123" })).id;
		cookies[name] = await login(app, name, "password-123");
	}
	await addNode("n1");
	await addNode("n2");
	aliceSession = newId();
	bobSession = newId();
	await addSession(aliceSession, uid.alice as string);
	await addSession(bobSession, uid.bob as string);
});

afterAll(async () => {
	await groups.close();
	await cluster.close();
	await db.destroy();
});

describe("job list and get", () => {
	it("lists a session's jobs newest first, one keyset page at a time", async () => {
		const token = await newToken("alice");
		const task = await mkTask(token, uid.alice as string, execSpec("true"));
		const created: JobRow[] = [];
		for (const key of ["page-1", "page-2", "page-3"]) {
			created.push(
				await mkJob({
					kind: "exec",
					resourceType: "task",
					resourceId: task.id,
					action: task.action,
					callKey: key,
				}),
			);
		}
		const first = await page("alice", `/api/jobs?session=${aliceSession}&limit=2`);
		expect(first.items).toHaveLength(2);
		expect(first.nextCursor).not.toBeNull();
		expect(first.items[0]).toMatchObject({
			kind: "exec",
			state: "waiting",
			wait: "approval",
			sessionId: aliceSession,
			resource: { type: "task", id: task.id },
			action: task.action,
		});
		const second = await page(
			"alice",
			`/api/jobs?session=${aliceSession}&limit=2&cursor=${encodeURIComponent(first.nextCursor ?? "")}`,
		);
		expect(second.items).toHaveLength(1);
		expect(second.nextCursor).toBeNull();
		const ids = [...first.items, ...second.items].map((job) => job.id);
		expect(new Set(ids).size).toBe(3);
		expect(new Set(ids)).toEqual(new Set(created.map((job) => job.id)));
		await cluster.decide(task.id, {
			decision: "rejected",
			by: { type: "user", id: uid.alice as string, onBehalfOfUserId: uid.alice as string },
			at: new Date().toISOString(),
		});
	});

	it("filters to active jobs and rejects a malformed cursor", async () => {
		const token = await newToken("alice");
		const settledTask = await mkTask(token, uid.alice as string, execSpec("settled"));
		const settled = await mkJob({
			kind: "exec",
			resourceType: "task",
			resourceId: settledTask.id,
			action: settledTask.action,
		});
		// Project settles the job; the row then reads as settled.
		await cluster.decide(settledTask.id, {
			decision: "rejected",
			by: { type: "user", id: uid.alice as string, onBehalfOfUserId: uid.alice as string },
			at: new Date().toISOString(),
		});
		await jobs.project(settled);
		expect((await jobs.get(settled.id))?.state).toBe("settled");

		const runningTask = await mkTask(token, uid.alice as string, execSpec("running"));
		const running = await mkJob({
			kind: "exec",
			resourceType: "task",
			resourceId: runningTask.id,
			action: runningTask.action,
		});

		const active = await page("alice", `/api/jobs?session=${aliceSession}&active=true&limit=200`);
		expect(active.items.map((job) => job.id)).toContain(running.id);
		expect(active.items.map((job) => job.id)).not.toContain(settled.id);
		const all = await page("alice", `/api/jobs?session=${aliceSession}&limit=200`);
		expect(all.items.map((job) => job.id)).toContain(settled.id);
		expect(
			(await call(app, `/api/jobs?session=${aliceSession}&cursor=not-a-cursor`, { cookie: cookies.alice })).status,
		).toBe(400);
	});

	it("serves one job, and a session job is invisible to a stranger", async () => {
		const token = await newToken("alice");
		const task = await mkTask(token, uid.alice as string, execSpec("visible"));
		const job = await mkJob({
			kind: "exec",
			resourceType: "task",
			resourceId: task.id,
			action: task.action,
		});
		const found = await call(app, `/api/jobs/${job.id}`, { cookie: cookies.alice });
		expect(found.status).toBe(200);
		expect(((await found.json()) as { job: JobView }).job.id).toBe(job.id);

		expect((await call(app, `/api/jobs/${job.id}`, { cookie: cookies.bob })).status).toBe(404);
		expect((await call(app, `/api/jobs?session=${aliceSession}`, { cookie: cookies.carol })).status).toBe(404);
		expect((await call(app, `/api/jobs/does-not-exist`, { cookie: cookies.alice })).status).toBe(404);
		// An administrator may read the session's jobs, like the session itself.
		expect((await call(app, `/api/jobs?session=${aliceSession}`, { cookie: cookies.root })).status).toBe(200);
	});
});

describe("job access", () => {
	it("share viewers read but never cancel; only the owner does", async () => {
		const token = await newToken("alice");
		const canceled = await mkTask(token, uid.alice as string, execSpec("cancel-me"));
		const cancelJob = await mkJob({
			kind: "exec",
			resourceType: "task",
			resourceId: canceled.id,
			action: canceled.action,
		});
		await shareSession(db, {
			sessionId: aliceSession,
			granteeType: "user",
			granteeId: uid.bob as string,
			access: "view",
			createdBy: uid.alice as string,
		});

		expect((await page("bob", `/api/jobs?session=${aliceSession}&limit=200`)).items.map((job) => job.id)).toContain(
			cancelJob.id,
		);
		expect((await call(app, `/api/jobs/${cancelJob.id}`, { cookie: cookies.bob })).status).toBe(200);
		expect((await call(app, `/api/jobs/${cancelJob.id}/cancel`, { cookie: cookies.bob, body: {} })).status).toBe(403);
		// An administrator sees the row and the API refuses the control too, as the session's own controls are.
		expect((await call(app, `/api/jobs/${cancelJob.id}/cancel`, { cookie: cookies.root, body: {} })).status).toBe(403);

		const cancelled = await call(app, `/api/jobs/${cancelJob.id}/cancel`, { cookie: cookies.alice, body: {} });
		expect(cancelled.status).toBe(200);
		const body = (await cancelled.json()) as { cancelled: boolean; job: JobView };
		expect(body.cancelled).toBe(true);
		expect(body.job.state).toBe("settled");
		expect(body.job.outcome?.kind).toBe("cancelled");
		// A settled job answers its current state instead of failing.
		const again = await call(app, `/api/jobs/${cancelJob.id}/cancel`, { cookie: cookies.alice, body: {} });
		expect(again.status).toBe(200);
		expect(((await again.json()) as { cancelled: boolean }).cancelled).toBe(false);
	});
});

describe("job cancel", () => {
	it("cancels a waiting extension call through its job's own cancel path", async () => {
		const callId = await addExternalCall({ handler: "user" });
		const job = await mkJob({
			kind: "call",
			resourceType: "external_call",
			resourceId: callId,
			action: { type: "extension_tool", extension: "github", tool: "create_issue" },
		});
		const res = await call(app, `/api/jobs/${job.id}/cancel`, { cookie: cookies.alice, body: {} });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { cancelled: boolean; job: JobView };
		expect(body.cancelled).toBe(true);
		expect(body.job.state).toBe("settled");
		expect(body.job.outcome?.kind).toBe("cancelled");
		expect(body.job.resource).toEqual({ type: "external_call", id: callId });
	});
});

describe("ApprovalRequest.job", () => {
	it("names the job behind a waiting task, and nothing when no tool call started it", async () => {
		const token = await newToken("alice");
		const task = await mkTask(token, uid.alice as string, execSpec("with-job"));
		const job = await mkJob({
			kind: "exec",
			resourceType: "task",
			resourceId: task.id,
			action: task.action,
		});
		const res = await call(app, `/api/tasks/${task.id}`, { cookie: cookies.alice });
		const body = (await res.json()) as { request: { job?: { id: string; kind: string } } };
		expect(body.request.job).toEqual({ id: job.id, kind: "exec", action: task.action });

		const otherToken = await newToken("alice");
		const plain = await mkTask(otherToken, uid.alice as string, execSpec("without-job"));
		const plainRes = await call(app, `/api/tasks/${plain.id}`, { cookie: cookies.alice });
		const plainBody = (await plainRes.json()) as { request: { job?: unknown } };
		expect(plainBody.request.job).toBeUndefined();
	});
});

describe("job.changed", () => {
	it("emits the projection when a job is created and when it settles", async () => {
		const seen: JobRow[] = [];
		const unsubscribe = jobs.onChanged((job) => seen.push(job));
		try {
			const token = await newToken("alice");
			const task = await mkTask(token, uid.alice as string, execSpec("watched"));
			const job = await mkJob({
				kind: "exec",
				resourceType: "task",
				resourceId: task.id,
				action: task.action,
			});
			expect(seen.some((row) => row.id === job.id && row.state === "waiting")).toBe(true);

			const now = new Date().toISOString();
			await db
				.updateTable("tasks")
				.set({ state: "exited", exit_code: 0, finished_at: now })
				.where("id", "=", task.id)
				.execute();
			jobs.changed("task", task.id);
			await vi.waitFor(() => expect(seen.some((row) => row.id === job.id && row.state === "settled")).toBe(true), {
				timeout: 5_000,
				interval: 20,
			});
			expect(seen.at(-1)?.settled_at).not.toBeNull();
		} finally {
			unsubscribe();
		}
	});
});
