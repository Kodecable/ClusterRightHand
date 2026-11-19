import { describe, expect, it } from "vitest";
import { SatoriChannel } from "../src/channels/satori.ts";
import { TelegramChannel } from "../src/channels/telegram.ts";

/**
 * The adapters' network bounds (doc/design/channels.md "Channel kinds"): an API call and a file download give up
 * after their timeout, the stop signal of a running connection also ends them, and the failure is redacted like
 * every other error. The timeouts are injectable, so these tests never wait the real 30 or 120 seconds.
 */

interface Recorded {
	url: string;
	signal: AbortSignal | undefined;
}

/** A fetch that records its calls and hangs until the passed signal aborts. */
function hangingFetch(): { fetchImpl: typeof fetch; calls: Recorded[] } {
	const calls: Recorded[] = [];
	const fetchImpl = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
		const signal = init?.signal ?? undefined;
		calls.push({ url: String(input), signal });
		return new Promise<Response>((_resolve, reject) => {
			const abort = (): void => reject(signal?.reason);
			if (signal?.aborted) return abort();
			signal?.addEventListener("abort", abort, { once: true });
		});
	}) as typeof fetch;
	return { fetchImpl, calls };
}

/** A fetch that answers every call with the given bytes. */
function textFetch(body: string): { fetchImpl: typeof fetch; calls: Recorded[] } {
	const calls: Recorded[] = [];
	const fetchImpl = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
		calls.push({ url: String(input), signal: init?.signal ?? undefined });
		return Promise.resolve(new Response(body, { status: 200, headers: { "content-type": "text/plain" } }));
	}) as typeof fetch;
	return { fetchImpl, calls };
}

const TOKEN = "satori-secret-token";
const BASE = "http://127.0.0.1:9/satori";

function satori(fetchImpl: typeof fetch): SatoriChannel {
	return new SatoriChannel({
		channelId: "satori-1",
		url: BASE,
		token: TOKEN,
		platform: "telegram",
		botId: "1",
		fetch: fetchImpl,
		initialCursor: 0,
		onCursor: async () => {},
		callTimeoutMs: 20,
		downloadTimeoutMs: 20,
	});
}

/** The error one rejected promise settled with. */
async function rejection(promise: Promise<unknown>): Promise<Error> {
	try {
		await promise;
	} catch (err) {
		if (err instanceof Error) return err;
		return new Error(String(err));
	}
	throw new Error("the promise resolved");
}

describe("satori network bounds", () => {
	it("gives up on an API call that never answers, redacted", async () => {
		const { fetchImpl, calls } = hangingFetch();
		const channel = satori(fetchImpl);
		const error = await rejection(channel.sendText({ chatId: "1" }, "hi"));
		expect(error.message).toContain("satori message.create failed");
		expect(error.message.toLowerCase()).toMatch(/timeout|aborted/);
		expect(error.message).not.toContain(TOKEN);
		expect(calls[0]?.url).toBe(`${BASE}/v1/message.create`);
		// The request carried a timeout signal of its own.
		expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);
	});

	it("gives up on a file download that never answers, redacted", async () => {
		const { fetchImpl, calls } = hangingFetch();
		const channel = satori(fetchImpl);
		const error = await rejection(
			channel.downloadFile(
				{ fileId: "https://cdn.example/huge.png", name: "huge.png", mediaType: "image/png", bytes: null },
				{ maxBytes: 1024 },
			),
		);
		expect(error.message).toContain("satori file download failed");
		expect(error.message.toLowerCase()).toMatch(/timeout|aborted/);
		expect(error.message).not.toContain(TOKEN);
		expect(calls[0]?.url).toBe(`${BASE}/v1/proxy/https://cdn.example/huge.png`);
	});

	it("fetches gateway-served files directly and proxies any /v1/ API path", async () => {
		const own = "http://127.0.0.1:9/satori/v1/proxy/telegram/1/photo.png";
		const admin = "http://127.0.0.1:9/v1/admin/secret.png";
		const direct = textFetch("direct");
		const channel = satori(direct.fetchImpl);
		const file = await channel.downloadFile(
			{ fileId: own, name: "photo.png", mediaType: "image/png", bytes: null },
			{ maxBytes: 1024 },
		);
		expect(new TextDecoder().decode(file.bytes)).toBe("direct");
		expect(direct.calls[0]?.url).toBe(own);

		// A file the gateway serves outside its proxy roots (Koishi's Telegram adapter) is fetched directly.
		const served = "http://127.0.0.1:9/telegram/1/photo.png";
		const servedFetch = textFetch("served");
		await satori(servedFetch.fetchImpl).downloadFile(
			{ fileId: served, name: "photo.png", mediaType: "image/png", bytes: null },
			{ maxBytes: 1024 },
		);
		expect(servedFetch.calls[0]?.url).toBe(served);

		// A /v1/ API path is never fetched with the token, whatever its prefix or spelling: the proxy checks it.
		for (const src of [
			admin,
			"http://127.0.0.1:9/satori/v1/admin/secret.png",
			"http://127.0.0.1:9/satori/v1/proxy/../admin/secret.png",
			"http://127.0.0.1:9//satori//V1//admin/secret.png",
			"http://127.0.0.1:9/satori/v1%2fadmin/secret.png",
		]) {
			const proxied = textFetch("proxied");
			await satori(proxied.fetchImpl).downloadFile(
				{ fileId: src, name: "secret.png", mediaType: "image/png", bytes: null },
				{ maxBytes: 1024 },
			);
			expect(proxied.calls[0]?.url).toBe(`${BASE}/v1/proxy/${src}`);
		}
	});

	it("ends a call when the connection stops", async () => {
		const { fetchImpl, calls } = hangingFetch();
		const channel = satori(fetchImpl);
		// A fake long-running connection keeps the stop signal alive while the call is in flight.
		const loop = channel as unknown as { run: (signal: AbortSignal) => Promise<void> };
		const controller = new AbortController();
		loop.run = () => new Promise<void>((resolve) => controller.signal.addEventListener("abort", () => resolve()));
		channel.start();
		const pending = channel.sendText({ chatId: "1" }, "hi");
		controller.abort();
		const error = await rejection(pending);
		expect(error.message).toContain("satori message.create failed");
		expect(calls[0]?.signal?.aborted).toBe(true);
		await channel.stop();
	});
});

describe("telegram download bounds", () => {
	it("gives up on a file download that never answers, redacted", async () => {
		const calls: Recorded[] = [];
		const token = "123:telegram-secret";
		const fetchImpl = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
			const url = String(input);
			calls.push({ url, signal: init?.signal ?? undefined });
			if (url.endsWith("/getFile")) {
				return Promise.resolve(
					new Response(JSON.stringify({ ok: true, result: { file_id: "f1", file_path: "photos/x.png" } }), {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
				);
			}
			const signal = init?.signal ?? undefined;
			return new Promise<Response>((_resolve, reject) => {
				const abort = (): void => reject(signal?.reason);
				if (signal?.aborted) return abort();
				signal?.addEventListener("abort", abort, { once: true });
			});
		}) as typeof fetch;
		const channel = new TelegramChannel({
			channelId: "telegram-1",
			token,
			fetch: fetchImpl,
			pollTimeoutSeconds: 1,
			initialCursor: 0,
			onCursor: async () => {},
			downloadTimeoutMs: 20,
		});
		const error = await rejection(
			channel.downloadFile({ fileId: "f1", name: "x.png", mediaType: "image/png", bytes: null }, { maxBytes: 1024 }),
		);
		expect(error.message).toContain("Telegram file download failed");
		expect(error.message.toLowerCase()).toMatch(/timeout|aborted/);
		expect(error.message).not.toContain(token);
		const download = calls.find((call) => call.url.includes("/file/bot"));
		expect(download?.signal).toBeInstanceOf(AbortSignal);
	});
});
