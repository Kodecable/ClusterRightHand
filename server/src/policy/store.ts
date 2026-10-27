import type { Db } from "../storage/db.ts";
import type { RuleScopeType, RuleSetsTable } from "../storage/schema.ts";
import { NotFoundError, UserError } from "../users/service.ts";
import { newId } from "../util/id.ts";
import { type ChainLevel, PRESETS, type Preset, presetRuleSet, type Rule, type RuleSet } from "./rules.ts";

/** One level of a rule chain, as stored on tasks: root first. */
export interface RuleRef {
	type: RuleScopeType;
	id: string;
}

export interface StoredRuleSet {
	scope: RuleRef;
	/** Roots only. */
	preset: Preset | null;
	/** The rules added on top of the preset's (roots), or all rules (sub-levels). */
	rules: Rule[];
	default: RuleSet["default"];
	/** JSON budget ({ tokens?, costUsd? }), sessions only. */
	budget: unknown;
	updatedAt: string;
}

function fromRow(row: RuleSetsTable): StoredRuleSet {
	return {
		scope: { type: row.scope_type, id: row.scope_id },
		preset: row.preset as Preset | null,
		rules: JSON.parse(row.rules) as Rule[],
		default: row.default_action as RuleSet["default"],
		budget: row.budget ? JSON.parse(row.budget) : null,
		updatedAt: row.updated_at,
	};
}

export function parsePreset(raw: unknown): Preset {
	if (typeof raw !== "string" || !(PRESETS as readonly string[]).includes(raw)) {
		throw new UserError(`preset must be one of ${PRESETS.join(", ")}`);
	}
	return raw as Preset;
}

export async function getRuleSet(db: Db, ref: RuleRef): Promise<StoredRuleSet | undefined> {
	const row = await db
		.selectFrom("rule_sets")
		.selectAll()
		.where("scope_type", "=", ref.type)
		.where("scope_id", "=", ref.id)
		.executeTakeFirst();
	return row ? fromRow(row) : undefined;
}

/** Creates the rule set of a chain root with a preset and no extra rules. */
export async function createRootRuleSet(db: Db, orgId: string, ref: RuleRef, preset: Preset): Promise<void> {
	await db
		.insertInto("rule_sets")
		.values({
			id: newId(),
			org_id: orgId,
			scope_type: ref.type,
			scope_id: ref.id,
			preset,
			default_action: presetRuleSet(preset).default,
			rules: "[]",
			budget: null,
			updated_at: new Date().toISOString(),
		})
		.execute();
}

/** Changes a root's preset; the rules added on top are kept. */
export async function setPreset(db: Db, ref: RuleRef, preset: Preset): Promise<void> {
	const res = await db
		.updateTable("rule_sets")
		.set({ preset, default_action: presetRuleSet(preset).default, updated_at: new Date().toISOString() })
		.where("scope_type", "=", ref.type)
		.where("scope_id", "=", ref.id)
		.where("preset", "is not", null)
		.executeTakeFirst();
	if (res.numUpdatedRows === 0n) throw new NotFoundError("no such rule set");
}

/** Replaces the rules added on top of the preset (or a sub-level's rules). */
export async function setRules(db: Db, ref: RuleRef, rules: Rule[]): Promise<void> {
	const res = await db
		.updateTable("rule_sets")
		.set({ rules: JSON.stringify(rules), updated_at: new Date().toISOString() })
		.where("scope_type", "=", ref.type)
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
	await db.deleteFrom("rule_sets").where("scope_type", "=", ref.type).where("scope_id", "=", ref.id).execute();
}

/** The effective rule set of one level: a root's preset rules come before the rules added on top. */
export function effectiveRuleSet(stored: StoredRuleSet): RuleSet {
	if (!stored.preset) return { default: stored.default, rules: stored.rules };
	const base = presetRuleSet(stored.preset);
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
