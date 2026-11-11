import type { SystemSettings } from "@crh/api";
import { afterEach, describe, expect, it } from "vitest";
import { createClientAddress } from "../src/api/client-address.ts";
import { Audit } from "../src/audit/audit.ts";
import { resetHashGateForTesting } from "../src/auth/hash-gate.ts";
import type { RetentionConfig } from "../src/config.ts";
import { SettingsStore } from "../src/settings/settings.ts";
import type { Db } from "../src/storage/db.ts";
import {
	type RetentionCounts,
	type RetentionOptions,
	runRetention,
	startRetentionSweep,
} from "../src/storage/retention.ts";
import { createUser, defaultOrgId } from "../src/users/service.ts";
import { newId } from "../src/util/id.ts";
import { type App, call, login, makeApp } from "./helpers/api.ts";
import { openTestDb } from "./helpers/db.ts";

interface Fixture {
	db: Db;
	store: SettingsStore;
	app: App;
	audit: Audit;
	admin: string;
}

/**
 * An app whose password login has no captcha (set through the same store it edits), plus an
 * administrator session. `patch` can adjust other settings before the app is built.
 */
async function setup(
	patch: Record<string, unknown> = {},
	appOptions: Parameters<typeof makeApp>[2] = {},
): Promise<Fixture> {
	const db = await openTestDb("sqlite");
	const store = await SettingsStore.load(db);
	await store.patch(db, { auth: { captcha: "none" }, ...patch }, null);
	const audit = new Audit(db);
	const app = makeApp(db, undefined, { settings: store, audit, ...appOptions });
	await createUser(db, { username: "root", kind: "admin", password: "root-password" });
	const admin = await login(app, "root", "root-password");
	return { db, store, app, audit, admin };
}

async function waitFor(what: string, condition: () => boolean, timeoutMs = 3_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

afterEach(() => {
	resetHashGateForTesting();
});

describe("settings applied without a restart", () => {
	it("changes the captcha mode of login and the challenge endpoint", async () => {
		const { db, app, admin } = await setup();
		try {
			expect(await (await call(app, "/api/auth/login-options")).json()).toEqual({ captcha: "none" });
			const disabled = await call(app, "/api/auth/login/challenge", {
				body: { username: "root", tag: "A".repeat(43) },
			});
			expect(disabled.status).toBe(404);

			const patched = await call(app, "/api/settings", {
				method: "PATCH",
				cookie: admin,
				body: { auth: { captcha: "cap" } },
			});
			expect(patched.status).toBe(200);

			expect(await (await call(app, "/api/auth/login-options")).json()).toEqual({ captcha: "cap" });
			const challenge = await call(app, "/api/auth/login/challenge", {
				body: { username: "root", tag: "A".repeat(43) },
			});
			expect(challenge.status).toBe(200);
			const login = await call(app, "/api/auth/login", { body: { username: "root", password: "root-password" } });
			expect(login.status).toBe(400);
			expect(((await login.json()) as { code: string }).code).toBe("captcha_required");
		} finally {
			await db.destroy();
		}
	});

	it("changes which header supplies the client address", async () => {
		const db = await openTestDb("sqlite");
		const store = await SettingsStore.load(db);
		await store.patch(db, { auth: { captcha: "none" } }, null);
		const audit = new Audit(db);
		const app = makeApp(db, undefined, {
			settings: store,
			audit,
			// Late-bound: the app never captures the header name.
			clientAddress: createClientAddress(() => store.current().realIpHeader),
		});
		await createUser(db, { username: "root", kind: "admin", password: "root-password" });
		const admin = await login(app, "root", "root-password");
		const failedAddress = async (): Promise<unknown> => {
			await audit.flush();
			const row = await db
				.selectFrom("audit_events")
				.select("detail")
				.where("action", "=", "auth.login_failed")
				.orderBy("seq", "desc")
				.executeTakeFirst();
			return (JSON.parse(row?.detail ?? "{}") as { address?: unknown }).address;
		};
		try {
			await call(app, "/api/auth/login", { body: { username: "root", password: "wrong" } });
			expect(await failedAddress()).toBeUndefined();

			const patched = await call(app, "/api/settings", {
				method: "PATCH",
				cookie: admin,
				body: { realIpHeader: "X-Real-IP" },
			});
			expect(patched.status).toBe(200);
			await call(app, "/api/auth/login", {
				body: { username: "root", password: "wrong" },
				headers: { "x-real-ip": "203.0.113.9" },
			});
			expect(await failedAddress()).toBe("203.0.113.9");
		} finally {
			await db.destroy();
		}
	});

	it("changes the WebAuthn origins accepted for registration options", async () => {
		const { db, app, admin } = await setup();
		const options = (origin: string) =>
			call(app, "/api/me/credentials/webauthn/options", {
				method: "POST",
				cookie: admin,
				body: {},
				headers: { origin, host: new URL(origin).host },
			});
		try {
			// Unset: the relying party follows the request's Origin.
			expect((await options("https://crh.example.com")).status).toBe(200);

			const patched = await call(app, "/api/settings", {
				method: "PATCH",
				cookie: admin,
				body: { webauthn: { rpId: "crh.example.com", origins: ["https://crh.example.com"] } },
			});
			expect(patched.status).toBe(200);

			const foreign = await options("https://evil.example");
			expect(foreign.status).toBe(400);
			expect(((await foreign.json()) as { error: string }).error).toMatch(/not one of webauthn\.origins/);
			const allowed = await options("https://crh.example.com");
			expect(allowed.status).toBe(200);
			const body = (await allowed.json()) as { options: { rp: { id: string } } };
			expect(body.options.rp.id).toBe("crh.example.com");
		} finally {
			await db.destroy();
		}
	});

	it("changes the clock warning threshold returned by the node API", async () => {
		const { db, app, admin } = await setup();
		const nodeId = newId();
		const now = new Date().toISOString();
		await db
			.insertInto("nodes")
			.values({
				id: nodeId,
				org_id: await defaultOrgId(db),
				name: "web-1",
				name_key: "web-1",
				transport: "client",
				status: "active",
				public_key: null,
				hostname: "web-1",
				facts: JSON.stringify({ clockOffsetMs: 120_000 }),
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
		const clock = async () =>
			(
				(await (await call(app, `/api/nodes/${nodeId}`, { cookie: admin })).json()) as {
					node: { clockWarning: { offsetMs: number; thresholdMs: number } | null };
				}
			).node.clockWarning;
		const patch = (clockWarn: string) =>
			call(app, "/api/settings", { method: "PATCH", cookie: admin, body: { clockWarn } });
		try {
			expect(await clock()).toEqual({ offsetMs: 120_000, thresholdMs: 60_000 });
			expect((await patch("5m")).status).toBe(200);
			expect(await clock()).toBeNull();
			expect((await patch("30s")).status).toBe(200);
			expect(await clock()).toEqual({ offsetMs: 120_000, thresholdMs: 30_000 });
		} finally {
			await db.destroy();
		}
	});

	it("reads the retention window at each sweep run", async () => {
		const { db, store } = await setup({ retention: { piTasks: "off" } });
		const orgId = await defaultOrgId(db);
		const old = new Date(Date.now() - 2 * 86_400_000).toISOString();
		await db
			.insertInto("tasks")
			.values({
				id: "old-task",
				org_id: orgId,
				node_id: "node-1",
				task_group_id: null,
				kind: "exec",
				spec: "{}",
				input_size: null,
				input_sha256: null,
				privileged: 0,
				attempt: 1,
				timeout_ms: null,
				output_mode: "full",
				state: "exited",
				exit_code: 0,
				signal: null,
				timed_out: 0,
				cancelled: 0,
				error_code: null,
				error_message: null,
				actor_type: "user",
				actor_id: "user-1",
				on_behalf_of_user_id: "user-1",
				created_at: old,
				dispatched_at: null,
				accepted_at: null,
				finished_at: old,
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
				handler_type: null,
				handler_session_id: null,
			})
			.execute();
		const seen: RetentionConfig[] = [];
		const run = (async (
			database: Db,
			retention: RetentionConfig,
			now = new Date(),
			options: RetentionOptions = {},
		): Promise<RetentionCounts> => {
			seen.push(retention);
			return await runRetention(database, retention, now, options);
		}) as typeof runRetention;
		const sweep = startRetentionSweep(db, () => store.current().retention, {
			startupDelayMs: 5,
			intervalMs: 25,
			run,
		});
		try {
			await waitFor("the first sweep", () => seen.length >= 1);
			expect(await db.selectFrom("tasks").select("id").where("id", "=", "old-task").executeTakeFirst()).toBeDefined();

			await store.patch(db, { retention: { tasks: "1d" } }, null);
			await waitFor("the second sweep", () => seen.length >= 2);
			await sweep.stop();
			expect(seen[1]?.tasksMs).toBe(86_400_000);
			expect(await db.selectFrom("tasks").select("id").where("id", "=", "old-task").executeTakeFirst()).toBeUndefined();
		} finally {
			await sweep.stop();
			await db.destroy();
		}
	});

	it("exposes the defaults and the current settings to the WebUI", async () => {
		const { db, app, admin } = await setup();
		try {
			const res = await call(app, "/api/settings", { cookie: admin });
			const body = (await res.json()) as { settings: SystemSettings; defaults: SystemSettings };
			expect(body.defaults.clockWarn).toBe("60s");
			expect(body.settings.auth.captcha).toBe("none");
			expect(body.settings.auth.argon2Concurrency).toBe(2);
		} finally {
			await db.destroy();
		}
	});
});
