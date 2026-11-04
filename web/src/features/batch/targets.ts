import { parseList } from "@/lib/format";
import { ALL_TARGET } from "@/lib/names";

/**
 * The batch target picker's selection: node and node-group names it chose,
 * the "all my nodes" switch, and free-text names. The API accepts names or
 * UUIDs; names are what the picker has and what a task group displays.
 */
export interface BatchTargetSelection {
	nodes?: string[];
	nodeGroups?: string[];
	/** Every node the caller can operate, evaluated by the server (`_all`). */
	all?: boolean;
	/** Comma-separated node or node-group names (or `_all`). */
	extra?: string;
}

/** Builds the POST body's `targets`: names, `_all` alone, no `group:` syntax, no duplicates. */
export function buildTargets(selection: BatchTargetSelection): string[] {
	if (selection.all === true) return [ALL_TARGET];
	const targets: string[] = [];
	const seen = new Set<string>();
	for (const raw of [
		...(selection.nodes ?? []),
		...(selection.nodeGroups ?? []),
		...parseList(selection.extra ?? ""),
	]) {
		const name = raw.trim();
		if (name === "") continue;
		// Names and node-group names share one case-insensitive namespace (D109).
		const key = name.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		targets.push(name);
	}
	return targets;
}
