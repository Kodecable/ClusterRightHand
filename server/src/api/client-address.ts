import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context } from "hono";
import { resolveClientAddress } from "../util/client-address.ts";

export { resolveClientAddress } from "../util/client-address.ts";

/** The socket's direct remote address; undefined where the context has no socket (tests, proxies). */
export function directClientAddress(c: Context): string | undefined {
	try {
		return getConnInfo(c).remote.address;
	} catch {
		return undefined;
	}
}

/**
 * Builds the `clientAddress` function for `createApp` from `listen.real_ip_header`. The header name
 * may be a function, so System settings is read per request and a change applies without a restart.
 */
export function createClientAddress(
	headerName: string | null | undefined | (() => string | null | undefined),
): (c: Context) => string | undefined {
	const configured = typeof headerName === "function" ? headerName : () => headerName;
	return (c) => {
		const header = configured();
		if (!header) return directClientAddress(c);
		return resolveClientAddress(directClientAddress(c), header, c.req.header(header));
	};
}
