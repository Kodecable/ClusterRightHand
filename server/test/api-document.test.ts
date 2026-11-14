import { OpenAPIHono } from "@hono/zod-openapi";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentRuntime } from "../src/agent/runtime.ts";
import { createApp } from "../src/api/app.ts";
import type { AppEnv } from "../src/api/context.ts";
import { AGENT_ACCESS_EXTENSION, apiDocument } from "../src/api/openapi.ts";
import { scheduleRoutes } from "../src/api/schedule-routes.ts";
import { Audit } from "../src/audit/audit.ts";
import { Cluster } from "../src/cluster/cluster.ts";
import { TaskGroups } from "../src/cluster/task-groups.ts";
import { MasterKey } from "../src/keys/master-key.ts";
import type { Db } from "../src/storage/db.ts";
import { openTestDb } from "./helpers/db.ts";

describe("API document", () => {
	let db: Db;
	let cluster: Cluster;

	beforeAll(async () => {
		db = await openTestDb("sqlite");
		const audit = new Audit(db);
		cluster = new Cluster(db, { audit });
		// Task groups mount the task, approval and authorization routes, which the document must also describe.
		new TaskGroups(db, cluster, { audit });
	});

	afterAll(async () => {
		await cluster.close();
		await db.destroy();
	});

	it("describes the defined routes with their agent access", async () => {
		const audit = new Audit(db);
		const doc = apiDocument(createApp(db, { cluster, taskGroups: new TaskGroups(db, cluster, { audit }), audit }));
		const groups = doc.paths?.["/api/node-groups"];
		expect(groups?.get?.[AGENT_ACCESS_EXTENSION]).toBe("allow");
		expect(groups?.post?.[AGENT_ACCESS_EXTENSION]).toBe("ask");
		expect(doc.components?.schemas?.NodeGroup).toBeDefined();
		// A read is allowed, a settings mutation needs an approval and a signing credential is the owner's.
		const settings = doc.paths?.["/api/settings"];
		expect(settings?.get?.[AGENT_ACCESS_EXTENSION]).toBe("allow");
		expect(settings?.patch?.[AGENT_ACCESS_EXTENSION]).toBe("deny");
		expect(doc.paths?.["/api/me/signing-credentials"]?.get?.[AGENT_ACCESS_EXTENSION]).toBe("deny");
		expect(doc.paths?.["/api/node-access-grants"]?.post?.[AGENT_ACCESS_EXTENSION]).toBe("deny");
		for (const schema of ["SystemSettings", "NodeAccessGrant", "SigningCredentialView"]) {
			expect(doc.components?.schemas?.[schema]).toBeDefined();
		}

		// Nodes: reading metadata is allowed; a file's contents, an approval and a group change are not.
		expect(doc.paths?.["/api/nodes"]?.get?.[AGENT_ACCESS_EXTENSION]).toBe("allow");
		expect(doc.paths?.["/api/nodes/{id}"]?.get?.[AGENT_ACCESS_EXTENSION]).toBe("allow");
		expect(doc.paths?.["/api/nodes/{id}/file"]?.get?.[AGENT_ACCESS_EXTENSION]).toBe("deny");
		expect(doc.paths?.["/api/nodes/{id}/approve"]?.post?.[AGENT_ACCESS_EXTENSION]).toBe("deny");
		expect(doc.paths?.["/api/nodes/{id}/node-groups"]?.put?.[AGENT_ACCESS_EXTENSION]).toBe("deny");
		// Tasks: running and cancelling one needs an approval; reading one does not.
		expect(doc.paths?.["/api/nodes/{id}/tasks"]?.post?.[AGENT_ACCESS_EXTENSION]).toBe("ask");
		expect(doc.paths?.["/api/tasks/{id}/cancel"]?.post?.[AGENT_ACCESS_EXTENSION]).toBe("ask");
		expect(doc.paths?.["/api/tasks"]?.get?.[AGENT_ACCESS_EXTENSION]).toBe("allow");
		// Approvals and authorizations are decisions and signing material: an agent never makes them.
		expect(doc.paths?.["/api/approvals"]?.get?.[AGENT_ACCESS_EXTENSION]).toBe("allow");
		expect(doc.paths?.["/api/tasks/{id}/approval"]?.post?.[AGENT_ACCESS_EXTENSION]).toBe("deny");
		expect(doc.paths?.["/api/authorizations"]?.post?.[AGENT_ACCESS_EXTENSION]).toBe("deny");
		expect(doc.paths?.["/api/tasks/{id}/authorization"]?.get?.[AGENT_ACCESS_EXTENSION]).toBe("deny");
		// The auth flow and user management are closed to agents.
		expect(doc.paths?.["/api/auth/login"]?.post?.[AGENT_ACCESS_EXTENSION]).toBe("deny");
		expect(doc.paths?.["/api/auth/login-options"]?.get?.[AGENT_ACCESS_EXTENSION]).toBe("deny");
		expect(doc.paths?.["/api/users"]?.post?.[AGENT_ACCESS_EXTENSION]).toBe("deny");
		expect(doc.paths?.["/api/user-groups/{id}/members/{userId}"]?.put?.[AGENT_ACCESS_EXTENSION]).toBe("deny");
		expect(doc.paths?.["/api/users"]?.get?.[AGENT_ACCESS_EXTENSION]).toBe("allow");
		expect(doc.paths?.["/api/directory"]?.get?.[AGENT_ACCESS_EXTENSION]).toBe("allow");
		// A library upload writes user storage; reading and listing it are ordinary reads.
		expect(doc.paths?.["/api/libraries/{ref}/file"]?.put?.[AGENT_ACCESS_EXTENSION]).toBe("ask");
		expect(doc.paths?.["/api/libraries/{ref}/file"]?.get?.[AGENT_ACCESS_EXTENSION]).toBe("allow");
		expect(doc.paths?.["/api/libraries/{ref}/limits"]?.patch?.[AGENT_ACCESS_EXTENSION]).toBe("deny");
		for (const schema of [
			"TaskView",
			"TaskGroupView",
			"ApprovalList",
			"NodeDetailResponse",
			"User",
			"DirectoryResponse",
			"LibraryView",
			"PublicNode",
		]) {
			expect(doc.components?.schemas?.[schema]).toBeDefined();
		}
		for (const [path, item] of Object.entries(doc.paths ?? {})) {
			for (const method of ["get", "post", "put", "patch", "delete"] as const) {
				const operation = item[method];
				if (operation) expect([path, method, operation[AGENT_ACCESS_EXTENSION]]).not.toContain(undefined);
			}
		}
	});

	it("describes the schedule routes, which mount with the agent runtime", async () => {
		// The document only needs the route definitions; the handlers' dependencies are never called.
		const scheduler = {} as never;
		const models = {} as never;
		const app = new OpenAPIHono<AppEnv>();
		app.route("/api", scheduleRoutes(db, { scheduler, models, cluster, taskGroups: new TaskGroups(db, cluster) }));
		const doc = apiDocument(app);
		expect(doc.paths?.["/api/schedules"]?.get?.[AGENT_ACCESS_EXTENSION]).toBe("allow");
		expect(doc.paths?.["/api/schedules"]?.post?.[AGENT_ACCESS_EXTENSION]).toBe("deny");
		expect(doc.paths?.["/api/schedules/{id}"]?.patch?.[AGENT_ACCESS_EXTENSION]).toBe("deny");
		expect(doc.paths?.["/api/schedules/{id}/run"]?.post?.[AGENT_ACCESS_EXTENSION]).toBe("ask");
		expect(doc.paths?.["/api/schedules/{id}/runs"]?.get?.[AGENT_ACCESS_EXTENSION]).toBe("allow");
		expect(doc.components?.schemas?.ScheduleView).toBeDefined();
		expect(doc.components?.schemas?.ScheduleRunView).toBeDefined();
	});

	it("describes every route registered under /api, including the conditional groups", () => {
		// The runtime is only needed to register the session routes; no handler runs in this test.
		const runtime = {
			sessionList: {
				onVisibilityChanged: () => () => {},
				revalidateWebSessions: async () => {},
			},
		} as unknown as AgentRuntime;
		const app = createApp(db, {
			cluster,
			taskGroups: new TaskGroups(db, cluster, { audit: new Audit(db) }),
			audit: new Audit(db),
			masterKey: MasterKey.generate(),
			mcp: {} as never,
			agent: { runtime, models: {} as never },
			scheduler: {} as never,
		});
		const doc = apiDocument(app);
		const seen = new Set<string>();
		for (const route of app.routes) {
			// Middleware-only entries (`app.use`) are not operations.
			if (route.method === "ALL") continue;
			// `/api` routes are the API document's subject; `/mcp` and the static WebUI are not API routes.
			if (!route.path.startsWith("/api/")) continue;
			const path = route.path.replace(/:([^/]+)/g, "{$1}");
			const method = route.method.toLowerCase();
			const key = `${method} ${path}`;
			if (seen.has(key)) continue;
			seen.add(key);
			const operation = (doc.paths?.[path] as Record<string, Record<string, unknown> | undefined> | undefined)?.[
				method
			];
			expect(operation, key).toBeDefined();
			expect(operation?.[AGENT_ACCESS_EXTENSION], key).toMatch(/^(allow|ask|deny)$/);
		}
		// The walk saw the session, model, schedule and MCP groups that only mount with all dependencies.
		for (const key of [
			"get /api/sessions/stream",
			"get /api/sessions/{id}/events",
			"post /api/sessions",
			"get /api/models",
			"get /api/schedules",
			"get /api/mcp-servers",
			"get /api/health",
		]) {
			expect(seen.has(key), key).toBe(true);
		}
		// Session access: reads are allowed; messages need approval; guardrails, sharing and streams do not.
		const agent = (path: string, method: string) =>
			(doc.paths?.[path] as Record<string, Record<string, unknown> | undefined> | undefined)?.[method]?.[
				AGENT_ACCESS_EXTENSION
			];
		expect(agent("/api/sessions", "get")).toBe("allow");
		expect(agent("/api/sessions", "post")).toBe("ask");
		expect(agent("/api/sessions/{id}", "get")).toBe("allow");
		expect(agent("/api/sessions/{id}", "patch")).toBe("deny");
		expect(agent("/api/sessions/{id}/messages", "post")).toBe("ask");
		expect(agent("/api/sessions/{id}/shares", "put")).toBe("deny");
		expect(agent("/api/sessions/{id}/shares/{shareId}", "delete")).toBe("deny");
		expect(agent("/api/sessions/{id}/quota", "post")).toBe("deny");
		expect(agent("/api/sessions/stream", "get")).toBe("deny");
		expect(agent("/api/sessions/{id}/events", "get")).toBe("deny");
		expect(agent("/api/health", "get")).toBe("allow");
		for (const schema of [
			"SessionView",
			"SessionListResponse",
			"SessionSearchResponse",
			"SessionEntriesResponse",
			"HealthResponse",
		]) {
			expect(doc.components?.schemas?.[schema], schema).toBeDefined();
		}
	});
});
