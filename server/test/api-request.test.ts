import type { Rule } from "@crh/api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as z from "zod/v4";
import { type AppOptions, createApp } from "../src/api/app.ts";
import { apiDocument, defineRoute, json } from "../src/api/openapi.ts";
import { Audit, userActor } from "../src/audit/audit.ts";
import { normalizeApiRequest } from "../src/extensions/api-request.ts";
import { configureBuiltinExtensions } from "../src/extensions/builtin.ts";
import { decideExternalCall, externalCallViews } from "../src/extensions/external-calls.ts";
import { sessionExtensionsForUser } from "../src/extensions/registry.ts";
import { createRootRuleSet } from "../src/policy/store.ts";
import type { Db } from "../src/storage/db.ts";
import { defaultOrgId } from "../src/storage/org.ts";
import type { ToolContext } from "../src/tools/catalog.ts";
import { runExtensionTool } from "../src/tools/catalog.ts";
import { createUser } from "../src/users/service.ts";
import { openTestDb } from "./helpers/db.ts";

/** `api_request`, the built-in `api` extension (doc/design/extensions.md "API requests"). */

type CreatedApp = ReturnType<typeof createApp>;
type TestUser = Awaited<ReturnType<typeof createUser>>;

const SESSION = "session-audit";

let db: Db;
let audit: Audit;
let app: CreatedApp;
let owner: TestUser;

/** Adds the routes these tests need; they do not exist on the ordinary app without a runtime. */
function addTestRoutes(target: CreatedApp): void {
	target.openapi(
		defineRoute({
			method: "post",
			path: "/api/sessions",
			tags: ["Sessions"],
			summary: "Start a session",
			agent: "ask",
			responses: { 200: { description: "Started", ...json(z.object({ created: z.boolean() })) } },
		}),
		(c) => c.json({ created: true }, 200),
	);
	target.openapi(
		defineRoute({
			method: "post",
			path: "/api/test-audit",
			tags: ["Test"],
			summary: "Record one audit event as the caller",
			agent: "ask",
			responses: { 200: { description: "Recorded", ...json(z.object({ ok: z.boolean() })) } },
		}),
		async (c) => {
			await c.get("audit").append({
				actor: userActor(c.get("user")),
				action: "test.audited",
				target: { type: "test", id: "one" },
			});
			return c.json({ ok: true }, 200);
		},
	);
	target.openapi(
		defineRoute({
			method: "get",
			path: "/api/test-binary",
			tags: ["Test"],
			summary: "Return four bytes",
			agent: "allow",
			responses: {
				200: {
					description: "Bytes",
					content: { "application/octet-stream": { schema: z.string() } },
				},
			},
		}),
		(c) => c.body(new Uint8Array([1, 2, 3, 4]), 200, { "content-type": "application/octet-stream" }),
	);
}

function useTestRoutes(target: CreatedApp): CreatedApp {
	addTestRoutes(target);
	// The running app's document and router, as createApp installs them, plus the routes above.
	configureBuiltinExtensions({
		api: {
			document: apiDocument(target),
			request: async (request, identity) => target.request(request, undefined, { crhInternal: identity }),
		},
	});
	return target;
}

beforeEach(async () => {
	db = await openTestDb("sqlite");
	audit = new Audit(db);
	app = useTestRoutes(createApp(db, { audit } satisfies AppOptions));
	owner = await createUser(db, { username: "owner", kind: "member", password: "password-123" });
});

afterEach(async () => {
	await db.destroy();
	configureBuiltinExtensions();
});

async function context(rules: Rule[] = [], preset: "ask" | "auto_review" | "yolo" = "ask"): Promise<ToolContext> {
	await createRootRuleSet(db, await defaultOrgId(db), { type: "session", id: SESSION }, preset, rules);
	const user = {
		sessionId: "web-session",
		userId: owner.id,
		username: owner.username,
		kind: owner.kind,
	};
	return {
		db,
		cluster: {} as never,
		taskGroups: {} as never,
		user,
		actor: { type: "session", id: SESSION, onBehalfOfUserId: owner.id },
		chain: [{ type: "session", id: SESSION }],
		approvalUrl: () => "",
		rootSessionId: SESSION,
		extensions: await sessionExtensionsForUser(db, owner.id, [], undefined),
		audit,
		externalCallUrl: (id) => `/approvals/external-calls/${id}`,
	};
}

async function waitFor<T>(probe: () => Promise<T | undefined>, timeoutMs = 5000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await probe();
		if (value !== undefined) return value;
		if (Date.now() > deadline) throw new Error("timed out waiting");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

const textOf = (result: Awaited<ReturnType<typeof runExtensionTool>>): string =>
	result.content.map((block) => block.text).join("\n");

describe("api_request", () => {
	it("reads a body sent as a string holding JSON as that JSON", () => {
		expect(normalizeApiRequest({ method: "POST", path: "/api/x", body: '{"name":"a"}' }).body).toBe('{"name":"a"}');
		expect(normalizeApiRequest({ method: "POST", path: "/api/x", body: { name: "a" } }).body).toBe('{"name":"a"}');
		expect(normalizeApiRequest({ method: "POST", path: "/api/x", body: "plain" }).body).toBe('"plain"');
	});

	it("runs an allowed GET as the session owner and the Ask preset allows the read", async () => {
		const result = await runExtensionTool(await context(), "api", "api_request", { method: "GET", path: "/api/me" });
		expect(result.isError).toBe(false);
		expect(textOf(result)).toContain("HTTP 200");
		expect(textOf(result)).toContain(`"username":"${owner.username}"`);
		const row = await db.selectFrom("external_calls").selectAll().executeTakeFirstOrThrow();
		expect(JSON.parse(row.operation)).toEqual({ method: "api.read", target: "GET /api/me" });
		expect(row.state).toBe("succeeded");
	});

	it("waits for approval on an ask route and runs it after the owner approves", async () => {
		const admin = await createUser(db, { username: "admin", kind: "admin", password: "password-123" });
		const ctx = await context();
		ctx.user = { ...ctx.user, userId: admin.id, username: admin.username, kind: admin.kind };
		ctx.actor = { ...ctx.actor, onBehalfOfUserId: admin.id };
		ctx.extensions = await sessionExtensionsForUser(db, admin.id, [], undefined);
		const pending = runExtensionTool(ctx, "api", "api_request", {
			method: "POST",
			path: "/api/node-groups",
			body: { name: "team" },
		});
		const waiting = await waitFor(async () =>
			db.selectFrom("external_calls").selectAll().where("state", "=", "awaiting_approval").executeTakeFirst(),
		);
		const view = (await externalCallViews(db, [waiting]))[0];
		expect(view?.operation).toEqual({ method: "api.write", target: "POST /api/node-groups" });
		expect(view?.arguments).toEqual({ method: "POST", path: "/api/node-groups", body: { name: "team" } });
		const decided = await decideExternalCall(db, waiting.id, {
			decision: "approved",
			by: { type: "user", id: admin.id },
			at: new Date().toISOString(),
		});
		expect(decided).toBe(true);
		const result = await pending;
		expect(result.isError).toBe(false);
		expect(textOf(result)).toContain("HTTP 201");
		expect(textOf(result)).toContain('"name":"team"');
		expect(await db.selectFrom("node_groups").select("name").execute()).toContainEqual({ name: "team" });
	});

	it("refuses a deny route, an unknown route and a path outside /api without creating a call", async () => {
		const ctx = await context();
		const denied = await runExtensionTool(ctx, "api", "api_request", {
			method: "POST",
			path: "/api/users",
			body: { username: "x" },
		});
		expect(denied.isError).toBe(true);
		expect(textOf(denied)).toContain("not available to agents");
		const unknown = await runExtensionTool(ctx, "api", "api_request", { method: "GET", path: "/api/no-such-route" });
		expect(unknown.isError).toBe(true);
		expect(textOf(unknown)).toContain("no API route");
		const outside = await runExtensionTool(ctx, "api", "api_request", { method: "GET", path: "/etc/passwd" });
		expect(outside.isError).toBe(true);
		expect(textOf(outside)).toContain("only paths under /api");
		expect(await db.selectFrom("external_calls").select("id").execute()).toHaveLength(0);
	});

	it("records the audit event as the session, on behalf of the owner", async () => {
		const ctx = await context([{ action: "allow", method: "api.write", exact: "POST /api/test-audit" }]);
		const result = await runExtensionTool(ctx, "api", "api_request", { method: "POST", path: "/api/test-audit" });
		expect(result.isError).toBe(false);
		await audit.flush();
		const event = await db
			.selectFrom("audit_events")
			.select(["actor_type", "actor_id", "on_behalf_of_user_id"])
			.where("action", "=", "test.audited")
			.executeTakeFirstOrThrow();
		expect(event).toEqual({ actor_type: "session", actor_id: SESSION, on_behalf_of_user_id: owner.id });
	});

	it("does not let a network request inject the internal identity", async () => {
		const spoofed = await app.request("/api/me", {
			headers: {
				"x-crh-internal": owner.id,
				"x-crh-internal-user": owner.id,
				"crh-internal-user": owner.id,
				"x-crh-user": owner.id,
			},
		});
		expect(spoofed.status).toBe(401);
		expect((await app.request("/api/me")).status).toBe(401);
	});

	it("refuses a body larger than 1 MiB before creating a call", async () => {
		const ctx = await context();
		const result = await runExtensionTool(ctx, "api", "api_request", {
			method: "POST",
			path: "/api/test-audit",
			body: { data: "x".repeat(1024 * 1024) },
		});
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("at most 1048576");
		expect(await db.selectFrom("external_calls").select("id").execute()).toHaveLength(0);
	});

	it("describes a binary response by type and size instead of returning it", async () => {
		const result = await runExtensionTool(await context(), "api", "api_request", {
			method: "GET",
			path: "/api/test-binary",
		});
		expect(result.isError).toBe(false);
		expect(textOf(result)).toContain("HTTP 200");
		expect(textOf(result)).toContain("application/octet-stream, 4 bytes; not returned");
	});

	it("allows a route family with a prefix rule such as POST /api/sessions", async () => {
		const result = await runExtensionTool(
			await context([{ action: "allow", method: "api.write", prefix: "POST /api/sessions" }]),
			"api",
			"api_request",
			{ method: "POST", path: "/api/sessions" },
		);
		expect(result.isError).toBe(false);
		expect(textOf(result)).toContain("HTTP 200");
		expect(textOf(result)).toContain('"created":true');
		const row = await db.selectFrom("external_calls").selectAll().executeTakeFirstOrThrow();
		expect(row.state).toBe("succeeded");
		expect(JSON.parse(row.operation)).toEqual({ method: "api.write", target: "POST /api/sessions" });
	});

	it("matches a parameterised route by its template and passes query parameters", async () => {
		const result = await runExtensionTool(await context(), "api", "api_request", {
			method: "GET",
			path: "/api/node-groups",
			query: { q: "team", limit: 5 },
		});
		expect(result.isError).toBe(false);
		expect(textOf(result)).toContain("HTTP 200");
		const row = await db.selectFrom("external_calls").selectAll().executeTakeFirstOrThrow();
		expect(JSON.parse(row.operation)).toEqual({ method: "api.read", target: "GET /api/node-groups" });
	});
});
