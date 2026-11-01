import { createHash } from "node:crypto";

/**
 * The stored form of a web session's cookie or an API token: a SHA-256 of the secret, so a database read
 * cannot be replayed as a credential. The secret itself is never stored.
 */
export function hashToken(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}
