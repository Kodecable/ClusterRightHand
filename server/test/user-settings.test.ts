import type { UserSettings } from "@crh/api";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { OpenAPIHono } from "@hono/zod-openapi";
import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ModelConfig } from "../src/agent/models.ts";
import type { AppEnv } from "../src/api/context.ts";
import { apiErrorHandler } from "../src/api/errors.ts";
import { userSettingsRoutes } from "../src/api/user-settings-routes.ts";
import { Audit } from "../src/audit/audit.ts";
import type { SessionUser } from "../src/auth/sessions.ts";
import { MasterKey } from "../src/keys/master-key.ts";
import type { Db } from "../src/storage/db.ts";
import { createUser } from "../src/users/service.ts";
import { getUserSettings, patchUserSettings } from "../src/users/settings.ts";
import { type App, call } from "./helpers/api.ts";
import { openTestDb } from "./helpers/db.ts";

const faux = fauxProvider({ models: [{ id: "settings-model", reasoning: true }] });
const model = () => ({ provider: faux.provider.id, modelId: faux.getModel().id, thinkingLevel: "high" as const });

let db: Db;
let app: App;
let user: SessionUser;
let otherUserId = "";
let audit: Audit;

beforeEach(async () => {
	db = await openTestDb("sqlite");
	audit = new Audit(db);
	const models = new ModelConfig(db, MasterKey.generate());
	models.addProvider(faux.provider);
	await models.reload();
	const created = await createUser(db, { username: "alice", kind: "member", password: "password-123" });
	otherUserId = (await createUser(db, { username: "bob", kind: "member", password: "password-123" })).id;
	user = { sessionId: "web-session", userId: created.id, username: "alice", kind: "member" };
	const isolated = new OpenAPIHono<AppEnv>();
	isolated.onError(apiErrorHandler());
	isolated.use("*", async (c, next) => {
		c.set("user", user);
		c.set("audit", audit);
		await next();
	});
	isolated.route("/api", userSettingsRoutes(db, { models }));
	app = isolated;
});

afterEach(async () => {
	await audit.flush();
	await db.destroy();
});

const get = () => call(app, "/api/me/settings", { cookie: "unused" });
const patch = (body: Record<string, unknown>) => call(app, "/api/me/settings", { method: "PATCH", body });

const linkedAccount = async (userId: string, id = "account-1"): Promise<string> => {
	await db
		.insertInto("channel_accounts")
		.values({
			id,
			channel_id: "channel-1",
			platform: "telegram",
			platform_user_id: `tg-${id}`,
			platform_chat_id: `tg-${id}`,
			user_id: userId,
			display_name: null,
			linked_at: new Date().toISOString(),
		})
		.execute();
	return id;
};

describe("user settings storage", () => {
	it("starts from the defaults and clears a field with null", async () => {
		expect(await getUserSettings(db, user.userId)).toEqual({
			locale: null,
			defaultModel: null,
			defaultRulePreset: null,
			showProgress: true,
			defaultChannelAccountId: null,
		});
		await patchUserSettings(db, user.userId, {
			locale: "zh-CN",
			defaultModel: { provider: "faux", modelId: "faux-1", thinkingLevel: "high" },
			defaultRulePreset: "yolo",
			showProgress: false,
		});
		expect(await getUserSettings(db, user.userId)).toEqual({
			locale: "zh-CN",
			defaultModel: { provider: "faux", modelId: "faux-1", thinkingLevel: "high" },
			defaultRulePreset: "yolo",
			showProgress: false,
			defaultChannelAccountId: null,
		});
		await patchUserSettings(db, user.userId, {
			locale: null,
			defaultModel: null,
			defaultRulePreset: null,
			showProgress: true,
		});
		expect(await getUserSettings(db, user.userId)).toEqual({
			locale: null,
			defaultModel: null,
			defaultRulePreset: null,
			showProgress: true,
			defaultChannelAccountId: null,
		});
	});

	it("refuses a default notification account that is not the user's", async () => {
		const other = await linkedAccount(otherUserId, "account-other");
		await expect(patchUserSettings(db, user.userId, { defaultChannelAccountId: other })).rejects.toThrow(
			"no such linked chat account",
		);
	});
});

describe("GET/PATCH /api/me/settings", () => {
	it("returns the defaults and applies a partial change", async () => {
		const initial = await get();
		expect(initial.status).toBe(200);
		expect(((await initial.json()) as { settings: UserSettings }).settings.showProgress).toBe(true);

		const res = await patch({
			locale: "zh-CN",
			defaultModel: model(),
			defaultRulePreset: "yolo",
			showProgress: false,
		});
		expect(res.status).toBe(200);
		expect(((await res.json()) as { settings: UserSettings }).settings).toMatchObject({
			locale: "zh-CN",
			defaultModel: model(),
			defaultRulePreset: "yolo",
			showProgress: false,
		});
	});

	it("rejects a locale, rule preset, model or channel account that is not offered", async () => {
		let res = await patch({ locale: "fr" });
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toMatch(/^locale:/);

		res = await patch({ defaultRulePreset: "bogus" });
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toMatch(/^defaultRulePreset:/);

		res = await patch({ defaultModel: { provider: "gone", modelId: "gone" } });
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toMatch(/^defaultModel: model gone\/gone/);

		res = await patch({ defaultChannelAccountId: "not-mine" });
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toBe(
			"defaultChannelAccountId: no such linked chat account",
		);
	});

	it("accepts a linked account and null clears every nullable field", async () => {
		const accountId = await linkedAccount(user.userId);
		const saved = await patch({
			locale: "zh-CN",
			defaultModel: model(),
			defaultRulePreset: "ask",
			defaultChannelAccountId: accountId,
		});
		expect(saved.status).toBe(200);

		const cleared = await patch({
			locale: null,
			defaultModel: null,
			defaultRulePreset: null,
			defaultChannelAccountId: null,
		});
		expect(cleared.status).toBe(200);
		expect(((await cleared.json()) as { settings: UserSettings }).settings).toEqual({
			locale: null,
			defaultModel: null,
			defaultRulePreset: null,
			showProgress: true,
			defaultChannelAccountId: null,
		});
	});

	it("rejects a default account that is unlinked after the route checked it", async () => {
		const accountId = await linkedAccount(user.userId);
		// Move the account row as the setting is written, so both checks above still saw it but the foreign
		// key rejects the write: the same refusal as an unknown account.
		await sql`
			create trigger user_settings_move_account before insert on user_settings
			begin
				update channel_accounts set id = 'moved-' || id where id = new.default_channel_account_id;
			end`.execute(db);
		const res = await patch({ defaultChannelAccountId: accountId });
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toBe(
			"defaultChannelAccountId: no such linked chat account",
		);
	});

	it("audits the changed fields without recording a no-op", async () => {
		await patch({ locale: "zh-CN" });
		await audit.flush();
		const events = await db
			.selectFrom("audit_events")
			.select(["action", "target_type", "target_id", "detail"])
			.where("action", "=", "user_settings.changed")
			.execute();
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ target_type: "user", target_id: user.userId });
		expect(JSON.parse(events[0]?.detail ?? "{}")).toEqual({
			changed: ["locale"],
			old: { locale: null },
			new: { locale: "zh-CN" },
		});

		// A PATCH that sets the value it already has changes nothing and writes no event.
		await patch({ locale: "zh-CN" });
		await audit.flush();
		expect(
			await db.selectFrom("audit_events").select("id").where("action", "=", "user_settings.changed").execute(),
		).toHaveLength(1);
	});
});
