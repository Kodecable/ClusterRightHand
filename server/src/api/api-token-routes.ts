import { Hono } from "hono";
import { type Audit, userActor } from "../audit/audit.ts";
import {
	createApiToken,
	deleteApiToken,
	getApiToken,
	listApiTokens,
	parseApiTokenRulePreset,
	revokeApiToken,
} from "../auth/api-tokens.ts";
import type { Cluster } from "../cluster/cluster.ts";
import type { TaskGroups } from "../cluster/task-groups.ts";
import { parseRulesForWrite } from "../policy/refs.ts";
import { type RuleRef, setRulePreset, setRules } from "../policy/store.ts";
import type { Db } from "../storage/db.ts";
import { defaultOrgId } from "../users/service.ts";
import { rejectRevokedTokenWaits } from "./api-token-waits.ts";
import { reevaluateAfterRuleChange } from "./approval-routes.ts";
import { type AppEnv, jsonError, readJsonObject } from "./context.ts";

/**
 * API tokens with their rules. Management needs a WebUI session: these routes sit behind requireUser, and
 * API tokens only work at /mcp.
 */
export function apiTokenRoutes(db: Db, cluster: Cluster, taskGroups: TaskGroups, audit: Audit) {
	const app = new Hono<AppEnv>();

	app.get("/api-tokens", async (c) => c.json({ tokens: await listApiTokens(db, c.get("user")) }));

	app.post("/api-tokens", async (c) => {
		const user = c.get("user");
		const body = (await readJsonObject(c)) ?? {};
		const days = body.days === null ? null : body.days === undefined ? undefined : Number(body.days);
		const { token, view } = await createApiToken(db, user, {
			name: typeof body.name === "string" ? body.name : "",
			rulePreset: parseApiTokenRulePreset(body.rulePreset ?? "ask"),
			days,
		});
		void audit.record({
			actor: userActor(user),
			action: "api_token.created",
			target: { type: "api_token", id: view.id },
			detail: { name: view.name, rule_preset: view.rules?.rulePreset, expires_at: view.expiresAt },
		});
		return c.json({ token, apiToken: view }, 201);
	});

	app.post("/api-tokens/:id/revoke", async (c) => {
		const user = c.get("user");
		await revokeApiToken(db, user, c.req.param("id"));
		void audit.record({
			actor: userActor(user),
			action: "api_token.revoked",
			target: { type: "api_token", id: c.req.param("id") },
		});
		// What the token started and is still waiting for approval will not run; expiry sweeps the same rows.
		await rejectRevokedTokenWaits(db, cluster, taskGroups, [c.req.param("id")], user.userId);
		return c.json({ apiToken: await getApiToken(db, user, c.req.param("id")) });
	});

	app.delete("/api-tokens/:id", async (c) => {
		const user = c.get("user");
		await deleteApiToken(db, user, c.req.param("id"));
		void audit.record({
			actor: userActor(user),
			action: "api_token.deleted",
			target: { type: "api_token", id: c.req.param("id") },
		});
		return c.json({ ok: true });
	});

	/** Changes a token's rule preset and/or the rules added on top; `{ rulePreset?, rules? }`. */
	app.put("/api-tokens/:id/rules", async (c) => {
		const user = c.get("user");
		const id = c.req.param("id");
		if (!(await getApiToken(db, user, id))) return jsonError(c, 404, "no such token");
		const body = await readJsonObject(c);
		if (!body) return jsonError(c, 400, "expected a JSON object");
		const ref: RuleRef = { type: "api_token", id };
		const rulePreset = body.rulePreset === undefined ? undefined : parseApiTokenRulePreset(body.rulePreset);
		const rules =
			body.rules === undefined ? undefined : await parseRulesForWrite(db, await defaultOrgId(db), body.rules);
		// One transaction: a failure after the preset was written would leave the token with the new preset and
		// the old rules, which is a policy the caller never asked for.
		await db.transaction().execute(async (trx) => {
			if (rulePreset) await setRulePreset(trx, ref, rulePreset);
			if (rules) await setRules(trx, ref, rules);
		});
		void audit.record({
			actor: userActor(user),
			action: "rules.changed",
			target: { type: "api_token", id },
			detail: { rule_preset: rulePreset, rules },
		});
		await reevaluateAfterRuleChange(cluster, taskGroups, ref);
		return c.json({ apiToken: await getApiToken(db, user, id) });
	});

	return app;
}
