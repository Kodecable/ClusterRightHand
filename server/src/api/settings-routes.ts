import { Hono } from "hono";
import { userActor } from "../audit/audit.ts";
import { defaultSystemSettings, SettingsStore, SettingsValidationError } from "../settings/settings.ts";
import type { Db } from "../storage/db.ts";
import { type AppEnv, jsonError, readJsonObject } from "./context.ts";
import { requireAdmin } from "./middleware.ts";

export interface SettingsRoutesOptions {
	/** The live settings; main.ts loads them from the database. Omitted: load on first request. */
	settings?: SettingsStore;
}

/**
 * System settings (doc/guide/reference/crhs-config.md): administrators read and partially update the
 * runtime settings. A successful write replaces the shared in-memory object and is audited; no
 * restart is needed. Requires a WebUI session; API tokens cannot reach this route.
 */
export function settingsRoutes(db: Db, options: SettingsRoutesOptions = {}) {
	const app = new Hono<AppEnv>();
	let store = options.settings;
	const current = async (): Promise<SettingsStore> => {
		if (!store) store = await SettingsStore.load(db);
		else await store.ensureLoaded(db);
		return store;
	};

	app.get("/settings", requireAdmin, async (c) => {
		const settings = await current();
		return c.json({ settings: settings.wire(), defaults: defaultSystemSettings() });
	});

	app.patch("/settings", requireAdmin, async (c) => {
		const body = await readJsonObject(c);
		if (!body) return jsonError(c, 400, "expected a JSON object");
		let result: Awaited<ReturnType<SettingsStore["patch"]>>;
		try {
			result = await (await current()).patch(db, body, c.get("user").userId);
		} catch (err) {
			if (err instanceof SettingsValidationError) return c.json({ error: err.message, fields: err.fields }, 400);
			throw err;
		}
		if (result.changes.length > 0) {
			const oldValues: Record<string, unknown> = {};
			const newValues: Record<string, unknown> = {};
			for (const change of result.changes) {
				oldValues[change.key] = change.oldValue;
				newValues[change.key] = change.newValue;
			}
			void c.get("audit").record({
				actor: userActor(c.get("user")),
				action: "settings.changed",
				detail: { changed: result.changes.map((change) => change.key), old: oldValues, new: newValues },
			});
		}
		return c.json({ settings: result.settings });
	});

	return app;
}
