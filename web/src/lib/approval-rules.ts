/** The actor of a task / token for display; token ids are resolved through the given map. */
export function actorLabel(type: string, id: string, tokenNames: Map<string, string>): string {
	return type === "api_token" ? `API token ${tokenNames.get(id) ?? id}` : `${type} ${id}`;
}
