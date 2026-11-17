import type { ExternalCallView } from "@crh/api";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { approvalRequestForTask } from "../src/approvals/request.ts";
import { Audit, listAuditEvents } from "../src/audit/audit.ts";
import { createApiToken } from "../src/auth/api-tokens.ts";
import { Cluster } from "../src/cluster/cluster.ts";
import { TaskGroups } from "../src/cluster/task-groups.ts";
import { externalCallViews, getExternalCall } from "../src/extensions/external-calls.ts";
import { requestSourceFor, requestSourcesFor, sourceActorKey } from "../src/request-source.ts";
import type { Db } from "../src/storage/db.ts";
import { defaultOrgId } from "../src/storage/org.ts";
import { createUser } from "../src/users/service.ts";
import { newId } from "../src/util/id.ts";
import { openTestDb } from "./helpers/db.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

describe("request sources (sqlite)", () => {
	let db: Db;
	let cluster: Cluster;
	let groups: TaskGroups;
	let audit: Audit;
	let orgId = "";
	let aliceId = "";
	let tokenId = "";
	let nodeId = "";

	const evaluation = { result: "require-approval" as const, levels: [] };
	const spec = { kind: "exec", command: { argv: ["echo", "hi"] }, env: {}, cwd: "", stdin: null };

	beforeAll(async () => {
		db = await openTestDb("sqlite");
		audit = new Audit(db);
		cluster = new Cluster(db, { audit, nodeOfflineGraceMs: 10 });
		groups = new TaskGroups(db, cluster, { audit });
		orgId = await defaultOrgId(db);
		aliceId = (await createUser(db, { username: "alice", kind: "member", password: "password-123" })).id;
		const token = await createApiToken(
			db,
			{ sessionId: "test", userId: aliceId, username: "alice", kind: "member" },
			{ name: "deploy", rulePreset: "ask", days: null },
		);
		tokenId = token.view.id;
		nodeId = newId();
		const now = new Date().toISOString();
		await db
			.insertInto("nodes")
			.values({
				id: nodeId,
				org_id: orgId,
				name: "web-1",
				name_key: "web-1",
				transport: "client",
				status: "active",
				public_key: null,
				hostname: "web-1",
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
	});

	afterAll(async () => {
		await cluster.close();
		await groups.close();
		await db.destroy();
	});

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
	};

	const insertTask = async (values: {
		id: string;
		actorType: string;
		actorId: string;
		rootSessionId: string | null;
		state?: "awaiting_approval" | "exited";
		exitCode?: number | null;
	}) => {
		const now = new Date().toISOString();
		await db
			.insertInto("tasks")
			.values({
				id: values.id,
				org_id: orgId,
				node_id: nodeId,
				task_group_id: null,
				kind: "exec",
				spec: JSON.stringify(spec),
				input_size: null,
				input_sha256: null,
				attempt: 1,
				rev: 1,
				privileged: 0,
				authorization: null,
				timeout_ms: null,
				output_mode: "full",
				max_lines: null,
				max_bytes: null,
				state: values.state ?? "awaiting_approval",
				exit_code: values.exitCode ?? null,
				signal: null,
				timed_out: 0,
				error_code: null,
				error_message: null,
				actor_type: values.actorType,
				actor_id: values.actorId,
				on_behalf_of_user_id: aliceId,
				created_at: now,
				dispatched_at: null,
				accepted_at: null,
				finished_at: values.state === "exited" ? now : null,
				output_bytes: 0,
				output_head: null,
				output_tail: null,
				notice: null,
				output_lines: null,
				output_file: null,
				result: null,
				late_result: null,
				rule_chain: JSON.stringify([{ type: "user", id: aliceId }]),
				approval: JSON.stringify({ evaluation }),
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

	it("resolves a session's root and keeps an empty title for the renderer", async () => {
		await addSession("root-a", "Clean up", null, "root-a");
		await addSession("child-a", "subagent", "root-a", "root-a");
		const sources = await requestSourcesFor(db, [
			{ actorType: "subagent", actorId: "child-a", onBehalfOfUserId: aliceId },
			{ actorType: "api_token", actorId: tokenId, onBehalfOfUserId: aliceId },
			{ actorType: "user", actorId: aliceId, onBehalfOfUserId: aliceId },
		]);
		expect(sources.get(sourceActorKey("subagent", "child-a", aliceId))).toEqual({
			type: "session",
			sessionId: "root-a",
			title: "Clean up",
		});
		expect(sources.get(sourceActorKey("api_token", tokenId, aliceId))).toEqual({
			type: "api_token",
			tokenId,
			name: "deploy",
		});
		expect(sources.get(sourceActorKey("user", aliceId, aliceId))).toEqual({
			type: "user",
			userId: aliceId,
			username: "alice",
		});
		expect(await requestSourceFor(db, "user", aliceId, aliceId)).toEqual({
			type: "user",
			userId: aliceId,
			username: "alice",
		});
	});

	it("exposes the source, action and terminal outcome on a task view, and the same source and action on its request", async () => {
		await addSession("root-b", "", null, "root-b");
		await insertTask({ id: "task-b", actorType: "subagent", actorId: "root-b", rootSessionId: "root-b" });
		const waiting = await cluster.getTask("task-b");
		if (!waiting) throw new Error("the task disappeared");
		expect(waiting.source).toEqual({ type: "session", sessionId: "root-b", title: "" });
		expect(waiting.action).toEqual({ type: "exec", command: "echo hi" });
		expect(waiting.outcome).toBeNull();
		const request = await approvalRequestForTask(db, waiting);
		expect(request.source).toEqual(waiting.source);
		expect(request.action).toEqual(waiting.action);

		await db.updateTable("tasks").set({ state: "exited", exit_code: 2 }).where("id", "=", "task-b").execute();
		const ended = await cluster.getTask("task-b");
		expect(ended?.outcome).toEqual({ kind: "exit", failed: true, exitCode: 2 });
	});

	it("exposes the source and action on a task group view", async () => {
		await addSession("root-c", "Batch", null, "root-c");
		const id = await groups.create({
			targets: ["web-1"],
			nodeIds: [nodeId],
			spec: spec as never,
			actor: { type: "session", id: "root-c", onBehalfOfUserId: aliceId },
		});
		const view = await groups.get(id);
		if (!view) throw new Error("the group disappeared");
		expect(view.source).toEqual({ type: "session", sessionId: "root-c", title: "Batch" });
		expect(view.action).toEqual({ type: "exec", command: "echo hi" });
		expect(view.outcome).toBeNull();
	});

	it("exposes the source on an external call view", async () => {
		await addSession("root-d", "Call", null, "root-d");
		await db
			.insertInto("external_calls")
			.values({
				id: "call-d",
				org_id: orgId,
				actor_type: "session",
				actor_id: "root-d",
				on_behalf_of_user_id: aliceId,
				extension_name: "github",
				tool_name: "create_issue",
				arguments: "{}",
				operation: JSON.stringify({ method: "ext.write", target: "github/create_issue" }),
				annotations: null,
				rule_chain: JSON.stringify([{ type: "session", id: "root-d" }]),
				approval: JSON.stringify({ evaluation }),
				pending_input: null,
				root_session_id: "root-d",
				handler_type: "user",
				handler_session_id: null,
				state: "awaiting_approval",
				created_at: new Date().toISOString(),
				finished_at: null,
			})
			.execute();
		const row = await getExternalCall(db, "call-d");
		if (!row) throw new Error("the call disappeared");
		const [view] = (await externalCallViews(db, [row])) as ExternalCallView[];
		expect(view?.source).toEqual({ type: "session", sessionId: "root-d", title: "Call" });
	});

	it("gives audit events their own source kinds and names", async () => {
		await addSession("root-e", "Audited", null, "root-e");
		const admin = await createUser(db, { username: "admin-source", kind: "admin", password: "password-123" });
		const adminUser = { sessionId: "test", userId: admin.id, username: admin.username, kind: "admin" as const };
		const now = new Date().toISOString();
		await db
			.insertInto("schedules")
			.values({
				id: "schedule-e",
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
				report_account_id: null,
				report_on: "always",
				created_at: now,
				updated_at: now,
			})
			.execute();
		const events: Array<[string, string, string]> = [
			["session", "root-e", "test.session"],
			["api_token", tokenId, "test.api_token"],
			["user", aliceId, "test.user"],
			["schedule", "schedule-e", "test.schedule"],
			["system", "auto-review", "test.auto-review"],
			["system", "auth", "test.system"],
		];
		for (const [type, id, action] of events) {
			await audit.record({
				actor: { type, id, onBehalfOfUserId: aliceId },
				action,
				target: { type: "task", id: "task-b" },
			});
		}
		await audit.flush();
		const listed = await listAuditEvents(db, adminUser, {});
		const sourceOf = (action: string) => listed.find((event) => event.action === action)?.source;
		expect(sourceOf("test.session")).toEqual({ type: "session", sessionId: "root-e", title: "Audited" });
		expect(sourceOf("test.api_token")).toEqual({ type: "api_token", tokenId, name: "deploy" });
		expect(sourceOf("test.user")).toEqual({ type: "user", userId: aliceId, username: "alice" });
		expect(sourceOf("test.schedule")).toEqual({ type: "schedule", scheduleId: "schedule-e", name: "nightly" });
		expect(sourceOf("test.auto-review")).toEqual({ type: "auto_review" });
		expect(sourceOf("test.system")).toEqual({ type: "system" });
	});
});
