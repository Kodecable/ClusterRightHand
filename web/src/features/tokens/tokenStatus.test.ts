import { describe, expect, test } from "vitest";
import { mcpCommand, tokenStatus } from "./tokenStatus";

describe("tokenStatus", () => {
	test("revoked wins over expired", () => {
		const now = Date.parse("2026-01-01T00:00:00Z");
		expect(tokenStatus({ revokedAt: "x", expiresAt: null }, now)).toBe("revoked");
		expect(tokenStatus({ revokedAt: null, expiresAt: "2025-01-01T00:00:00Z" }, now)).toBe("expired");
		expect(tokenStatus({ revokedAt: null, expiresAt: null }, now)).toBe("active");
	});
});

test("mcpCommand builds the MCP client command", () => {
	expect(mcpCommand("http://h:1", "crh_x")).toBe(
		'claude mcp add --transport http crh http://h:1/mcp --header "Authorization: Bearer crh_x"',
	);
});
