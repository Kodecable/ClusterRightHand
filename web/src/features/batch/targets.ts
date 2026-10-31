/** Splits a comma/whitespace separated list, dropping empties and duplicates. */
export function parseList(text: string): string[] {
	return [...new Set(text.split(/[\s,]+/).filter(Boolean))];
}

/** Batch targets: checked node names, plus free-text groups ("web" or "group:web") and raw targets. */
export function buildTargets(nodeNames: string[], extra: string): string[] {
	return [...new Set([...nodeNames, ...parseList(extra)])];
}
