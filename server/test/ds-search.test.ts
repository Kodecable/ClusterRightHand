import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Audit } from "../src/audit/audit.ts";
import type { SessionUser } from "../src/auth/sessions.ts";
import { builtinProvider } from "../src/extensions/builtin.ts";
import { McpConnections } from "../src/extensions/connections.ts";
import { sessionExtensionsForUser } from "../src/extensions/registry.ts";
import { extensionView, getExtensionRow, saveExtension } from "../src/extensions/store.ts";
import { MasterKey } from "../src/keys/master-key.ts";
import { createRootRuleSet } from "../src/policy/store.ts";
import type { Db } from "../src/storage/db.ts";
import { defaultOrgId } from "../src/storage/org.ts";
import { runExtensionTool, type ToolContext } from "../src/tools/catalog.ts";
import { createUser } from "../src/users/service.ts";
import { newId } from "../src/util/id.ts";
import { openTestDb } from "./helpers/db.ts";

/** A stand-in for DeepSeek's Search and Fetch API: it records requests and answers as told. */
interface FakeApi {
	server: Server;
	baseUrl: string;
	requests: { path: string; auth: string | undefined; body: Record<string, unknown> }[];
	/** Status codes to answer before the real answer, one per request. */
	failures: number[];
}

async function fakeApi(): Promise<FakeApi> {
	const api: FakeApi = { server: undefined as never, baseUrl: "", requests: [], failures: [] };
	api.server = createServer((req: IncomingMessage, res: ServerResponse) => {
		let raw = "";
		req.on("data", (chunk) => {
			raw += chunk;
		});
		req.on("end", () => {
			const body = JSON.parse(raw || "{}") as Record<string, unknown>;
			api.requests.push({ path: req.url ?? "", auth: req.headers.authorization, body });
			const reply = (status: number, payload: unknown) => {
				res.writeHead(status, { "content-type": "application/json" });
				res.end(JSON.stringify(payload));
			};
			const failure = api.failures.shift();
			if (failure !== undefined) {
				reply(failure, { error: { message: `failure ${failure}`, type: "x", param: null, code: "x" } });
				return;
			}
			if (req.url === "/v1/tools/search") {
				reply(200, {
					results: [
						{
							rerank_score: 2.4,
							title: "DeepSeek V4 released",
							url: "https://example.com/v4",
							snippet: "short",
							summary: "A long summary for the model.",
							content: body.need_content ? "The page content." : "",
							site_name: "Example",
							site_icon: null,
							date: "2026-06-01T00:00:00+00:00",
							authority: 3,
						},
					],
				});
				return;
			}
			if (req.url === "/v1/tools/fetch") {
				const lines = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`);
				reply(200, { title: "A page", content: lines.join("\n") });
				return;
			}
			reply(404, { error: { message: "no such endpoint" } });
		});
	});
	await new Promise<void>((resolve) => api.server.listen(0, "127.0.0.1", resolve));
	api.baseUrl = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`;
	return api;
}

describe("crhs-ds-search", () => {
	let db: Db;
	let masterKey: MasterKey;
	let connections: McpConnections;
	let user: SessionUser;
	let sessionId: string;
	let api: FakeApi;

	beforeEach(async () => {
		db = await openTestDb("sqlite");
		masterKey = MasterKey.generate();
		connections = new McpConnections({ db, masterKey });
		const created = await createUser(db, { username: "alice", kind: "member", password: "password-123" });
		user = { sessionId: "s", userId: created.id, username: created.username, kind: "member" };
		sessionId = newId();
		await createRootRuleSet(db, await defaultOrgId(db), { type: "session", id: sessionId }, "ask");
		api = await fakeApi();
	});

	afterEach(async () => {
		await connections.close();
		await new Promise<void>((resolve) => api.server.close(() => resolve()));
		await db.destroy();
	});

	async function configure(): Promise<void> {
		await saveExtension(
			db,
			masterKey,
			"crhs-ds-search",
			{ enabled: true, config: { apiKey: "sk-secret-key", baseUrl: api.baseUrl } },
			user.userId,
		);
	}

	async function context(): Promise<ToolContext> {
		return {
			db,
			cluster: {} as never,
			taskGroups: {} as never,
			user,
			actor: { type: "session", id: sessionId, onBehalfOfUserId: user.userId },
			chain: [{ type: "session", id: sessionId }],
			approvalUrl: () => "",
			rootSessionId: sessionId,
			extensions: await sessionExtensionsForUser(db, user.userId, [], connections),
			audit: new Audit(db),
		};
	}

	const text = (result: { content: { text?: string }[] }) => result.content.map((block) => block.text).join("\n");

	it("ships disabled and cannot be enabled without an API key", async () => {
		const row = await getExtensionRow(db, "crhs-ds-search");
		expect(row).toMatchObject({ kind: "builtin", enabled: 0, description: null });
		await expect(saveExtension(db, masterKey, "crhs-ds-search", { enabled: true }, user.userId)).rejects.toThrow(
			/set apiKey before enabling/,
		);
		// Not offered to sessions while disabled.
		const ctx = await context();
		expect(ctx.extensions?.some((entry) => entry.extension.name === "crhs-ds-search")).toBe(false);
	});

	it("keeps the API key encrypted and write-only, and reports only that it is set", async () => {
		await configure();
		const secret = await db.selectFrom("secrets").select(["ciphertext", "kind"]).executeTakeFirstOrThrow();
		expect(secret.kind).toBe("extension_config");
		expect(Buffer.from(secret.ciphertext).toString("utf8")).not.toContain("sk-secret-key");
		const row = await getExtensionRow(db, "crhs-ds-search");
		if (!row) throw new Error("no row");
		expect(row.config).not.toContain("sk-secret-key");
		const view = await extensionView(db, masterKey, row, connections.status("crhs-ds-search"));
		expect(view.config).toMatchObject({ values: { baseUrl: api.baseUrl }, secretsSet: ["apiKey"], missing: [] });
		expect(JSON.stringify(view)).not.toContain("sk-secret-key");
		// Removing the key while enabled is refused; with the extension disabled it is allowed.
		await expect(
			saveExtension(db, masterKey, "crhs-ds-search", { config: { apiKey: null } }, user.userId),
		).rejects.toThrow(/set apiKey before enabling/);
		await saveExtension(db, masterKey, "crhs-ds-search", { enabled: false, config: { apiKey: null } }, user.userId);
		expect(await db.selectFrom("secrets").select("id").execute()).toHaveLength(0);
		// Unknown settings and settings on an MCP extension are refused.
		await expect(
			saveExtension(db, masterKey, "crhs-ds-search", { config: { nope: "x" } }, user.userId),
		).rejects.toThrow(/no setting nope/);
		await expect(saveExtension(db, masterKey, "crhs-docs", { config: { apiKey: "x" } }, user.userId)).rejects.toThrow(
			/no settings/,
		);
	});

	it("binds the key to the base URL: moving it needs the key again, and it must be an http(s) URL", async () => {
		await configure();
		await expect(
			saveExtension(db, masterKey, "crhs-ds-search", { config: { baseUrl: "https://elsewhere.example" } }, user.userId),
		).rejects.toThrow(/changing baseUrl requires entering apiKey again/);
		await expect(
			saveExtension(db, masterKey, "crhs-ds-search", { config: { baseUrl: "file:///etc/passwd" } }, user.userId),
		).rejects.toThrow(/http\(s\) URL/);
		// With the key entered again, the move is allowed.
		await saveExtension(
			db,
			masterKey,
			"crhs-ds-search",
			{ config: { baseUrl: `${api.baseUrl}/`, apiKey: "sk-secret-key" } },
			user.userId,
		);
	});

	it("replaces stored secrets that cannot be decrypted once every one is entered again", async () => {
		await configure();
		// Another master key cannot read what this one wrote, as after a lost or replaced key file. With the
		// only secret entered again nothing is dropped, so the save goes through and the new key is readable.
		const other = MasterKey.generate();
		await saveExtension(db, other, "crhs-ds-search", { config: { apiKey: "sk-replaced" } }, user.userId);
		const row = await getExtensionRow(db, "crhs-ds-search");
		if (!row) throw new Error("no row");
		const reader = new McpConnections({ db, masterKey: other });
		try {
			const provider = builtinProvider("crhs-ds-search");
			if (!provider) throw new Error("no provider");
			expect((await reader.builtinConfig("crhs-ds-search", provider)).apiKey).toBe("sk-replaced");
		} finally {
			await reader.close();
		}
	});

	it("reads the settings when the call runs, not when the session listed the extension", async () => {
		await configure();
		const ctx = await context();
		await saveExtension(db, masterKey, "crhs-ds-search", { config: { apiKey: "sk-new-key" } }, user.userId);
		const result = await runExtensionTool(ctx, "crhs-ds-search", "search", { query: "fresh" });
		expect(result.isError).toBe(false);
		expect(api.requests.at(-1)?.auth).toBe("Bearer sk-new-key");
	});

	it("searches with the key and returns the model's summaries without an approval", async () => {
		await configure();
		const result = await runExtensionTool(await context(), "crhs-ds-search", "search", { query: "DeepSeek V4" });
		expect(result.isError).toBe(false);
		expect(text(result)).toContain("DeepSeek V4 released");
		expect(text(result)).toContain("https://example.com/v4");
		expect(text(result)).toContain("A long summary for the model.");
		expect(text(result)).not.toContain("The page content.");
		expect(api.requests[0]).toMatchObject({
			path: "/v1/tools/search",
			auth: "Bearer sk-secret-key",
			body: { query: "DeepSeek V4", count: 10, need_content: false },
		});
	});

	it("returns a page whole when it fits, and continues a longer one at the offset it gives", async () => {
		await configure();
		const whole = await runExtensionTool(await context(), "crhs-ds-search", "fetch", {
			url: "https://example.com/article",
		});
		expect(text(whole)).toContain("# A page");
		expect(text(whole)).toContain("line 1\n");
		expect(text(whole)).toContain("line 30");
		expect(text(whole)).toContain("end of page");
		// A continuation fetches the page again and starts where the model asks.
		const next = await runExtensionTool({ ...(await context()), callKey: "next" }, "crhs-ds-search", "fetch", {
			url: "https://example.com/article",
			offset: 21,
		});
		expect(text(next)).toContain("line 21");
		expect(text(next)).not.toContain("line 20\n");
		expect(text(next)).not.toContain("# A page");
		expect(api.requests.filter((request) => request.path === "/v1/tools/fetch")).toHaveLength(2);
	});

	it("retries what DeepSeek says to retry and reports the rest", async () => {
		await configure();
		api.failures.push(429, 503);
		const retried = await runExtensionTool(await context(), "crhs-ds-search", "search", { query: "retry" });
		expect(retried.isError).toBe(false);
		expect(api.requests).toHaveLength(3);
		api.failures.push(402);
		const broke = await runExtensionTool({ ...(await context()), callKey: "broke" }, "crhs-ds-search", "search", {
			query: "x",
		});
		expect(broke.isError).toBe(true);
		expect(text(broke)).toContain("insufficient balance");
		api.failures.push(404);
		const missing = await runExtensionTool({ ...(await context()), callKey: "gone" }, "crhs-ds-search", "fetch", {
			url: "https://example.com/gone",
		});
		expect(text(missing)).toContain("could not get usable content");
	});

	it("refuses bad arguments before calling DeepSeek", async () => {
		await configure();
		const ctx = await context();
		const credentials = await runExtensionTool(ctx, "crhs-ds-search", "fetch", { url: "https://u:p@example.com/" });
		expect(text(credentials)).toContain("must not contain a username or password");
		const tooLong = await runExtensionTool({ ...ctx, callKey: "long" }, "crhs-ds-search", "search", {
			query: "x".repeat(129),
		});
		expect(text(tooLong)).toContain("at most 128 characters");
		const tooMany = await runExtensionTool({ ...ctx, callKey: "many" }, "crhs-ds-search", "search", {
			query: "x",
			count: 51,
		});
		expect(text(tooMany)).toContain("from 1 to 50");
		expect(api.requests).toHaveLength(0);
	});
});
