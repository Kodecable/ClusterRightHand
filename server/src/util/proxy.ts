import http from "node:http";
import { UserError } from "./errors.ts";

/**
 * Outbound proxy support (doc/guide/install.md "Outbound proxy"). The process environment is the only
 * source: `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY`, lower-case forms included. Node reads the same
 * variables and gives the lower-case name precedence when both forms are set, so the values are passed
 * through unchanged; only the log line normalises them.
 */
export interface OutboundProxy {
	httpProxy: string | undefined;
	httpsProxy: string | undefined;
	noProxy: string | undefined;
}

/** A variable's lower-case form wins over its upper-case form, and an empty value counts as unset. */
function proxyEnvValue(env: NodeJS.ProcessEnv, lowerCase: string, upperCase: string): string | undefined {
	return env[lowerCase] || env[upperCase] || undefined;
}

/** The effective proxy settings, or `undefined` when neither an HTTP nor an HTTPS proxy is configured. */
export function outboundProxySettings(env: NodeJS.ProcessEnv = process.env): OutboundProxy | undefined {
	const httpProxy = proxyEnvValue(env, "http_proxy", "HTTP_PROXY");
	const httpsProxy = proxyEnvValue(env, "https_proxy", "HTTPS_PROXY");
	if (httpProxy === undefined && httpsProxy === undefined) return undefined;
	return { httpProxy, httpsProxy, noProxy: proxyEnvValue(env, "no_proxy", "NO_PROXY") };
}

/**
 * A proxy URL as it may be logged: credentials, path and query are dropped, because a proxy password
 * would otherwise end up in the journal. The result names the proxy's scheme, host and port only.
 */
export function proxyUrlForLog(value: string): string {
	try {
		const url = new URL(value);
		return `${url.protocol}//${url.host}`;
	} catch {
		return "<invalid>";
	}
}

/** The one startup line describing the effective settings, with credentials removed. */
export function formatOutboundProxy(settings: OutboundProxy): string {
	const httpProxy = settings.httpProxy === undefined ? "(none)" : proxyUrlForLog(settings.httpProxy);
	const httpsProxy = settings.httpsProxy === undefined ? "(none)" : proxyUrlForLog(settings.httpsProxy);
	const noProxy = settings.noProxy === undefined ? "(none)" : settings.noProxy;
	return `HTTP_PROXY=${httpProxy}, HTTPS_PROXY=${httpsProxy}, NO_PROXY=${noProxy}`;
}

/**
 * Applies the environment proxy to Node's global fetch, WebSocket and HTTP(S) agents
 * (doc/guide/install.md "Outbound proxy"). Nothing happens when no proxy is configured. An invalid
 * URL stops startup with a `UserError` that does not repeat the URL, which may hold a password.
 * Returns the function that restores the previous global state; tests use it.
 */
export function configureOutboundProxy(
	env: NodeJS.ProcessEnv = process.env,
	log: (message: string) => void = console.log,
): () => void {
	const settings = outboundProxySettings(env);
	if (settings === undefined) return () => {};
	for (const [name, value] of [
		["HTTP_PROXY", settings.httpProxy],
		["HTTPS_PROXY", settings.httpsProxy],
	] as const) {
		if (value === undefined) continue;
		let url: URL;
		try {
			url = new URL(value);
		} catch {
			throw new UserError(`${name} is not a valid proxy URL`);
		}
		if (url.protocol !== "http:" && url.protocol !== "https:") {
			throw new UserError(`${name} must be an http:// or https:// proxy URL`);
		}
	}
	let restore: () => void;
	try {
		restore = http.setGlobalProxyFromEnv(env);
	} catch {
		// Node's own error repeats the URL it rejected; keep that out of the log.
		throw new UserError("the outbound proxy configuration is invalid");
	}
	log(`crhs: outbound proxy: ${formatOutboundProxy(settings)}`);
	return restore;
}
