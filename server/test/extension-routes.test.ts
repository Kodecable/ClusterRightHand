import type { OpenAPIHono } from "@hono/zod-openapi";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppEnv } from "../src/api/context.ts";
import { AGENT_ACCESS_EXTENSION, apiDocument } from "../src/api/openapi.ts";
import { Audit } from "../src/audit/audit.ts";
import { McpConnections } from "../src/extensions/connections.ts";
import { MasterKey } from "../src/keys/master-key.ts";
import type { Db } from "../src/storage/db.ts";
import { createUser } from "../src/users/service.ts";
import { type App, call, login, makeApp } from "./helpers/api.ts";
import { openTestDb } from "./helpers/db.ts";

describe("api extensions", () => {
	let db: Db;
	let app: App;
	let mcp: McpConnections;
	let audit: Audit;
	let admin = "";

	beforeAll(async () => {
		db = await openTestDb("sqlite");
		const masterKey = MasterKey.generate();
		mcp = new McpConnections({ db, masterKey });
		audit = new Audit(db);
		app = makeApp(db, undefined, { masterKey, mcp, audit });
		await createUser(db, { username: "root", kind: "admin", password: "password-123" });
		admin = await login(app, "root", "password-123");
	});

	afterAll(async () => {
		await mcp.close();
		await db.destroy();
	});

	it("lists the built-in extensions from the start", async () => {
		const res = await call(app, "/api/extensions", { cookie: admin });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { extensions: { name: string; kind: string }[] };
		expect(body.extensions.map((extension) => [extension.name, extension.kind])).toEqual([
			["crhs-api", "builtin"],
			["crhs-docs", "builtin"],
		]);
	});

	it("appears in the API document with deny for every route", () => {
		const doc = apiDocument(app as unknown as OpenAPIHono<AppEnv>);
		expect(doc.paths?.["/api/extensions"]?.get?.[AGENT_ACCESS_EXTENSION]).toBe("deny");
		expect(doc.paths?.["/api/extensions/{name}"]?.put?.[AGENT_ACCESS_EXTENSION]).toBe("deny");
		expect(doc.components?.schemas?.ExtensionView).toBeDefined();
	});

	it("rejects a body that does not match the route's schema", async () => {
		const url = await call(app, "/api/extensions/fake", { method: "PUT", cookie: admin, body: { url: 42 } });
		expect(url.status).toBe(400);
		expect(((await url.json()) as { error: string }).error).toMatch(/^url: /);

		const headers = await call(app, "/api/extensions/fake", {
			method: "PUT",
			cookie: admin,
			body: { url: "http://mcp.test/mcp", headers: "not a list" },
		});
		expect(headers.status).toBe(400);
		expect(((await headers.json()) as { error: string }).error).toMatch(/^headers: /);

		const timeout = await call(app, "/api/extensions/fake", {
			method: "PUT",
			cookie: admin,
			body: { url: "http://mcp.test/mcp", timeoutSeconds: "30" },
		});
		expect(timeout.status).toBe(400);
		expect(((await timeout.json()) as { error: string }).error).toMatch(/^timeoutSeconds: /);
	});

	it("creates an MCP extension with granted availability by default", async () => {
		const res = await call(app, "/api/extensions/fake", {
			method: "PUT",
			cookie: admin,
			body: { url: "http://mcp.test/mcp", description: "A fake server" },
		});
		expect(res.status).toBe(200);
		const { extension } = (await res.json()) as {
			extension: { kind: string; availability: string; url: string | null; trustAnnotations: boolean | null };
		};
		expect(extension).toMatchObject({
			kind: "mcp",
			availability: "granted",
			url: "http://mcp.test/mcp",
			trustAnnotations: true,
		});
	});

	it("refuses to delete a built-in and allows only its own fields", async () => {
		const deleted = await call(app, "/api/extensions/crhs-docs", { method: "DELETE", cookie: admin, body: {} });
		expect(deleted.status).toBe(400);
		expect(((await deleted.json()) as { error: string }).error).toMatch(/built-in extensions cannot be deleted/);

		const url = await call(app, "/api/extensions/crhs-docs", {
			method: "PUT",
			cookie: admin,
			body: { url: "http://mcp.test/mcp" },
		});
		expect(url.status).toBe(400);
		expect(((await url.json()) as { error: string }).error).toMatch(/url cannot be set on a built-in extension/);

		const saved = await call(app, "/api/extensions/crhs-docs", {
			method: "PUT",
			cookie: admin,
			body: { description: "Our documentation", availability: "granted", enabled: false },
		});
		expect(saved.status).toBe(200);
		const { extension } = (await saved.json()) as {
			extension: {
				kind: string;
				description: string | null;
				availability: string;
				enabled: boolean;
				url: string | null;
				trustAnnotations: boolean | null;
				timeoutSeconds: number | null;
			};
		};
		expect(extension).toMatchObject({
			kind: "builtin",
			description: "Our documentation",
			availability: "granted",
			enabled: false,
			url: null,
			trustAnnotations: null,
			timeoutSeconds: null,
		});
	});

	it("deletes an unknown extension as a 404, not a body error", async () => {
		const res = await call(app, "/api/extensions/never-was", { method: "DELETE", cookie: admin, body: {} });
		expect(res.status).toBe(404);
	});

	it("audits an MCP URL without its userinfo or query", async () => {
		const res = await call(app, "/api/extensions/audited", {
			method: "PUT",
			cookie: admin,
			body: { url: "http://user:pass@mcp.test:8080/path/mcp?api_key=top-secret" },
		});
		expect(res.status).toBe(200);
		await audit.flush();
		const event = await db
			.selectFrom("audit_events")
			.select(["action", "detail"])
			.where("action", "=", "extension.created")
			.orderBy("seq", "desc")
			.executeTakeFirstOrThrow();
		const detail = JSON.parse(event.detail ?? "{}") as { url?: string };
		expect(detail.url).toBe("http://mcp.test:8080/path/mcp");
		expect(event.detail).not.toContain("top-secret");
		expect(event.detail).not.toContain("user:pass");
	});
});
