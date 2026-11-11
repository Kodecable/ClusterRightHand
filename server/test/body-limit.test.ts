import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_BODY_LIMIT, MAX_INPUT_BASE64_LENGTH, MAX_INPUT_BYTES } from "../src/api/body-limit.ts";
import { Cluster } from "../src/cluster/cluster.ts";
import { TaskGroups } from "../src/cluster/task-groups.ts";
import type { Db } from "../src/storage/db.ts";
import { createUser, defaultOrgId } from "../src/users/service.ts";
import { newId } from "../src/util/id.ts";
import { type App, call, login, makeApp } from "./helpers/api.ts";
import { openTestDb } from "./helpers/db.ts";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 30_000 });

describe("request body limits (sqlite)", () => {
	let db: Db;
	let app: App;
	let cluster: Cluster;
	let cookie: string;
	let nodeId: string;

	const addNode = async (name: string): Promise<string> => {
		const id = newId();
		const now = new Date().toISOString();
		await db
			.insertInto("nodes")
			.values({
				id,
				org_id: await defaultOrgId(db),
				name,
				name_key: name.toLowerCase(),
				transport: "client",
				status: "active",
				public_key: null,
				hostname: name,
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
		const user = await db.selectFrom("users").select("id").where("username", "=", "alice").executeTakeFirstOrThrow();
		await db
			.insertInto("node_access_grants")
			.values({
				id: newId(),
				org_id: await defaultOrgId(db),
				grantee_type: "user",
				grantee_id: user.id,
				target_type: "node",
				target_id: id,
				created_by_user_id: user.id,
				created_at: now,
			})
			.execute();
		return id;
	};

	beforeAll(async () => {
		db = await openTestDb("sqlite");
		cluster = new Cluster(db, { nodeOfflineGraceMs: 0 });
		const groups = new TaskGroups(db, cluster, {});
		app = makeApp(db, undefined, { cluster, taskGroups: groups });
		await createUser(db, { username: "alice", kind: "member", password: "password-123" });
		cookie = await login(app, "alice", "password-123");
		nodeId = await addNode("n1");
	});

	afterAll(async () => {
		await cluster.close();
		await db.destroy();
	});

	it("rejects a login body over the default limit before parsing or auditing it", async () => {
		const before = await db
			.selectFrom("audit_events")
			.select("seq")
			.where("action", "=", "auth.login_failed")
			.execute();
		const oversized = "u".repeat(DEFAULT_BODY_LIMIT);
		const parse = vi.spyOn(JSON, "parse");
		try {
			const res = await call(app, "/api/auth/login", { body: { username: oversized, password: "wrong-password" } });
			expect(res.status).toBe(413);
			expect(await res.json()).toEqual({ error: "request body too large" });
			// The handler never ran, so the oversized JSON was not parsed.
			expect(parse.mock.calls.some(([text]) => typeof text === "string" && text.length > DEFAULT_BODY_LIMIT)).toBe(
				false,
			);
		} finally {
			parse.mockRestore();
		}
		const after = await db.selectFrom("audit_events").select("seq").where("action", "=", "auth.login_failed").execute();
		expect(after.length).toBe(before.length);
	});

	it("accepts a task body above the default limit within the task input limit", async () => {
		const stdin = "x".repeat(DEFAULT_BODY_LIMIT + 256 * 1024);
		const res = await call(app, `/api/nodes/${nodeId}/tasks`, {
			cookie,
			body: { kind: "exec", shell: "cat", stdin },
		});
		expect(res.status).toBe(201);
		const { task } = (await res.json()) as { task: { id: string } };
		const row = await db.selectFrom("tasks").select("input_size").where("id", "=", task.id).executeTakeFirstOrThrow();
		expect(row.input_size).toBe(Buffer.byteLength(stdin, "utf8"));
	});

	it("gives /mcp the task input limit, above the default", async () => {
		const res = await app.request("/mcp", {
			method: "POST",
			headers: { host: "localhost:8080", "content-type": "application/json" },
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/list",
				params: { padding: "x".repeat(DEFAULT_BODY_LIMIT + 256 * 1024) },
			}),
		});
		// The body passed the route's own limit; without a bearer token it stops at the MCP auth check.
		expect(res.status).toBe(401);
	});

	it("rejects an oversized contentBase64 before decoding it", async () => {
		const contentBase64 = "A".repeat(MAX_INPUT_BASE64_LENGTH + 1);
		const res = await call(app, `/api/nodes/${nodeId}/tasks`, {
			cookie,
			body: { kind: "file.write", path: "/tmp/big", contentBase64 },
		});
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "contentBase64 too large" });
	});

	it("rejects stdin over the input limit", async () => {
		const stdin = "s".repeat(MAX_INPUT_BYTES + 1);
		const res = await call(app, `/api/nodes/${nodeId}/tasks`, {
			cookie,
			body: { kind: "exec", shell: "cat", stdin },
		});
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "stdin too large" });
	});

	it("truncates the username kept in a failed login's audit record", async () => {
		const username = "u".repeat(300);
		const res = await call(app, "/api/auth/login", { body: { username, password: "wrong-password" } });
		expect(res.status).toBe(401);
		const row = await (async () => {
			for (let i = 0; i < 100; i++) {
				const found = await db
					.selectFrom("audit_events")
					.select("detail")
					.where("action", "=", "auth.login_failed")
					.execute()
					.then((rows) =>
						rows.find((r) => (JSON.parse(r.detail) as { username?: string }).username?.startsWith("uuu")),
					);
				if (found) return found;
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			return undefined;
		})();
		expect(row).toBeDefined();
		const detail = JSON.parse(row?.detail ?? "{}") as { username?: string };
		expect(detail.username).toBe(username.slice(0, 256));
	});
});
