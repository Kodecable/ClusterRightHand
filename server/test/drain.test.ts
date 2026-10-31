import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/api/app.ts";
import type { AppEnv } from "../src/api/context.ts";
import { RequestDrain } from "../src/api/drain.ts";
import { openDb } from "../src/storage/db.ts";
import { InProcessCrhs } from "./e2e/harness.ts";

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	return Promise.race([
		promise,
		new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms);
		}),
	]).finally(() => clearTimeout(timer));
}

/** Reads an SSE response until `needle` is seen; the stream stays open. */
async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, needle: string): Promise<string> {
	const decoder = new TextDecoder();
	let text = "";
	while (!text.includes(needle)) {
		const chunk = await withTimeout(reader.read(), 5_000, `"${needle}" on the event stream`);
		if (chunk.done) throw new Error(`the event stream ended before "${needle}"`);
		text += decoder.decode(chunk.value, { stream: true });
	}
	return text;
}

async function readToEnd(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
	for (;;) {
		const chunk = await reader.read();
		if (chunk.done) return;
	}
}

describe("request drain", () => {
	it("keeps shutdown waiting for a request that is still being handled", async () => {
		const drain = new RequestDrain();
		const entered = deferred();
		const finish = deferred();
		const app = new Hono<AppEnv>();
		app.use("*", drain.middleware());
		app.get("/slow", async (c) => {
			entered.resolve();
			await finish.promise;
			return c.json({ ok: true });
		});

		const response = app.request("/slow");
		await entered.promise;
		drain.begin();
		let idle = false;
		const waiting = drain.waitForIdle().then(() => {
			idle = true;
		});
		// The handler is still blocked, so shutdown must still be waiting.
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(idle).toBe(false);

		finish.resolve();
		expect((await response).status).toBe(200);
		await waiting;
		expect(idle).toBe(true);
	});

	it("keeps shutdown waiting until the reply has been written", async () => {
		const drain = new RequestDrain();
		const reply = new EventEmitter();
		const entered = deferred();
		const finish = deferred();
		const app = new Hono<AppEnv>();
		app.use("*", drain.middleware());
		app.get("/slow", async (c) => {
			entered.resolve();
			await finish.promise;
			return c.json({ ok: true });
		});

		const response = app.request("/slow", {}, { outgoing: reply } as never);
		await entered.promise;
		drain.begin();
		let idle = false;
		const waiting = drain.waitForIdle().then(() => {
			idle = true;
		});
		finish.resolve();
		expect((await response).status).toBe(200);
		// The handler returned, but shutdown drops connections after the drain: the reply hold still waits.
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(idle).toBe(false);
		reply.emit("finish");
		await waiting;
		expect(idle).toBe(true);
	});

	it("keeps waiting for the handler when the client goes before the reply", async () => {
		const drain = new RequestDrain();
		const reply = new EventEmitter();
		const entered = deferred();
		const finish = deferred();
		const app = new Hono<AppEnv>();
		app.use("*", drain.middleware());
		app.get("/slow", async (c) => {
			entered.resolve();
			await finish.promise;
			return c.json({ ok: true });
		});

		const response = app.request("/slow", {}, { outgoing: reply } as never);
		await entered.promise;
		drain.begin();
		let idle = false;
		const waiting = drain.waitForIdle().then(() => {
			idle = true;
		});
		// The response cannot be written any more, but the handler may still be using the database.
		reply.emit("close");
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(idle).toBe(false);
		finish.resolve();
		await response;
		await waiting;
		expect(idle).toBe(true);
	});

	it("resolves every waitForIdle caller, not only the first", async () => {
		const drain = new RequestDrain();
		const release = drain.hold();
		drain.begin();
		const first = drain.waitForIdle();
		const second = drain.waitForIdle();
		release();
		// A single idle resolver would leave the second call pending forever.
		await withTimeout(Promise.all([first, second]), 5_000, "both waitForIdle callers");
		expect(drain.draining).toBe(true);
	});

	it("refuses a request that arrives after shutdown began without touching the database", async () => {
		const db = openDb({ driver: "sqlite", path: ":memory:" });
		const drain = new RequestDrain();
		const app = createApp(db, { drain });
		// Any query now fails, so a 503 (rather than a 500) shows the request never reached the database.
		await db.destroy();
		drain.begin();

		const res = await app.request("/api/health");
		expect(res.status).toBe(503);
		expect(res.headers.get("connection")).toBe("close");
		expect(await res.json()).toEqual({ error: "server is shutting down" });
	});

	it("ends an open session event stream when shutdown begins", async () => {
		const dir = await mkdtemp(join(tmpdir(), "crh-drain-"));
		const drain = new RequestDrain();
		const crhs = await InProcessCrhs.create({}, { drain }, dir);
		try {
			await crhs.loginAdmin();
			const model = { provider: crhs.faux.provider.id, modelId: crhs.faux.getModel().id };
			const created = await crhs.api("/api/sessions", { body: { model } });
			expect(created.status).toBe(201);

			const response = await fetch(`${crhs.url}/api/sessions/${created.json.session.id}/events`, {
				headers: { cookie: crhs.cookie },
			});
			expect(response.status).toBe(200);
			const reader = response.body?.getReader();
			if (!reader) throw new Error("the event stream has no body");
			// The snapshot proves the stream is live before shutdown, and it is not closed by the client.
			await readUntil(reader, "snapshot");

			drain.begin();
			const refused = await fetch(`${crhs.url}/api/health`);
			expect(refused.status).toBe(503);
			expect(refused.headers.get("connection")).toBe("close");

			// Ending the stream lets its callback return, which is what shutdown waits for.
			await withTimeout(readToEnd(reader), 5_000, "the event stream to end");
			await withTimeout(drain.waitForIdle(), 5_000, "the drain to go idle");
		} finally {
			await crhs.destroy();
			await rm(dir, { recursive: true, force: true });
		}
	});
});
