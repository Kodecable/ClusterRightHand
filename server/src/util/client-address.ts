/**
 * The client address a request is keyed by: the first non-empty element of the configured real-IP
 * header, or the direct remote address when the header is not configured, absent or empty. There is
 * deliberately no trusted-proxy list and no right-to-left walk: the deployer is responsible for a proxy
 * that sets the header correctly (doc/guide/reference/crhs-config.md "[listen]"). The API's audit records
 * and the terminal attach endpoint share it, so both agree on who connected.
 */
export function resolveClientAddress(
	direct: string | undefined,
	headerName: string | undefined,
	headerValue: string | undefined,
): string | undefined {
	if (headerName !== undefined && headerValue !== undefined) {
		for (const part of headerValue.split(",")) {
			const value = part.trim();
			if (value !== "") return value;
		}
	}
	return direct;
}
