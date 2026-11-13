import type { SystemSettings } from "@crh/api";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Audit } from "../src/audit/audit.ts";
import { createApiToken } from "../src/auth/api-tokens.ts";
import { configureHashGate, HashBusyError, resetHashGateForTesting, withHashSlot } from "../src/auth/hash-gate.ts";
import {
	DEFAULT_ARGON2_CONCURRENCY,
	DEFAULT_ARGON2_QUEUE,
	DEFAULT_CAPTCHA,
	DEFAULT_CLOCK_WARN_MS,
	DEFAULT_GROUP_LIBRARY_LIMITS,
	DEFAULT_RETENTION_AUDIT_MS,
	DEFAULT_RETENTION_PI_TASKS_MS,
	DEFAULT_RETENTION_TASKS_MS,
	DEFAULT_RP_NAME,
	DEFAULT_USER_LIBRARY_LIMITS,
	parseConfigFile,
	parseDurationMs,
	parseRetentionDuration,
} from "../src/config.ts";
import {
	DEFAULT_ATTACHMENT_INLINE_TEXT_BYTES,
	DEFAULT_ATTACHMENT_INLINE_TOTAL_BYTES,
	DEFAULT_IMAGE_CACHE_DISK_BYTES,
	DEFAULT_IMAGE_CACHE_MEMORY_BYTES,
	DEFAULT_IMAGE_CACHE_TTL,
	DEFAULT_SYSTEM_SETTINGS,
	importSettingsFromFile,
	SettingsStore,
} from "../src/settings/settings.ts";
import type { Db } from "../src/storage/db.ts";
import { createUser } from "../src/users/service.ts";
import { type App, call, login, makeApp } from "./helpers/api.ts";
import { openTestDb } from "./helpers/db.ts";

describe("system settings storage", () => {
	let db: Db;

	beforeAll(async () => {
		db = await openTestDb("sqlite");
	});
	afterAll(async () => {
		await db.destroy();
	});

	it("starts from the config.ts defaults", async () => {
		const store = await SettingsStore.load(db);
		expect(store.wire()).toEqual(DEFAULT_SYSTEM_SETTINGS);
		// The textual defaults in System settings resolve to the same values config.ts documents.
		expect(parseDurationMs(DEFAULT_SYSTEM_SETTINGS.clockWarn, "clock_warn")).toBe(DEFAULT_CLOCK_WARN_MS);
		expect(parseRetentionDuration(DEFAULT_SYSTEM_SETTINGS.retention.tasks, "retention.tasks")).toBe(
			DEFAULT_RETENTION_TASKS_MS,
		);
		expect(parseRetentionDuration(DEFAULT_SYSTEM_SETTINGS.retention.audit, "retention.audit")).toBe(
			DEFAULT_RETENTION_AUDIT_MS,
		);
		expect(parseRetentionDuration(DEFAULT_SYSTEM_SETTINGS.retention.piTasks, "retention.pi_tasks")).toBe(
			DEFAULT_RETENTION_PI_TASKS_MS,
		);
		expect(store.current()).toEqual({
			publicUrl: null,
			clockWarnMs: DEFAULT_CLOCK_WARN_MS,
			retention: {
				tasksMs: DEFAULT_RETENTION_TASKS_MS,
				auditMs: DEFAULT_RETENTION_AUDIT_MS,
				piTasksMs: DEFAULT_RETENTION_PI_TASKS_MS,
			},
			webauthn: { rpId: null, rpName: DEFAULT_RP_NAME, origins: [] },
			auth: {
				captcha: DEFAULT_CAPTCHA,
				argon2Concurrency: DEFAULT_ARGON2_CONCURRENCY,
				argon2Queue: DEFAULT_ARGON2_QUEUE,
			},
			realIpHeader: null,
			library: {
				user: { ...DEFAULT_USER_LIBRARY_LIMITS },
				group: { ...DEFAULT_GROUP_LIBRARY_LIMITS },
			},
			attachments: {
				inlineTextBytes: DEFAULT_ATTACHMENT_INLINE_TEXT_BYTES,
				inlineTotalBytes: DEFAULT_ATTACHMENT_INLINE_TOTAL_BYTES,
			},
			imageCache: {
				memoryBytes: DEFAULT_IMAGE_CACHE_MEMORY_BYTES,
				diskBytes: DEFAULT_IMAGE_CACHE_DISK_BYTES,
				ttlMs: parseDurationMs(DEFAULT_IMAGE_CACHE_TTL, "image_cache.ttl"),
			},
		});
	});
});

describe("settings file import", () => {
	let db: Db;

	beforeEach(async () => {
		db = await openTestDb("sqlite");
	});
	afterEach(async () => {
		await db.destroy();
	});

	const file = (text: string) => parseConfigFile(text).moved;

	it("imports moved keys into an empty database and warns to remove them", async () => {
		const moved = file(
			[
				'public_url = "https://crh.example.com/"',
				'clock_warn = "90s"',
				"[listen]",
				'real_ip_header = "X-Forwarded-For"',
				"[retention]",
				'tasks = "30d"',
				"[webauthn]",
				'rp_id = "crh.example.com"',
				'origins = ["https://crh.example.com"]',
				"[auth]",
				'captcha = "none"',
				"",
			].join("\n"),
		);
		const warnings: string[] = [];
		const imported = await importSettingsFromFile(db, moved, (message) => warnings.push(message));
		expect(imported).toEqual([
			"auth.captcha",
			"clock_warn",
			"listen.real_ip_header",
			"public_url",
			"retention.tasks",
			"webauthn.origins",
			"webauthn.rp_id",
		]);
		expect(warnings).toHaveLength(imported.length);
		for (const [index, key] of imported.entries()) {
			expect(warnings[index]).toContain(`imported ${key} from crhs.toml`);
			expect(warnings[index]).toContain("remove it from crhs.toml");
		}

		const store = await SettingsStore.load(db);
		expect(store.wire()).toMatchObject({
			publicUrl: "https://crh.example.com",
			clockWarn: "90s",
			realIpHeader: "X-Forwarded-For",
			retention: { tasks: "30d" },
			webauthn: { rpId: "crh.example.com", origins: ["https://crh.example.com"] },
			auth: { captcha: "none" },
		});
		expect(store.current().clockWarnMs).toBe(90_000);
		expect(store.current().retention.tasksMs).toBe(30 * 86_400_000);
	});

	it("does nothing when the file has no moved keys", async () => {
		const warnings: string[] = [];
		expect(await importSettingsFromFile(db, file(""), (message) => warnings.push(message))).toEqual([]);
		expect(warnings).toEqual([]);
	});

	it("refuses to start when the database already has a value", async () => {
		await importSettingsFromFile(db, file('public_url = "https://old.example.com"\n'), () => {});
		const before = await db.selectFrom("settings").select("key").execute();
		await expect(
			importSettingsFromFile(db, file('public_url = "https://new.example.com"\nclock_warn = "90s"\n'), () => {}),
		).rejects.toThrow("public_url is now set in System settings; remove it from crhs.toml");
		// Nothing was imported: the conflicting file is refused as a whole.
		expect(await db.selectFrom("settings").select("key").execute()).toEqual(before);
		expect((await SettingsStore.load(db)).wire().clockWarn).toBe("60s");
	});
});

describe("settings API", () => {
	let db: Db;
	let store: SettingsStore;
	let app: App;
	let admin: string;
	let member: string;
	let memberId: string;
	let audit: Audit;

	beforeAll(async () => {
		db = await openTestDb("sqlite");
		store = await SettingsStore.load(db);
		// The suite signs in with a password: turn the captcha off through the same store it edits.
		await store.patch(db, { auth: { captcha: "none" } }, null);
		audit = new Audit(db);
		app = makeApp(db, undefined, { settings: store, audit });
		await createUser(db, { username: "root", kind: "admin", password: "root-password" });
		admin = await login(app, "root", "root-password");
		memberId = (await createUser(db, { username: "member", kind: "member", password: "member-password" })).id;
		member = await login(app, "member", "member-password");
	});
	afterAll(async () => {
		resetHashGateForTesting();
		await db.destroy();
	});

	const get = (cookie?: string) => call(app, "/api/settings", { cookie });
	const patch = (body: unknown, cookie = admin) => call(app, "/api/settings", { method: "PATCH", cookie, body });

	it("returns the current settings and the defaults to an administrator", async () => {
		const res = await get(admin);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { settings: SystemSettings; defaults: SystemSettings };
		expect(body.defaults).toEqual(DEFAULT_SYSTEM_SETTINGS);
		expect(body.settings.auth.captcha).toBe("none");
		expect(body.settings.clockWarn).toBe("60s");
	});

	it("is administrators only and rejects API tokens", async () => {
		expect((await get()).status).toBe(401);
		expect((await get(member)).status).toBe(403);
		expect((await patch({ clockWarn: "90s" }, member)).status).toBe(403);

		const token = (
			await createApiToken(
				db,
				{ sessionId: "s", userId: memberId, username: "member", kind: "member" },
				{ name: "api", rulePreset: "yolo" },
			)
		).token;
		const res = await call(app, "/api/settings", { headers: { authorization: `Bearer ${token}` } });
		expect(res.status).toBe(401);
	});

	it("partially updates, validates every value and returns the new settings", async () => {
		const res = await patch({
			publicUrl: "https://crh.example.com/",
			clockWarn: "90s",
			retention: { tasks: "off" },
			webauthn: { rpId: "crh.example.com", origins: ["https://crh.example.com"] },
			auth: { argon2Concurrency: 1, argon2Queue: 0 },
			realIpHeader: "X-Real-IP",
			library: {
				user: { files: 5, fileBytes: 6, totalBytes: 7 },
				group: { files: 1, fileBytes: 2, totalBytes: 3 },
			},
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { settings: SystemSettings };
		expect(body.settings).toEqual({
			...DEFAULT_SYSTEM_SETTINGS,
			auth: { captcha: "none", argon2Concurrency: 1, argon2Queue: 0 },
			publicUrl: "https://crh.example.com",
			clockWarn: "90s",
			realIpHeader: "X-Real-IP",
			retention: { ...DEFAULT_SYSTEM_SETTINGS.retention, tasks: "off" },
			webauthn: { rpId: "crh.example.com", rpName: "ClusterRightHand", origins: ["https://crh.example.com"] },
			library: {
				user: { files: 5, fileBytes: 6, totalBytes: 7 },
				group: { files: 1, fileBytes: 2, totalBytes: 3 },
			},
		});
		// The live object the consumers read is replaced at once.
		expect(store.current().publicUrl).toBe("https://crh.example.com");
		expect(store.current().clockWarnMs).toBe(90_000);
		expect(store.current().retention.tasksMs).toBeNull();
		expect(store.current().auth).toEqual({ captcha: "none", argon2Concurrency: 1, argon2Queue: 0 });
		expect(store.current().webauthn.origins).toEqual(["https://crh.example.com"]);
		expect(store.current().realIpHeader).toBe("X-Real-IP");
		expect(store.current().library.user).toEqual({ files: 5, fileBytes: 6, totalBytes: 7 });
		expect(store.current().library.group).toEqual({ files: 1, fileBytes: 2, totalBytes: 3 });
	});

	it("rejects bad values with a per-field message and writes nothing", async () => {
		const before = (await (await get(admin)).json()) as { settings: SystemSettings };
		const cases: [unknown, string][] = [
			[{ publicUrl: "ftp://crh.example.com" }, "publicUrl"],
			[{ clockWarn: 90 }, "clockWarn"],
			[{ clockWarn: "90" }, "clockWarn"],
			[{ retention: { tasks: "23h" } }, "retention.tasks"],
			[{ retention: { audit: "0s" } }, "retention.audit"],
			[{ retention: { nope: "30d" } }, "retention.nope"],
			[{ webauthn: { rpId: "crh.example.com" } }, "webauthn.origins"],
			[{ webauthn: { rpId: null, origins: ["https://crh.example.com"] } }, "webauthn.origins"],
			[{ webauthn: { rpName: "" } }, "webauthn.rpName"],
			[{ auth: { captcha: "sometimes" } }, "auth.captcha"],
			[{ auth: { argon2Concurrency: 0 } }, "auth.argon2Concurrency"],
			[{ auth: { argon2Queue: -1 } }, "auth.argon2Queue"],
			[{ realIpHeader: "X Forwarded For" }, "realIpHeader"],
			[{ library: { user: { files: -1 } } }, "library.user.files"],
			[{ library: { group: { nope: 1 } } }, "library.group.nope"],
			[{ nope: 1 }, "nope"],
			[{ retention: "30d" }, "retention"],
		];
		for (const [body, field] of cases) {
			const res = await patch(body);
			expect(res.status, JSON.stringify(body)).toBe(400);
			const error = (await res.json()) as { error: string; fields: Record<string, string> };
			expect(error.error).toBe("invalid settings");
			expect(error.fields[field], JSON.stringify(body)).toBeTypeOf("string");
		}
		expect(((await (await get(admin)).json()) as { settings: SystemSettings }).settings).toEqual(before.settings);
	});

	it("records what changed in the audit log", async () => {
		const before = await db
			.selectFrom("audit_events")
			.select((eb) => eb.fn.countAll<number>().as("count"))
			.where("action", "=", "settings.changed")
			.executeTakeFirst();
		const res = await patch({ clockWarn: "2m", retention: { audit: "off" } });
		expect(res.status).toBe(200);
		await audit.flush();
		const rows = await db
			.selectFrom("audit_events")
			.select(["action", "detail", "actor_id"])
			.where("action", "=", "settings.changed")
			.orderBy("seq", "desc")
			.execute();
		expect(rows).toHaveLength(Number(before?.count ?? 0) + 1);
		const detail = JSON.parse(rows[0]?.detail ?? "{}") as {
			changed: string[];
			old: Record<string, unknown>;
			new: Record<string, unknown>;
		};
		expect(detail.changed).toEqual(["clock_warn", "retention.audit"]);
		expect(detail.old).toEqual({ clock_warn: "90s", "retention.audit": "180d" });
		expect(detail.new).toEqual({ clock_warn: "2m", "retention.audit": "off" });
	});
});

describe("argon2 gate resize", () => {
	afterEach(() => resetHashGateForTesting());

	it("keeps queued work when the limits shrink and lets running hashes finish", async () => {
		await withHashSlot(async () => {}, "login"); // leave the gate idle first
		let releaseA = (): void => {};
		let releaseB = (): void => {};
		const a = new Promise<void>((resolve) => {
			releaseA = resolve;
		});
		const b = new Promise<void>((resolve) => {
			releaseB = resolve;
		});
		const first = withHashSlot(async () => await a, "login");
		const second = withHashSlot(async () => await b, "login");
		let queued = false;
		const third = withHashSlot(async () => {
			queued = true;
		}, "login");
		// Shrink both limits while two hashes run and one waits.
		configureHashGate({ concurrency: 1, queue: 0 });
		expect(queued).toBe(false);
		await expect(withHashSlot(async () => {})).rejects.toBeInstanceOf(HashBusyError);

		releaseA();
		await first;
		// One running hash still blocks the queued one under the new concurrency.
		expect(queued).toBe(false);
		releaseB();
		await second;
		// The waiter was not dropped by the shrink: it gets the freed slot.
		await third;
		expect(queued).toBe(true);
	});

	it("applies the new limits from a settings write", async () => {
		const db = await openTestDb("sqlite");
		try {
			const store = await SettingsStore.load(db);
			await store.patch(db, { auth: { argon2Concurrency: 1, argon2Queue: 0 } }, null);
			let release = (): void => {};
			const held = new Promise<void>((resolve) => {
				release = resolve;
			});
			const running = withHashSlot(async () => await held);
			await expect(withHashSlot(async () => {})).rejects.toBeInstanceOf(HashBusyError);
			release();
			await running;
			await expect(withHashSlot(async () => {})).resolves.toBeUndefined();
		} finally {
			resetHashGateForTesting();
			await db.destroy();
		}
	});
});
