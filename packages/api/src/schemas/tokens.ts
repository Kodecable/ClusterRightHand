/** Runtime schemas for API tokens and their rules (`../tokens.ts`, doc/design/access-control.md "API tokens"). */
import { z } from "zod";
import { RefMapSchema } from "./common.ts";
import { RuleInputSchema, RulePresetSchema, StoredRuleSetSchema } from "./policy.ts";

export const ApiTokenViewSchema = z
	.object({
		id: z.string(),
		name: z.string(),
		userId: z.string(),
		createdAt: z.string(),
		expiresAt: z.string().nullable().describe("null: never expires."),
		revokedAt: z.string().nullable(),
		lastUsedAt: z.string().nullable(),
		rules: StoredRuleSetSchema.nullable(),
		refs: RefMapSchema.describe("Display names for the ids `rules` references; null means deleted."),
	})
	.meta({ id: "ApiTokenView", description: "An API token; the secret is shown only when it is created." });

export const ApiTokenListResponseSchema = z.object({ tokens: z.array(ApiTokenViewSchema) });

/** `POST /api/api-tokens`: the secret is returned only here. */
export const ApiTokenCreatedResponseSchema = z
	.object({
		token: z.string().describe("The token secret; it cannot be read again."),
		apiToken: ApiTokenViewSchema,
	})
	.meta({ id: "ApiTokenCreatedResponse" });

export const ApiTokenResponseSchema = z.object({ apiToken: ApiTokenViewSchema });

export const ApiTokenCreateBodySchema = z.object({
	name: z.string().optional().describe("The label; 1 to 100 characters after trimming."),
	rulePreset: RulePresetSchema.optional().describe('The starting rules; "ask" by default.'),
	days: z.number().nullable().optional().describe("Lifetime in days, 1 to 365; null never expires; 90 by default."),
});

/** `PUT /api/api-tokens/{id}/rules`: the preset and/or rules replaced on top of it. */
export const ApiTokenRulesBodySchema = z.object({
	rulePreset: RulePresetSchema.optional(),
	rules: z.array(RuleInputSchema).optional().describe("The complete list of rules added on top of the preset."),
});
