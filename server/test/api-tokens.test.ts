import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { rejectExpiredTokenWaits } from "../src/api/api-token-waits.ts";
import { Audit } from "../src/audit/audit.ts";
import { createApiToken, resolveApiToken } from "../src/auth/api-tokens.ts";
import type { SessionUser } from "../src/auth/sessions.ts";
import { Cluster } from "../src/cluster/cluster.ts";
import { createNodeGroup } from "../src/cluster/node-groups.ts";
import { TaskGroups } from "../src/cluster/task-groups.ts";
import type { Db } from "../src/storage/db.ts";
import { createUser, defaultOrgId } from "../src/users/service.ts";
import { newId } from "../src/util/id.ts";
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
		rules: { rulePreset: string | null; rules: unknown[] } | null;
	};
}

describeBackends("api tokens", (backend) => {
	let db: Db;
	let app: App;
	let cluster: Cluster;
	let taskGroups: TaskGroups;
	let audit: Audit;
	const cookies: Record<string, string> = {};
	const users: Record<string, SessionUser> = {};

	const create = async (who: string, body: Record<string, unknown> = { name: "t" }) => {
		const res = await call(app, "/api/api-tokens", { cookie: cookies[who], body });
		return { res, body: (await res.json()) as TokenBody };
	};
	const ck = (who: string) => ({ cookie: cookies[who] });

	/** A task the token started that still waits for its approval. */
	const insertWaitingTask = async (
		tokenId: string,
		onBehalfOfUserId = users.alice?.userId as string,
	): Promise<string> => {
		const id = newId();
		const now = new Date().toISOString();
		await db
			.insertInto("tasks")
			.values({
				id,
				org_id: await defaultOrgId(db),
				node_id: "no-such-node",
				task_group_id: null,
				kind: "exec",
				spec: JSON.stringify({ kind: "exec", command: { argv: ["true"] }, env: {}, cwd: "", stdin: null }),
				input_size: null,
				input_sha256: null,
				privileged: 0,
				attempt: 1,
				timeout_ms: null,
				output_mode: "full",
				state: "awaiting_approval",
				exit_code: null,
				signal: null,
				timed_out: 0,
				cancelled: 0,
				error_code: null,
				error_message: null,
				actor_type: "api_token",
				actor_id: tokenId,
				on_behalf_of_user_id: onBehalfOfUserId,
				created_at: now,
				dispatched_at: null,
				accepted_at: null,
				finished_at: null,
				output_bytes: 0,
				output_head: null,
				output_tail: null,
				notice: null,
				output_file: null,
				late_result: null,
				rule_chain: null,
				approval: null,
				pending_input: null,
				root_session_id: null,
				handler_type: "user",
				handler_session_id: null,
			})
			.execute();
		return id;
	};

	/** A task group the token started that still waits for its approval. */
	const insertWaitingGroup = async (
		tokenId: string,
		onBehalfOfUserId = users.alice?.userId as string,
	): Promise<string> => {
		const id = newId();
		await db
			.insertInto("task_groups")
			.values({
				id,
				org_id: await defaultOrgId(db),
				targets: JSON.stringify(["web-1"]),
				node_ids: JSON.stringify(["no-such-node"]),
				kind: "exec",
				parallel: 1,
				fail_fast: 0,
				output_mode: "status",
				privileged: 0,
				skipped: "[]",
				state: "awaiting_approval",
				actor_type: "api_token",
				actor_id: tokenId,
				on_behalf_of_user_id: onBehalfOfUserId,
				created_at: new Date().toISOString(),
				finished_at: null,
			})
			.execute();
		return id;
	};

	beforeAll(async () => {
		db = await openTestDb(backend);
		audit = new Audit(db);
		cluster = new Cluster(db, { audit });
		taskGroups = new TaskGroups(db, cluster, { audit });
		app = makeApp(db, undefined, { cluster, taskGroups, audit });
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

		it("defaults to 90 days and the ask rule preset", async () => {
			const { body } = await create("alice", { name: "d" });
			const left = Date.parse(body.apiToken.expiresAt as string) - Date.now();
			expect(Math.abs(left - 90 * DAY)).toBeLessThan(60_000);
			expect(body.apiToken.rules?.rulePreset).toBe("ask");
			expect(body.apiToken.rules?.rules).toEqual([]);
		});

		it("takes days, null for no expiry, and a rule preset", async () => {
			const none = await create("alice", { name: "n", days: null, rulePreset: "yolo" });
			expect(none.res.status).toBe(201);
			expect(none.body.apiToken.expiresAt).toBeNull();
			expect(none.body.apiToken.rules?.rulePreset).toBe("yolo");
			const seven = await create("alice", { name: "7", days: 7, rulePreset: "auto_review" });
			expect(Math.abs(Date.parse(seven.body.apiToken.expiresAt as string) - Date.now() - 7 * DAY)).toBeLessThan(60_000);
			expect(seven.body.apiToken.rules?.rulePreset).toBe("auto_review");
		});

		it("rejects bad input", async () => {
			expect((await create("alice", { name: "x", days: 400 })).res.status).toBe(400);
			expect((await create("alice", { name: "x", days: 0 })).res.status).toBe(400);
			expect((await create("alice", { name: "x", days: 1.5 })).res.status).toBe(400);
			expect((await create("alice", { name: "x", rulePreset: "bogus" })).res.status).toBe(400);
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
				{ name: "c", rulePreset: "ask" },
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
							body: { rulePreset: "yolo" },
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
		it("rejects the token's waiting tasks and groups on revoke", async () => {
			const { body } = await create("alice", { name: "revoke-waiting" });
			const tokenId = body.apiToken.id;
			const taskId = await insertWaitingTask(tokenId);
			const groupId = await insertWaitingGroup(tokenId);
			const res = await call(app, `/api/api-tokens/${tokenId}/revoke`, { cookie: cookies.alice, body: {} });
			expect(res.status).toBe(200);
			expect(
				await db.selectFrom("tasks").select(["state", "error_code"]).where("id", "=", taskId).executeTakeFirstOrThrow(),
			).toMatchObject({ state: "rejected", error_code: "approval_rejected" });
			expect(
				(await db.selectFrom("task_groups").select("state").where("id", "=", groupId).executeTakeFirstOrThrow()).state,
			).toBe("rejected");
		});

		it("rejects an expired token's waiting work once, like revoke", async () => {
			const expired = await create("alice", { name: "expired-waiting" });
			const live = await create("alice", { name: "still-valid" });
			const expiredTask = await insertWaitingTask(expired.body.apiToken.id);
			const expiredGroup = await insertWaitingGroup(expired.body.apiToken.id);
			const liveTask = await insertWaitingTask(live.body.apiToken.id);
			await db
				.updateTable("api_tokens")
				.set({ expires_at: new Date(Date.now() - 60_000).toISOString() })
				.where("id", "=", expired.body.apiToken.id)
				.execute();

			expect(await rejectExpiredTokenWaits(db, cluster, taskGroups)).toBe(2);
			expect(
				await db
					.selectFrom("tasks")
					.select(["state", "error_message"])
					.where("id", "=", expiredTask)
					.executeTakeFirstOrThrow(),
			).toMatchObject({ state: "rejected", error_message: "the API token expired" });
			const group = await db
				.selectFrom("task_groups")
				.select(["state", "approval"])
				.where("id", "=", expiredGroup)
				.executeTakeFirstOrThrow();
			expect(group.state).toBe("rejected");
			expect(JSON.parse(group.approval as string)).toMatchObject({
				decision: { decision: "rejected", reason: "the API token expired" },
			});
			// A token that has not expired keeps its waiting task.
			expect(
				await db.selectFrom("tasks").select("state").where("id", "=", liveTask).executeTakeFirstOrThrow(),
			).toMatchObject({ state: "awaiting_approval" });
			// The sweep is idempotent: the first run left nothing waiting.
			expect(await rejectExpiredTokenWaits(db, cluster, taskGroups)).toBe(0);
		});
	});

	describe("password changes", () => {
		const newUser = async (name: string) => {
			const u = await createUser(db, { username: name, kind: "member", password: "password-123" });
			users[name] = { sessionId: "s", userId: u.id, username: name, kind: "member" };
			cookies[name] = await login(app, name, "password-123");
			return u;
		};

		it("self password change revokes every token when asked, in the audit too", async () => {
			await newUser("pw-self-revoke");
			const first = await create("pw-self-revoke", { name: "a" });
			const second = await create("pw-self-revoke", { name: "b" });
			const untouched = await create("alice", { name: "self-revoke-untouched" });
			const res = await call(app, "/api/auth/password", {
				cookie: cookies["pw-self-revoke"],
				body: { currentPassword: "password-123", newPassword: "new-password-123", revokeApiTokens: true },
			});
			expect(res.status).toBe(200);
			expect(await resolveApiToken(db, first.body.token)).toBeUndefined();
			expect(await resolveApiToken(db, second.body.token)).toBeUndefined();
			expect(await resolveApiToken(db, untouched.body.token)).toBeDefined();

			await audit.flush();
			const events = await db
				.selectFrom("audit_events")
				.selectAll()
				.where("action", "=", "auth.password_changed")
				.where("target_id", "=", users["pw-self-revoke"]?.userId as string)
				.execute();
			expect(events).toHaveLength(1);
			expect(JSON.parse(events[0]?.detail ?? "{}")).toMatchObject({
				revoke_api_tokens: true,
				revoked_api_tokens: 2,
			});
		});

		it("self password change leaves tokens when the flag is absent or false", async () => {
			for (const [name, flag] of [
				["pw-self-keep-absent", undefined],
				["pw-self-keep-false", false],
			] as const) {
				await newUser(name);
				const { body } = await create(name, { name: "keep" });
				const res = await call(app, "/api/auth/password", {
					cookie: cookies[name],
					body: {
						currentPassword: "password-123",
						newPassword: "new-password-123",
						...(flag === undefined ? {} : { revokeApiTokens: flag }),
					},
				});
				expect(res.status).toBe(200);
				expect(await resolveApiToken(db, body.token)).toBeDefined();
			}
		});

		it("an admin reset revokes every token when asked", async () => {
			const target = await newUser("pw-reset-revoke");
			const first = await create("pw-reset-revoke", { name: "a" });
			const second = await create("pw-reset-revoke", { name: "b" });
			const res = await call(app, `/api/users/${target.id}/password`, {
				cookie: cookies.root,
				body: { password: "reset-password-123", revokeApiTokens: true },
			});
			expect(res.status).toBe(200);
			expect(await resolveApiToken(db, first.body.token)).toBeUndefined();
			expect(await resolveApiToken(db, second.body.token)).toBeUndefined();

			await audit.flush();
			const events = await db
				.selectFrom("audit_events")
				.selectAll()
				.where("action", "=", "user.password_reset")
				.where("target_id", "=", target.id)
				.execute();
			expect(JSON.parse(events[0]?.detail ?? "{}")).toMatchObject({
				revoke_api_tokens: true,
				revoked_api_tokens: 2,
			});
		});

		it("an admin reset keeps tokens when the flag is absent or false", async () => {
			for (const [name, flag] of [
				["pw-reset-keep-absent", undefined],
				["pw-reset-keep-false", false],
			] as const) {
				const target = await newUser(name);
				const { body } = await create(name, { name: "keep" });
				const res = await call(app, `/api/users/${target.id}/password`, {
					cookie: cookies.root,
					body: { password: "reset-password-123", ...(flag === undefined ? {} : { revokeApiTokens: flag }) },
				});
				expect(res.status).toBe(200);
				expect(await resolveApiToken(db, body.token)).toBeDefined();
			}
		});
		it("self password change rejects a revoked token's waiting task and group", async () => {
			const target = await newUser("pw-self-revoke-waits");
			const { body } = await create("pw-self-revoke-waits", { name: "waits" });
			const taskId = await insertWaitingTask(body.apiToken.id, target.id);
			const groupId = await insertWaitingGroup(body.apiToken.id, target.id);
			const res = await call(app, "/api/auth/password", {
				cookie: cookies["pw-self-revoke-waits"],
				body: { currentPassword: "password-123", newPassword: "new-password-123", revokeApiTokens: true },
			});
			expect(res.status).toBe(200);
			const task = await db
				.selectFrom("tasks")
				.select(["state", "error_code", "error_message", "approval"])
				.where("id", "=", taskId)
				.executeTakeFirstOrThrow();
			expect(task).toMatchObject({
				state: "rejected",
				error_code: "approval_rejected",
				error_message: "the API token was revoked",
			});
			expect(JSON.parse(task.approval as string)).toMatchObject({
				decision: {
					decision: "rejected",
					by: { type: "user", id: target.id, onBehalfOfUserId: target.id },
					reason: "the API token was revoked",
				},
			});
			expect(
				(await db.selectFrom("task_groups").select("state").where("id", "=", groupId).executeTakeFirstOrThrow()).state,
			).toBe("rejected");
		});

		it("self password change leaves a token's waiting task when the flag is false", async () => {
			const target = await newUser("pw-self-keep-waits");
			const { body } = await create("pw-self-keep-waits", { name: "waits" });
			const taskId = await insertWaitingTask(body.apiToken.id, target.id);
			const res = await call(app, "/api/auth/password", {
				cookie: cookies["pw-self-keep-waits"],
				body: { currentPassword: "password-123", newPassword: "new-password-123", revokeApiTokens: false },
			});
			expect(res.status).toBe(200);
			expect(
				(await db.selectFrom("tasks").select("state").where("id", "=", taskId).executeTakeFirstOrThrow()).state,
			).toBe("awaiting_approval");
		});

		it("an admin reset rejects the revoked token's waiting task as the administrator", async () => {
			const target = await newUser("pw-reset-revoke-waits");
			const { body } = await create("pw-reset-revoke-waits", { name: "waits" });
			const taskId = await insertWaitingTask(body.apiToken.id, target.id);
			const res = await call(app, `/api/users/${target.id}/password`, {
				cookie: cookies.root,
				body: { password: "reset-password-123", revokeApiTokens: true },
			});
			expect(res.status).toBe(200);
			const task = await db
				.selectFrom("tasks")
				.select(["state", "error_message", "approval"])
				.where("id", "=", taskId)
				.executeTakeFirstOrThrow();
			expect(task).toMatchObject({ state: "rejected", error_message: "the API token was revoked" });
			expect(JSON.parse(task.approval as string)).toMatchObject({
				decision: {
					decision: "rejected",
					by: { type: "user", id: users.root?.userId, onBehalfOfUserId: users.root?.userId },
					reason: "the API token was revoked",
				},
			});
		});
	});

	describe("rules", () => {
		it("changes rule preset and rules, and audits it", async () => {
			const { body } = await create("alice", { name: "rules" });
			const id = body.apiToken.id;
			const put = (b: unknown) =>
				call(app, `/api/api-tokens/${id}/rules`, { cookie: cookies.alice, method: "PUT", body: b });

			let res = await put({ rulePreset: "yolo" });
			expect(res.status).toBe(200);
			let view = ((await res.json()) as TokenBody).apiToken;
			expect(view.rules?.rulePreset).toBe("yolo");
			expect(view.rules?.rules).toEqual([]);

			const rules = [{ action: "deny", method: "exec", prefix: "rm " }];
			res = await put({ rules });
			view = ((await res.json()) as TokenBody).apiToken;
			expect(view.rules?.rulePreset).toBe("yolo"); // kept
			expect(view.rules?.rules).toEqual(rules);

			res = await put({ rulePreset: "ask", rules: [] });
			view = ((await res.json()) as TokenBody).apiToken;
			expect(view.rules).toMatchObject({ rulePreset: "ask", rules: [] });

			await audit.flush();
			const ev = (await (await call(app, `/api/audit?action=rules.changed&targetId=${id}`, ck("alice"))).json()) as {
				items: { action: string; targetType: string; detail: { rule_preset?: string } }[];
			};
			expect(ev.items).toHaveLength(3);
			expect(ev.items[0]).toMatchObject({ action: "rules.changed", targetType: "api_token" });
			expect(ev.items[2]?.detail.rule_preset).toBe("yolo");
		});

		it.skipIf(backend !== "sqlite")("rolls the rule preset back when the rules cannot be written", async () => {
			const { body } = await create("alice", { name: "atomic" });
			const id = body.apiToken.id;
			await sql`create trigger fail_rule_update before update of rules on rule_sets begin select raise(abort, 'injected rule failure'); end`.execute(
				db,
			);
			try {
				const res = await call(app, `/api/api-tokens/${id}/rules`, {
					cookie: cookies.alice,
					method: "PUT",
					body: { rulePreset: "yolo", rules: [] },
				});
				expect(res.status).toBe(500);
			} finally {
				await sql`drop trigger fail_rule_update`.execute(db);
			}
			// Both statements are one transaction: the preset must not stay changed when the rules write failed.
			const list = (await (await call(app, "/api/api-tokens", ck("alice"))).json()) as {
				tokens: TokenBody["apiToken"][];
			};
			expect(list.tokens.find((token) => token.id === id)?.rules).toMatchObject({ rulePreset: "ask", rules: [] });
		});

		it("resolves node names to UUIDs at write time and returns display names", async () => {
			const orgId = await defaultOrgId(db);
			const group = await createNodeGroup(db, orgId, "Prod");
			const nodeId = newId();
			const now = new Date().toISOString();
			await db
				.insertInto("nodes")
				.values({
					id: nodeId,
					org_id: orgId,
					name: "Web-1",
					name_key: "web-1",
					transport: "client",
					status: "active",
					public_key: null,
					hostname: "web-1",
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
					ssh_host_key: null,
					ssh_credential_id: null,
					ssh_jumps: null,
				})
				.execute();

			const { body } = await create("alice", { name: "refs" });
			const id = body.apiToken.id;
			let res = await call(app, `/api/api-tokens/${id}/rules`, {
				cookie: cookies.alice,
				method: "PUT",
				body: { rules: [{ action: "allow", method: "exec", nodes: ["web-1", "prod", "_all"] }] },
			});
			expect(res.status).toBe(200);
			const view = (await res.json()) as {
				apiToken: { rules: { rules: { nodes?: string[] }[] }; refs: Record<string, unknown> };
			};
			expect(view.apiToken.rules.rules[0]?.nodes).toEqual([nodeId, group.id, "_all"]);
			expect(view.apiToken.refs).toEqual({
				[nodeId]: { kind: "node", name: "Web-1" },
				[group.id]: { kind: "node_group", name: "Prod" },
			});

			res = await call(app, `/api/api-tokens/${id}/rules`, {
				cookie: cookies.alice,
				method: "PUT",
				body: { rules: [{ action: "allow", nodes: ["missing"] }] },
			});
			expect(res.status).toBe(400);
			expect(((await res.json()) as { error: string }).error).toMatch(/no node or node group missing/);

			// A deleted object is kept as a reference and displayed as null.
			await db.deleteFrom("node_groups").where("id", "=", group.id).execute();
			const listed = (await (await call(app, "/api/api-tokens", { cookie: cookies.alice })).json()) as {
				tokens: (typeof view.apiToken & { id: string })[];
			};
			expect(listed.tokens.find((token) => token.id === id)?.refs[group.id]).toBeNull();
		});

		it("rejects invalid rules and leaves the token unchanged", async () => {
			const { body } = await create("alice", { name: "bad" });
			const id = body.apiToken.id;
			const put = (b: unknown) =>
				call(app, `/api/api-tokens/${id}/rules`, { cookie: cookies.alice, method: "PUT", body: b });
			expect((await put({ rules: [{ action: "allow", regex: ".*" }] })).status).toBe(400);
			expect((await put({ rules: [{ action: "maybe" }] })).status).toBe(400);
			expect((await put({ rules: "x" })).status).toBe(400);
			expect((await put({ rulePreset: "nope" })).status).toBe(400);
			const list = (await (await call(app, "/api/api-tokens", ck("alice"))).json()) as {
				tokens: TokenBody["apiToken"][];
			};
			const t = list.tokens.find((x) => x.id === id);
			expect(t?.rules).toMatchObject({ rulePreset: "ask", rules: [] });
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
