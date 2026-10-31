/** The command that enrols a new crha on a node (shown on the nodes page). */
export function enrollCommand(origin: string, token: string): string {
	return `crha enroll ${origin} ${token}`;
}

/** The `OS pretty name` fact of a node, if it reported one. */
export function osName(facts: Record<string, unknown> | null): string {
	const value = facts?.osPrettyName;
	return typeof value === "string" && value !== "" ? value : "–";
}
