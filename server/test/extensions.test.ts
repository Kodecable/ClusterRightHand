import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RulePreset } from "@crh/api";
import { Client, SdkError, SdkErrorCode } from "@modelcontextprotocol/client";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as z from "zod/v4";
import { directToolsExtension, sessionExtensionViews } from "../src/agent/extension.ts";
import type { AgentRuntimeOptions } from "../src/agent/runtime.ts";
import type { RuntimeHost } from "../src/agent/runtime-core.ts";
import { endSessionWork } from "../src/agent/runtime-state.ts";
import { Audit } from "../src/audit/audit.ts";
import type { SessionUser } from "../src/auth/sessions.ts";
import { CallRunner } from "../src/extensions/call-runner.ts";
import { McpConnections } from "../src/extensions/connections.ts";
import {
	cancelWaitingExternalCall,
	createExternalCall,
	decideExternalCall,
	escalateAgentDecision,
	externalCallApproval,
	externalCallId,
	externalCallViews,
	finishExternalCall,
	getExternalCall,
	recoverExternalCalls,
	reevaluateExternalCalls,
	requestAgentDecision,
	waitExternalCall,
} from "../src/extensions/external-calls.ts";
import {
	ExtensionCallLostError,
	type ExtensionTool,
	ExtensionUnavailableError,
	readyStatus,
	type SessionExtension,
} from "../src/extensions/model.ts";
import { sessionExtensionsForUser } from "../src/extensions/registry.ts";
import {
	deleteExtension,
	extensionNamesForUser,
	extensionsForUser,
	parseDisabledExtensionNames,
	revisedTools,
	saveExtension,
} from "../src/extensions/store.ts";
import { createJobs } from "../src/jobs/jobs.ts";
import { MasterKey } from "../src/keys/master-key.ts";
import { ImageCache } from "../src/library/image-cache.ts";
import { createRootRuleSet } from "../src/policy/store.ts";
import type { Db } from "../src/storage/db.ts";
import { defaultOrgId } from "../src/storage/org.ts";
import type { ToolContext } from "../src/tools/catalog.ts";
import { runExtensionTool, TOOLS } from "../src/tools/catalog.ts";
import { convertExternalResult } from "../src/tools/external-results.ts";
import { execJobRenderers } from "../src/tools/job-renderers.ts";
import { createUser } from "../src/users/service.ts";
import { newId } from "../src/util/id.ts";
import { openTestDb } from "./helpers/db.ts";

/**
 * A Db whose external-call finishes fail, as a busy database would. Reads and inserts still go through, so the
 * only failure is the finish a catch path tries to make best-effort.
 */
function finishFailingDb(real: Db): Db {
	const wrap = (builder: object): object =>
		new Proxy(builder, {
			get(target, property) {
				if (property === "executeTakeFirst") return async () => Promise.reject(new Error("database is busy"));
				const value = Reflect.get(target, property, target);
				if (typeof value !== "function") return value;
				return (...args: unknown[]) => {
					const result = value.apply(target, args) as unknown;
					return typeof result === "object" && result !== null && "executeTakeFirst" in result ? wrap(result) : result;
				};
			},
		});
	return new Proxy(real, {
		get(target, property) {
			if (property === "updateTable") {
				return (table: string) => {
					const update = target.updateTable(table as never);
					return table === "external_calls" ? wrap(update) : update;
				};
			}
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	}) as Db;
}

/** What the fake server records and can be told to do. */
interface FakeState {
	calls: { tool: string; arguments: Record<string, unknown> }[];
	failConnections: boolean;
	/** The message a failed connection throws; a URL with a token exercises redaction. */
	failureMessage: string | null;
	hangTools: boolean;
	hangConnections: boolean;
	/** Fails a request after the connection is up, as a dropped link would. */
	failCalls: boolean;
	/** Fetches that reached the fake endpoint, one per connection attempt plus its requests. */
	requests: number;
	/** Requests whose per-request stream was aborted, i.e. MCP cancellations on a modern connection. */
	aborted: number;
	/** Cancellation notifications (`notifications/cancelled`) posted by the client on an older connection. */
	cancellations: number;
	/** How long `sleepy_thing` takes. */
	sleepMs: number;
	/** What the server reports about itself at initialization. */
	instructions?: string;
	serverDescription?: string;
	/** Changes `echo` for servers created from now on: a new input schema, or a write instead of a read. */
	echoTakesCount?: boolean;
	echoWrites?: boolean;
}

const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	"base64",
);

/** An in-process Streamable HTTP MCP server; `handler.fetch` is the network. */
function fakeMcp(state: FakeState) {
	return createMcpHandler(() => {
		const server = new McpServer(
			{
				name: "fake",
				version: "1.0.0",
				...(state.serverDescription === undefined ? {} : { description: state.serverDescription }),
			},
			state.instructions === undefined ? {} : { instructions: state.instructions },
		);
		server.registerTool(
			"echo",
			{
				description: "Echo the message back",
				inputSchema: state.echoTakesCount
					? z.object({ message: z.string(), count: z.number() })
					: z.object({ message: z.string() }),
				annotations: { readOnlyHint: state.echoWrites !== true },
			},
			async (args: { message: string }) => {
				state.calls.push({ tool: "echo", arguments: args });
				return { content: [{ type: "text", text: `echo: ${args.message}` }] };
			},
		);
		server.registerTool(
			"write_thing",
			{
				description: "Change one thing",
				inputSchema: z.object({ value: z.number() }),
				annotations: { readOnlyHint: false },
			},
			async ({ value }) => {
				state.calls.push({ tool: "write_thing", arguments: { value } });
				return { content: [{ type: "text", text: `wrote ${value}` }] };
			},
		);
		server.registerTool(
			"show_picture",
			{
				description: "Return a one-pixel image",
				inputSchema: z.object({}),
				annotations: { readOnlyHint: true },
			},
			async () => {
				state.calls.push({ tool: "show_picture", arguments: {} });
				return { content: [{ type: "image", data: PNG.toString("base64"), mimeType: "image/png" }] };
			},
		);
		server.registerTool(
			"fail_thing",
			{ description: "Fail on purpose", inputSchema: z.object({}), annotations: { readOnlyHint: false } },
			async () => {
				state.calls.push({ tool: "fail_thing", arguments: {} });
				return { content: [{ type: "text", text: "it failed" }], isError: true };
			},
		);
		server.registerTool(
			"slow_thing",
			{ description: "Never answer", inputSchema: z.object({}), annotations: { readOnlyHint: true } },
			async () => {
				state.calls.push({ tool: "slow_thing", arguments: {} });
				if (state.hangTools) return await new Promise(() => {});
				return { content: [{ type: "text", text: "done" }] };
			},
		);
		server.registerTool(
			"sleepy_thing",
			{ description: "Answer after a while", inputSchema: z.object({}), annotations: { readOnlyHint: true } },
			async () => {
				state.calls.push({ tool: "sleepy_thing", arguments: {} });
				await new Promise((resolve) => setTimeout(resolve, state.sleepMs));
				return { content: [{ type: "text", text: "slept" }] };
			},
		);
		server.registerTool(
			"delayed_thing",
			{ description: "Answer after a short delay", inputSchema: z.object({}), annotations: { readOnlyHint: true } },
			async () => {
				state.calls.push({ tool: "delayed_thing", arguments: {} });
				await new Promise((resolve) => setTimeout(resolve, 50));
				return { content: [{ type: "text", text: "delayed" }] };
			},
		);
		server.registerTool(
			"nodeGroupLookup",
			{
				description: "Find one node group by name",
				inputSchema: z.object({}),
				annotations: { readOnlyHint: true },
			},
			async () => {
				state.calls.push({ tool: "nodeGroupLookup", arguments: {} });
				return { content: [{ type: "text", text: "found" }] };
			},
		);
		return server;
	});
}

function fakeFetch(state: FakeState, handler: ReturnType<typeof fakeMcp>) {
	return async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
		const url = input instanceof Request ? input.url : String(input);
		if (!url.startsWith("http://mcp.test")) return fetch(input, init);
		state.requests += 1;
		// A request is cancelled either by aborting its per-request stream (a modern connection) or by
		// posting notifications/cancelled (an older one); both are the MCP cancellation the call sends.
		init?.signal?.addEventListener("abort", () => {
			state.aborted += 1;
		});
		if (typeof init?.body === "string" && init.body.includes("notifications/cancelled")) {
			state.cancellations += 1;
		}
		if (state.failConnections) throw new Error(state.failureMessage ?? "connection refused");
		// A server that accepts the request but never answers: only the connect timeout ends the attempt.
		if (state.hangConnections) return await new Promise<Response>(() => {});
		if (state.failCalls) throw new Error("the connection was reset");
		return handler.fetch(new Request(url, init));
	};
}

async function waitFor<T>(read: () => Promise<T | undefined>, timeoutMs = 5000): Promise<T> {
	const start = Date.now();
	for (;;) {
		const value = await read();
		if (value !== undefined) return value;
		if (Date.now() - start > timeoutMs) throw new Error("timed out waiting");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

describe("MCP extensions", () => {
	let db: Db;
	let user: SessionUser;
	let sessionId: string;
	let masterKey: MasterKey;
	let audit: Audit;
	let state: FakeState;
	let mcp: McpConnections;
	let imageDir: string;
	/** Each test's own runner: no module singleton outlives the test that started a call. */
	let runner: CallRunner;

	beforeEach(async () => {
		db = await openTestDb("sqlite");
		const created = await createUser(db, { username: "alice", kind: "member", password: "password-123" });
		user = { sessionId: "s", userId: created.id, username: created.username, kind: "member" };
		sessionId = newId();
		const orgId = await defaultOrgId(db);
		const now = new Date().toISOString();
		await db
			.insertInto("sessions")
			.values({
				id: sessionId,
				org_id: orgId,
				owner_user_id: user.userId,
				conversation_id: `c-${sessionId}`,
				parent_session_id: null,
				root_session_id: sessionId,
				schedule_id: null,
				title: "test",
				title_pending: 0,
				create_request_id: null,
				model: JSON.stringify({ provider: "faux", modelId: "faux-1" }),
				status: "active",
				created_at: now,
				updated_at: now,
				archived_at: null,
				disabled_extensions: null,
				last_submission_id: null,
				state: "idle",
				waiting_kind: null,
				waiting_level_id: null,
				waiting_handler_id: null,
				state_changed_at: now,
			})
			.execute();
		masterKey = MasterKey.generate();
		audit = new Audit(db);
		state = {
			calls: [],
			failConnections: false,
			failureMessage: null,
			hangTools: false,
			hangConnections: false,
			failCalls: false,
			requests: 0,
			aborted: 0,
			cancellations: 0,
			sleepMs: 70_000,
		};
		mcp = new McpConnections({ db, masterKey, fetch: fakeFetch(state, fakeMcp(state)) });
		runner = new CallRunner();
		imageDir = await mkdtemp(join(tmpdir(), "crh-ext-"));
	});

	afterEach(async () => {
		// A test may leave a call in flight; shutdown writes its row before the database goes.
		await runner.shutdown();
		await mcp.close();
		await db.destroy();
		await rm(imageDir, { recursive: true, force: true });
	});

	async function addServer(
		overrides: { preset?: RulePreset; trustAnnotations?: boolean; listDirectly?: boolean; grants?: boolean } = {},
	) {
		const { row } = await saveExtension(
			db,
			masterKey,
			"fake",
			{
				url: "http://mcp.test/mcp",
				description: "A fake server",
				trustAnnotations: overrides.trustAnnotations ?? true,
				listDirectly: overrides.listDirectly ?? false,
				grants: overrides.grants === false ? [] : [{ granteeType: "user", granteeId: user.userId }],
			},
			user.userId,
		);
		await createRootRuleSet(db, await defaultOrgId(db), { type: "session", id: sessionId }, overrides.preset ?? "ask");
		return row;
	}

	async function context(server: {
		name: string;
		description: string | null;
		enabled: boolean;
		available: boolean;
	}): Promise<ToolContext> {
		const entries = await sessionExtensionsForUser(db, user.userId, server.enabled ? [] : [server.name], mcp);
		return {
			db,
			cluster: {} as never,
			taskGroups: {} as never,
			user,
			actor: { type: "session", id: sessionId, onBehalfOfUserId: user.userId },
			chain: [{ type: "session", id: sessionId }],
			approvalUrl: () => "",
			rootSessionId: sessionId,
			extensions: entries,
			audit,
			callRunner: runner,
		};
	}

	/** A waiting call row left by an earlier process, as a replay would find it. */
	async function waitingCall(callKey: string, tool: string) {
		const { row } = await createExternalCall(db, {
			callKey,
			orgId: await defaultOrgId(db),
			actorType: "session",
			actorId: sessionId,
			onBehalfOfUserId: user.userId,
			extension: "fake",
			tool,
			arguments: { message: "hi" },
			operation: { method: "ext.read", target: `fake/${tool}` },
			annotations: { readOnlyHint: true },
			ruleChain: [{ type: "session", id: sessionId }],
			rootSessionId: sessionId,
			approval: { evaluation: { result: "require-approval", levels: [] } },
			state: "awaiting_approval",
		});
		return row;
	}

	/** A fake extension for the unexpected-exception paths, which the real registry never produces. */
	function failingExtension(call: () => Promise<unknown>): SessionExtension {
		const tool: ExtensionTool = {
			name: "echo",
			title: null,
			description: null,
			inputSchema: { type: "object" },
			annotations: { readOnlyHint: true },
		};
		return {
			enabled: true,
			extension: {
				name: "fake",
				kind: "mcp",
				description: null,
				enabled: true,
				listDirectly: false,
				availability: "granted",
				status: () => readyStatus(1),
				tools: () => [tool],
				ensureAvailable: async () => {},
				prepareCall: async () => {},
				refreshTools: async () => [tool],
				call,
				operation: () => ({ method: "ext.read", target: "fake/echo" }),
			},
		};
	}

	async function search(query: string, extension = "fake") {
		const tool = TOOLS.find((entry) => entry.name === "search_tools");
		if (!tool) throw new Error("no search_tools");
		const ctx = await context({ name: extension, description: "A fake server", enabled: true, available: true });
		const result = await tool.handler({ query } as never, ctx);
		return JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>;
	}

	it("validates server names, encrypts headers and requires re-entering them on a URL change", async () => {
		await expect(saveExtension(db, masterKey, "Bad Name", { url: "http://mcp.test/mcp" }, user.userId)).rejects.toThrow(
			/lowercase/,
		);
		// The whole crhs- prefix belongs to built-in extensions, including names no built-in has yet.
		await expect(
			saveExtension(db, masterKey, "crhs-future", { url: "http://mcp.test/mcp" }, user.userId),
		).rejects.toThrow(/starting with crhs- are reserved/);
		await saveExtension(
			db,
			masterKey,
			"fake",
			{ url: "http://mcp.test/mcp", headers: [{ name: "Authorization", value: "Bearer top-secret" }] },
			user.userId,
		);
		const secret = await db.selectFrom("secrets").select(["ciphertext"]).executeTakeFirst();
		expect(secret?.ciphertext).not.toContain("top-secret");
		await expect(saveExtension(db, masterKey, "fake", { url: "http://other.test/mcp" }, user.userId)).rejects.toThrow(
			/re-entering the headers/,
		);
		await saveExtension(db, masterKey, "fake", { url: "http://other.test/mcp", headers: null }, user.userId);
		await deleteExtension(db, "fake");
		expect(await db.selectFrom("secrets").select("id").execute()).toHaveLength(0);
	});

	it("searches the last tool list and calls a trusted read without approval", async () => {
		await addServer();
		const found = await search("echo");
		const results = found.results as { tool: string; input_schema: unknown }[];
		expect(results.map((entry) => entry.tool)).toEqual(["echo"]);
		expect(results[0]?.input_schema).toMatchObject({ type: "object" });
		const ctx = await context({ name: "fake", description: "A fake server", enabled: true, available: true });
		const result = await runExtensionTool(ctx, "fake", "echo", { message: "hi" });
		expect(result.isError).toBe(false);
		expect(result.content.map((block) => block.text).join("\n")).toContain("echo: hi");
		const row = await db.selectFrom("external_calls").selectAll().executeTakeFirst();
		expect(row?.state).toBe("succeeded");
		expect(state.calls).toEqual([{ tool: "echo", arguments: { message: "hi" } }]);
	});

	it("creates a call job whose stored result job_wait returns", async () => {
		await addServer();
		const jobs = createJobs({
			db,
			cluster: {} as never,
			taskGroups: {} as never,
			execRenderers: execJobRenderers,
			callRunner: runner,
		});
		const ctx = {
			...(await context({ name: "fake", description: "A fake server", enabled: true, available: true })),
			jobs,
		};
		const result = await runExtensionTool({ ...ctx, callKey: "job-call" }, "fake", "echo", { message: "hello" });
		const row = await db.selectFrom("jobs").selectAll().where("call_key", "=", "job-call").executeTakeFirstOrThrow();
		expect(row).toMatchObject({
			kind: "call",
			resource_type: "external_call",
			resource_id: externalCallId("job-call"),
			state: "settled",
		});
		expect(JSON.parse(row.action)).toEqual({ type: "extension_tool", extension: "fake", tool: "echo" });
		expect(row.result).not.toBeNull();

		const wait = TOOLS.find((tool) => tool.name === "job_wait");
		if (!wait) throw new Error("job_wait tool missing");
		const waited = (await wait.handler({ job_id: row.id, wait: 0 } as never, ctx)) as {
			content: { type: string; text: string }[];
			isError: boolean;
		};
		expect(waited.content.map((block) => block.text)).toEqual(result.content.map((block) => block.text));
		expect(waited.isError).toBe(result.isError);
	});

	/** A job of a call, once the runner has projected it. */
	async function callJob(callKey: string) {
		return db.selectFrom("jobs").selectAll().where("call_key", "=", callKey).executeTakeFirst();
	}

	async function settledCallJob(callKey: string) {
		return waitFor(async () => {
			const row = await callJob(callKey);
			return row?.state === "settled" ? row : undefined;
		});
	}

	async function jobWait(ctx: ToolContext, jobId: string, wait = 0) {
		const tool = TOOLS.find((candidate) => candidate.name === "job_wait");
		if (!tool) throw new Error("job_wait tool missing");
		return tool.handler({ job_id: jobId, wait } as never, ctx);
	}

	function textOf(result: { content: { text: string }[] }): string {
		return result.content.map((block) => block.text).join("\n");
	}

	it("gives a directly listed tool crhs's wait and strips it from its arguments", async () => {
		await addServer({ preset: "yolo" });
		const tools: ExtensionTool[] = [
			{
				name: "echo",
				title: null,
				description: null,
				inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
				annotations: { readOnlyHint: true },
			},
		];
		const options = {
			db,
			cluster: {} as never,
			taskGroups: {} as never,
			mcp,
			models: { getModel: () => undefined },
			callRunner: runner,
		} as unknown as AgentRuntimeOptions;
		const extension = directToolsExtension(options, {}, "fake", tools);
		const registration = extension.tools?.find((candidate) => candidate.name === "ext__fake__echo");
		expect(registration?.parameters).toMatchObject({
			properties: { wait: { type: "integer", minimum: 0, maximum: 600 } },
		});
		const result = await registration?.execute(
			{ message: "hi", wait: 0 } as never,
			{
				taskId: "direct-call",
				callId: "call_0",
				conversationId: { toString: () => `c-${sessionId}` },
				details: async () => {},
			} as never,
			{} as never,
		);
		expect((result?.output ?? []).map((block) => ("text" in block ? block.text : "")).join("\n")).toContain(
			"still running",
		);
		// The wait is crhs's: the extension receives only its own arguments.
		expect(state.calls).toEqual([{ tool: "echo", arguments: { message: "hi" } }]);
		await waitFor(async () =>
			(await getExternalCall(db, externalCallId("direct-call")))?.state === "succeeded" ? true : undefined,
		);
	});

	it("returns the job id with wait: 0, and job_wait returns the same text a foreground call returns", async () => {
		await addServer({ preset: "yolo" });
		const jobs = createJobs({
			db,
			cluster: {} as never,
			taskGroups: {} as never,
			execRenderers: execJobRenderers,
			callRunner: runner,
		});
		const ctx = {
			...(await context({ name: "fake", description: "A fake server", enabled: true, available: true })),
			jobs,
		};
		const background = await runExtensionTool(
			{ ...ctx, callKey: "background-call" },
			"fake",
			"echo",
			{
				message: "hello",
			},
			0,
		);
		const job = await callJob("background-call");
		expect(job).toMatchObject({ kind: "call" });
		expect(background.details).toMatchObject({ external_call_id: externalCallId("background-call") });
		expect(textOf(background)).toContain(`job ${job?.id}`);
		expect(textOf(background)).toContain("job_wait");

		const settled = await settledCallJob("background-call");
		const waited = await jobWait(ctx, settled.id);
		const foreground = await runExtensionTool({ ...ctx, callKey: "foreground-call" }, "fake", "echo", {
			message: "hello",
		});
		expect(waited.content.map((block) => block.text)).toEqual(foreground.content.map((block) => block.text));
		expect(waited.details).toMatchObject({ job_id: settled.id, external_call_id: externalCallId("background-call") });
	});

	it("returns the approval link and job id while a call waits, and job_wait returns it after approval", async () => {
		await addServer({ preset: "ask" });
		const jobs = createJobs({
			db,
			cluster: {} as never,
			taskGroups: {} as never,
			execRenderers: execJobRenderers,
			callRunner: runner,
		});
		const ctx = {
			...(await context({ name: "fake", description: "A fake server", enabled: true, available: true })),
			externalCallUrl: (id: string) => `/approvals/external-calls/${id}`,
			jobs,
		};
		const waiting = await runExtensionTool(
			{ ...ctx, callKey: "approval-call" },
			"fake",
			"write_thing",
			{
				value: 3,
			},
			0,
		);
		const row = await waitFor(async () => {
			const found = await getExternalCall(db, externalCallId("approval-call"));
			return found?.state === "awaiting_approval" ? found : undefined;
		});
		const job = await callJob("approval-call");
		expect(textOf(waiting)).toContain(`waiting for approval: /approvals/external-calls/${row.id}`);
		expect(textOf(waiting)).toContain(`job ${job?.id}`);

		await decideExternalCall(db, row.id, {
			decision: "approved",
			by: { type: "user", id: user.userId },
			at: new Date().toISOString(),
		});
		const settled = await settledCallJob("approval-call");
		const waited = await jobWait(ctx, settled.id);
		expect(textOf(waited)).toContain("wrote 3");
		expect(textOf(waited)).not.toContain("waiting for approval");
	});

	it("cancels a running call through the runner: an MCP cancellation, then unknown", async () => {
		await addServer({ preset: "yolo" });
		state.hangTools = true;
		const jobs = createJobs({
			db,
			cluster: {} as never,
			taskGroups: {} as never,
			execRenderers: execJobRenderers,
			callRunner: runner,
		});
		const ctx = {
			...(await context({ name: "fake", description: "A fake server", enabled: true, available: true })),
			jobs,
		};
		await runExtensionTool({ ...ctx, callKey: "cancel-call" }, "fake", "slow_thing", {}, 0);
		await waitFor(async () => (state.calls.some((call) => call.tool === "slow_thing") ? true : undefined));
		const job = await callJob("cancel-call");
		const cancel = TOOLS.find((candidate) => candidate.name === "job_cancel");
		if (!cancel) throw new Error("job_cancel tool missing");
		const result = await cancel.handler({ job_id: job?.id } as never, ctx);
		expect(JSON.parse(result.content[0]?.text ?? "{}")).toMatchObject({
			state: "settled",
			cancel_sent: true,
			outcome: { kind: "unknown" },
		});
		expect(await getExternalCall(db, externalCallId("cancel-call"))).toMatchObject({ state: "unknown" });
		// The MCP cancellation is the abort of the request's stream on this transport.
		expect(state.aborted + state.cancellations).toBeGreaterThan(0);
		expect(textOf(await jobWait(ctx, job?.id ?? ""))).toContain("unknown");
	});

	it("lets a tool invocation's abort only stop waiting, not the call", async () => {
		await addServer({ preset: "yolo" });
		state.hangTools = true;
		const jobs = createJobs({
			db,
			cluster: {} as never,
			taskGroups: {} as never,
			execRenderers: execJobRenderers,
			callRunner: runner,
		});
		const controller = new AbortController();
		const ctx = {
			...(await context({ name: "fake", description: "A fake server", enabled: true, available: true })),
			jobs,
		};
		const pending = runExtensionTool(
			{ ...ctx, callKey: "invocation-abort", signal: controller.signal },
			"fake",
			"slow_thing",
			{},
			600,
		);
		await waitFor(async () => (state.calls.some((call) => call.tool === "slow_thing") ? true : undefined));
		controller.abort();
		const result = await pending;
		const job = await callJob("invocation-abort");
		expect(textOf(result)).toContain("still running");
		expect(textOf(result)).toContain(`job ${job?.id}`);
		expect(await getExternalCall(db, externalCallId("invocation-abort"))).toMatchObject({ state: "running" });
		await runner.cancel(externalCallId("invocation-abort"), "test cleanup");
	});

	it("finds the in-flight call on a replay instead of starting another", async () => {
		await addServer({ preset: "yolo" });
		const jobs = createJobs({
			db,
			cluster: {} as never,
			taskGroups: {} as never,
			execRenderers: execJobRenderers,
			callRunner: runner,
		});
		const ctx = {
			...(await context({ name: "fake", description: "A fake server", enabled: true, available: true })),
			jobs,
		};
		const first = runExtensionTool({ ...ctx, callKey: "replay-call" }, "fake", "delayed_thing", {}, 0);
		await waitFor(async () => (state.calls.some((call) => call.tool === "delayed_thing") ? true : undefined));
		const replay = await runExtensionTool({ ...ctx, callKey: "replay-call" }, "fake", "delayed_thing", {}, 5);
		expect(textOf(replay)).toContain("delayed");
		expect(textOf(await first)).toContain(`job ${(await callJob("replay-call"))?.id}`);
		expect(state.calls.filter((call) => call.tool === "delayed_thing")).toHaveLength(1);
		await settledCallJob("replay-call");
	});

	it("stops a session tree's calls when the session is stopped, but not when its run ends", async () => {
		await addServer({ preset: "yolo" });
		state.hangTools = true;
		const jobs = createJobs({
			db,
			cluster: {} as never,
			taskGroups: {} as never,
			execRenderers: execJobRenderers,
			callRunner: runner,
		});
		const ctx = {
			...(await context({ name: "fake", description: "A fake server", enabled: true, available: true })),
			jobs,
		};
		await runExtensionTool({ ...ctx, callKey: "session-call" }, "fake", "slow_thing", {}, 0);
		await waitFor(async () => (state.calls.some((call) => call.tool === "slow_thing") ? true : undefined));
		const host = {
			db,
			cluster: { cancelTask: async () => false },
			taskGroups: { cancel: async () => false },
			callRunner: runner,
		} as unknown as RuntimeHost;
		await endSessionWork(host, [sessionId], "the session's run ended", { includeRunning: false });
		expect(await getExternalCall(db, externalCallId("session-call"))).toMatchObject({ state: "running" });
		await endSessionWork(host, [sessionId], "the session was stopped", { includeRunning: true });
		expect(await getExternalCall(db, externalCallId("session-call"))).toMatchObject({ state: "unknown" });
		expect(state.aborted + state.cancellations).toBeGreaterThan(0);
	});

	it("keeps a call alive past the SDK's 60-second default when the extension allows it", async () => {
		vi.useFakeTimers();
		try {
			await saveExtension(
				db,
				masterKey,
				"fake",
				{
					url: "http://mcp.test/mcp",
					timeoutSeconds: 120,
					grants: [{ granteeType: "user", granteeId: user.userId }],
				},
				user.userId,
			);
			await createRootRuleSet(db, await defaultOrgId(db), { type: "session", id: sessionId }, "yolo");
			await mcp.prepareCall("fake");
			const pending = mcp.callTool("fake", "sleepy_thing", {}, { timeoutMs: 120_000 });
			await vi.advanceTimersByTimeAsync(70_000);
			const result = (await pending) as { content: { text: string }[] };
			expect(result.content.map((block) => block.text)).toEqual(["slept"]);
			expect(mcp.status("fake").state).toBe("ready");
			expect(mcp.status("fake").connected).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it("reports an SDK request timeout as a timed-out call without marking the extension unavailable", async () => {
		await addServer();
		await mcp.prepareCall("fake");
		const spy = vi
			.spyOn(Client.prototype, "callTool")
			.mockRejectedValue(new SdkError(SdkErrorCode.RequestTimeout, "request timed out"));
		try {
			const lost = await mcp.callTool("fake", "echo", { message: "x" }, { timeoutMs: 300_000 }).then(
				() => undefined,
				(error: unknown) => error,
			);
			expect(lost).toBeInstanceOf(ExtensionCallLostError);
			expect((lost as Error).message).toBe("the call timed out after 300 s");
			expect(mcp.status("fake").state).toBe("ready");
			expect(mcp.status("fake").connected).toBe(true);
		} finally {
			spy.mockRestore();
		}
	});

	it("projects an in-flight call recovered at startup as settled unknown", async () => {
		await addServer();
		const jobs = createJobs({
			db,
			cluster: {} as never,
			taskGroups: {} as never,
			execRenderers: execJobRenderers,
			callRunner: runner,
		});
		const { row } = await createExternalCall(db, {
			callKey: "restart-call",
			orgId: await defaultOrgId(db),
			actorType: "session",
			actorId: sessionId,
			onBehalfOfUserId: user.userId,
			extension: "fake",
			tool: "echo",
			arguments: {},
			operation: { method: "ext.read", target: "fake/echo" },
			annotations: null,
			ruleChain: [{ type: "session", id: sessionId }],
			rootSessionId: sessionId,
			approval: { evaluation: { result: "allow", levels: [] } },
			state: "running",
		});
		const job = await jobs.ensure({
			kind: "call",
			callKey: "restart-call",
			actor: { type: "session", id: sessionId, onBehalfOfUserId: user.userId },
			sessionId,
			resourceType: "external_call",
			resourceId: row.id,
			action: { type: "extension_tool", extension: "fake", tool: "echo" },
		});
		expect(job.state).not.toBe("settled");
		await recoverExternalCalls(db);
		const settled = await jobs.project(job);
		expect(settled?.state).toBe("settled");
		expect(JSON.parse(settled?.outcome ?? "null")).toEqual({ kind: "unknown", failed: true });
		const ctx = {
			...(await context({ name: "fake", description: "A fake server", enabled: true, available: true })),
			jobs,
		};
		expect(textOf(await jobWait(ctx, job.id))).toContain("unknown");
	});

	it("finds a tool by a description word and by a camelCase part of its name", async () => {
		await addServer();
		const byDescription = await search("name");
		expect((byDescription.results as { tool: string }[]).map((entry) => entry.tool)).toEqual(["nodeGroupLookup"]);
		const byNamePart = await search("lookup");
		expect((byNamePart.results as { tool: string }[]).map((entry) => entry.tool)).toContain("nodeGroupLookup");
	});

	it("runs two calls whose model call ids repeat, keyed by durable's call key", async () => {
		await addServer();
		const ctx = await context({ name: "fake", description: "A fake server", enabled: true, available: true });
		// Some providers reuse call ids such as "call_0" across turns; the durable tool task key names the call.
		const first = await runExtensionTool({ ...ctx, callKey: "turn-1", callId: "call_0" }, "fake", "echo", {
			message: "one",
		});
		const second = await runExtensionTool({ ...ctx, callKey: "turn-2", callId: "call_0" }, "fake", "echo", {
			message: "two",
		});
		expect(first.content.map((block) => block.text).join("\n")).toContain("echo: one");
		expect(second.content.map((block) => block.text).join("\n")).toContain("echo: two");
		expect(await getExternalCall(db, externalCallId("turn-2"))).toMatchObject({
			state: "succeeded",
			source_tool_task: "turn-2",
		});
	});

	it("keeps only the marker of a finished call and never calls the server again", async () => {
		await addServer();
		const ctx = await context({ name: "fake", description: "A fake server", enabled: true, available: true });
		const id = externalCallId("finished");
		const first = await runExtensionTool({ ...ctx, callKey: "finished" }, "fake", "echo", { message: "hi" });
		expect(first.isError).toBe(false);
		expect(first.content.map((block) => block.text).join("\n")).toContain("echo: hi");
		expect(first.details?.approval_url).toBeUndefined();
		// The terminal row is the "already ran" marker: state and finished_at only, no arguments or result.
		const finished = await getExternalCall(db, id);
		expect(finished).toMatchObject({ state: "succeeded", arguments: null });
		expect(finished?.finished_at).not.toBeNull();

		const callsBefore = state.calls.length;
		const replay = await runExtensionTool({ ...ctx, callKey: "finished" }, "fake", "echo", { message: "hi" });
		const text = replay.content.map((block) => block.text).join("\n");
		expect(text).toContain("finished before a restart");
		expect(text).toContain("could not be kept");
		expect(replay.details).toEqual({ extension: "fake", tool: "echo" });
		expect(state.calls.length).toBe(callsBefore);
	});

	it("asks for approval on a write, shows the call in the approvals, and runs it after approval", async () => {
		await addServer({ preset: "ask" });
		const statuses: Record<string, unknown>[] = [];
		const ctx = {
			...(await context({ name: "fake", description: "A fake server", enabled: true, available: true })),
			externalCallUrl: (id: string) => `/approvals/external-calls/${id}`,
			onStatus: async (status: Record<string, unknown>) => {
				statuses.push(status);
			},
		};
		const pending = runExtensionTool(ctx, "fake", "write_thing", { value: 3 });
		const waiting = await waitFor(async () => {
			const rows = await db.selectFrom("external_calls").selectAll().execute();
			return rows.find((row) => row.state === "awaiting_approval");
		});
		const view = (await externalCallViews(db, [waiting]))[0];
		expect(view?.extension).toBe("fake");
		expect(view?.operation).toEqual({ method: "ext.write", target: "fake/write_thing" });
		await expect(getExternalCall(db, waiting.id)).resolves.toBeDefined();
		const decided = await decideExternalCall(db, waiting.id, {
			decision: "approved",
			by: { type: "user", id: user.userId },
			at: new Date().toISOString(),
		});
		expect(decided).toBe(true);
		const result = await pending;
		expect(result.isError).toBe(false);
		expect(result.content.map((block) => block.text).join("\n")).toContain("wrote 3");
		// The link is shown while waiting; the finished result and the last status carry no approval link.
		expect(statuses.some((status) => typeof status.approval_url === "string")).toBe(true);
		expect(statuses.at(-1)?.approval_url).toBeUndefined();
		expect(result.details?.approval_url).toBeUndefined();
		const finished = await getExternalCall(db, waiting.id);
		expect(finished).toMatchObject({ state: "succeeded", arguments: null });
		await audit.flush();
		const actions = (await db.selectFrom("audit_events").select("action").execute()).map((row) => row.action);
		expect(actions).toContain("external_call.started");
		expect(actions).toContain("external_call.finished");
	});

	it("fails a waiting call whose extension was revoked before it ran", async () => {
		await addServer({ preset: "ask" });
		const ctx = await context({ name: "fake", description: "A fake server", enabled: true, available: true });
		const pending = runExtensionTool({ ...ctx, callKey: "revoked-while-waiting" }, "fake", "write_thing", {
			value: 1,
		});
		const waiting = await waitFor(async () => {
			const rows = await db.selectFrom("external_calls").selectAll().execute();
			return rows.find((row) => row.state === "awaiting_approval");
		});
		// The grant goes while the call waits; approving it now must not reach the server.
		await db.deleteFrom("extension_grants").execute();
		const decided = await decideExternalCall(db, waiting.id, {
			decision: "approved",
			by: { type: "user", id: user.userId },
			at: new Date().toISOString(),
		});
		expect(decided).toBe(true);
		const result = await pending;
		expect(result.isError).toBe(true);
		expect(result.content.map((block) => block.text).join("\n")).toContain("no longer available");
		expect(state.calls).toHaveLength(0);
		expect(await getExternalCall(db, waiting.id)).toMatchObject({ state: "failed", arguments: null });
	});

	it("keeps an external call in progress while Auto Review judges it, then links the approval", async () => {
		await addServer({ preset: "auto_review" });
		const statuses: Record<string, unknown>[] = [];
		let releaseReview: () => void = () => {};
		const reviewGate = new Promise<void>((resolve) => {
			releaseReview = resolve;
		});
		const ctx = {
			...(await context({ name: "fake", description: "A fake server", enabled: true, available: true })),
			externalCallUrl: (id: string) => `/approvals/external-calls/${id}`,
			// Auto Review judges tool calls: the call needs its durable tool task.
			callKey: "41",
			willReview: async () => true,
			reviewExternalCall: async () => {
				await reviewGate;
			},
			onStatus: async (status: Record<string, unknown>) => {
				statuses.push(status);
			},
		};
		const pending = runExtensionTool(ctx, "fake", "write_thing", { value: 6 });
		const waiting = await waitFor(async () => {
			const rows = await db.selectFrom("external_calls").selectAll().execute();
			return rows.find((row) => row.state === "awaiting_approval");
		});
		// The transcript keeps the in-progress look and has no approval link until the verdict arrives.
		const reviewing = await waitFor(async () =>
			statuses.find((status) => status.phase === "reviewing" && status.external_call_id === waiting.id),
		);
		expect(reviewing).toEqual({
			external_call_id: waiting.id,
			state: "awaiting_approval",
			phase: "reviewing",
		});
		expect(reviewing.approval_url).toBeUndefined();

		// The review escalates (the call stays waiting): the next status is an ordinary user-facing wait, with its
		// approval link and no phase.
		releaseReview();
		await waitFor(async () =>
			statuses.find((status) => status.phase === undefined && typeof status.approval_url === "string"),
		);
		await decideExternalCall(db, waiting.id, {
			decision: "rejected",
			by: { type: "user", id: user.userId },
			at: new Date().toISOString(),
		});
		const result = await pending;
		expect(result.isError).toBe(true);
	});

	it("never links an approval for an external call Auto Review approves", async () => {
		await addServer({ preset: "auto_review" });
		const statuses: Record<string, unknown>[] = [];
		const base = await context({ name: "fake", description: "A fake server", enabled: true, available: true });
		const ctx = {
			...base,
			externalCallUrl: (id: string) => `/approvals/external-calls/${id}`,
			callKey: "42",
			willReview: async () => true,
			reviewExternalCall: async (id: string) => {
				await decideExternalCall(db, id, {
					decision: "approved",
					by: { type: "system", id: "auto-review" },
					at: new Date().toISOString(),
				});
			},
			onStatus: async (status: Record<string, unknown>) => {
				statuses.push(status);
			},
		};
		const result = await runExtensionTool(ctx, "fake", "write_thing", { value: 7 });
		expect(result.isError).not.toBe(true);
		expect(statuses.some((status) => status.phase === "reviewing")).toBe(true);
		expect(statuses.some((status) => "approval_url" in status)).toBe(false);
	});

	it("returns a rejected call's reason without an approval link", async () => {
		await addServer({ preset: "ask" });
		const ctx = await context({ name: "fake", description: "A fake server", enabled: true, available: true });
		const pending = runExtensionTool(ctx, "fake", "write_thing", { value: 4 });
		const waiting = await waitFor(async () => {
			const rows = await db.selectFrom("external_calls").selectAll().execute();
			return rows.find((row) => row.state === "awaiting_approval");
		});
		await decideExternalCall(
			db,
			waiting.id,
			{ decision: "rejected", by: { type: "user", id: user.userId }, at: new Date().toISOString() },
			"too risky",
		);
		const result = await pending;
		expect(result.isError).toBe(true);
		expect(result.content.map((block) => block.text).join("\n")).toContain("too risky");
		expect(result.details?.approval_url).toBeUndefined();
		// The row is terminal and keeps no arguments; the reason lives in the approval decision.
		const finished = await getExternalCall(db, waiting.id);
		expect(finished?.arguments).toBeNull();
		expect(externalCallApproval(finished ?? waiting)?.decision?.reason).toBe("too risky");
	});

	it("treats an untrusted readOnlyHint as a write", async () => {
		await addServer({ trustAnnotations: false });
		const ctx = await context({ name: "fake", description: "A fake server", enabled: true, available: true });
		const pending = runExtensionTool(ctx, "fake", "echo", { message: "x" });
		const waiting = await waitFor(async () => {
			const rows = await db.selectFrom("external_calls").selectAll().execute();
			return rows.find((row) => row.state === "awaiting_approval");
		});
		expect(JSON.parse(waiting.operation)).toEqual({ method: "ext.write", target: "fake/echo" });
		await cancelWaitingExternalCall(db, waiting.id);
		const result = await pending;
		expect(result.isError).toBe(true);
	});

	it("converts images into the image cache", async () => {
		const cache = new ImageCache(db, imageDir, () => ({ diskBytes: 1_048_576, ttlMs: 60_000 }));
		await addServer();
		const ctx = await context({ name: "fake", description: "A fake server", enabled: true, available: true });
		const result = await runExtensionTool({ ...ctx, imageCache: cache }, "fake", "show_picture", {});
		const images = (result.details as { images?: { sha256: string }[] } | undefined)?.images ?? [];
		expect(images).toHaveLength(1);
		expect(await cache.get(images[0]?.sha256 ?? "")).toBeDefined();
	});

	it("reports an isError result as a failed tool result with text", async () => {
		await addServer({ preset: "yolo" });
		const ctx = await context({ name: "fake", description: "A fake server", enabled: true, available: true });
		const result = await runExtensionTool(ctx, "fake", "fail_thing", {});
		expect(result.isError).toBe(true);
		expect(result.content.map((block) => block.text).join("\n")).toContain("it failed");
	});

	it("lists tools directly only when asked, skipping names that do not fit", async () => {
		const options = { db } as AgentRuntimeOptions;
		const tools: ExtensionTool[] = [
			{ name: "echo", title: null, description: null, inputSchema: { type: "object" }, annotations: null },
			{
				name: `x${"y".repeat(64)}`,
				title: null,
				description: null,
				inputSchema: { type: "object" },
				annotations: null,
			},
		];
		const extension = directToolsExtension(options, {}, "fake", tools);
		expect(extension.name).toBe("ext:fake");
		expect(extension.tools?.map((tool) => tool.name)).toEqual(["ext__fake__echo"]);
		// The direct tool takes crhs's `wait`, as call_tool does; it is not part of the extension's own schema.
		const parameters = extension.tools?.[0]?.parameters as { properties?: Record<string, unknown> };
		expect(parameters.properties?.wait).toMatchObject({ type: "integer", minimum: 0, maximum: 600 });
	});

	it("records a failed connection without retrying on its own, and lets an administrator reconnect at once", async () => {
		vi.useFakeTimers();
		try {
			await addServer();
			state.failConnections = true;
			await expect(mcp.prepareCall("fake")).rejects.toThrow();
			const unavailable = mcp.status("fake");
			expect(unavailable.state).toBe("unavailable");
			expect(unavailable.connected).toBe(false);
			// No backoff: past the first refresh of a server never listed (within a minute), nothing contacts it
			// again until a call, an administrator or the daily refresh.
			await vi.advanceTimersByTimeAsync(61_000);
			const requests = state.requests;
			await vi.advanceTimersByTimeAsync(60 * 60_000);
			expect(state.requests).toBe(requests);
			state.failConnections = false;
			expect((await mcp.reconnect("fake")).state).toBe("ready");
			expect(mcp.status("fake").connected).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it("fails a call at once after a failed attempt in the last 10 s and tries again after the window", async () => {
		vi.useFakeTimers();
		try {
			await addServer();
			state.failConnections = true;
			await expect(mcp.prepareCall("fake")).rejects.toThrow();
			const attempts = state.requests;
			// A second call within the window does not touch the server.
			await expect(mcp.prepareCall("fake")).rejects.toThrow(/connection refused/);
			expect(state.requests).toBe(attempts);
			// Once the window has passed, the call attempts the connection again.
			vi.setSystemTime(Date.now() + 10_001);
			await expect(mcp.prepareCall("fake")).rejects.toThrow();
			expect(state.requests).toBeGreaterThan(attempts);
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not contact a server disabled while a connection attempt is in flight", async () => {
		vi.useFakeTimers();
		try {
			await addServer();
			state.hangConnections = true;
			const attempt = mcp.prepareCall("fake").then(
				() => undefined,
				() => undefined,
			);
			// Let the attempt reach the network, where it hangs until the connect timeout.
			for (let i = 0; i < 100 && state.requests === 0; i += 1) await vi.advanceTimersByTimeAsync(0);
			expect(state.requests).toBe(1);
			await saveExtension(db, masterKey, "fake", { enabled: false }, user.userId);
			const invalidation = mcp.invalidate("fake", { keepTools: true });
			await vi.advanceTimersByTimeAsync(10_000);
			await invalidation;
			await attempt;
			expect(mcp.status("fake").state).toBe("unknown");
			// A disabled extension has no scheduled refresh.
			expect(mcp.status("fake").nextAttemptAt).toBeNull();
			const requests = state.requests;
			await vi.advanceTimersByTimeAsync(48 * 60 * 60_000);
			expect(state.requests).toBe(requests);
			// A direct attempt on the disabled server is refused without contacting it.
			await expect(mcp.reconnect("fake")).resolves.toMatchObject({ state: "unavailable" });
			expect(mcp.status("fake").lastError).toContain("disabled");
			expect(state.requests).toBe(requests);
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps a token in an MCP URL's query out of connection errors", async () => {
		await saveExtension(db, masterKey, "fake", { url: "http://mcp.test/mcp?api_key=top-secret" }, user.userId);
		state.failConnections = true;
		state.failureMessage = "could not reach http://mcp.test/mcp?api_key=top-secret (connection refused)";
		const error = await mcp.prepareCall("fake").catch((err: unknown) => err);
		expect(String(error)).not.toContain("top-secret");
		const lastError = mcp.status("fake").lastError;
		expect(lastError).not.toBeNull();
		expect(lastError).not.toContain("top-secret");
		expect(lastError).toContain("http://mcp.test/mcp");
		// The row keeps the error for the next process, redacted too.
		const row = await db.selectFrom("extensions").select("refresh_error").where("name", "=", "fake").executeTakeFirst();
		expect(row?.refresh_error).not.toContain("top-secret");
	});

	it("bounds a connection attempt at the connect timeout", async () => {
		vi.useFakeTimers();
		try {
			await addServer();
			state.hangConnections = true;
			const outcome = mcp.prepareCall("fake").then(
				() => undefined,
				(error: unknown) => error,
			);
			await vi.advanceTimersByTimeAsync(9_999);
			await vi.advanceTimersByTimeAsync(1);
			const error = await outcome;
			expect(error).toBeInstanceOf(ExtensionUnavailableError);
			expect((error as Error).message).toContain("timed out");
			expect(mcp.status("fake").state).toBe("unavailable");
		} finally {
			vi.useRealTimers();
		}
	});

	it("shares one connection attempt between concurrent calls", async () => {
		vi.useFakeTimers();
		try {
			await addServer();
			state.hangConnections = true;
			const both = Promise.allSettled([mcp.prepareCall("fake"), mcp.prepareCall("fake")]);
			await vi.advanceTimersByTimeAsync(10_000);
			const results = await both;
			expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
			expect(state.requests).toBe(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps the last tool list across a configuration change and drops it on deletion", async () => {
		await addServer();
		await mcp.prepareCall("fake");
		const cached = mcp.tools("fake").length;
		expect(cached).toBeGreaterThan(0);
		await mcp.invalidate("fake", { keepTools: true });
		expect(mcp.status("fake").state).toBe("unknown");
		expect(mcp.tools("fake")).toHaveLength(cached);
		// The changed configuration is checked soon, not a day later.
		const next = Date.parse(mcp.status("fake").nextAttemptAt ?? "");
		expect(next - Date.now()).toBeLessThanOrEqual(60_000);
		await mcp.invalidate("fake");
		expect(mcp.tools("fake")).toHaveLength(0);
	});

	it("caches the tools and the server's description on the row, so a restart searches without connecting", async () => {
		state.instructions = "Use echo to repeat things.";
		state.serverDescription = "A fake server for tests";
		await saveExtension(
			db,
			masterKey,
			"fake",
			{ url: "http://mcp.test/mcp", grants: [{ granteeType: "user", granteeId: user.userId }] },
			user.userId,
		);
		await createRootRuleSet(db, await defaultOrgId(db), { type: "session", id: sessionId }, "ask");
		await mcp.prepareCall("fake");
		const row = await db.selectFrom("extensions").selectAll().where("name", "=", "fake").executeTakeFirstOrThrow();
		expect(row.server_instructions).toBe("Use echo to repeat things.");
		expect(row.server_description).toBe("A fake server for tests");
		expect(row.tools_rev).toBe(1);
		expect(row.refreshed_at).not.toBeNull();
		await mcp.close();

		// A new process: the cache loads without a connection; search and the description use it.
		mcp = new McpConnections({ db, masterKey, fetch: fakeFetch(state, fakeMcp(state)) });
		await mcp.start();
		const requests = state.requests;
		const found = await search("echo");
		expect((found.results as { tool: string }[]).map((entry) => entry.tool)).toEqual(["echo"]);
		const ctx = await context({ name: "fake", description: null, enabled: true, available: true });
		const fake = (entries: ToolContext["extensions"]) => entries?.find((entry) => entry.extension.name === "fake");
		expect(fake(ctx.extensions)?.extension.description).toBe("Use echo to repeat things.");
		expect(mcp.status("fake")).toMatchObject({ state: "ready", connected: false });
		expect(state.requests).toBe(requests);

		// Without instructions (none, or an empty text) the server's own description is used; the administrator's
		// text wins over both.
		await db.updateTable("extensions").set({ server_instructions: null }).where("name", "=", "fake").execute();
		await mcp.close();
		mcp = new McpConnections({ db, masterKey, fetch: fakeFetch(state, fakeMcp(state)) });
		const again = await context({ name: "fake", description: null, enabled: true, available: true });
		expect(fake(again.extensions)?.extension.description).toBe("A fake server for tests");
		await saveExtension(db, masterKey, "fake", { description: "Ours" }, user.userId);
		const ours = await context({ name: "fake", description: null, enabled: true, available: true });
		expect(fake(ours.extensions)?.extension.description).toBe("Ours");
	});

	it("closes an idle connection and refreshes the list on schedule without staying connected", async () => {
		await mcp.close();
		mcp = new McpConnections({
			db,
			masterKey,
			fetch: fakeFetch(state, fakeMcp(state)),
			idleDisconnectMs: 40,
			refreshIntervalMs: 200,
			random: () => 0,
		});
		await addServer({ preset: "yolo" });
		const ctx = await context({ name: "fake", description: "A fake server", enabled: true, available: true });
		expect((await runExtensionTool(ctx, "fake", "echo", { message: "hi" })).isError).toBe(false);
		expect(mcp.status("fake").connected).toBe(true);
		await waitFor(async () => (mcp.status("fake").connected ? undefined : true));
		// The scheduled refresh connects, lists, and closes again.
		const refreshed = mcp.status("fake").refreshedAt;
		const requests = state.requests;
		await waitFor(async () => (mcp.status("fake").refreshedAt !== refreshed ? true : undefined));
		expect(state.requests).toBeGreaterThan(requests);
		await waitFor(async () => (mcp.status("fake").connected ? undefined : true));
	});

	it("takes an empty instructions text as none and closes the connection a scheduled refresh opened", async () => {
		await mcp.close();
		mcp = new McpConnections({
			db,
			masterKey,
			fetch: fakeFetch(state, fakeMcp(state)),
			// Long enough that only the refresh itself could close the connection within the test.
			idleDisconnectMs: 60_000,
			refreshIntervalMs: 200,
			random: () => 0,
		});
		state.instructions = "   ";
		state.serverDescription = "A fake server for tests";
		await addServer();
		await mcp.start();
		await waitFor(async () => (mcp.status("fake").refreshedAt !== null ? true : undefined));
		await waitFor(async () => (mcp.status("fake").connected ? undefined : true));
		expect(mcp.instructions("fake")).toBeNull();
		const ctx = await context({ name: "fake", description: null, enabled: true, available: true });
		await saveExtension(db, masterKey, "fake", { description: null }, user.userId);
		const fresh = await context({ name: "fake", description: null, enabled: true, available: true });
		expect(fresh.extensions?.find((entry) => entry.extension.name === "fake")?.extension.description).toBe(
			"A fake server for tests",
		);
		expect(ctx).toBeDefined();
	});

	it("refuses a call built for an input schema the server no longer has, with the new schema", async () => {
		await mcp.close();
		mcp = new McpConnections({ db, masterKey, fetch: fakeFetch(state, fakeMcp(state)), idleDisconnectMs: 20 });
		await addServer({ preset: "yolo" });
		await mcp.prepareCall("fake");
		await waitFor(async () => (mcp.status("fake").connected ? undefined : true));
		state.echoTakesCount = true;
		const ctx = await context({ name: "fake", description: "A fake server", enabled: true, available: true });
		const result = await runExtensionTool(ctx, "fake", "echo", { message: "hi" });
		expect(result.isError).toBe(true);
		const text = result.content.map((block) => block.text).join("\n");
		expect(text).toContain("changed since the call was made");
		expect(text).toContain('"count"');
		expect(state.calls).toEqual([]);
		// The model calls again with the schema it was given, and the call runs.
		const retry = await runExtensionTool({ ...ctx, callKey: "retry" }, "fake", "echo", { message: "hi", count: 1 });
		expect(retry.isError).toBe(false);
	});

	it("judges a call on the server's current annotations: a tool that became a write needs approval", async () => {
		await mcp.close();
		mcp = new McpConnections({ db, masterKey, fetch: fakeFetch(state, fakeMcp(state)), idleDisconnectMs: 20 });
		await addServer({ preset: "ask" });
		await mcp.prepareCall("fake");
		await waitFor(async () => (mcp.status("fake").connected ? undefined : true));
		const before = mcp.tool("fake", "echo")?.rev;
		state.echoWrites = true;
		const ctx = await context({ name: "fake", description: "A fake server", enabled: true, available: true });
		const controller = new AbortController();
		const pending = runExtensionTool({ ...ctx, callKey: "now-a-write", signal: controller.signal }, "fake", "echo", {
			message: "hi",
		});
		const row = await waitFor(async () => {
			const found = await getExternalCall(db, externalCallId("now-a-write"));
			return found?.state === "awaiting_approval" ? found : undefined;
		});
		expect(JSON.parse(row.operation)).toMatchObject({ method: "ext.write" });
		expect(row.tool_rev).toBe(mcp.tool("fake", "echo")?.rev);
		expect(row.tool_rev).not.toBe(before);
		controller.abort();
		await pending;
	});

	it("ends an approved call whose tool changed while it waited, without calling it", async () => {
		await mcp.close();
		mcp = new McpConnections({ db, masterKey, fetch: fakeFetch(state, fakeMcp(state)), idleDisconnectMs: 20 });
		await addServer({ preset: "ask" });
		const ctx = await context({ name: "fake", description: "A fake server", enabled: true, available: true });
		const pending = runExtensionTool({ ...ctx, callKey: "changes-while-waiting" }, "fake", "write_thing", {
			value: 1,
		});
		const id = externalCallId("changes-while-waiting");
		await waitFor(async () => ((await getExternalCall(db, id))?.state === "awaiting_approval" ? true : undefined));
		await waitFor(async () => (mcp.status("fake").connected ? undefined : true));
		// The call was judged at write_thing's rev then; the server lists it at another rev now.
		expect((await getExternalCall(db, id))?.tool_rev).toBe(mcp.tool("fake", "write_thing")?.rev);
		await db.updateTable("external_calls").set({ tool_rev: 99 }).where("id", "=", id).execute();
		await decideExternalCall(db, id, {
			decision: "approved",
			by: { type: "user", id: user.userId },
			at: new Date().toISOString(),
		});
		const result = await pending;
		expect(result.isError).toBe(true);
		expect(result.content.map((block) => block.text).join("\n")).toContain("changed since the call was made");
		expect(state.calls).toEqual([]);
		expect((await getExternalCall(db, id))?.state).toBe("failed");
	});

	it("searches the last known list with a stale note while unavailable, and call_tool fails at once", async () => {
		await addServer();
		await mcp.prepareCall("fake");
		state.failConnections = true;
		await mcp.reconnect("fake");
		expect(mcp.status("fake").state).toBe("unavailable");
		const found = await search("echo");
		expect(found.stale).toBe(true);
		expect((found.results as unknown[]).length).toBe(1);
		const ctx = await context({ name: "fake", description: "A fake server", enabled: true, available: false });
		const result = await runExtensionTool(ctx, "fake", "echo", { message: "x" });
		expect(result.isError).toBe(true);
		expect(result.content.map((block) => block.text).join("\n")).toContain("unavailable");
	});

	it("ends a call whose connection or timeout is lost as unknown and never repeats it", async () => {
		await addServer({ preset: "yolo" });
		state.hangTools = true;
		const result = await mcp.callTool("fake", "slow_thing", {}, { timeoutMs: 30 }).then(
			() => undefined,
			(error: unknown) => error,
		);
		expect(result).toBeInstanceOf(ExtensionCallLostError);
		// A row that was in flight when the process stopped is recovered as unknown.
		const call = await createExternalCall(db, {
			callKey: "in-flight",
			orgId: await defaultOrgId(db),
			actorType: "session",
			actorId: sessionId,
			onBehalfOfUserId: user.userId,
			extension: "fake",
			tool: "write_thing",
			arguments: {},
			operation: { method: "ext.write", target: "fake/write_thing" },
			annotations: null,
			ruleChain: [{ type: "session", id: sessionId }],
			rootSessionId: sessionId,
			approval: { evaluation: { result: "allow", levels: [] } },
			state: "running",
		});
		expect(await recoverExternalCalls(db)).toBeGreaterThan(0);
		expect((await getExternalCall(db, call.row.id))?.state).toBe("unknown");
		const callsBefore = state.calls.length;
		const ctx = await context({ name: "fake", description: "A fake server", enabled: true, available: true });
		const replay = await runExtensionTool({ ...ctx, callKey: "in-flight" }, "fake", "write_thing", { value: 1 });
		expect(replay.isError).toBe(true);
		expect(replay.content.map((block) => block.text).join("\n")).toContain("unknown");
		expect(state.calls.length).toBe(callsBefore);

		// A request that drops after the connection is up has an unknown outcome too, and its client is closed.
		state.hangTools = false;
		await mcp.reconnect("fake");
		const closeSpy = vi.spyOn(Client.prototype, "close");
		try {
			state.failCalls = true;
			const lost = await mcp.callTool("fake", "echo", { message: "x" }).then(
				() => undefined,
				(error: unknown) => error,
			);
			expect(lost).toBeInstanceOf(ExtensionCallLostError);
			expect(closeSpy).toHaveBeenCalled();
			expect(mcp.status("fake").state).toBe("unavailable");
		} finally {
			closeSpy.mockRestore();
		}
	});

	it("finishes a replayed waiting call when the extension is unavailable", async () => {
		await addServer();
		const waiting = await waitingCall("orphan-unavailable", "echo");
		state.failConnections = true;
		const ctx = await context({ name: "fake", description: "A fake server", enabled: true, available: true });
		const result = await runExtensionTool({ ...ctx, callKey: "orphan-unavailable" }, "fake", "echo", {
			message: "hi",
		});
		expect(result.isError).toBe(true);
		expect(result.content.map((block) => block.text).join("\n")).toContain("unavailable");
		// The row is terminal and cleared like any finished call, so it leaves the approvals page.
		expect(await getExternalCall(db, waiting.id)).toMatchObject({
			state: "failed",
			arguments: null,
			handler_type: null,
			handler_session_id: null,
		});
		expect((await getExternalCall(db, waiting.id))?.finished_at).not.toBeNull();
	});

	it("finishes a replayed waiting call when the tool is gone", async () => {
		await addServer();
		const waiting = await waitingCall("orphan-tool", "gone_tool");
		const ctx = await context({ name: "fake", description: "A fake server", enabled: true, available: true });
		const result = await runExtensionTool({ ...ctx, callKey: "orphan-tool" }, "fake", "gone_tool", {});
		expect(result.isError).toBe(true);
		expect(result.content.map((block) => block.text).join("\n")).toContain("has no tool named gone_tool");
		expect(await getExternalCall(db, waiting.id)).toMatchObject({ state: "failed", arguments: null });
	});

	it("rejects a replayed waiting call that the rules now deny", async () => {
		await addServer({ preset: "ask" });
		const waiting = await waitingCall("orphan-deny", "echo");
		const ctx = {
			...(await context({ name: "fake", description: "A fake server", enabled: true, available: true })),
			chain: [{ type: "session" as const, id: "deleted-rule-set" }],
		};
		const result = await runExtensionTool({ ...ctx, callKey: "orphan-deny" }, "fake", "echo", { message: "hi" });
		expect(result.isError).toBe(true);
		expect(result.content.map((block) => block.text).join("\n")).toContain("denied by the authorization rules");
		expect(await getExternalCall(db, waiting.id)).toMatchObject({ state: "rejected", arguments: null });
	});

	it("finishes a replayed waiting call whose extension left the session", async () => {
		await addServer();
		const waiting = await waitingCall("orphan-disabled", "echo");
		const ctx = await context({ name: "fake", description: "A fake server", enabled: false, available: false });
		await expect(
			runExtensionTool({ ...ctx, callKey: "orphan-disabled" }, "fake", "echo", { message: "hi" }),
		).rejects.toThrow(/turned off/);
		expect(await getExternalCall(db, waiting.id)).toMatchObject({ state: "failed", arguments: null });
	});

	it("finishes a call when the extension throws unexpectedly", async () => {
		await addServer({ preset: "yolo" });
		const ctx = {
			...(await context({ name: "fake", description: "A fake server", enabled: true, available: true })),
			extensions: [
				failingExtension(async () => {
					throw new Error("boom");
				}),
			],
		};
		await expect(
			runExtensionTool({ ...ctx, callKey: "orphan-throw" }, "fake", "echo", { message: "hi" }),
		).rejects.toThrow("boom");
		expect(await getExternalCall(db, externalCallId("orphan-throw"))).toMatchObject({
			state: "unknown",
			arguments: null,
		});
	});

	it("does not let a failed finish hide an unexpected extension error", async () => {
		await addServer({ preset: "yolo" });
		const ctx = {
			...(await context({ name: "fake", description: "A fake server", enabled: true, available: true })),
			extensions: [
				failingExtension(async () => {
					throw new Error("boom");
				}),
			],
		};
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			await expect(
				runExtensionTool({ ...ctx, db: finishFailingDb(db), callKey: "finish-db-fail" }, "fake", "echo", {
					message: "hi",
				}),
			).rejects.toThrow("boom");
			expect(spy).toHaveBeenCalledWith("extensions: finishing an extension call failed:", expect.any(Error));
		} finally {
			spy.mockRestore();
		}
		expect(await getExternalCall(db, externalCallId("finish-db-fail"))).toMatchObject({ state: "running" });
	});

	it("does not let a failed orphan finish hide the original error", async () => {
		await addServer();
		const waiting = await waitingCall("finish-orphan-db-fail", "echo");
		const ctx = await context({ name: "fake", description: "A fake server", enabled: false, available: false });
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			await expect(
				runExtensionTool({ ...ctx, db: finishFailingDb(db), callKey: "finish-orphan-db-fail" }, "fake", "echo", {
					message: "hi",
				}),
			).rejects.toThrow(/turned off/);
			expect(spy).toHaveBeenCalledWith("tools: finishing an orphaned extension call failed:", expect.any(Error));
		} finally {
			spy.mockRestore();
		}
		expect(await getExternalCall(db, waiting.id)).toMatchObject({ state: "awaiting_approval" });
	});

	it("finishes a call when its result cannot be converted", async () => {
		await addServer({ preset: "yolo" });
		const ctx = {
			...(await context({ name: "fake", description: "A fake server", enabled: true, available: true })),
			extensions: [failingExtension(async () => null)],
		};
		await expect(
			runExtensionTool({ ...ctx, callKey: "orphan-convert" }, "fake", "echo", { message: "hi" }),
		).rejects.toThrow();
		expect(await getExternalCall(db, externalCallId("orphan-convert"))).toMatchObject({
			state: "unknown",
			arguments: null,
		});
	});

	it("does not overwrite a call recovered as unknown", async () => {
		const call = await createExternalCall(db, {
			callKey: "recovered",
			orgId: await defaultOrgId(db),
			actorType: "session",
			actorId: sessionId,
			onBehalfOfUserId: user.userId,
			extension: "fake",
			tool: "write_thing",
			arguments: {},
			operation: { method: "ext.write", target: "fake/write_thing" },
			annotations: null,
			ruleChain: [{ type: "session", id: sessionId }],
			rootSessionId: sessionId,
			approval: { evaluation: { result: "allow", levels: [] } },
			state: "running",
		});
		await recoverExternalCalls(db);
		await finishExternalCall(db, call.row.id, { state: "succeeded" });
		expect((await getExternalCall(db, call.row.id))?.state).toBe("unknown");
	});

	it("applies grants and the session's own on/off choice", async () => {
		await addServer();
		const orgId = await defaultOrgId(db);
		const [group] = await db
			.insertInto("user_groups")
			.values({ id: newId(), org_id: orgId, name: "team", source: "local", created_at: new Date().toISOString() })
			.returningAll()
			.execute();
		await db
			.insertInto("user_group_members")
			.values({ user_group_id: group?.id ?? "", user_id: user.userId, created_at: new Date().toISOString() })
			.execute();
		// The direct grant already covers the user; drop it to prove the group grant is what reaches them.
		await db.deleteFrom("extension_grants").execute();
		expect((await extensionsForUser(db, user.userId)).map((row) => row.name)).toEqual(["crhs-api", "crhs-docs"]);
		const row = await db.selectFrom("extensions").selectAll().where("name", "=", "fake").executeTakeFirst();
		await db
			.insertInto("extension_grants")
			.values({
				id: newId(),
				org_id: orgId,
				extension_id: row?.id ?? "",
				grantee_type: "user_group",
				grantee_id: group?.id ?? "",
				created_by_user_id: user.userId,
				created_at: new Date().toISOString(),
			})
			.execute();
		expect(await extensionNamesForUser(db, user.userId)).toEqual(["crhs-api", "crhs-docs", "fake"]);
		expect(await extensionNamesForUser(db, user.userId, ["fake"])).toEqual(["crhs-api", "crhs-docs"]);
		expect(parseDisabledExtensionNames('["fake"]')).toEqual(["fake"]);
	});

	it("describes the session's extensions for the tool guide", async () => {
		await addServer();
		const extensions = await sessionExtensionViews({ db, mcp } as AgentRuntimeOptions, user.userId, []);
		expect(extensions).toEqual([
			{
				name: "crhs-api",
				kind: "builtin",
				description: "The crhs API as the session owner, through the same routes and rules as the WebUI",
				enabled: true,
				available: true,
				listDirectly: true,
			},
			{
				name: "crhs-docs",
				kind: "builtin",
				description: "The documentation and the API reference of this crhs version",
				enabled: true,
				available: true,
				listDirectly: true,
			},
			{
				name: "fake",
				kind: "mcp",
				description: "A fake server",
				enabled: true,
				available: true,
				listDirectly: false,
			},
		]);
	});

	it("feeds a waiting call after a decision through the same wait path", async () => {
		await addServer();
		const call = await createExternalCall(db, {
			callKey: "waiting",
			orgId: await defaultOrgId(db),
			actorType: "session",
			actorId: sessionId,
			onBehalfOfUserId: user.userId,
			extension: "fake",
			tool: "write_thing",
			arguments: {},
			operation: { method: "ext.write", target: "fake/write_thing" },
			annotations: null,
			ruleChain: [{ type: "session", id: sessionId }],
			rootSessionId: sessionId,
			approval: { evaluation: { result: "require-approval", levels: [] } },
			state: "awaiting_approval",
		});
		// Fake timers never fire the old 200 ms poll: only the decision's wake can resolve the wait.
		vi.useFakeTimers();
		try {
			const waiting = waitExternalCall(db, call.row.id);
			await decideExternalCall(db, call.row.id, {
				decision: "approved",
				by: { type: "user", id: user.userId },
				at: new Date().toISOString(),
			});
			expect((await waiting).state).toBe("running");
		} finally {
			vi.useRealTimers();
		}
	});

	it("wakes a waiting call on cancellation and on abort", async () => {
		await addServer();
		const waitingCall = async (callKey: string) =>
			(
				await createExternalCall(db, {
					callKey,
					orgId: await defaultOrgId(db),
					actorType: "session",
					actorId: sessionId,
					onBehalfOfUserId: user.userId,
					extension: "fake",
					tool: "write_thing",
					arguments: {},
					operation: { method: "ext.write", target: "fake/write_thing" },
					annotations: null,
					ruleChain: [{ type: "session", id: sessionId }],
					rootSessionId: sessionId,
					approval: { evaluation: { result: "require-approval", levels: [] } },
					state: "awaiting_approval",
				})
			).row;
		vi.useFakeTimers();
		try {
			const cancelled = await waitingCall("wake-cancel");
			const cancelledWait = waitExternalCall(db, cancelled.id);
			expect(await cancelWaitingExternalCall(db, cancelled.id)).toBe(true);
			expect((await cancelledWait).state).toBe("cancelled");

			const aborted = await waitingCall("wake-abort");
			const controller = new AbortController();
			const abortedWait = waitExternalCall(db, aborted.id, { signal: controller.signal });
			controller.abort();
			expect((await abortedWait).state).toBe("cancelled");
		} finally {
			vi.useRealTimers();
		}
	});

	it("routes a waiting call to an ancestor agent's session and back to the owner", async () => {
		await addServer();
		const { row: call } = await createExternalCall(db, {
			callKey: "routed",
			orgId: await defaultOrgId(db),
			actorType: "subagent",
			actorId: sessionId,
			onBehalfOfUserId: user.userId,
			extension: "fake",
			tool: "write_thing",
			arguments: { value: 1 },
			operation: { method: "ext.write", target: "fake/write_thing" },
			annotations: null,
			ruleChain: [{ type: "session", id: sessionId }],
			rootSessionId: sessionId,
			approval: { evaluation: { result: "require-approval", levels: [] } },
			state: "awaiting_approval",
		});
		expect(await requestAgentDecision(db, call.id, "agent-1")).toBe(true);
		let row = await getExternalCall(db, call.id);
		expect(row).toMatchObject({ handler_type: "agent", handler_session_id: "agent-1" });
		expect(externalCallApproval(row ?? call)).toMatchObject({ agent: { session: "agent-1", state: "pending" } });

		// Another agent's decision or escalation does not apply to this request.
		const decision = {
			decision: "approved" as const,
			by: { type: "session" as const, id: "agent-2" },
			at: new Date().toISOString(),
		};
		expect(
			await decideExternalCall(db, call.id, decision, null, { handlerType: "agent", handlerSessionId: "agent-2" }),
		).toBe(false);
		expect(await escalateAgentDecision(db, call.id, "agent-2")).toBe(false);

		expect(await escalateAgentDecision(db, call.id, "agent-1")).toBe(true);
		row = await getExternalCall(db, call.id);
		expect(row).toMatchObject({ handler_type: "user", handler_session_id: null });
		expect(externalCallApproval(row ?? call)?.agent).toEqual({ session: "agent-1", state: "escalated" });
		// Replay must not route the escalated call back to the same agent.
		expect(await requestAgentDecision(db, call.id, "agent-1")).toBe(false);
		expect(await getExternalCall(db, call.id)).toMatchObject({ handler_type: "user" });
	});

	it("lets the routed agent approve or reject the call it was given", async () => {
		await addServer();
		const call = await createExternalCall(db, {
			callKey: "agent-decides",
			orgId: await defaultOrgId(db),
			actorType: "subagent",
			actorId: sessionId,
			onBehalfOfUserId: user.userId,
			extension: "fake",
			tool: "write_thing",
			arguments: {},
			operation: { method: "ext.write", target: "fake/write_thing" },
			annotations: null,
			ruleChain: [{ type: "session", id: sessionId }],
			rootSessionId: sessionId,
			approval: { evaluation: { result: "require-approval", levels: [] } },
			state: "awaiting_approval",
		});
		expect(await requestAgentDecision(db, call.row.id, "agent-1")).toBe(true);
		const approved = await decideExternalCall(
			db,
			call.row.id,
			{
				decision: "approved",
				by: { type: "session", id: "agent-1" },
				at: new Date().toISOString(),
			},
			null,
			{ handlerType: "agent", handlerSessionId: "agent-1" },
		);
		expect(approved).toBe(true);
		expect((await getExternalCall(db, call.row.id))?.state).toBe("running");
		// A second decision finds no waiting row.
		expect(
			await decideExternalCall(db, call.row.id, {
				decision: "rejected",
				by: { type: "session", id: "agent-1" },
				at: new Date().toISOString(),
			}),
		).toBe(false);
	});

	it("wakes a waiting call when changed rules settle it", async () => {
		await addServer({ preset: "yolo" });
		const call = await createExternalCall(db, {
			callKey: "rule-change",
			orgId: await defaultOrgId(db),
			actorType: "session",
			actorId: sessionId,
			onBehalfOfUserId: user.userId,
			extension: "fake",
			tool: "write_thing",
			arguments: {},
			operation: { method: "ext.write", target: "fake/write_thing" },
			annotations: null,
			ruleChain: [{ type: "session", id: sessionId }],
			rootSessionId: sessionId,
			approval: { evaluation: { result: "require-approval", levels: [] } },
			state: "awaiting_approval",
		});
		vi.useFakeTimers();
		try {
			const waiting = waitExternalCall(db, call.row.id);
			await reevaluateExternalCalls(db, { type: "session", id: sessionId });
			expect((await waiting).state).toBe("running");
		} finally {
			vi.useRealTimers();
		}
	});

	it("converts structured content, resource links and audio", async () => {
		const result = await convertExternalResult(
			{
				content: [
					{ type: "resource_link", uri: "file:///a.txt", name: "a" },
					{ type: "audio", data: Buffer.from("abc").toString("base64"), mimeType: "audio/wav" },
					{ type: "resource", resource: { uri: "file:///b.bin", mimeType: "application/octet-stream", blob: "AAAA" } },
				],
				structuredContent: { ok: 1 },
			},
			{ extension: "fake", tool: "mixed" },
		);
		const text = result.content.map((block) => block.text).join("\n");
		expect(text).toContain("file:///a.txt");
		expect(text).toContain("audio/wav");
		expect(text).toContain("application/octet-stream");
		expect(text).toContain("fake/mixed");
	});
});

describe("tool revs", () => {
	const tool = (name: string, description: string | null = null): ExtensionTool => ({
		name,
		title: null,
		description,
		inputSchema: { type: "object", properties: { a: { type: "string" } } },
		annotations: { readOnlyHint: true },
	});

	it("keeps the rev of an unchanged listing and gives added and changed tools the next one", () => {
		const first = revisedTools([], 0, [tool("a"), tool("b")]);
		expect(first.toolsRev).toBe(1);
		expect(first.tools.map((entry) => entry.rev)).toEqual([1, 1]);
		// The same definitions in another key order are the same tools.
		const same = revisedTools(first.tools, first.toolsRev, [
			{ ...tool("b"), inputSchema: { properties: { a: { type: "string" } }, type: "object" } },
			tool("a"),
		]);
		expect(same.toolsRev).toBe(1);
		expect(same.tools.map((entry) => entry.rev)).toEqual([1, 1]);
		const changed = revisedTools(same.tools, same.toolsRev, [tool("a", "now described"), tool("b"), tool("c")]);
		expect(changed.toolsRev).toBe(2);
		expect(changed.tools.map((entry) => [entry.name, entry.rev])).toEqual([
			["a", 2],
			["b", 1],
			["c", 2],
		]);
		// A removal alone moves the list's rev; the remaining tools keep theirs.
		const removed = revisedTools(changed.tools, changed.toolsRev, [tool("b")]);
		expect(removed.toolsRev).toBe(3);
		expect(removed.tools.map((entry) => entry.rev)).toEqual([1]);
	});
});
