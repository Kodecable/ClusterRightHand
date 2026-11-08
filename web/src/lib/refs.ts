import type { RefMap, Rule } from "@crh/api";
import { ALL_TARGET } from "@/lib/names";

/**
 * Helpers for the name lookups the server sends with task groups and rule sets
 * (D109): references are stored as UUIDs, and `refs` maps each one to its
 * current name (null once the object was deleted). `_all` has no entry.
 */

/** The names of the references that still exist, keyed by UUID. */
export function refNames(refs: RefMap | undefined): Map<string, string> {
	const names = new Map<string, string>();
	for (const [id, target] of Object.entries(refs ?? {})) {
		if (target !== null) names.set(id, target.name);
	}
	return names;
}

/**
 * One rule with its `nodes` UUIDs replaced by their current names, for display
 * and for the JSON rule editors: a name the server accepts on write. `_all`
 * and references without a name (a deleted object, an old entry) stay as they
 * are, so the stored rule round-trips.
 */
export function ruleWithNames(rule: Rule, names: Map<string, string>): Rule {
	if (rule.nodes === undefined) return rule;
	return { ...rule, nodes: rule.nodes.map((ref) => (ref === ALL_TARGET ? ref : (names.get(ref) ?? ref))) };
}

export function rulesWithNames(rules: readonly Rule[], names: Map<string, string>): Rule[] {
	return rules.map((rule) => ruleWithNames(rule, names));
}
