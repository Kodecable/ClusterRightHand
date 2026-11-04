/**
 * The one HTTP client of the WebUI.
 *
 * Every request goes through `request()`, which:
 *  - prefixes `/api` (the dev server proxies it to crhs);
 *  - parses JSON errors into a typed `ApiError` carrying the status;
 *  - reports a 401 (except on the login call itself) to the auth store, which
 *    clears the user and lets the router guard redirect to the login page.
 */

export class ApiError extends Error {
	readonly status: number;
	readonly code: string | null;

	constructor(status: number, message: string, code: string | null = null) {
		super(message);
		this.name = "ApiError";
		this.status = status;
		this.code = code;
	}
}

export type UnauthorizedHandler = () => void;

let unauthorizedHandler: UnauthorizedHandler | null = null;

export function setUnauthorizedHandler(handler: UnauthorizedHandler | null): void {
	unauthorizedHandler = handler;
}

/** Drop the query parameters whose value is undefined or an empty string. */
export function queryString(params: Record<string, string | number | boolean | null | undefined>): string {
	const search = new URLSearchParams();
	for (const [key, value] of Object.entries(params)) {
		if (value === undefined || value === null || value === "") continue;
		search.set(key, String(value));
	}
	const text = search.toString();
	return text === "" ? "" : `?${text}`;
}

export interface RequestOptions {
	method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
	body?: unknown;
	signal?: AbortSignal;
	/** Set for the login call: a 401 there is a wrong password, not a lost session. */
	skipUnauthorized?: boolean;
}

async function errorDetails(response: Response): Promise<{ message: string; code: string | null }> {
	try {
		const data: unknown = await response.json();
		if (data !== null && typeof data === "object") {
			const record = data as Record<string, unknown>;
			const message = typeof record.error === "string" ? record.error : null;
			const code = typeof record.code === "string" ? record.code : null;
			if (message !== null) return { message, code };
		}
	} catch {
		// A non-JSON error body: fall back to the status line below.
	}
	return { message: `HTTP ${response.status}`, code: null };
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
	const method = options.method ?? "GET";
	const init: RequestInit = { method, credentials: "same-origin" };
	if (options.signal) init.signal = options.signal;
	if (method !== "GET") {
		// The server's CSRF guard requires a JSON content type on every write, DELETE included.
		init.headers = { "content-type": "application/json" };
		init.body = JSON.stringify(options.body ?? {});
	}
	const response = await fetch(`/api${path}`, init);
	if (!response.ok) {
		const { message, code } = await errorDetails(response);
		if (response.status === 401 && !options.skipUnauthorized) unauthorizedHandler?.();
		throw new ApiError(response.status, message, code);
	}
	if (response.status === 204) return undefined as T;
	const text = await response.text();
	if (text === "") return undefined as T;
	return JSON.parse(text) as T;
}

export const http = {
	get: <T>(path: string, options?: Omit<RequestOptions, "method" | "body">) => request<T>(path, options),
	post: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, "method" | "body">) =>
		request<T>(path, { ...options, method: "POST", body }),
	put: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, "method" | "body">) =>
		request<T>(path, { ...options, method: "PUT", body }),
	patch: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, "method" | "body">) =>
		request<T>(path, { ...options, method: "PATCH", body }),
	del: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, "method" | "body">) =>
		request<T>(path, { ...options, method: "DELETE", body }),
};

/** Whether a query failed because the resource does not exist (the retention sweep removed it, for example). */
export function isNotFound(error: unknown): boolean {
	return error instanceof ApiError && error.status === 404;
}

/** A human-readable message for an unknown thrown value (server messages are not translated). */
export function errorMessage(error: unknown): string {
	if (error instanceof ApiError) return error.message;
	if (error instanceof Error) return error.message;
	return String(error);
}

export const enc = encodeURIComponent;
