import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpSessionServer, RulePreset } from "@crh/api";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as z from "zod/v4";
import { mcpServerExtension, mcpSessionServers } from "../src/agent/extension.ts";
import type { AgentRuntimeOptions } from "../src/agent/runtime.ts";
import { Audit } from "../src/audit/audit.ts";
import type { SessionUser } from "../src/auth/sessions.ts";
import { McpCallLostError, McpConnections, type McpTool, McpUnavailableError } from "../src/extensions/connections.ts";
import {
	cancelWaitingExternalCall,
	createExternalCall,
	decideExternalCall,
	escalateAgentDecision,
	externalCallApproval,
	externalCallId,
	externalCallViews,
	getExternalCall,
	recoverExternalCalls,
	reevaluateExternalCalls,
	requestAgentDecision,
	waitExternalCall,
} from "../src/extensions/external-calls.ts";
import {
	deleteMcpServer,
	mcpServerNamesForUser,
	mcpServersForUser,
	parseDisabledServers,
	saveMcpServer,
} from "../src/extensions/servers.ts";
import { MasterKey } from "../src/keys/master-key.ts";
import { ImageCache } from "../src/library/image-cache.ts";
import { createRootRuleSet } from "../src/policy/store.ts";
import type { Db } from "../src/storage/db.ts";
import { defaultOrgId } from "../src/storage/org.ts";
import type { ToolContext } from "../src/tools/catalog.ts";
import { runExternalTool, TOOLS } from "../src/tools/catalog.ts";
import { convertExternalResult } from "../src/tools/external-results.ts";
import { createUser } from "../src/users/service.ts";
import { newId } from "../src/util/id.ts";
import { openTestDb } from "./helpers/db.ts";

/** What the fake server records and can be told to do. */
interface FakeState {
	calls: { tool: string; arguments: Record<string, unknown> }[];
	failConnections: boolean;
	hangTools: boolean;
	hangConnections: boolean;
	/** Fetches that reached the fake endpoint, one per connection attempt plus its requests. */
	requests: number;
}

const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	"base64",
);

/** An in-process Streamable HTTP MCP server; `handler.fetch` is the network. */
function fakeMcp(state: FakeState) {
	return createMcpHandler(() => {
		const server = new McpServer({ name: "fake", version: "1.0.0" });
		server.registerTool(
			"echo",
			{
				description: "Echo the message back",
				inputSchema: z.object({ message: z.string() }),
				annotations: { readOnlyHint: true },
			},
			async ({ message }) => {
				state.calls.push({ tool: "echo", arguments: { message } });
				return { content: [{ type: "text", text: `echo: ${message}` }] };
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
		return server;
	});
}

function fakeFetch(state: FakeState, handler: ReturnType<typeof fakeMcp>) {
	return async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
		const url = input instanceof Request ? input.url : String(input);
		if (!url.startsWith("http://mcp.test")) return fetch(input, init);
		state.requests += 1;
		if (state.failConnections) throw new Error("connection refused");
		// A server that accepts the request but never answers: only the connect timeout ends the attempt.
		if (state.hangConnections) return await new Promise<Response>(() => {});
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
				disabled_mcp_servers: null,
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
		state = { calls: [], failConnections: false, hangTools: false, hangConnections: false, requests: 0 };
		mcp = new McpConnections({ db, masterKey, fetch: fakeFetch(state, fakeMcp(state)), backoffBaseMs: 1000 });
		imageDir = await mkdtemp(join(tmpdir(), "crh-ext-"));
	});

	afterEach(async () => {
		await mcp.close();
		await db.destroy();
		await rm(imageDir, { recursive: true, force: true });
	});

	async function addServer(
		overrides: { preset?: RulePreset; trustAnnotations?: boolean; listDirectly?: boolean; grants?: boolean } = {},
	) {
		const { row } = await saveMcpServer(
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
		const row = await db.selectFrom("mcp_servers").selectAll().where("name", "=", server.name).executeTakeFirst();
		const session: McpSessionServer = {
			name: server.name,
			description: server.description,
			enabled: server.enabled,
			available: server.available,
			trustAnnotations: row?.trust_annotations === 1,
			listDirectly: row?.list_directly === 1,
			timeoutMs: row?.timeout_ms ?? 300_000,
		};
		return {
			db,
			cluster: {} as never,
			taskGroups: {} as never,
			user,
			actor: { type: "session", id: sessionId, onBehalfOfUserId: user.userId },
			chain: [{ type: "session", id: sessionId }],
			approvalUrl: () => "",
			rootSessionId: sessionId,
			mcp,
			mcpServers: [session],
			audit,
		};
	}

	async function search(query: string, server = "fake") {
		const tool = TOOLS.find((entry) => entry.name === "search_tools");
		if (!tool) throw new Error("no search_tools");
		const ctx = await context({ name: server, description: "A fake server", enabled: true, available: true });
		const result = await tool.handler({ query } as never, ctx);
		return JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>;
	}

	it("validates server names, encrypts headers and requires re-entering them on a URL change", async () => {
		await expect(saveMcpServer(db, masterKey, "Bad Name", { url: "http://mcp.test/mcp" }, user.userId)).rejects.toThrow(
			/lowercase/,
		);
		await saveMcpServer(
			db,
			masterKey,
			"fake",
			{ url: "http://mcp.test/mcp", headers: [{ name: "Authorization", value: "Bearer top-secret" }] },
			user.userId,
		);
		const secret = await db.selectFrom("secrets").select(["ciphertext"]).executeTakeFirst();
		expect(secret?.ciphertext).not.toContain("top-secret");
		await expect(saveMcpServer(db, masterKey, "fake", { url: "http://other.test/mcp" }, user.userId)).rejects.toThrow(
			/re-entering the headers/,
		);
		await saveMcpServer(db, masterKey, "fake", { url: "http://other.test/mcp", headers: null }, user.userId);
		await deleteMcpServer(db, "fake");
		expect(await db.selectFrom("secrets").select("id").execute()).toHaveLength(0);
	});

	it("searches the last tool list and calls a trusted read without approval", async () => {
		await addServer();
		const found = await search("echo");
		const results = found.results as { tool: string; input_schema: unknown }[];
		expect(results.map((entry) => entry.tool)).toEqual(["echo"]);
		expect(results[0]?.input_schema).toMatchObject({ type: "object" });
		const ctx = await context({ name: "fake", description: "A fake server", enabled: true, available: true });
		const result = await runExternalTool(ctx, "fake", "echo", { message: "hi" });
		expect(result.isError).toBe(false);
		expect(result.content.map((block) => block.text).join("\n")).toContain("echo: hi");
		const row = await db.selectFrom("external_calls").selectAll().executeTakeFirst();
		expect(row?.state).toBe("succeeded");
		expect(state.calls).toEqual([{ tool: "echo", arguments: { message: "hi" } }]);
	});

	it("keeps only the marker of a finished call and never calls the server again", async () => {
		await addServer();
		const ctx = await context({ name: "fake", description: "A fake server", enabled: true, available: true });
		const id = externalCallId("finished");
		const first = await runExternalTool({ ...ctx, callKey: "finished" }, "fake", "echo", { message: "hi" });
		expect(first.isError).toBe(false);
		expect(first.content.map((block) => block.text).join("\n")).toContain("echo: hi");
		expect(first.details?.approval_url).toBeUndefined();
		// The terminal row is the "already ran" marker: state and finished_at only, no arguments or result.
		const finished = await getExternalCall(db, id);
		expect(finished).toMatchObject({ state: "succeeded", arguments: null });
		expect(finished?.finished_at).not.toBeNull();

		const callsBefore = state.calls.length;
		const replay = await runExternalTool({ ...ctx, callKey: "finished" }, "fake", "echo", { message: "hi" });
		const text = replay.content.map((block) => block.text).join("\n");
		expect(text).toContain("finished before a restart");
		expect(text).toContain("could not be kept");
		expect(replay.details).toEqual({ server: "fake", tool: "echo" });
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
		const pending = runExternalTool(ctx, "fake", "write_thing", { value: 3 });
		const waiting = await waitFor(async () => {
			const rows = await db.selectFrom("external_calls").selectAll().execute();
			return rows.find((row) => row.state === "awaiting_approval");
		});
		const view = (await externalCallViews(db, [waiting]))[0];
		expect(view?.server).toBe("fake");
		expect(view?.operation).toEqual({ method: "mcp.write", target: "fake/write_thing" });
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

	it("returns a rejected call's reason without an approval link", async () => {
		await addServer({ preset: "ask" });
		const ctx = await context({ name: "fake", description: "A fake server", enabled: true, available: true });
		const pending = runExternalTool(ctx, "fake", "write_thing", { value: 4 });
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
		const pending = runExternalTool(ctx, "fake", "echo", { message: "x" });
		const waiting = await waitFor(async () => {
			const rows = await db.selectFrom("external_calls").selectAll().execute();
			return rows.find((row) => row.state === "awaiting_approval");
		});
		expect(JSON.parse(waiting.operation)).toEqual({ method: "mcp.write", target: "fake/echo" });
		await cancelWaitingExternalCall(db, waiting.id);
		const result = await pending;
		expect(result.isError).toBe(true);
	});

	it("converts images into the image cache", async () => {
		const cache = new ImageCache(db, imageDir, () => ({ diskBytes: 1_048_576, ttlMs: 60_000 }));
		await addServer();
		const ctx = await context({ name: "fake", description: "A fake server", enabled: true, available: true });
		const result = await runExternalTool({ ...ctx, imageCache: cache }, "fake", "show_picture", {});
		const images = (result.details as { images?: { sha256: string }[] } | undefined)?.images ?? [];
		expect(images).toHaveLength(1);
		expect(await cache.get(images[0]?.sha256 ?? "")).toBeDefined();
	});

	it("reports an isError result as a failed tool result with text", async () => {
		await addServer({ preset: "yolo" });
		const ctx = await context({ name: "fake", description: "A fake server", enabled: true, available: true });
		const result = await runExternalTool(ctx, "fake", "fail_thing", {});
		expect(result.isError).toBe(true);
		expect(result.content.map((block) => block.text).join("\n")).toContain("it failed");
	});

	it("lists tools directly only when asked, skipping names that do not fit", async () => {
		const options = { db } as AgentRuntimeOptions;
		const tools: McpTool[] = [
			{ name: "echo", title: null, description: null, inputSchema: { type: "object" }, annotations: null },
			{
				name: `x${"y".repeat(64)}`,
				title: null,
				description: null,
				inputSchema: { type: "object" },
				annotations: null,
			},
		];
		const extension = mcpServerExtension(options, {}, "fake", tools);
		expect(extension.name).toBe("mcp:fake");
		expect(extension.tools?.map((tool) => tool.name)).toEqual(["mcp__fake__echo"]);
	});

	it("backs off exponentially and lets an administrator reconnect at once", async () => {
		vi.useFakeTimers();
		try {
			await addServer();
			state.failConnections = true;
			await expect(mcp.ensureConnected("fake")).rejects.toThrow();
			const unavailable = mcp.status("fake");
			expect(unavailable.state).toBe("unavailable");
			expect(unavailable.nextAttemptAt).not.toBeNull();
			state.failConnections = false;
			// The administrator's reconnect always tries at once and resets the backoff.
			expect((await mcp.reconnect("fake")).state).toBe("ready");
			expect(mcp.status("fake").nextAttemptAt).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});

	it("fails a call at once after a failed attempt in the last 10 s and tries again after the window", async () => {
		vi.useFakeTimers();
		try {
			await addServer();
			state.failConnections = true;
			await expect(mcp.ensureConnected("fake", { immediate: true })).rejects.toThrow();
			const attempts = state.requests;
			// A second call within the window does not touch the server.
			await expect(mcp.ensureConnected("fake", { immediate: true })).rejects.toThrow(/connection refused/);
			expect(state.requests).toBe(attempts);
			// Once the window has passed, the call attempts the connection again.
			vi.setSystemTime(Date.now() + 10_001);
			await expect(mcp.ensureConnected("fake", { immediate: true })).rejects.toThrow();
			expect(state.requests).toBeGreaterThan(attempts);
		} finally {
			vi.useRealTimers();
		}
	});

	it("continues the backoff schedule after a failed call attempt instead of restarting it", async () => {
		vi.useFakeTimers();
		try {
			await addServer();
			state.failConnections = true;
			await expect(mcp.ensureConnected("fake")).rejects.toThrow();
			const scheduled = mcp.status("fake").nextAttemptAt;
			expect(scheduled).not.toBeNull();
			vi.setSystemTime(Date.now() + 10_001);
			await expect(mcp.ensureConnected("fake", { immediate: true })).rejects.toThrow();
			// The retry that was already scheduled stays; it is not rescheduled from scratch.
			expect(mcp.status("fake").nextAttemptAt).toBe(scheduled);
		} finally {
			vi.useRealTimers();
		}
	});

	it("bounds an on-demand connection at the connect timeout", async () => {
		vi.useFakeTimers();
		try {
			await addServer();
			state.hangConnections = true;
			const outcome = mcp.ensureConnected("fake", { immediate: true }).then(
				() => undefined,
				(error: unknown) => error,
			);
			await vi.advanceTimersByTimeAsync(9_999);
			await vi.advanceTimersByTimeAsync(1);
			const error = await outcome;
			expect(error).toBeInstanceOf(McpUnavailableError);
			expect((error as Error).message).toContain("timed out");
			expect(mcp.status("fake").state).toBe("unavailable");
			expect(mcp.status("fake").nextAttemptAt).not.toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});

	it("shares one connection attempt between concurrent calls", async () => {
		vi.useFakeTimers();
		try {
			await addServer();
			state.hangConnections = true;
			const both = Promise.allSettled([
				mcp.ensureConnected("fake", { immediate: true }),
				mcp.ensureConnected("fake", { immediate: true }),
			]);
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
		await mcp.ensureConnected("fake");
		const cached = mcp.tools("fake").length;
		expect(cached).toBeGreaterThan(0);
		await mcp.invalidate("fake", { keepTools: true });
		expect(mcp.status("fake").state).toBe("unknown");
		expect(mcp.tools("fake")).toHaveLength(cached);
		await mcp.invalidate("fake");
		expect(mcp.tools("fake")).toHaveLength(0);
	});

	it("searches the last known list with a stale note while unavailable, and call_tool fails at once", async () => {
		await addServer();
		await mcp.ensureConnected("fake");
		state.failConnections = true;
		await mcp.reconnect("fake");
		expect(mcp.status("fake").state).toBe("unavailable");
		const found = await search("echo");
		expect(found.stale).toBe(true);
		expect((found.results as unknown[]).length).toBe(1);
		const ctx = await context({ name: "fake", description: "A fake server", enabled: true, available: false });
		const result = await runExternalTool(ctx, "fake", "echo", { message: "x" });
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
		expect(result).toBeInstanceOf(McpCallLostError);
		// A row that was in flight when the process stopped is recovered as unknown.
		const call = await createExternalCall(db, {
			callKey: "in-flight",
			orgId: await defaultOrgId(db),
			actorType: "session",
			actorId: sessionId,
			onBehalfOfUserId: user.userId,
			server: "fake",
			tool: "write_thing",
			arguments: {},
			operation: { method: "mcp.write", target: "fake/write_thing" },
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
		const replay = await runExternalTool({ ...ctx, callKey: "in-flight" }, "fake", "write_thing", { value: 1 });
		expect(replay.isError).toBe(true);
		expect(replay.content.map((block) => block.text).join("\n")).toContain("unknown");
		expect(state.calls.length).toBe(callsBefore);
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
		await db.deleteFrom("mcp_server_grants").execute();
		expect(await mcpServersForUser(db, user.userId)).toHaveLength(0);
		const row = await db.selectFrom("mcp_servers").selectAll().executeTakeFirst();
		await db
			.insertInto("mcp_server_grants")
			.values({
				id: newId(),
				org_id: orgId,
				server_id: row?.id ?? "",
				grantee_type: "user_group",
				grantee_id: group?.id ?? "",
				created_by_user_id: user.userId,
				created_at: new Date().toISOString(),
			})
			.execute();
		expect(await mcpServerNamesForUser(db, user.userId)).toEqual(["fake"]);
		expect(await mcpServerNamesForUser(db, user.userId, ["fake"])).toEqual([]);
		expect(parseDisabledServers('["fake"]')).toEqual(["fake"]);
	});

	it("describes the session's servers for the tool guide", async () => {
		await addServer();
		const servers = await mcpSessionServers({ db } as AgentRuntimeOptions, user.userId, []);
		expect(servers).toEqual([
			{
				name: "fake",
				description: "A fake server",
				enabled: true,
				available: true,
				trustAnnotations: true,
				listDirectly: false,
				timeoutMs: 300_000,
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
			server: "fake",
			tool: "write_thing",
			arguments: {},
			operation: { method: "mcp.write", target: "fake/write_thing" },
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
					server: "fake",
					tool: "write_thing",
					arguments: {},
					operation: { method: "mcp.write", target: "fake/write_thing" },
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
			server: "fake",
			tool: "write_thing",
			arguments: { value: 1 },
			operation: { method: "mcp.write", target: "fake/write_thing" },
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
			server: "fake",
			tool: "write_thing",
			arguments: {},
			operation: { method: "mcp.write", target: "fake/write_thing" },
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
			server: "fake",
			tool: "write_thing",
			arguments: {},
			operation: { method: "mcp.write", target: "fake/write_thing" },
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
			{ server: "fake", tool: "mixed" },
		);
		const text = result.content.map((block) => block.text).join("\n");
		expect(text).toContain("file:///a.txt");
		expect(text).toContain("audio/wav");
		expect(text).toContain("application/octet-stream");
		expect(text).toContain("fake/mixed");
	});
});
