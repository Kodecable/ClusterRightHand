import type { Hono } from "hono";
import { type AppOptions, createApp } from "../../src/api/app.ts";
import type { AppEnv } from "../../src/api/context.ts";
import { LoginLimiter } from "../../src/auth/login-limiter.ts";
import type { Db } from "../../src/storage/db.ts";

export type App = Hono<AppEnv>;

export function makeApp(db: Db, limiter = new LoginLimiter(), extra: Partial<AppOptions> = {}): App {
	return createApp(db, { limiter, clientAddress: () => "198.51.100.7", ...extra });
}

export interface Req {
	method?: string;
	cookie?: string;
	body?: unknown;
	headers?: Record<string, string>;
}

export function call(app: App, path: string, { method, cookie, body, headers }: Req = {}) {
	const h: Record<string, string> = { host: "localhost:8080", ...headers };
	if (cookie) h.cookie = cookie;
	const init: RequestInit = { method: method ?? (body === undefined ? "GET" : "POST"), headers: h };
	if (body !== undefined) {
		if (!Object.keys(h).some((k) => k.toLowerCase() === "content-type")) h["content-type"] = "application/json";
		init.body = JSON.stringify(body);
	}
	return app.request(path, init);
}

/** The `crh_session=<token>` pair from a response's set-cookie header. */
export function sessionCookie(res: Response): string | undefined {
	return res.headers.get("set-cookie")?.match(/crh_session=([^;]+)/)?.[0];
}

export async function login(app: App, username: string, password: string): Promise<string> {
	const res = await call(app, "/api/auth/login", { body: { username, password } });
	const cookie = sessionCookie(res);
	if (res.status !== 200 || !cookie) throw new Error(`login failed for ${username}: ${res.status}`);
	return cookie;
}
