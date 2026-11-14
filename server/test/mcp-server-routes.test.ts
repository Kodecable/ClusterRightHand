import type { OpenAPIHono } from "@hono/zod-openapi";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppEnv } from "../src/api/context.ts";
import { AGENT_ACCESS_EXTENSION, apiDocument } from "../src/api/openapi.ts";
import { McpConnections } from "../src/extensions/connections.ts";
import { MasterKey } from "../src/keys/master-key.ts";
import type { Db } from "../src/storage/db.ts";
import { createUser } from "../src/users/service.ts";
import { type App, call, login, makeApp } from "./helpers/api.ts";
import { openTestDb } from "./helpers/db.ts";

describe("api MCP servers", () => {
	let db: Db;
	let app: App;
	let mcp: McpConnections;
	let admin = "";

	beforeAll(async () => {
		db = await openTestDb("sqlite");
		const masterKey = MasterKey.generate();
		mcp = new McpConnections({ db, masterKey });
		app = makeApp(db, undefined, { masterKey, mcp });
		await createUser(db, { username: "root", kind: "admin", password: "password-123" });
		admin = await login(app, "root", "password-123");
	});

	afterAll(async () => {
		await mcp.close();
		await db.destroy();
	});

	it("lists no servers yet", async () => {
		const res = await call(app, "/api/mcp-servers", { cookie: admin });
		expect(res.status).toBe(200);
		expect((await res.json()) as { servers: unknown[] }).toEqual({ servers: [] });
	});

	it("appears in the API document with deny for every route", () => {
		const doc = apiDocument(app as unknown as OpenAPIHono<AppEnv>);
		expect(doc.paths?.["/api/mcp-servers"]?.get?.[AGENT_ACCESS_EXTENSION]).toBe("deny");
		expect(doc.paths?.["/api/mcp-servers/{name}"]?.put?.[AGENT_ACCESS_EXTENSION]).toBe("deny");
		expect(doc.components?.schemas?.McpServerView).toBeDefined();
	});

	it("rejects a body that does not match the route's schema", async () => {
		const url = await call(app, "/api/mcp-servers/fake", { method: "PUT", cookie: admin, body: { url: 42 } });
		expect(url.status).toBe(400);
		expect(((await url.json()) as { error: string }).error).toMatch(/^url: /);

		const headers = await call(app, "/api/mcp-servers/fake", {
			method: "PUT",
			cookie: admin,
			body: { url: "http://mcp.test/mcp", headers: "not a list" },
		});
		expect(headers.status).toBe(400);
		expect(((await headers.json()) as { error: string }).error).toMatch(/^headers: /);

		const timeout = await call(app, "/api/mcp-servers/fake", {
			method: "PUT",
			cookie: admin,
			body: { url: "http://mcp.test/mcp", timeoutSeconds: "30" },
		});
		expect(timeout.status).toBe(400);
		expect(((await timeout.json()) as { error: string }).error).toMatch(/^timeoutSeconds: /);
	});

	it("deletes an unknown server as a 404, not a body error", async () => {
		const res = await call(app, "/api/mcp-servers/never-was", { method: "DELETE", cookie: admin, body: {} });
		expect(res.status).toBe(404);
	});
});
