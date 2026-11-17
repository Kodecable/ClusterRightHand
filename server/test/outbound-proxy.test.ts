import http, { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TelegramChannel } from "../src/channels/telegram.ts";
import { configureOutboundProxy, formatOutboundProxy, outboundProxySettings } from "../src/util/proxy.ts";
import { startFakeTelegram } from "./helpers/fake-telegram.ts";

/**
 * The environment proxy (doc/guide/install.md "Outbound proxy"): a local proxy forwards absolute-form HTTP
 * requests, so a request either reaches it or the target directly. Vitest isolates files, and every global
 * change this file makes is restored in afterEach, so the other suites' local fakes stay direct.
 */

const PROXY_ENV_NAMES = ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"] as const;

interface ProxyHandle {
	readonly url: string;
	readonly requests: string[];
	close(): Promise<void>;
}

/** An HTTP forward proxy for absolute-form requests; it always dials the target directly. */
async function startProxy(): Promise<ProxyHandle> {
	const requests: string[] = [];
	const direct = new http.Agent({ keepAlive: false });
	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		if (req.url === undefined || !req.url.startsWith("http://")) {
			res.writeHead(400);
			res.end();
			return;
		}
		requests.push(req.url);
		const target = new URL(req.url);
		const upstream = http.request(
			{
				host: target.hostname,
				port: target.port,
				path: `${target.pathname}${target.search}`,
				method: req.method,
				headers: req.headers,
				agent: direct,
			},
			(response) => {
				res.writeHead(response.statusCode ?? 502, response.headers);
				response.pipe(res);
			},
		);
		upstream.on("error", () => {
			if (!res.headersSent) res.writeHead(502);
			res.end();
		});
		req.pipe(upstream);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${port}`,
		requests,
		async close() {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			direct.destroy();
		},
	};
}

interface TargetHandle {
	readonly url: string;
	readonly hits: string[];
	close(): Promise<void>;
}

async function startTarget(): Promise<TargetHandle> {
	const hits: string[] = [];
	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		hits.push(req.url ?? "");
		res.writeHead(200, { "content-type": "text/plain" });
		res.end("target-ok");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${port}/resource`,
		hits,
		async close() {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

let proxy: ProxyHandle;
let target: TargetHandle;
let restoreGlobal: (() => void) | undefined;
let savedEnv: Map<string, string | undefined>;

beforeAll(async () => {
	proxy = await startProxy();
	target = await startTarget();
});

afterAll(async () => {
	await proxy.close();
	await target.close();
});

beforeEach(() => {
	proxy.requests.length = 0;
	target.hits.length = 0;
	savedEnv = new Map();
	for (const name of PROXY_ENV_NAMES) {
		savedEnv.set(name, process.env[name]);
		delete process.env[name];
	}
});

afterEach(() => {
	restoreGlobal?.();
	restoreGlobal = undefined;
	for (const [name, value] of savedEnv) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
});

describe("outbound proxy settings", () => {
	it("treats lower-case names as authoritative, like Node", () => {
		expect(
			outboundProxySettings({
				HTTP_PROXY: "http://upper.example:8080",
				http_proxy: "http://lower.example:3128",
				HTTPS_PROXY: "http://upper-secure.example:8443",
				NO_PROXY: "upper.example",
				no_proxy: "lower.example",
			}),
		).toEqual({
			httpProxy: "http://lower.example:3128",
			httpsProxy: "http://upper-secure.example:8443",
			noProxy: "lower.example",
		});
	});

	it("returns undefined when no proxy is configured", () => {
		expect(outboundProxySettings({})).toBeUndefined();
		expect(outboundProxySettings({ NO_PROXY: "localhost" })).toBeUndefined();
	});

	it("strips credentials and everything after the host from the startup line", () => {
		const settings = outboundProxySettings({
			http_proxy: "http://alice:s3cret@proxy.example:3128/tenant?password=leak",
			HTTPS_PROXY: "https://bob:pass@secure-proxy.example:8443",
			NO_PROXY: "localhost,.corp.example",
		});
		expect(settings).toBeDefined();
		const line = formatOutboundProxy(settings as NonNullable<typeof settings>);
		expect(line).toBe(
			"HTTP_PROXY=http://proxy.example:3128, HTTPS_PROXY=https://secure-proxy.example:8443, NO_PROXY=localhost,.corp.example",
		);
		for (const secret of ["alice", "s3cret", "bob", "pass", "tenant", "password", "leak"]) {
			expect(line).not.toContain(secret);
		}
	});
});

describe("configureOutboundProxy", () => {
	it("does nothing and logs nothing without a proxy", () => {
		const lines: string[] = [];
		const restore = configureOutboundProxy({ NO_PROXY: "localhost" }, (line) => lines.push(line));
		restore();
		expect(lines).toEqual([]);
	});

	it("logs one line with the proxy URLs and the NO_PROXY list, without credentials", () => {
		const lines: string[] = [];
		restoreGlobal = configureOutboundProxy(
			{ HTTP_PROXY: `http://user:pw@${proxy.url.replace("http://", "")}`, NO_PROXY: "127.0.0.1,::1" },
			(line) => lines.push(line),
		);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toBe(`crhs: outbound proxy: HTTP_PROXY=${proxy.url}, HTTPS_PROXY=(none), NO_PROXY=127.0.0.1,::1`);
		expect(lines[0]).not.toContain("user");
		expect(lines[0]).not.toContain("pw");
	});

	it("rejects a URL that is not an http(s) proxy", () => {
		expect(() => configureOutboundProxy({ HTTP_PROXY: "socks5://proxy.example:1080" })).toThrow(
			/HTTP_PROXY must be an http/,
		);
	});

	it("sends the global fetch through the proxy", async () => {
		restoreGlobal = configureOutboundProxy({ HTTP_PROXY: proxy.url }, () => {});
		const response = await fetch(target.url);
		expect(await response.text()).toBe("target-ok");
		expect(proxy.requests).toEqual([target.url]);
	});

	it("reaches a NO_PROXY host directly", async () => {
		restoreGlobal = configureOutboundProxy({ HTTP_PROXY: proxy.url, NO_PROXY: "127.0.0.1" }, () => {});
		const response = await fetch(target.url);
		expect(await response.text()).toBe("target-ok");
		expect(proxy.requests).toEqual([]);
	});

	it("still proxies a host outside the NO_PROXY list", async () => {
		restoreGlobal = configureOutboundProxy({ HTTP_PROXY: proxy.url, NO_PROXY: "example.com" }, () => {});
		const response = await fetch(target.url);
		expect(await response.text()).toBe("target-ok");
		expect(proxy.requests).toEqual([target.url]);
	});
});

describe("Telegram through the outbound proxy", () => {
	it("sends Bot API calls through the global proxy", async () => {
		const fake = await startFakeTelegram();
		try {
			// The adapter hands grammY Node's global fetch, which the startup setting proxies.
			restoreGlobal = configureOutboundProxy({ HTTP_PROXY: proxy.url }, () => {});
			const channel = new TelegramChannel({
				channelId: "proxy-test",
				token: fake.token,
				apiRoot: fake.apiRoot,
				initialCursor: 0,
				onCursor: async () => {},
			});
			const sent = await channel.sendText({ chatId: "42", topicId: null }, "hello proxy");
			expect(sent.messageId).not.toBe("");
			expect(fake.callsOf("sendRichMessage")).toHaveLength(1);
			expect(proxy.requests).toEqual([`${fake.apiRoot}/bot${fake.token}/sendRichMessage`]);
		} finally {
			await fake.close();
		}
	});
});
