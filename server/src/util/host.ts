/**
 * A host, optionally with a port, in the form an Origin and a Host header compare in: lower-case, and
 * without the default port of `scheme`. The scheme is the Origin's; a Host header has none of its own,
 * so the proxy's `host:443` for an https origin equals `example.com`. The API's CSRF guard and the
 * terminal attach endpoint share it, so both accept and refuse the same origins.
 */
export function normalizedHost(host: string, scheme: string): string {
	const lower = host.trim().toLowerCase();
	const defaultPort = scheme === "https" ? ":443" : scheme === "http" ? ":80" : undefined;
	return defaultPort !== undefined && lower.endsWith(defaultPort) ? lower.slice(0, -defaultPort.length) : lower;
}
