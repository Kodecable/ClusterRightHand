import { parseList } from "@/lib/format";

/** Batch targets: checked node names, plus free-text groups ("web" or "group:web") and raw targets. */
export function buildTargets(nodeNames: string[], extra: string): string[] {
	return [...new Set([...nodeNames, ...parseList(extra)])];
}
