/**
 * crhs's User-Agent on outbound requests (doc/design/architecture.md "Outbound requests"):
 * `ClusterRightHand/<version> (crhs)`, the same form crha uses with "(crha)".
 *
 * A User-Agent a request already carries is kept, so one set in an extension's or a provider's own
 * headers takes precedence. Model requests get theirs through pi-ai's client identity instead
 * (`CLIENT_IDENTITY` in agent/models.ts), which pi-ai applies beneath the configured headers.
 */
import { CRH_VERSION } from "../version.ts";

export const USER_AGENT = `ClusterRightHand/${CRH_VERSION} (crhs)`;

/** Marks a fetch already wrapped, so installing twice does not stack wrappers. */
const WRAPPED = Symbol.for("crh.userAgent");

/** Wraps a fetch so a request that sets no User-Agent carries crhs's. */
export function withUserAgent(fetchFn: typeof fetch): typeof fetch {
	const wrapped: typeof fetch = (input, init) => {
		const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
		if (headers.has("user-agent")) return fetchFn(input, init);
		headers.set("user-agent", USER_AGENT);
		return fetchFn(input, { ...init, headers });
	};
	return Object.assign(wrapped, { [WRAPPED]: true });
}

/**
 * Makes the process's global fetch add crhs's User-Agent where a request sets none, so every outbound
 * request that goes through it (the model catalogue, extensions, channels, WebDAV, search) is
 * identified alike. Called once at startup; repeated calls do nothing.
 */
export function installUserAgent(): void {
	const current = globalThis.fetch as typeof fetch & { [WRAPPED]?: true };
	if (current[WRAPPED]) return;
	globalThis.fetch = withUserAgent(current);
}
