import type { Operation, Rule } from "@crh/api";

/**
 * The allow rule offered by "Approve and always allow", built from the
 * operation the server reports. It carries the task's `privileged` value so
 * that allowing a privileged call does not also allow ordinary ones
 * (doc/design/access-control.md "Rules").
 */
export function alwaysRule(
	operation: Operation | null | undefined,
	nodes: string[],
	mode: "exact" | "prefix",
	privileged: boolean,
): Rule | undefined {
	if (!operation) return undefined;
	return { action: "allow", method: operation.method, nodes, privileged, [mode]: operation.target };
}

/** The actor of a task / token for display; token ids are resolved through the given map. */
export function actorLabel(type: string, id: string, tokenNames: Map<string, string>): string {
	return type === "api_token" ? `API token ${tokenNames.get(id) ?? id}` : `${type} ${id}`;
}

/** POSIX single quoting as the server renders command lines: plain words stay bare. */
export function shellQuote(value: string): string {
	return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}
