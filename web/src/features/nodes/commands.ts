/** The `OS pretty name` fact of a node, if it reported one. */
export function osName(facts: Record<string, unknown> | null): string {
	const value = facts?.osPrettyName;
	return typeof value === "string" && value !== "" ? value : "–";
}
