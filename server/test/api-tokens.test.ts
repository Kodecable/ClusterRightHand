import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Audit } from "../src/audit/audit.ts";
import { createApiToken, resolveApiToken } from "../src/auth/api-tokens.ts";
import type { SessionUser } from "../src/auth/sessions.ts";
import { Cluster } from "../src/cluster/cluster.ts";
import { TaskGroups } from "../src/cluster/task-groups.ts";
import type { Db } from "../src/storage/db.ts";
import { createUser } from "../src/users/service.ts";
import { type App, call, login, makeApp } from "./helpers/api.ts";
import { describeBackends, openTestDb } from "./helpers/db.ts";

vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });

const DAY = 86_400_000;

interface TokenBody {
	token: string;
	apiToken: {
		id: string;
		name: string;
		userId: string;
		expiresAt: string | null;
		revokedAt: string | null;
		lastUsedAt: string | null;
		rules: { preset: string | null; rules: unknown[] } | null;
	};
}

describeBackends("api tokens", (backend) => {
	let db: Db;
	let app: App;
	let cluster: Cluster;
	let audit: Audit;
	const cookies: Record<string, string> = {};
	const users: Record<string, SessionUser> = {};

	const create = async (who: string, body: Record<string, unknown> = { name: "t" }) => {
		const res = await call(app, "/api/api-tokens", { cookie: cookies[who], body });
		return { res, body: (await res.json()) as TokenBody };
	};
	const ck = (who: string) => ({ cookie: cookies[who] });

	beforeAll(async () => {
		db = await openTestDb(backend);
		audit = new Audit(db);
		cluster = new Cluster(db, { audit });
		app = makeApp(db, undefined, { cluster, taskGroups: new TaskGroups(db, cluster, { audit }), audit });
		for (const [name, kind] of [
			["alice", "member"],
			["bob", "member"],
			["root", "admin"],
		] as const) {
			const u = await createUser(db, { username: name, kind, password: "password-123" });
			users[name] = { sessionId: "s", userId: u.id, username: name, kind };
			cookies[name] = await login(app, name, "password-123");
		}
	});
	afterAll(async () => {
		await cluster.close();
		await db.destroy();
	});

	it("requires a session", async () => {
		expect((await call(app, "/api/api-tokens")).status).toBe(401);
	});

	describe("create and list", () => {
		it("returns the secret once; list never contains it", async () => {
			const { res, body } = await create("alice", { name: "ci" });
			expect(res.status).toBe(201);
			expect(body.token).toMatch(/^crh_[A-Za-z0-9_-]{40,}$/);
			expect(body.apiToken.name).toBe("ci");
			expect(body.apiToken.userId).toBe(users.alice?.userId);
			const list = await call(app, "/api/api-tokens", ck("alice"));
			const text = await list.text();
			expect(text).not.toContain(body.token);
			expect(text).not.toContain("token_hash");
			expect((JSON.parse(text) as { tokens: { id: string }[] }).tokens.map((t) => t.id)).toContain(body.apiToken.id);
		});

		it("defaults to 90 days and the ask preset", async () => {
			const { body } = await create("alice", { name: "d" });
			const left = Date.parse(body.apiToken.expiresAt as string) - Date.now();
			expect(Math.abs(left - 90 * DAY)).toBeLessThan(60_000);
			expect(body.apiToken.rules?.preset).toBe("ask");
			expect(body.apiToken.rules?.rules).toEqual([]);
		});

		it("takes days, null for no expiry, and a preset", async () => {
			const none = await create("alice", { name: "n", days: null, preset: "yolo" });
			expect(none.res.status).toBe(201);
			expect(none.body.apiToken.expiresAt).toBeNull();
			expect(none.body.apiToken.rules?.preset).toBe("yolo");
			const seven = await create("alice", { name: "7", days: 7, preset: "auto_review" });
			expect(Math.abs(Date.parse(seven.body.apiToken.expiresAt as string) - Date.now() - 7 * DAY)).toBeLessThan(60_000);
			expect(seven.body.apiToken.rules?.preset).toBe("auto_review");
		});

		it("rejects bad input", async () => {
			expect((await create("alice", { name: "x", days: 400 })).res.status).toBe(400);
			expect((await create("alice", { name: "x", days: 0 })).res.status).toBe(400);
			expect((await create("alice", { name: "x", days: 1.5 })).res.status).toBe(400);
			expect((await create("alice", { name: "x", preset: "bogus" })).res.status).toBe(400);
			expect((await create("alice", { name: "  " })).res.status).toBe(400);
			expect((await create("alice", { name: "x".repeat(101) })).res.status).toBe(400);
		});
	});

	describe("resolveApiToken", () => {
		it("resolves a valid token to its user and records last use", async () => {
			const { body } = await create("alice", { name: "r" });
			expect(body.apiToken.lastUsedAt).toBeNull();
			const id = await resolveApiToken(db, body.token);
			expect(id?.tokenId).toBe(body.apiToken.id);
			expect(id?.user.userId).toBe(users.alice?.userId);
			expect(id?.user.kind).toBe("member");
			const row = await db
				.selectFrom("api_tokens")
				.select("last_used_at")
				.where("id", "=", body.apiToken.id)
				.executeTakeFirst();
			expect(row?.last_used_at).not.toBeNull();
		});

		it("rejects unknown, malformed and tampered tokens", async () => {
			const { body } = await create("alice", { name: "r2" });
			expect(await resolveApiToken(db, "crh_nope")).toBeUndefined();
			expect(await resolveApiToken(db, "nope")).toBeUndefined();
			expect(await resolveApiToken(db, "")).toBeUndefined();
			expect(await resolveApiToken(db, `${body.token}x`)).toBeUndefined();
		});

		it("rejects revoked and expired tokens", async () => {
			const { body } = await create("alice", { name: "r3", days: 1 });
			expect(await resolveApiToken(db, body.token, new Date(Date.now() + 2 * DAY))).toBeUndefined();
			expect(await resolveApiToken(db, body.token, new Date(Date.now() + 0.5 * DAY))).toBeDefined();
			const rv = await call(app, `/api/api-tokens/${body.apiToken.id}/revoke`, { cookie: cookies.alice, body: {} });
			expect(rv.status).toBe(200);
			expect(await resolveApiToken(db, body.token)).toBeUndefined();
		});

		it("rejects tokens of disabled users", async () => {
			const u = await createUser(db, { username: "carol", kind: "member", password: "password-123" });
			const { token } = await createApiToken(
				db,
				{ sessionId: "s", userId: u.id, username: "carol", kind: "member" },
				{ name: "c", preset: "ask" },
			);
			expect(await resolveApiToken(db, token)).toBeDefined();
			await db.updateTable("users").set({ status: "disabled" }).where("id", "=", u.id).execute();
			expect(await resolveApiToken(db, token)).toBeUndefined();
		});
	});

	describe("ownership", () => {
		it("hides a token from other users, admins included", async () => {
			const { body } = await create("alice", { name: "mine" });
			const id = body.apiToken.id;
			for (const who of ["bob", "root"]) {
				const list = (await (await call(app, "/api/api-tokens", ck(who))).json()) as { tokens: { id: string }[] };
				expect(list.tokens.map((t) => t.id)).not.toContain(id);
				expect((await call(app, `/api/api-tokens/${id}/revoke`, { cookie: cookies[who], body: {} })).status).toBe(404);
				expect(
					(
						await call(app, `/api/api-tokens/${id}/rules`, {
							cookie: cookies[who],
							method: "PUT",
							body: { preset: "yolo" },
						})
					).status,
				).toBe(404);
				expect(
					(await call(app, `/api/api-tokens/${id}`, { cookie: cookies[who], method: "DELETE", body: {} })).status,
				).toBe(404);
			}
			expect(await resolveApiToken(db, body.token)).toBeDefined();
		});
	});

	describe("revoke and delete", () => {
		it("deleting needs a revoke first", async () => {
			const { body } = await create("alice", { name: "del" });
			const id = body.apiToken.id;
			expect(
				(await call(app, `/api/api-tokens/${id}`, { cookie: cookies.alice, method: "DELETE", body: {} })).status,
			).toBe(400);
			const rv = await call(app, `/api/api-tokens/${id}/revoke`, { cookie: cookies.alice, body: {} });
			expect(((await rv.json()) as TokenBody).apiToken.revokedAt).not.toBeNull();
			// revoking again: no active token
			expect((await call(app, `/api/api-tokens/${id}/revoke`, { cookie: cookies.alice, body: {} })).status).toBe(404);
			expect(
				(await call(app, `/api/api-tokens/${id}`, { cookie: cookies.alice, method: "DELETE", body: {} })).status,
			).toBe(200);
			const list = (await (await call(app, "/api/api-tokens", ck("alice"))).json()) as { tokens: { id: string }[] };
			expect(list.tokens.map((t) => t.id)).not.toContain(id);
			const rs = await db.selectFrom("rule_sets").select("id").where("scope_id", "=", id).execute();
			expect(rs).toEqual([]);
		});
	});

	describe("rules", () => {
		it("changes preset and rules, and audits it", async () => {
			const { body } = await create("alice", { name: "rules" });
			const id = body.apiToken.id;
			const put = (b: unknown) =>
				call(app, `/api/api-tokens/${id}/rules`, { cookie: cookies.alice, method: "PUT", body: b });

			let res = await put({ preset: "yolo" });
			expect(res.status).toBe(200);
			let view = ((await res.json()) as TokenBody).apiToken;
			expect(view.rules?.preset).toBe("yolo");
			expect(view.rules?.rules).toEqual([]);

			const rules = [{ action: "deny", method: "exec", prefix: "rm " }];
			res = await put({ rules });
			view = ((await res.json()) as TokenBody).apiToken;
			expect(view.rules?.preset).toBe("yolo"); // kept
			expect(view.rules?.rules).toEqual(rules);

			res = await put({ preset: "ask", rules: [] });
			view = ((await res.json()) as TokenBody).apiToken;
			expect(view.rules).toMatchObject({ preset: "ask", rules: [] });

			await audit.flush();
			const ev = (await (await call(app, `/api/audit?action=rules.changed&targetId=${id}`, ck("alice"))).json()) as {
				items: { action: string; targetType: string; detail: { preset?: string } }[];
			};
			expect(ev.items).toHaveLength(3);
			expect(ev.items[0]).toMatchObject({ action: "rules.changed", targetType: "api_token" });
			expect(ev.items[2]?.detail.preset).toBe("yolo");
		});

		it("rejects invalid rules and leaves the token unchanged", async () => {
			const { body } = await create("alice", { name: "bad" });
			const id = body.apiToken.id;
			const put = (b: unknown) =>
				call(app, `/api/api-tokens/${id}/rules`, { cookie: cookies.alice, method: "PUT", body: b });
			expect((await put({ rules: [{ action: "allow", regex: ".*" }] })).status).toBe(400);
			expect((await put({ rules: [{ action: "maybe" }] })).status).toBe(400);
			expect((await put({ rules: "x" })).status).toBe(400);
			expect((await put({ preset: "nope" })).status).toBe(400);
			const list = (await (await call(app, "/api/api-tokens", ck("alice"))).json()) as {
				tokens: TokenBody["apiToken"][];
			};
			const t = list.tokens.find((x) => x.id === id);
			expect(t?.rules).toMatchObject({ preset: "ask", rules: [] });
		});
	});

	describe("/mcp authentication", () => {
		const mcp = (headers: Record<string, string | undefined> = {}) =>
			call(app, "/mcp", {
				method: "POST",
				headers: { accept: "application/json, text/event-stream", ...headers },
				body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
			});

		it("rejects a missing or bad bearer with WWW-Authenticate", async () => {
			for (const headers of [
				{},
				{ authorization: "Bearer crh_bogus" },
				{ authorization: "Basic abc" },
				{ authorization: "Bearer" },
			]) {
				const res = await mcp(headers);
				expect(res.status).toBe(401);
				expect(res.headers.get("www-authenticate")).toMatch(/^Bearer/);
			}
		});

		it("rejects a revoked token and a session cookie", async () => {
			const { body } = await create("alice", { name: "mcp" });
			await call(app, `/api/api-tokens/${body.apiToken.id}/revoke`, { cookie: cookies.alice, body: {} });
			const res = await mcp({ authorization: `Bearer ${body.token}` });
			expect(res.status).toBe(401);
			expect(res.headers.get("www-authenticate")).toMatch(/^Bearer/);
			expect((await mcp({ cookie: cookies.alice })).status).toBe(401);
		});

		it("accepts a valid token", async () => {
			const { body } = await create("alice", { name: "mcp-ok" });
			const res = await mcp({ authorization: `Bearer ${body.token}` });
			expect(res.status).not.toBe(401);
		});
	});
});
