import type { RefMap, RefTarget } from "@crh/api";
import { ALL_TARGET, isUuid, nameKey } from "../cluster/names.ts";
import type { Db } from "../storage/db.ts";
import { UserError } from "../users/service.ts";
import { parseRuleSet, parseRules, type Rule, type RuleSet } from "./rules.ts";

export type { RefMap, RefTarget };

/**
 * Rule and task-group references (D109): inputs accept names (case-insensitive), UUIDs or `_all`, and the
 * database stores UUIDs. These helpers do the write-time resolution and the reverse lookup used by API
 * responses to display names. A reference whose object was deleted has no name: it is reported as null.
 */

async function lookupRef(db: Db, orgId: string, ref: string): Promise<RefTarget | null> {
	const node = await db
		.selectFrom("nodes")
		.select("name")
		.where("org_id", "=", orgId)
		.where("id", "=", ref)
		.executeTakeFirst();
	if (node) return { kind: "node", name: node.name };
	const group = await db
		.selectFrom("node_groups")
		.select("name")
		.where("org_id", "=", orgId)
		.where("id", "=", ref)
		.executeTakeFirst();
	if (group) return { kind: "node_group", name: group.name };
	return null;
}

/** The display names for stored UUID references; `_all` and historical non-UUID entries are not UUID refs. */
export async function nameRefs(db: Db, orgId: string, refs: Iterable<string>): Promise<RefMap> {
	const ids = [...new Set([...refs].filter((ref) => ref !== ALL_TARGET && isUuid(ref)))];
	const out: RefMap = {};
	await Promise.all(
		ids.map(async (id) => {
			out[id] = await lookupRef(db, orgId, id);
		}),
	);
	return out;
}

export function ruleNodes(rules: readonly Rule[]): string[] {
	return rules.flatMap((rule) => rule.nodes ?? []);
}

export function ruleRefs(db: Db, orgId: string, rules: readonly Rule[]): Promise<RefMap> {
	return nameRefs(db, orgId, ruleNodes(rules));
}

export function targetRefs(db: Db, orgId: string, targets: readonly string[]): Promise<RefMap> {
	return nameRefs(db, orgId, targets);
}

/** Resolves one rule entry to a node/group UUID or `_all`; unknown names and ids are UserErrors. */
async function resolveNodeRef(db: Db, orgId: string, ref: string): Promise<string> {
	if (ref === ALL_TARGET) return ALL_TARGET;
	if (isUuid(ref)) {
		const node = await db
			.selectFrom("nodes")
			.select("id")
			.where("org_id", "=", orgId)
			.where("id", "=", ref)
			.executeTakeFirst();
		if (node) return node.id;
		const group = await db
			.selectFrom("node_groups")
			.select("id")
			.where("org_id", "=", orgId)
			.where("id", "=", ref)
			.executeTakeFirst();
		if (group) return group.id;
		throw new UserError(`no node or node group ${ref}`);
	}
	const node = await db
		.selectFrom("nodes")
		.select("id")
		.where("org_id", "=", orgId)
		.where("name_key", "=", nameKey(ref))
		.executeTakeFirst();
	if (node) return node.id;
	const group = await db
		.selectFrom("node_groups")
		.select("id")
		.where("org_id", "=", orgId)
		.where("name_key", "=", nameKey(ref))
		.executeTakeFirst();
	if (group) return group.id;
	throw new UserError(`no node or node group ${ref}`);
}

/** Resolves a rule's `nodes` entries at write time; keeps their order and removes duplicates. */
export async function resolveRuleNodes(db: Db, orgId: string, refs: string[]): Promise<string[]> {
	const out: string[] = [];
	for (const ref of refs) {
		const id = await resolveNodeRef(db, orgId, ref);
		if (!out.includes(id)) out.push(id);
	}
	return out;
}

export async function resolveRules(db: Db, orgId: string, rules: Rule[]): Promise<Rule[]> {
	return Promise.all(
		rules.map(async (rule) =>
			rule.nodes === undefined ? rule : { ...rule, nodes: await resolveRuleNodes(db, orgId, rule.nodes) },
		),
	);
}

/** Parses and resolves rules from an API/tool input; a name must exist in the organization. */
export async function parseRulesForWrite(db: Db, orgId: string, raw: unknown): Promise<Rule[]> {
	return resolveRules(db, orgId, parseRules(raw));
}

export async function parseRuleSetForWrite(db: Db, orgId: string, raw: unknown, root: boolean): Promise<RuleSet> {
	const set = parseRuleSet(raw, root);
	return { ...set, rules: await resolveRules(db, orgId, set.rules) };
}
