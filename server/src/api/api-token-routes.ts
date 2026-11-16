import {
	ApiTokenCreateBodySchema,
	ApiTokenCreatedResponseSchema,
	ApiTokenListResponseSchema,
	ApiTokenResponseSchema,
	ApiTokenRulesBodySchema,
	IdParamSchema,
	OkResponseSchema,
} from "@crh/api/schemas";
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
import { defaultOrgId } from "../storage/org.ts";
import { NotFoundError } from "../util/errors.ts";
import { cancelRevokedTokenWaits } from "./api-token-waits.ts";
import { reevaluateAfterRuleChange } from "./approval-routes.ts";
import { apiRouter, defineRoute, json } from "./openapi.ts";

const TAGS = ["API tokens"];

const listRoute = defineRoute({
	method: "get",
	path: "/api-tokens",
	tags: TAGS,
	summary: "List the caller's API tokens; the secrets are not included",
	agent: "deny",
	responses: { 200: { description: "The caller's tokens", ...json(ApiTokenListResponseSchema) } },
});

const createRoute = defineRoute({
	method: "post",
	path: "/api-tokens",
	tags: TAGS,
	summary: "Create an API token; the secret is returned only in this response",
	agent: "deny",
	request: { body: { required: true, ...json(ApiTokenCreateBodySchema) } },
	responses: { 201: { description: "The new token and its secret", ...json(ApiTokenCreatedResponseSchema) } },
});

const revokeRoute = defineRoute({
	method: "post",
	path: "/api-tokens/{id}/revoke",
	tags: TAGS,
	summary: "Revoke an API token at once; what it was waiting to run is rejected",
	agent: "deny",
	request: { params: IdParamSchema },
	responses: { 200: { description: "The revoked token", ...json(ApiTokenResponseSchema) } },
});

const deleteRoute = defineRoute({
	method: "delete",
	path: "/api-tokens/{id}",
	tags: TAGS,
	summary: "Delete a revoked or expired API token and its rules for good",
	agent: "deny",
	request: { params: IdParamSchema },
	responses: { 200: { description: "Deleted", ...json(OkResponseSchema) } },
});

const rulesRoute = defineRoute({
	method: "put",
	path: "/api-tokens/{id}/rules",
	tags: TAGS,
	summary: "Replace an API token's rule preset and/or the rules added on top of it",
	agent: "deny",
	request: { params: IdParamSchema, body: { required: true, ...json(ApiTokenRulesBodySchema) } },
	responses: { 200: { description: "The token with its new rules", ...json(ApiTokenResponseSchema) } },
});

/**
 * API tokens with their rules. Management needs a WebUI session: these routes sit behind requireUser, and
 * API tokens only work at /mcp.
 */
export function apiTokenRoutes(db: Db, cluster: Cluster, taskGroups: TaskGroups, audit: Audit) {
	const app = apiRouter();

	app.openapi(listRoute, async (c) => c.json({ tokens: await listApiTokens(db, c.get("user")) }, 200));

	app.openapi(createRoute, async (c) => {
		const user = c.get("user");
		const body = c.req.valid("json");
		const { token, view } = await createApiToken(db, user, {
			name: body.name ?? "",
			rulePreset: parseApiTokenRulePreset(body.rulePreset ?? "ask"),
			days: body.days,
		});
		void audit.record({
			actor: userActor(user),
			action: "api_token.created",
			target: { type: "api_token", id: view.id },
			detail: { name: view.name, rule_preset: view.rules?.rulePreset, expires_at: view.expiresAt },
		});
		return c.json({ token, apiToken: view }, 201);
	});

	app.openapi(revokeRoute, async (c) => {
		const user = c.get("user");
		const { id } = c.req.valid("param");
		await revokeApiToken(db, user, id);
		void audit.record({
			actor: userActor(user),
			action: "api_token.revoked",
			target: { type: "api_token", id },
		});
		// What the token started and is still waiting for approval will not run; expiry sweeps the same rows.
		await cancelRevokedTokenWaits(db, cluster, taskGroups, [id], user.userId);
		const apiToken = await getApiToken(db, user, id);
		if (!apiToken) throw new NotFoundError("no such token");
		return c.json({ apiToken }, 200);
	});

	app.openapi(deleteRoute, async (c) => {
		const user = c.get("user");
		const { id } = c.req.valid("param");
		await deleteApiToken(db, user, id);
		void audit.record({
			actor: userActor(user),
			action: "api_token.deleted",
			target: { type: "api_token", id },
		});
		return c.json({ ok: true as const }, 200);
	});

	/** Changes a token's rule preset and/or the rules added on top; `{ rulePreset?, rules? }`. */
	app.openapi(rulesRoute, async (c) => {
		const user = c.get("user");
		const { id } = c.req.valid("param");
		if (!(await getApiToken(db, user, id))) throw new NotFoundError("no such token");
		const body = c.req.valid("json");
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
		await reevaluateAfterRuleChange(db, cluster, taskGroups, ref);
		const apiToken = await getApiToken(db, user, id);
		if (!apiToken) throw new NotFoundError("no such token");
		return c.json({ apiToken }, 200);
	});

	return app;
}
