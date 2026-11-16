import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { TaskSpec } from "@crh/protocol";
import { getOpenCodeSessionHeaders } from "@earendil-works/pi-ai/utils/identity";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { ModelConfig, saveModelProvider } from "../src/agent/models.ts";
import { AgentRuntime } from "../src/agent/runtime.ts";
import { SessionCaches } from "../src/agent/runtime-host/session-caches.ts";
import { streamSessionId } from "../src/agent/stream-session-id.ts";
import { Audit } from "../src/audit/audit.ts";
import type { SessionUser } from "../src/auth/sessions.ts";
import { Cluster } from "../src/cluster/cluster.ts";
import { TaskGroups } from "../src/cluster/task-groups.ts";
import { MasterKey } from "../src/keys/master-key.ts";
import type { Db } from "../src/storage/db.ts";
import { defaultOrgId } from "../src/storage/org.ts";
import { createUser } from "../src/users/service.ts";
import { newId } from "../src/util/id.ts";
import { openTestDb } from "./helpers/db.ts";
import { waitSubmission } from "./helpers/runtime.ts";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

/**
 * One provider session id per request stream (doc/design/agent-runtime.md "Custom providers"): the main
 * conversation keeps durable's identity, while compaction, Auto Review and title generation derive their own,
 * so requests with completely different prefixes never share the main conversation's cache identity.
 */

interface Recorded {
	headers: IncomingMessage["headers"];
	body: Record<string, unknown>;
}

function startStub(): Promise<{ server: Server; url: string; requests: Recorded[] }> {
	const requests: Recorded[] = [];
	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		let raw = "";
		req.setEncoding("utf8");
		req.on("data", (chunk) => {
			raw += chunk;
		});
		req.on("end", () => {
			const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
			requests.push({ headers: req.headers, body });
			res.writeHead(200, { "content-type": "text/event-stream", connection: "keep-alive" });
			const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
				res.write(
					`data: ${JSON.stringify({
						id: "chatcmpl-1",
						object: "chat.completion.chunk",
						created: 1,
						model: "m-1",
						choices: [{ index: 0, delta, finish_reason: finish }],
					})}\n\n`,
				);
			chunk({ role: "assistant", content: "ok" });
			chunk({}, "stop");
			res.write(
				`data: ${JSON.stringify({
					id: "chatcmpl-1",
					object: "chat.completion.chunk",
					created: 1,
					model: "m-1",
					choices: [],
					usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
				})}\n\n`,
			);
			res.end("data: [DONE]\n\n");
		});
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as AddressInfo;
			resolve({ server, url: `http://127.0.0.1:${port}/v1`, requests });
		});
	});
}

let db: Db;
let runtime: AgentRuntime;
let cluster: Cluster;
let owner: SessionUser;
let stub: { server: Server; url: string; requests: Recorded[] };
let nodeId = "";
const spec: TaskSpec = { kind: "exec", command: { argv: ["echo", "hi"] }, env: {}, cwd: "", stdin: null };

/** The system prompt of a request, to tell the four streams apart. */
function systemPrompt(request: Recorded): string {
	const messages = request.body.messages as { role?: string; content?: unknown }[] | undefined;
	const system = messages?.find((message) => message.role === "system");
	if (typeof system?.content === "string") return system.content;
	if (Array.isArray(system?.content)) {
		return system.content.flatMap((part) => (part?.type === "text" ? [String(part.text)] : [])).join("");
	}
	return "";
}

/** The custom provider's configured header and body field of a request. */
function sessionFields(request: Recorded): { header: string | undefined; body: string | undefined } {
	const metadata = request.body.metadata as { session_id?: unknown } | undefined;
	return {
		header: typeof request.headers["x-crh-session"] === "string" ? request.headers["x-crh-session"] : undefined,
		body: typeof metadata?.session_id === "string" ? metadata.session_id : undefined,
	};
}

function isCompaction(request: Recorded): boolean {
	return systemPrompt(request).includes("context summarization assistant");
}
function isReview(request: Recorded): boolean {
	return systemPrompt(request).includes("submit_review");
}
function isTitle(request: Recorded): boolean {
	return systemPrompt(request).includes("Write a short title");
}
function isMain(request: Recorded): boolean {
	const prompt = systemPrompt(request);
	return prompt !== "" && !isCompaction(request) && !isReview(request) && !isTitle(request);
}

async function waitFor<T>(what: string, probe: () => T | undefined, timeoutMs = 10_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = probe();
		if (value !== undefined) return value;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

beforeAll(async () => {
	db = await openTestDb("sqlite");
	const audit = new Audit(db);
	cluster = new Cluster(db, { audit });
	const masterKey = MasterKey.generate();
	const models = new ModelConfig(db, masterKey);
	await models.reload();
	stub = await startStub();
	await saveModelProvider(db, masterKey, {
		kind: "custom",
		providerId: "stream-stub",
		name: "stream-stub",
		baseUrl: stub.url,
		apiKey: "sk-stub",
		models: [{ id: "m-1", api: "openai-completions", contextWindow: 1024, maxTokens: 256, input: ["text"] }],
		sessionId: { headers: ["x-crh-session"], body: ["metadata.session_id"] },
	});
	await models.reload();
	runtime = await AgentRuntime.open({
		db,
		storage: new MemoryStorage(),
		models,
		cluster,
		taskGroups: new TaskGroups(db, cluster, { audit }),
		audit,
		compaction: { reserveTokens: 8, keepRecentTokens: 1, backgroundTokens: 0 },
	});
	await runtime.modelPresets.update("review", { model: { provider: "stream-stub", modelId: "m-1" } });
	const user = await createUser(db, { username: "streams", kind: "member", password: "password-123" });
	owner = { sessionId: "streams", userId: user.id, username: user.username, kind: "member" };
	nodeId = newId();
	const now = new Date().toISOString();
	await db
		.insertInto("nodes")
		.values({
			id: nodeId,
			org_id: await defaultOrgId(db),
			name: "stream-node",
			name_key: "stream-node",
			transport: "client",
			status: "active",
			public_key: null,
			hostname: "stream-node",
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
	await runtime.close();
	await new Promise((resolve) => stub.server.close(resolve));
	await db.destroy();
});

it("derives deterministic, pairwise different ids per stream", () => {
	const review = streamSessionId("session-1", "review");
	expect(review).toBe(streamSessionId("session-1", "review"));
	expect(review).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
	const ids = [
		review,
		streamSessionId("session-1", "title"),
		streamSessionId("session-1", "compaction"),
		streamSessionId("session-2", "review"),
	];
	expect(new Set(ids).size).toBe(4);
	// A cleared cache cannot change a derived id: it does not depend on session state.
	const caches = new SessionCaches();
	caches.rememberProviderSession("conversation-1", "provider-1", "session-1");
	expect(streamSessionId("session-1", "review")).toBe(review);
	caches.forgetSession("session-1", "conversation-1");
	expect(streamSessionId("session-1", "review")).toBe(review);

	// The OpenCode session header is the request's session id, so the four streams' headers differ too.
	const target = { provider: "opencode", baseUrl: "https://opencode.ai/inference/v1" };
	const streams = [review, streamSessionId("session-1", "title"), streamSessionId("session-1", "compaction")];
	const headerOf = (id: string) => getOpenCodeSessionHeaders(target, id)?.["x-opencode-session"];
	expect([headerOf("main-session"), ...streams.map(headerOf)]).toEqual(["main-session", ...streams]);
	expect(new Set([headerOf("main-session"), ...streams.map(headerOf)]).size).toBe(4);
});

it("gives main, compaction, review and title their own provider session fields", async () => {
	const session = await runtime.createSession(owner, {
		model: { provider: "stream-stub", modelId: "m-1" },
		rulePreset: "auto_review",
	});
	const first = await runtime.submit(session.id, owner, "first message", "stream-main-1");
	expect((await waitSubmission(runtime, session.id, first)).status).toBe("done");

	// Title generation runs after the run ends, in the background.
	const title = await waitFor("the title request", () => stub.requests.find(isTitle));
	expect(sessionFields(title)).toEqual({
		header: streamSessionId(session.id, "title"),
		body: streamSessionId(session.id, "title"),
	});

	// A task under the Auto Review root is reviewed by the same model.
	const task = await cluster.createTask({
		nodeId,
		spec,
		chain: [{ type: "session", id: session.id }],
		actor: { type: "session", id: session.id, onBehalfOfUserId: owner.userId },
	});
	await waitFor("the review request", () => stub.requests.find(isReview));
	expect(task.id).toBeTruthy();

	// A manual compaction summarizes through the session's own model, with its own request stream.
	await runtime.compact(session.id, owner);
	const compaction = await waitFor("the compaction request", () => stub.requests.find(isCompaction));

	const main = stub.requests.find(isMain);
	if (main === undefined) throw new Error("no main generation request");
	expect(sessionFields(main).header).toBe(session.id);
	expect(sessionFields(main).body).toBe(session.id);
	expect(sessionFields(compaction)).toEqual({
		header: streamSessionId(session.id, "compaction"),
		body: streamSessionId(session.id, "compaction"),
	});

	const values = [
		sessionFields(main),
		sessionFields(title),
		sessionFields(compaction),
		sessionFields(stub.requests.find(isReview) as Recorded),
	];
	for (const fields of values) expect(fields.header).toBe(fields.body);
	expect(new Set(values.map((fields) => fields.header)).size).toBe(4);
});
