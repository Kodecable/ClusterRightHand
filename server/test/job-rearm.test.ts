import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import * as z from "zod/v4";
import { ModelConfig } from "../src/agent/models.ts";
import { AgentRuntime } from "../src/agent/runtime.ts";
import { Audit } from "../src/audit/audit.ts";
import type { SessionUser } from "../src/auth/sessions.ts";
import { Cluster } from "../src/cluster/cluster.ts";
import { TaskGroups } from "../src/cluster/task-groups.ts";
import { CallRunner } from "../src/extensions/call-runner.ts";
import { McpConnections } from "../src/extensions/connections.ts";
import { decideExternalCall, getExternalCall } from "../src/extensions/external-calls.ts";
import { sessionExtensionsForUser } from "../src/extensions/registry.ts";
import { saveExtension } from "../src/extensions/store.ts";
import { rearmWaitingCallJobs } from "../src/jobs/rearm.ts";
import { MasterKey } from "../src/keys/master-key.ts";
import type { Db } from "../src/storage/db.ts";
import { runExtensionTool, type ToolContext } from "../src/tools/catalog.ts";
import { convertExternalResult } from "../src/tools/external-results.ts";
import { createUser } from "../src/users/service.ts";
import { newId } from "../src/util/id.ts";
import { openTestDb } from "./helpers/db.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/**
 * Re-arming a waiting `call` job at startup (doc/design/jobs.md "Background extension calls"): a call that was
 * awaiting approval when crhs stopped has no runner after a restart, so an approval could never start it. The
 * startup re-arm builds the runner from the row, and a replayed tool invocation finds that call.
 */
const state = { calls: [] as { tool: string; arguments: Record<string, unknown> }[] };

function fakeMcp() {
	return createMcpHandler(() => {
		const server = new McpServer({ name: "fake", version: "1.0.0" });
		server.registerTool(
			"echo",
			{ description: "Echo the message back", inputSchema: z.object({ message: z.string() }) },
			async ({ message }) => {
				state.calls.push({ tool: "echo", arguments: { message } });
				return { content: [{ type: "text", text: `echo: ${message}` }] };
			},
		);
		return server;
	});
}

const handler = fakeMcp();
const fakeFetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
	const url = input instanceof Request ? input.url : String(input);
	if (!url.startsWith("http://mcp.test")) return fetch(input, init);
	return handler.fetch(new Request(url, init));
};

let db: Db;
let runtime: AgentRuntime;
let mcp: McpConnections;
let jobs: NonNullable<AgentRuntime["jobs"]>;
let owner: SessionUser;
let masterKey: MasterKey;
let clusterRef: Cluster;
let taskGroupsRef: TaskGroups;
let auditRef: Audit;
const faux = fauxProvider();
const model = () => ({ provider: faux.provider.id, modelId: faux.getModel().id });
/** The process's runner, replaced by a fresh one to simulate a restart. */
const runner = new CallRunner();

beforeAll(async () => {
	db = await openTestDb("sqlite");
	const audit = new Audit(db);
	const cluster = new Cluster(db, { audit });
	const taskGroups = new TaskGroups(db, cluster, { audit });
	auditRef = audit;
	clusterRef = cluster;
	taskGroupsRef = taskGroups;
	const models = new ModelConfig(db, MasterKey.generate());
	models.addProvider(faux.provider);
	await models.reload();
	masterKey = MasterKey.generate();
	mcp = new McpConnections({ db, masterKey, fetch: fakeFetch });
	runtime = await AgentRuntime.open({
		db,
		storage: new MemoryStorage(),
		models,
		cluster,
		taskGroups,
		audit,
		mcp,
		callRunner: runner,
	});
	jobs = runtime.jobs as NonNullable<AgentRuntime["jobs"]>;
	const user = await createUser(db, { username: "owner", kind: "member", password: "password-123" });
	owner = { sessionId: "test", userId: user.id, username: user.username, kind: "member" };
	const { row } = await saveExtension(
		db,
		masterKey,
		"fake",
		{
			url: "http://mcp.test/mcp",
			description: "A fake server",
			grants: [{ granteeType: "user", granteeId: user.id }],
		},
		user.id,
	);
	runtime.installExtensionTools(row, []);
	await mcp.prepareCall("fake");
});

afterAll(async () => {
	await runner.shutdown();
	await mcp.close();
	await runtime.close();
	await db.destroy();
});

const waitFor = async <T>(what: string, probe: () => Promise<T | undefined>, timeoutMs = 8000): Promise<T> => {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await probe();
		if (value !== undefined) return value;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
};

async function sessionContext(rulePreset: "ask" = "ask", callKey = newId()): Promise<ToolContext> {
	const session = await runtime.createSession(owner, { model: model(), rulePreset });
	return {
		db,
		cluster: clusterRef,
		taskGroups: taskGroupsRef,
		user: { sessionId: "test", userId: owner.userId, username: owner.username, kind: owner.kind },
		actor: { type: "session", id: session.id, onBehalfOfUserId: owner.userId },
		chain: [{ type: "session", id: session.id }],
		approvalUrl: (kind, id) => `/approvals/${kind}/${id}`,
		externalCallUrl: (id) => `/approvals/external-calls/${id}`,
		defaultWaitS: 0,
		extensions: await sessionExtensionsForUser(db, owner.userId, [], mcp),
		jobs,
		callKey,
		callRunner: runner,
	};
}

async function waitingCall(ctx: ToolContext, callKey: string) {
	const result = await runExtensionTool(ctx, "fake", "echo", { message: "hi" }, 0);
	expect(result.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n")).toContain(
		"waiting for approval",
	);
	const call = await waitFor("the waiting external call", async () =>
		db
			.selectFrom("external_calls")
			.selectAll()
			.where("state", "=", "awaiting_approval")
			.where("actor_id", "=", ctx.actor.id)
			.executeTakeFirst(),
	);
	const job = await waitFor("the call's job", () => jobs.forCall("call", callKey));
	return { call, job };
}

it("re-arms a waiting call so an approval runs it, and a replay finds it instead of a second call", async () => {
	state.calls.length = 0;
	const callKey = `rearm-approve-${newId()}`;
	const ctx = await sessionContext("ask", callKey);
	const { call, job } = await waitingCall(ctx, callKey);
	// A restart: the process's runner is gone, but the waiting approval and its job remain.
	await runner.shutdown();
	expect(runner.get(call.id)).toBeUndefined();
	expect(
		await rearmWaitingCallJobs({
			db,
			mcp,
			jobs,
			audit: auditRef,
			convert: (value, options) => convertExternalResult(value as never, options),
			callRunner: runner,
		}),
	).toBe(1);

	// The replayed tool invocation waits on the re-armed call rather than starting a second one.
	const replay = await runExtensionTool(ctx, "fake", "echo", { message: "hi" }, 0);
	expect(replay.isError).toBe(false);
	expect(runner.get(call.id)).toBeDefined();
	expect(await jobs.get(job.id)).toMatchObject({ state: "waiting", wait: "approval" });

	expect(
		await decideExternalCall(db, call.id, {
			decision: "approved",
			by: { type: "user", id: owner.userId },
			at: new Date().toISOString(),
		}),
	).toBe(true);
	const finished = await waitFor("the call to finish", async () => {
		const row = await getExternalCall(db, call.id);
		return row?.state === "succeeded" ? row : undefined;
	});
	expect(finished.state).toBe("succeeded");
	const settled = await waitFor("the job to settle", async () => {
		const row = await jobs.get(job.id);
		return row?.state === "settled" ? row : undefined;
	});
	expect(JSON.parse(settled.outcome ?? "null")).toMatchObject({ kind: "succeeded" });
	expect(settled.result).toContain("echo: hi");
	expect(state.calls).toEqual([{ tool: "echo", arguments: { message: "hi" } }]);

	// The replayed invocation now returns the kept result without calling the extension again.
	const again = await runExtensionTool(ctx, "fake", "echo", { message: "hi" }, 0);
	expect(again.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n")).toContain(
		"echo: hi",
	);
	expect(state.calls).toHaveLength(1);
});

it("fails a waiting call whose extension is gone instead of leaving it running", async () => {
	state.calls.length = 0;
	const callKey = `rearm-gone-${newId()}`;
	const ctx = await sessionContext("ask", callKey);
	const { call, job } = await waitingCall(ctx, callKey);
	await runner.shutdown();
	// The extension the call was judged on no longer exists: nobody could ever run an approval.
	await db.updateTable("external_calls").set({ extension_name: "ghost" }).where("id", "=", call.id).execute();

	expect(
		await rearmWaitingCallJobs({
			db,
			mcp,
			jobs,
			audit: auditRef,
			convert: (value, options) => convertExternalResult(value as never, options),
			callRunner: runner,
		}),
	).toBe(0);

	const finished = await waitFor("the call to be failed", async () => {
		const row = await getExternalCall(db, call.id);
		return row?.state === "failed" ? row : undefined;
	});
	expect(finished.state).toBe("failed");
	const settled = await waitFor("the job to settle", async () => {
		const row = await jobs.get(job.id);
		return row?.state === "settled" ? row : undefined;
	});
	expect(JSON.parse(settled.outcome ?? "null")).toMatchObject({ kind: "error" });
	const audit = await waitFor("the audited finish", async () => {
		const row = await db
			.selectFrom("audit_events")
			.selectAll()
			.where("target_type", "=", "external_call")
			.where("target_id", "=", call.id)
			.where("action", "=", "external_call.finished")
			.executeTakeFirst();
		return row;
	});
	expect(JSON.parse(audit.detail)).toMatchObject({ state: "failed" });
	expect(state.calls).toHaveLength(0);
});

it("re-arms a waiting call so a rejection settles its job", async () => {
	state.calls.length = 0;
	const callKey = `rearm-reject-${newId()}`;
	const ctx = await sessionContext("ask", callKey);
	const { call, job } = await waitingCall(ctx, callKey);
	await runner.shutdown();
	await rearmWaitingCallJobs({
		db,
		mcp,
		jobs,
		convert: (value, options) => convertExternalResult(value as never, options),
		callRunner: runner,
	});

	expect(
		await decideExternalCall(
			db,
			call.id,
			{ decision: "rejected", by: { type: "user", id: owner.userId }, at: new Date().toISOString() },
			"not now",
		),
	).toBe(true);
	const settled = await waitFor("the job to settle after a rejection", async () => {
		const row = await jobs.get(job.id);
		return row?.state === "settled" ? row : undefined;
	});
	expect(JSON.parse(settled.outcome ?? "null")).toMatchObject({ kind: "rejected" });
	expect(state.calls).toHaveLength(0);
});
