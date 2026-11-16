import type { TaskGroupView, TaskView } from "@crh/api";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	approvalRequestForExternalCall,
	approvalRequestForTask,
	approvalRequestForTaskGroup,
} from "../src/approvals/request.ts";
import { Audit } from "../src/audit/audit.ts";
import { createApiToken } from "../src/auth/api-tokens.ts";
import { Cluster } from "../src/cluster/cluster.ts";
import { TaskGroups } from "../src/cluster/task-groups.ts";
import { externalCallViews, getExternalCall } from "../src/extensions/external-calls.ts";
import type { Db } from "../src/storage/db.ts";
import { defaultOrgId } from "../src/storage/org.ts";
import { createUser } from "../src/users/service.ts";
import { newId } from "../src/util/id.ts";
import { openTestDb } from "./helpers/db.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const review = (risk: "low" | "medium" | "high", reason: string) => ({
	decision: "escalate" as const,
	risk,
	reason,
	model: "review-model",
});
const evaluation = { result: "require-approval" as const, levels: [] };

describe("approval request model (sqlite)", () => {
	let db: Db;
	let cluster: Cluster;
	let groups: TaskGroups;
	let audit: Audit;
	let orgId = "";
	let aliceId = "";
	const nodes: string[] = [];

	const addNode = async (name: string) => {
		const id = newId();
		const now = new Date().toISOString();
		await db
			.insertInto("nodes")
			.values({
				id,
				org_id: orgId,
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
		nodes.push(id);
		return id;
	};

	const addSession = async (id: string, title: string | null, parent: string | null, root: string) => {
		const now = new Date().toISOString();
		await db
			.insertInto("sessions")
			.values({
				id,
				org_id: orgId,
				owner_user_id: aliceId,
				conversation_id: `conv-${id}`,
				parent_session_id: parent,
				root_session_id: root,
				schedule_id: null,
				title,
				model: JSON.stringify({ provider: "faux", modelId: "faux" }),
				status: "active",
				created_at: now,
				updated_at: now,
				archived_at: null,
				last_submission_id: null,
				state: "awaiting",
				waiting_kind: null,
				waiting_level_id: null,
				waiting_handler_id: null,
				state_changed_at: now,
				quota_tokens: null,
			})
			.execute();
		return id;
	};

	const token = async (name: string) =>
		createApiToken(
			db,
			{ sessionId: "test", userId: aliceId, username: "alice", kind: "member" },
			{ name, rulePreset: "ask", days: null },
		);

	const insertTask = async (values: {
		id: string;
		nodeId: string;
		actorType: string;
		actorId: string;
		rootSessionId: string | null;
		spec: unknown;
		approval: unknown;
		privileged?: boolean;
	}) => {
		const now = new Date().toISOString();
		await db
			.insertInto("tasks")
			.values({
				id: values.id,
				org_id: orgId,
				node_id: values.nodeId,
				task_group_id: null,
				kind: (values.spec as { kind: string }).kind,
				spec: JSON.stringify(values.spec),
				input_size: null,
				input_sha256: null,
				attempt: 1,
				rev: 1,
				privileged: values.privileged === true ? 1 : 0,
				authorization: null,
				timeout_ms: null,
				output_mode: "full",
				max_lines: null,
				max_bytes: null,
				state: "awaiting_approval",
				exit_code: null,
				signal: null,
				timed_out: 0,
				cancelled: 0,
				error_code: null,
				error_message: null,
				actor_type: values.actorType,
				actor_id: values.actorId,
				on_behalf_of_user_id: aliceId,
				created_at: now,
				dispatched_at: null,
				accepted_at: null,
				finished_at: null,
				output_bytes: 0,
				output_head: null,
				output_tail: null,
				notice: null,
				output_lines: null,
				output_file: null,
				result: null,
				late_result: null,
				rule_chain: JSON.stringify([{ type: "user", id: aliceId }]),
				approval: JSON.stringify(values.approval),
				pending_input: null,
				root_session_id: values.rootSessionId,
				handler_type: "user",
				handler_session_id: null,
				transfer: null,
				purpose: null,
			})
			.execute();
		return values.id;
	};

	const callRow = async (values: {
		id: string;
		extension: string;
		tool: string;
		arguments: unknown;
		operation: { method: string; target: string };
		actorType: string;
		actorId: string;
		approval: unknown;
	}) => {
		await db
			.insertInto("external_calls")
			.values({
				id: values.id,
				org_id: orgId,
				actor_type: values.actorType,
				actor_id: values.actorId,
				on_behalf_of_user_id: aliceId,
				extension_name: values.extension,
				tool_name: values.tool,
				arguments: JSON.stringify(values.arguments),
				operation: JSON.stringify(values.operation),
				annotations: null,
				rule_chain: JSON.stringify([{ type: "user", id: aliceId }]),
				approval: JSON.stringify(values.approval),
				pending_input: null,
				root_session_id: null,
				handler_type: "user",
				handler_session_id: null,
				state: "awaiting_approval",
				created_at: new Date().toISOString(),
				finished_at: null,
			})
			.execute();
		const row = await getExternalCall(db, values.id);
		if (!row) throw new Error("the external call disappeared");
		return (await externalCallViews(db, [row]))[0] as Awaited<ReturnType<typeof externalCallViews>>[number];
	};

	beforeAll(async () => {
		db = await openTestDb("sqlite");
		audit = new Audit(db);
		cluster = new Cluster(db, { audit, nodeOfflineGraceMs: 10 });
		groups = new TaskGroups(db, cluster, { audit });
		orgId = await defaultOrgId(db);
		aliceId = (await createUser(db, { username: "alice", kind: "member", password: "password-123" })).id;
		for (let i = 1; i <= 12; i++) await addNode(`node-${i}`);
	});

	afterAll(async () => {
		await cluster.close();
		await db.destroy();
	});

	it("builds a task request from the stored spec, requester and review", async () => {
		const rootId = "session-root";
		const childId = "session-child";
		await addSession(rootId, null, null, rootId);
		await addSession(childId, "subagent title", rootId, rootId);
		const id = await insertTask({
			id: "task-session",
			nodeId: nodes[0] as string,
			actorType: "subagent",
			actorId: childId,
			rootSessionId: rootId,
			spec: { kind: "file.read", path: "/etc/hosts", startLine: 5, lineCount: 3 },
			privileged: true,
			approval: { evaluation, review: review("medium", "reads a system file") },
		});
		const view = (await cluster.getTask(id)) as TaskView;
		const request = await approvalRequestForTask(db, view);
		expect(request).toMatchObject({
			kind: "task",
			id,
			phase: "awaiting_user",
			requester: { type: "session", sessionId: rootId, title: "" },
			action: { type: "file", operation: "read", path: "/etc/hosts", lines: { start: 5, end: 7 } },
			nodes: ["node-1"],
			privileged: true,
			review: { risk: "medium", reason: "reads a system file" },
		});
		expect(request.alwaysAllow).toEqual([
			{
				option: "exact",
				rule: { action: "allow", method: "file.read", nodes: ["node-1"], privileged: true, exact: "/etc/hosts" },
			},
			{
				option: "prefix",
				rule: { action: "allow", method: "file.read", nodes: ["node-1"], privileged: true, prefix: "/etc/hosts" },
			},
		]);
	});

	it("is reviewing while Auto Review's marker is pending, with no review line yet", async () => {
		const { view } = await token("deploy");
		const awaiting = await cluster.createTask({
			nodeId: nodes[0] as string,
			spec: { kind: "exec", command: { argv: ["uptime"] }, env: {}, cwd: "", stdin: null },
			chain: [{ type: "api_token", id: view.id }],
			actor: { type: "api_token", id: view.id, onBehalfOfUserId: aliceId },
		});
		await db
			.updateTable("tasks")
			.set({
				approval: JSON.stringify({ evaluation, review: { status: "pending", startedAt: new Date().toISOString() } }),
			})
			.where("id", "=", awaiting.id)
			.execute();
		const task = (await cluster.getTask(awaiting.id)) as TaskView;
		const request = await approvalRequestForTask(db, task);
		expect(request.phase).toBe("reviewing");
		expect(request.requester).toEqual({ type: "api_token", tokenId: view.id, name: "deploy" });
		expect(request.action).toEqual({ type: "exec", command: "uptime" });
		expect(request.review).toBeUndefined();
		expect(request.alwaysAllow.map((candidate) => candidate.option)).toEqual(["exact", "prefix"]);
	});

	it("builds a task-group request with the nodes that need approval, capped", async () => {
		const { view: tokenView } = await token("batch");
		const id = await groups.create({
			targets: nodes,
			nodeIds: nodes,
			spec: {
				kind: "exec",
				command: { argv: ["systemctl", "restart", "nginx"] },
				env: {},
				cwd: "",
				stdin: null,
			},
			chain: [{ type: "api_token", id: tokenView.id }],
			actor: { type: "api_token", id: tokenView.id, onBehalfOfUserId: aliceId },
			privileged: true,
		});
		const view = (await groups.get(id)) as TaskGroupView;
		const request = await approvalRequestForTaskGroup(db, view);
		expect(request.kind).toBe("task_group");
		expect(request.action).toEqual({ type: "exec", command: "systemctl restart nginx" });
		expect(request.nodes).toEqual(nodes.slice(0, 10).map((_, index) => `node-${index + 1}`));
		expect(request.moreNodes).toBe(2);
		expect(request.privileged).toBe(true);
		// The rule must cover every node that needs approval, even when the card names only the first ten.
		expect(request.alwaysAllow[0]?.rule.nodes).toEqual(nodes.map((_, index) => `node-${index + 1}`));
		expect(request.alwaysAllow[0]?.rule.privileged).toBe(true);
	});

	it("builds an extension-tool call with this-tool and whole-extension rules", async () => {
		const rootId = "session-call-root";
		await addSession(rootId, "cleanup", null, rootId);
		const call = await callRow({
			id: "call-tool",
			extension: "github",
			tool: "create_issue",
			arguments: { title: "x" },
			operation: { method: "ext.write", target: "github/create_issue" },
			actorType: "session",
			actorId: rootId,
			approval: { evaluation },
		});
		const request = await approvalRequestForExternalCall(db, call);
		expect(request).toMatchObject({
			kind: "external_call",
			id: "call-tool",
			phase: "awaiting_user",
			requester: { type: "session", sessionId: rootId, title: "cleanup" },
			action: { type: "extension_tool", extension: "github", tool: "create_issue" },
			privileged: false,
		});
		expect(request.alwaysAllow).toEqual([
			{ option: "tool", rule: { action: "allow", method: "ext.write", exact: "github/create_issue" } },
			{ option: "extension", rule: { action: "allow", method: "ext.write", prefix: "github/" } },
		]);
	});

	it("builds an api_request call with this-request and this-route rules", async () => {
		const call = await callRow({
			id: "call-api",
			extension: "crhs-api",
			tool: "api_request",
			arguments: { method: "post", path: "/api/node-groups" },
			operation: { method: "api.write", target: "POST /api/node-groups" },
			actorType: "user",
			actorId: aliceId,
			approval: { evaluation, review: review("high", "creates a node group") },
		});
		const request = await approvalRequestForExternalCall(db, call);
		expect(request.action).toEqual({ type: "api_request", method: "POST", path: "/api/node-groups" });
		expect(request.alwaysAllow).toEqual([
			{ option: "request", rule: { action: "allow", method: "api.write", exact: "POST /api/node-groups" } },
			{ option: "route", rule: { action: "allow", method: "api.write", prefix: "POST /api/node-groups" } },
		]);
		expect(request.review).toEqual({ risk: "high", reason: "creates a node group" });
	});

	it("names a scheduled run's session, not the schedule, as the requester", async () => {
		const now = new Date().toISOString();
		await db
			.insertInto("schedules")
			.values({
				id: "schedule-1",
				org_id: orgId,
				owner_user_id: aliceId,
				name: "nightly",
				prompt: "check",
				model: JSON.stringify({ provider: "faux", modelId: "faux" }),
				token_budget: null,
				cron: "0 3 * * *",
				timezone: "UTC",
				catch_up: 0,
				enabled: 1,
				next_run_at: null,
				created_at: now,
				updated_at: now,
			})
			.execute();
		// A scheduled run is an ordinary session the user can go on with; its requests come from that session.
		await addSession("session-scheduled", "nightly run", null, "session-scheduled");
		await db.updateTable("sessions").set({ schedule_id: "schedule-1" }).where("id", "=", "session-scheduled").execute();
		const call = await callRow({
			id: "call-scheduled",
			extension: "test",
			tool: "echo",
			arguments: {},
			operation: { method: "ext.read", target: "test/echo" },
			actorType: "session",
			actorId: "session-scheduled",
			approval: { evaluation },
		});
		expect((await approvalRequestForExternalCall(db, call)).requester).toEqual({
			type: "session",
			sessionId: "session-scheduled",
			title: "nightly run",
		});
	});

	it("names a user acting directly", async () => {
		const userCall = await callRow({
			id: "call-user",
			extension: "test",
			tool: "echo",
			arguments: {},
			operation: { method: "ext.read", target: "test/echo" },
			actorType: "user",
			actorId: aliceId,
			approval: { evaluation },
		});
		expect((await approvalRequestForExternalCall(db, userCall)).requester).toEqual({
			type: "user",
			userId: aliceId,
			username: "alice",
		});
	});
});
