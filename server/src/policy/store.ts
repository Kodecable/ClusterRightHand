import type { RuleRef as ApiRuleRef, StoredRuleSet as ApiStoredRuleSet } from "@crh/api";
import type { Db } from "../storage/db.ts";
import type { RuleScopeType, RuleSetsTable } from "../storage/schema.ts";
import { NotFoundError, UserError } from "../users/service.ts";
import { newId } from "../util/id.ts";
import { type ChainLevel, RULE_PRESETS, type Rule, type RulePreset, type RuleSet, rulePresetRuleSet } from "./rules.ts";

/** One level of a rule chain, as stored on tasks: root first. */
export type RuleRef = ApiRuleRef;
export type StoredRuleSet = ApiStoredRuleSet;

function fromRow(row: RuleSetsTable): StoredRuleSet {
	return {
		scope: { type: row.scope_type, id: row.scope_id },
		rulePreset: row.rule_preset as RulePreset | null,
		rules: JSON.parse(row.rules) as Rule[],
		default: row.default_action as RuleSet["default"],
		updatedAt: row.updated_at,
	};
}

export function parseRulePreset(raw: unknown): RulePreset {
	if (typeof raw !== "string" || !(RULE_PRESETS as readonly string[]).includes(raw)) {
		throw new UserError(`rule preset must be one of ${RULE_PRESETS.join(", ")}`);
	}
	return raw as RulePreset;
}

export async function getRuleSet(db: Db, ref: RuleRef): Promise<StoredRuleSet | undefined> {
	const row = await db
		.selectFrom("rule_sets")
		.selectAll()
		.where("scope_type", "=", ref.type as RuleScopeType)
		.where("scope_id", "=", ref.id)
		.executeTakeFirst();
	return row ? fromRow(row) : undefined;
}

/** Creates the rule set of a chain root with a rule preset and the rules added on top of it. */
export async function createRootRuleSet(
	db: Db,
	orgId: string,
	ref: RuleRef,
	rulePreset: RulePreset,
	rules: Rule[] = [],
): Promise<void> {
	await db
		.insertInto("rule_sets")
		.values({
			id: newId(),
			org_id: orgId,
			scope_type: ref.type as RuleScopeType,
			scope_id: ref.id,
			rule_preset: rulePreset,
			default_action: rulePresetRuleSet(rulePreset).default,
			rules: JSON.stringify(rules),
			updated_at: new Date().toISOString(),
		})
		.execute();
}

/** Creates the rule set of a lower level (a subagent): full rules, no rule preset; it can only tighten. */
export async function createRuleSet(db: Db, orgId: string, ref: RuleRef, set: RuleSet): Promise<void> {
	await db
		.insertInto("rule_sets")
		.values({
			id: newId(),
			org_id: orgId,
			scope_type: ref.type as RuleScopeType,
			scope_id: ref.id,
			rule_preset: null,
			default_action: set.default,
			rules: JSON.stringify(set.rules),
			updated_at: new Date().toISOString(),
		})
		.execute();
}

/** Changes a root's rule preset; the rules added on top are kept. */
export async function setRulePreset(db: Db, ref: RuleRef, rulePreset: RulePreset): Promise<void> {
	const res = await db
		.updateTable("rule_sets")
		.set({
			rule_preset: rulePreset,
			default_action: rulePresetRuleSet(rulePreset).default,
			updated_at: new Date().toISOString(),
		})
		.where("scope_type", "=", ref.type as RuleScopeType)
		.where("scope_id", "=", ref.id)
		.where("rule_preset", "is not", null)
		.executeTakeFirst();
	if (res.numUpdatedRows === 0n) throw new NotFoundError("no such rule set");
}

/** Replaces the rules added on top of the rule preset (or a sub-level's rules). */
export async function setRules(db: Db, ref: RuleRef, rules: Rule[]): Promise<void> {
	const res = await db
		.updateTable("rule_sets")
		.set({ rules: JSON.stringify(rules), updated_at: new Date().toISOString() })
		.where("scope_type", "=", ref.type as RuleScopeType)
		.where("scope_id", "=", ref.id)
		.executeTakeFirst();
	if (res.numUpdatedRows === 0n) throw new NotFoundError("no such rule set");
}

/** "Always allow": appends a rule, inside a transaction so concurrent appends are not lost. */
export async function appendRule(db: Db, ref: RuleRef, rule: Rule): Promise<void> {
	await db.transaction().execute(async (trx) => {
		const current = await getRuleSet(trx, ref);
		if (!current) throw new NotFoundError("no such rule set");
		await setRules(trx, ref, [...current.rules, rule]);
	});
}

export async function deleteRuleSet(db: Db, ref: RuleRef): Promise<void> {
	await db
		.deleteFrom("rule_sets")
		.where("scope_type", "=", ref.type as RuleScopeType)
		.where("scope_id", "=", ref.id)
		.execute();
}

/** The effective rule set of one level: a root's rule preset rules come before the rules added on top. */
export function effectiveRuleSet(stored: StoredRuleSet): RuleSet {
	if (!stored.rulePreset) return { default: stored.default, rules: stored.rules };
	const base = rulePresetRuleSet(stored.rulePreset);
	return { default: base.default, rules: [...base.rules, ...stored.rules] };
}

/** Loads a chain for evaluation; a missing level (e.g. a deleted token) is an error. */
export async function loadChain(db: Db, refs: RuleRef[]): Promise<ChainLevel[]> {
	const levels: ChainLevel[] = [];
	for (const ref of refs) {
		const stored = await getRuleSet(db, ref);
		if (!stored) throw new NotFoundError(`no rule set for ${ref.type} ${ref.id}`);
		levels.push({ scope: ref, set: effectiveRuleSet(stored) });
	}
	return levels;
}
