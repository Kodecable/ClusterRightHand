import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import * as z from "zod/v4";
import { ModelConfig } from "../src/agent/models.ts";
import { AgentRuntime } from "../src/agent/runtime.ts";
import { sessionStateOf } from "../src/agent/session-state.ts";
import { Audit } from "../src/audit/audit.ts";
import type { SessionUser } from "../src/auth/sessions.ts";
import { Cluster } from "../src/cluster/cluster.ts";
import { TaskGroups } from "../src/cluster/task-groups.ts";
import { McpConnections } from "../src/extensions/connections.ts";
import type { ExtensionTool } from "../src/extensions/model.ts";
import { type ExtensionRow, getExtensionRow, saveExtension } from "../src/extensions/store.ts";
import { MasterKey } from "../src/keys/master-key.ts";
import type { Db } from "../src/storage/db.ts";
import { defaultOrgId } from "../src/storage/org.ts";
import { createUser } from "../src/users/service.ts";
import { newId } from "../src/util/id.ts";
import { openTestDb } from "./helpers/db.ts";
import { waitSubmission } from "./helpers/runtime.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/**
 * Direct MCP tools are computed from the rows read when a request is built (doc/design/extensions.md
 * "Tools for the model"): toggling list_directly, enabling or disabling a server, changing grants or the
 * tool list applies from the next request without a session-settings change.
 */

const faux = fauxProvider();
const model = () => ({ provider: faux.provider.id, modelId: faux.getModel().id });

function fakeMcp() {
	return createMcpHandler(() => {
		const server = new McpServer({ name: "fake", version: "1.0.0" });
		server.registerTool(
			"echo",
			{ description: "Echo the message back", inputSchema: z.object({ message: z.string() }) },
			async ({ message }) => ({ content: [{ type: "text", text: `echo: ${message}` }] }),
		);
		server.registerTool(
			"write_thing",
			{ description: "Change one thing", inputSchema: z.object({ value: z.number() }) },
			async ({ value }) => ({ content: [{ type: "text", text: `wrote ${value}` }] }),
		);
		server.registerTool(
			"later_tool",
			{ description: "A tool that appears later", inputSchema: z.object({}) },
			async () => ({ content: [{ type: "text", text: "later" }] }),
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

const manualTool = (name: string): ExtensionTool => ({
	name,
	title: null,
	description: `The ${name} tool`,
	inputSchema: { type: "object", properties: {} },
	annotations: null,
});

let db: Db;
let runtime: AgentRuntime;
let mcp: McpConnections;
let masterKey: MasterKey;
let owner: SessionUser;
let sessionId = "";
let request = 0;

beforeAll(async () => {
	db = await openTestDb("sqlite");
	const audit = new Audit(db);
	const cluster = new Cluster(db, { audit });
	const taskGroups = new TaskGroups(db, cluster, { audit });
	const models = new ModelConfig(db, MasterKey.generate());
	models.addProvider(faux.provider);
	await models.reload();
	masterKey = MasterKey.generate();
	mcp = new McpConnections({ db, masterKey, fetch: fakeFetch, backoffBaseMs: 1000 });
	runtime = await AgentRuntime.open({
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
	await addServer({ listDirectly: true, enabled: true, granted: true });
	await mcp.ensureConnected("fake");
	runtime.installExtensionTools((await getExtensionRow(db, "fake")) as ExtensionRow, mcp.tools("fake"));
	const session = await runtime.createSession(owner, { title: "direct tools", model: model(), rulePreset: "ask" });
	sessionId = session.id;
});

afterAll(async () => {
	await mcp.close();
	await runtime.close();
	await db.destroy();
});

async function addServer(options: { listDirectly: boolean; enabled: boolean; granted: boolean }) {
	const user = await db.selectFrom("users").select("id").where("username", "=", "owner").executeTakeFirst();
	const { row } = await saveExtension(
		db,
		masterKey,
		"fake",
		{
			url: "http://mcp.test/mcp",
			description: "A fake server",
			listDirectly: options.listDirectly,
			enabled: options.enabled,
			grants: options.granted ? [{ granteeType: "user", granteeId: user?.id ?? "" }] : [],
		},
		user?.id ?? "",
	);
	return row;
}

/** Saves the server through the administrator path and reinstalls its tools, like the settings route. */
async function updateServer(change: { listDirectly?: boolean; enabled?: boolean }) {
	const current = await getExtensionRow(db, "fake");
	const { row } = await saveExtension(
		db,
		masterKey,
		"fake",
		{
			url: "http://mcp.test/mcp",
			listDirectly: change.listDirectly ?? current?.list_directly === 1,
			enabled: change.enabled ?? current?.enabled === 1,
		},
		owner.userId,
	);
	await mcp.invalidate("fake", { keepTools: true });
	runtime.installExtensionTools(row, mcp.tools("fake"));
	return row;
}

async function setGrant(granted: boolean): Promise<void> {
	const user = await db.selectFrom("users").select("id").where("username", "=", "owner").executeTakeFirst();
	const server = await getExtensionRow(db, "fake");
	await db
		.deleteFrom("extension_grants")
		.where("extension_id", "=", server?.id ?? "")
		.execute();
	if (granted) {
		await db
			.insertInto("extension_grants")
			.values({
				id: newId(),
				org_id: await defaultOrgId(db),
				extension_id: server?.id ?? "",
				grantee_type: "user",
				grantee_id: user?.id ?? "",
				created_by_user_id: owner.userId,
				created_at: new Date().toISOString(),
			})
			.execute();
	}
}

/** Submits a message and returns the tool names the next request offered. */
async function nextRequestTools(session: string): Promise<string[]> {
	let seen: string[] = [];
	faux.setResponses([
		(context) => {
			seen = getCurrentTools(context.messages).map((tool) => tool.name);
			return fauxAssistantMessage([fauxText("ok")]);
		},
	]);
	request += 1;
	const submissionId = await runtime.submit(session, owner, `message ${request}`, `direct-${request}`);
	const settled = await waitSubmission(runtime, session, submissionId);
	expect(settled.status).toBe("done");
	return seen;
}

it("offers a list-directly server's tools and follows the flag on the next request", async () => {
	expect(await nextRequestTools(sessionId)).toContain("ext__fake__echo");
	await updateServer({ listDirectly: false });
	expect(await nextRequestTools(sessionId)).not.toContain("ext__fake__echo");
	await updateServer({ listDirectly: true });
	expect(await nextRequestTools(sessionId)).toContain("ext__fake__echo");
});

it("follows enabling and disabling a server on the next request", async () => {
	await updateServer({ enabled: false });
	expect(await nextRequestTools(sessionId)).not.toContain("ext__fake__echo");
	await updateServer({ enabled: true });
	expect(await nextRequestTools(sessionId)).toContain("ext__fake__echo");
});

it("follows grant changes on the next request", async () => {
	await setGrant(false);
	expect(await nextRequestTools(sessionId)).not.toContain("ext__fake__echo");
	await setGrant(true);
	expect(await nextRequestTools(sessionId)).toContain("ext__fake__echo");
});

it("follows a session's own off switch and its re-enabling", async () => {
	await runtime.configure(sessionId, { disabledExtensions: ["fake"] });
	expect(await nextRequestTools(sessionId)).not.toContain("ext__fake__echo");
	await runtime.configure(sessionId, { disabledExtensions: [] });
	expect(await nextRequestTools(sessionId)).toContain("ext__fake__echo");
});

it("follows the server's tool list on the next request", async () => {
	const row = (await getExtensionRow(db, "fake")) as ExtensionRow;
	runtime.installExtensionTools(row, [manualTool("echo"), manualTool("manual_only")]);
	let tools = await nextRequestTools(sessionId);
	expect(tools).toContain("ext__fake__manual_only");
	expect(tools).not.toContain("ext__fake__write_thing");
	runtime.installExtensionTools(row, mcp.tools("fake"));
	tools = await nextRequestTools(sessionId);
	expect(tools).toContain("ext__fake__write_thing");
	expect(tools).not.toContain("ext__fake__manual_only");
});

it("ends the run without an ext__ call when the quota is used up", async () => {
	const session = await runtime.createSession(owner, {
		title: "direct tool quota",
		model: model(),
		rulePreset: "yolo",
		budgetRemaining: 1,
	});
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("ext__fake__echo", { message: "hi" }, { id: "quota-direct" })], {
			stopReason: "toolUse",
		}),
	]);
	const submissionId = await runtime.submit(session.id, owner, "call the direct tool", "direct-quota");
	await until(async () => (await sessionStateOf(db, session.id)) === "awaiting");
	expect(await runtime.decideRootQuota(session.id, "deny")).toContain(session.id);
	const settled = await waitSubmission(runtime, session.id, submissionId);
	expect(settled.status).toBe("done");
	// The call never reached the extension, so no external-call row was written and no other model request ran.
	expect(await db.selectFrom("external_calls").select("id").where("actor_id", "=", session.id).execute()).toEqual([]);
	expect(faux.getPendingResponseCount()).toBe(0);
	expect(await sessionStateOf(db, session.id)).toBe("idle");
});

/** Polls a condition until it holds, for state a run writes after its reply. */
async function until(check: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await check())) {
		if (Date.now() > deadline) throw new Error("timed out waiting for a condition");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}
