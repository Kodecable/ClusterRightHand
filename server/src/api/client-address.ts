import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context } from "hono";

/**
 * The client address a login attempt is keyed by: the first non-empty element of the configured
 * real-IP header, or the socket's direct remote address when the header is not configured, absent or
 * empty. There is deliberately no trusted-proxy list and no right-to-left walk: the deployer is
 * responsible for a proxy that sets the header correctly (doc/configuration.md#listen).
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

/** The socket's direct remote address; undefined where the context has no socket (tests, proxies). */
export function directClientAddress(c: Context): string | undefined {
	try {
		return getConnInfo(c).remote.address;
	} catch {
		return undefined;
	}
}

/** Builds the `clientAddress` function for `createApp` from `listen.real_ip_header`. */
export function createClientAddress(headerName: string | null | undefined): (c: Context) => string | undefined {
	if (!headerName) return directClientAddress;
	return (c) => resolveClientAddress(directClientAddress(c), headerName, c.req.header(headerName));
}
