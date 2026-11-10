export type TokenStatus = "active" | "expired" | "revoked";

/** The effective state of an API token: revoked wins over expired. */
export function tokenStatus(
	token: { revokedAt: string | null; expiresAt: string | null },
	now: number = Date.now(),
): TokenStatus {
	if (token.revokedAt !== null) return "revoked";
	if (token.expiresAt !== null && Date.parse(token.expiresAt) <= now) return "expired";
	return "active";
}

/** The command that registers this console with an MCP client (doc/guide/mcp.md). */
export function mcpCommand(origin: string, token: string): string {
	return `claude mcp add --transport http crh ${origin}/mcp --header "Authorization: Bearer ${token}"`;
}
