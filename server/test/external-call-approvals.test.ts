import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
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
import { decideExternalCall, pendingExternalCallRows } from "../src/extensions/external-calls.ts";
import { saveExtension } from "../src/extensions/store.ts";
import { MasterKey } from "../src/keys/master-key.ts";
import { appendRule } from "../src/policy/store.ts";
import type { Db } from "../src/storage/db.ts";
import { createUser } from "../src/users/service.ts";
import { openTestDb } from "./helpers/db.ts";

// A loaded machine can push these past the default 5 s timeout.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/**
 * External MCP call approvals routed up the rule chain like tasks (doc/design/access-control.md
 * "Approvals"): an ancestor's agent decides, or Auto Review and then the owner.
 */

const faux = fauxProvider();
const model = () => ({ provider: faux.provider.id, modelId: faux.getModel().id });
const state = { calls: [] as { tool: string; arguments: Record<string, unknown> }[] };

/** An in-process Streamable HTTP MCP server; `handler.fetch` is the network. */
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
		server.registerTool(
			"write_thing",
			{ description: "Change one thing", inputSchema: z.object({ value: z.number() }) },
			async ({ value }) => {
				state.calls.push({ tool: "write_thing", arguments: { value } });
				return { content: [{ type: "text", text: `wrote ${value}` }] };
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
let owner: SessionUser;

beforeAll(async () => {
	db = await openTestDb("sqlite");
	const audit = new Audit(db);
	const cluster = new Cluster(db, { audit });
	const taskGroups = new TaskGroups(db, cluster, { audit });
	const models = new ModelConfig(db, MasterKey.generate());
	models.addProvider(faux.provider);
	await models.reload();
	const masterKey = MasterKey.generate();
	mcp = new McpConnections({ db, masterKey, fetch: fakeFetch });
	runtime = await AgentRuntime.open({
		callRunner: new CallRunner(),
		db,
		storage: new MemoryStorage(),
		models,
		cluster,
		taskGroups,
		audit,
		mcp,
	});
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
	await mcp.close();
	await runtime.close();
	await db.destroy();
});

async function waitFor<T>(what: string, probe: () => Promise<T | undefined>, timeoutMs = 8000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await probe();
		if (value !== undefined) return value;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 25));
	}
}

const subagent = (parentId: string, callKey: string, rules: { default: string; rules: unknown[] }) =>
	runtime.createSubagent(parentId, { callKey, task: `task ${callKey}`, rules: rules as never, quota: null });

const root = async (rulePreset: "ask" | "auto_review" | "yolo") =>
	runtime.createSession(owner, { model: model(), rulePreset });

/** Starts a child that calls an external tool, and resolves with its waiting external_calls row. */
async function startCall(
	parentId: string,
	callKey: string,
	tool: "echo" | "write_thing",
	args: Record<string, unknown>,
) {
	const child = await subagent(parentId, callKey, { default: "require-approval", rules: [] });
	faux.setResponses([
		fauxAssistantMessage(
			[fauxToolCall("call_tool", { extension: "fake", tool, arguments: args } as never, { id: `call-${callKey}` })],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage([fauxText("noted")]),
		fauxAssistantMessage([fauxText("done")]),
	]);
	await runtime.startSubagent(child.id, "do it", `subagent-${callKey}`);
	const call = await waitFor("the waiting external call", async () =>
		db
			.selectFrom("external_calls")
			.selectAll()
			.where("actor_id", "=", child.id)
			.where("state", "=", "awaiting_approval")
			.executeTakeFirst(),
	);
	return { child, call };
}

/** Waits until the root's wake for the routed request has run, so the review queue is deterministic. */
async function rootWokeUp(rootId: string): Promise<void> {
	await waitFor("the root's wake", async () => {
		const row = await db
			.selectFrom("sessions")
			.select(["state", "last_submission_id"])
			.where("id", "=", rootId)
			.executeTakeFirst();
		return row?.last_submission_id !== null && row?.state === "idle" ? true : undefined;
	});
}

it("hands a write call up to the nearest allowing ancestor's agent, which approves it", async () => {
	const parent = await root("yolo");
	state.calls.length = 0;
	const { call } = await startCall(parent.id, "route-approve", "write_thing", { value: 7 });
	try {
		const request = await waitFor("the root's external call request", async () =>
			(await runtime.pendingAgentRequests(parent.id)).find((entry) => entry.id === call.id),
		);
		expect(request).toMatchObject({ kind: "external_call", sessionId: call.actor_id });
		expect(request.externalCall).toMatchObject({
			extension: "fake",
			tool: "write_thing",
			operation: { method: "ext.write", target: "fake/write_thing" },
			arguments: { value: 7 },
		});
		expect(request.summary).toContain("fake/write_thing");
		const routed = await db
			.selectFrom("external_calls")
			.select(["handler_type", "handler_session_id"])
			.where("id", "=", call.id)
			.executeTakeFirstOrThrow();
		expect(routed).toMatchObject({ handler_type: "agent", handler_session_id: parent.id });

		expect(await runtime.decideAgentRequest(parent.id, call.id, "approve", "looks fine")).toBe("external_call");
		const finished = await waitFor("the call to finish", async () => {
			const row = await db
				.selectFrom("external_calls")
				.select(["state", "approval"])
				.where("id", "=", call.id)
				.executeTakeFirst();
			return row?.state === "succeeded" ? row : undefined;
		});
		expect(JSON.parse(finished.approval ?? "{}").decision).toMatchObject({ by: { id: parent.id } });
		expect(state.calls).toEqual([{ tool: "write_thing", arguments: { value: 7 } }]);
		expect(await runtime.pendingAgentRequests(parent.id)).toHaveLength(0);
	} finally {
		await runtime.abort(parent.id).catch(() => {});
	}
});

it("lets the ancestor's agent deny the call, which never reaches the server", async () => {
	const parent = await root("yolo");
	state.calls.length = 0;
	const { call } = await startCall(parent.id, "route-deny", "write_thing", { value: 3 });
	try {
		await waitFor("the root's request", async () =>
			(await runtime.pendingAgentRequests(parent.id)).find((entry) => entry.id === call.id),
		);
		expect(await runtime.decideAgentRequest(parent.id, call.id, "deny", "too risky")).toBe("external_call");
		const rejected = await waitFor("the rejected call", async () => {
			const row = await db
				.selectFrom("external_calls")
				.select(["state", "approval"])
				.where("id", "=", call.id)
				.executeTakeFirst();
			return row?.state === "rejected" ? row : undefined;
		});
		expect(JSON.parse(rejected.approval ?? "{}").decision.reason).toBe("too risky");
		expect(state.calls).toEqual([]);
	} finally {
		await runtime.abort(parent.id).catch(() => {});
	}
});

it("sends a request the ancestor's agent escalates back to the owner", async () => {
	const parent = await root("yolo");
	const { call } = await startCall(parent.id, "route-escalate", "write_thing", { value: 4 });
	try {
		await waitFor("the root's request", async () =>
			(await runtime.pendingAgentRequests(parent.id)).find((entry) => entry.id === call.id),
		);
		expect(await runtime.decideAgentRequest(parent.id, call.id, "escalate")).toBe("external_call");
		const escalated = await db
			.selectFrom("external_calls")
			.select(["handler_type", "handler_session_id", "approval"])
			.where("id", "=", call.id)
			.executeTakeFirstOrThrow();
		expect(escalated).toMatchObject({ handler_type: "user", handler_session_id: null });
		expect(JSON.parse(escalated.approval ?? "{}").agent).toEqual({ session: parent.id, state: "escalated" });
		expect(await runtime.pendingAgentRequests(parent.id)).toHaveLength(0);
		expect((await pendingExternalCallRows(db, owner.userId)).map((row) => row.id)).toContain(call.id);

		// The owner's decision settles it; the fake server never ran it.
		expect(
			await decideExternalCall(db, call.id, {
				decision: "rejected",
				by: { type: "user", id: owner.userId },
				at: new Date().toISOString(),
			}),
		).toBe(true);
	} finally {
		await runtime.abort(parent.id).catch(() => {});
	}
});

it("leaves an Ask root's call with the owner", async () => {
	const parent = await root("ask");
	const { call } = await startCall(parent.id, "ask-root", "write_thing", { value: 5 });
	try {
		// No ancestor allows mcp.write, so nobody is routed and the owner sees the request.
		const waiting = await waitFor("the call to wait for its owner", async () => {
			const row = await db
				.selectFrom("external_calls")
				.select(["id", "handler_type"])
				.where("id", "=", call.id)
				.executeTakeFirst();
			return row?.handler_type === "user" ? row : undefined;
		});
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(await runtime.pendingAgentRequests(parent.id)).toHaveLength(0);
		expect((await pendingExternalCallRows(db, owner.userId)).map((row) => row.id)).toContain(waiting.id);
	} finally {
		await runtime.abort(parent.id).catch(() => {});
	}
});

it("runs Auto Review for an escalated call of an auto_review root before the owner", async () => {
	const parent = await root("auto_review");
	// The root itself allows this one write, so the child's request routes to its agent; escalating it
	// falls back to Auto Review, which approves.
	await appendRule(
		db,
		{ type: "session", id: parent.id },
		{
			action: "allow",
			method: "ext.write",
			exact: "fake/write_thing",
		},
	);
	state.calls.length = 0;
	const { call } = await startCall(parent.id, "review-escalate", "write_thing", { value: 9 });
	try {
		await waitFor("the root's request", async () =>
			(await runtime.pendingAgentRequests(parent.id)).find((entry) => entry.id === call.id),
		);
		await rootWokeUp(parent.id);
		let reviewContext: unknown;
		faux.setResponses([
			(context) => {
				reviewContext = context;
				return fauxAssistantMessage([
					fauxToolCall("submit_review", { decision: "approve", risk: "low", reason: "a small change" }),
				]);
			},
		]);
		expect(await runtime.decideAgentRequest(parent.id, call.id, "escalate")).toBe("external_call");
		const finished = await waitFor("the reviewed call", async () => {
			const row = await db
				.selectFrom("external_calls")
				.select(["state", "approval"])
				.where("id", "=", call.id)
				.executeTakeFirst();
			return row?.state === "succeeded" ? row : undefined;
		});
		expect(finished.state).toBe("succeeded");
		expect(JSON.parse(finished.approval ?? "{}").review).toMatchObject({ decision: "approve", risk: "low" });
		// The reviewer sees the tool's description as trusted context, not just its name.
		expect(JSON.stringify(reviewContext)).toContain("Change one thing");
		// It also sees the original tool call exactly as the model made it, not only the stored extension arguments.
		const input = (reviewContext as { messages: { role: string; content: string }[] }).messages.find(
			(message) => message.role === "user",
		)?.content;
		expect(input).toContain('"tool_call"');
		expect(input).toContain('"name": "call_tool"');
		expect(input).toContain('"value": 9');
		expect(state.calls).toEqual([{ tool: "write_thing", arguments: { value: 9 } }]);
	} finally {
		await runtime.abort(parent.id).catch(() => {});
	}
});
