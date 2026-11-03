/**
 * The command that enrols a new crha on a node (shown on the nodes page). The paths are the
 * suggested install layout, not crha defaults.
 */
export function enrollCommand(origin: string, token: string): string {
	return `crha enroll --config /etc/crha/crha.toml --state-dir /var/lib/crha ${origin} ${token}`;
}

/** The `OS pretty name` fact of a node, if it reported one. */
export function osName(facts: Record<string, unknown> | null): string {
	const value = facts?.osPrettyName;
	return typeof value === "string" && value !== "" ? value : "–";
}
