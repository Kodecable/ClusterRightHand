import {
	SettingsValidationErrorSchema,
	SystemSettingsPatchBodySchema,
	SystemSettingsResponseSchema,
	SystemSettingsUpdateResponseSchema,
} from "@crh/api/schemas";
import { HTTPException } from "hono/http-exception";
import { userActor } from "../audit/audit.ts";
import {
	defaultSystemSettings,
	type SettingsChange,
	SettingsStore,
	SettingsValidationError,
} from "../settings/settings.ts";
import type { Db } from "../storage/db.ts";
import { requireAdmin } from "./middleware.ts";
import { apiRouter, defineRoute, json } from "./openapi.ts";

const TAGS = ["Settings"];

const getSettingsRoute = defineRoute({
	method: "get",
	path: "/settings",
	tags: TAGS,
	summary: "Read the runtime system settings and the defaults behind them (administrators)",
	agent: "allow",
	middleware: [requireAdmin],
	responses: { 200: { description: "The current settings and the defaults", ...json(SystemSettingsResponseSchema) } },
});

const patchSettingsRoute = defineRoute({
	method: "patch",
	path: "/settings",
	tags: TAGS,
	summary: "Partially update the runtime settings; a change applies without a restart (administrators)",
	agent: "deny", // also changes login and Passkey settings
	middleware: [requireAdmin],
	request: { body: { required: true, ...json(SystemSettingsPatchBodySchema) } },
	responses: {
		200: { description: "The settings as they now are", ...json(SystemSettingsUpdateResponseSchema) },
		400: {
			description: "The patch was rejected; `fields` names the problem of each field",
			...json(SettingsValidationErrorSchema),
		},
	},
});

export interface SettingsRoutesOptions {
	/** The live settings; main.ts loads them from the database. Omitted: load on first request. */
	settings?: SettingsStore;
	/** Called after a successful write, so consumers of a changed group apply it without a restart. */
	onChanged?: (changes: readonly SettingsChange[]) => void;
}

/**
 * System settings (doc/guide/reference/crhs-config.md): administrators read and partially update the
 * runtime settings. A successful write replaces the shared in-memory object and is audited; no
 * restart is needed. Requires a WebUI session; API tokens cannot reach this route.
 */
export function settingsRoutes(db: Db, options: SettingsRoutesOptions = {}) {
	const app = apiRouter();
	let store = options.settings;
	const current = async (): Promise<SettingsStore> => {
		if (!store) store = await SettingsStore.load(db);
		else await store.ensureLoaded(db);
		return store;
	};

	app.openapi(getSettingsRoute, async (c) => {
		const settings = await current();
		return c.json({ settings: settings.wire(), defaults: defaultSystemSettings() }, 200);
	});

	app.openapi(patchSettingsRoute, async (c) => {
		const body = c.req.valid("json");
		let result: Awaited<ReturnType<SettingsStore["patch"]>>;
		try {
			result = await (await current()).patch(db, body, c.get("user").userId);
		} catch (err) {
			// Every rejected field is reported at once, which a schema's first-problem message cannot do.
			if (err instanceof SettingsValidationError) {
				throw new HTTPException(400, { res: c.json({ error: err.message, fields: err.fields }, 400) });
			}
			throw err;
		}
		if (result.changes.length > 0) {
			options.onChanged?.(result.changes);
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
		return c.json({ settings: result.settings }, 200);
	});

	return app;
}
