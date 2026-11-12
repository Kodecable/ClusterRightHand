import capWasmUrl from "@cap.js/wasm/browser/cap_wasm_bg.wasm?url";
import hashwxWasmUrl from "@cap.js/wasm/browser/hashwx.wasm?url";
import { sha256 } from "@noble/hashes/sha2.js";
import { ApiError } from "@/lib/api/client";
import type { LoginCaptcha } from "@/lib/session";

/**
 * The WebUI side of the login proof of work (doc/design/access-control.md "Cap proof of work").
 *
 * The tag binds the challenge to the exact submitted credentials, so it is computed here with
 * @noble/hashes: `crypto.subtle` does not exist on a plain-HTTP LAN origin, and crhs may be opened
 * that way. The widget itself is a lazy chunk; its WASM files are served from web/dist, never a CDN.
 */

declare global {
	interface Window {
		/** cap-widget's pako fallback (instrumentation only); this app keeps it unreachable. */
		CAP_PAKO_URL?: string;
		/** Removes the widget referral query parameters; the widget is invisible and removed after a solve. */
		CAP_DISABLE_WIDGET_REF?: boolean;
	}
}

interface ChallengeResponse {
	challenge: { c: number; s: number; d: number };
	token: string;
	expires: number;
}

const API_ENDPOINT = "/api/auth/login/";
const CHALLENGE_PATH = `${API_ENDPOINT}challenge`;
const REDEEM_PATH = `${API_ENDPOINT}redeem`;

const encoder = new TextEncoder();

/** `base64url_nopad(SHA-256(UTF-8(username) || 0x00 || UTF-8(password)))`, on the exact strings. */
export function loginTag(username: string, password: string): string {
	const user = encoder.encode(username);
	const pass = encoder.encode(password);
	const bytes = new Uint8Array(user.length + 1 + pass.length);
	bytes.set(user, 0);
	// bytes[user.length] stays zero: the separator between the two strings.
	bytes.set(pass, user.length + 1);
	return base64url(sha256(bytes));
}

function base64url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

type CapModule = typeof import("cap-widget");

let capModulePromise: Promise<CapModule> | null = null;

/**
 * Load cap-widget once, with its WASM URLs pointed at the bundle. The module body starts fetching
 * cap_wasm_bg.wasm immediately, so the globals must be set before the import.
 *
 * cap-widget's other remote fallback is its pako loader, reached only when a challenge carries an
 * `instrumentation` blob. crhs's challenge response is exactly `{challenge, token, expires}`, so no
 * code path here ever calls it; the WASM globals below cover every CDN URL the widget would use.
 */
function loadCapModule(): Promise<CapModule> {
	if (capModulePromise) return capModulePromise;
	window.CAP_CUSTOM_WASM_URL = capWasmUrl;
	window.CAP_CUSTOM_HASHWX_URL = hashwxWasmUrl;
	window.CAP_DISABLE_WIDGET_REF = true;
	capModulePromise = import("cap-widget").catch((error: unknown) => {
		capModulePromise = null;
		throw error;
	});
	return capModulePromise;
}

function requestPath(input: RequestInfo | URL): string {
	const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
	return new URL(raw, window.location.href).pathname;
}

function jsonResponse(value: unknown): Response {
	return new Response(JSON.stringify(value), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

/**
 * The challenge request, with the app's HTTP conventions (same-origin credentials, JSON body). It
 * returns the server's own Response for the widget and turns a non-2xx answer into the same
 * `ApiError` (status + code) the rest of the WebUI uses, so a 429 shows its rate-limit message.
 */
async function requestChallenge(username: string, tag: string, signal?: AbortSignal): Promise<Response> {
	const response = await fetch(CHALLENGE_PATH, {
		method: "POST",
		credentials: "same-origin",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ username, tag }),
		signal,
	});
	if (response.ok) return response;
	let message = `HTTP ${response.status}`;
	let code: string | null = null;
	try {
		const data: unknown = await response.json();
		if (data !== null && typeof data === "object") {
			const record = data as Record<string, unknown>;
			if (typeof record.error === "string") message = record.error;
			if (typeof record.code === "string") code = record.code;
		}
	} catch {
		// A non-JSON error body: keep the status line.
	}
	throw new ApiError(response.status, message, code);
}

/**
 * Solve one challenge for the credentials the form is about to submit. The challenge is requested
 * only here, from the submit handler, so it is issued for the same username, password and address
 * as the following login. A fresh invisible widget is used per attempt and removed afterwards.
 */
export async function solveLoginCaptcha(username: string, password: string): Promise<LoginCaptcha> {
	const tag = loginTag(username, password);
	const Cap = (await loadCapModule()).default;

	let challenge: ChallengeResponse | null = null;
	const captured: { value: LoginCaptcha | null } = { value: null };
	const previousFetch = window.CAP_CUSTOM_FETCH;

	window.CAP_CUSTOM_FETCH = async (input, init) => {
		const path = requestPath(input);
		if (path === CHALLENGE_PATH) {
			const response = await requestChallenge(username, tag, init?.signal ?? undefined);
			// Keep a copy for the synthetic redeem response; the widget still gets the server's body.
			challenge = (await response.clone().json()) as ChallengeResponse;
			return response;
		}
		if (path === REDEEM_PATH) {
			// The widget would POST {token, solutions} to the real redeem endpoint. crhs verifies the
			// same token and solutions again when /login receives them, so this synthetic response only
			// has to have the shape cap-widget expects (success + token + a future expiry).
			const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : null;
			const record: Record<string, unknown> =
				typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
			const token = typeof record.token === "string" ? record.token : (challenge?.token ?? "");
			const solutions = Array.isArray(record.solutions) ? record.solutions.map((value) => Number(value)) : [];
			captured.value = { token, solutions };
			return jsonResponse({
				success: true,
				token,
				expires: challenge?.expires ?? Date.now() + 60_000,
			});
		}
		throw new Error(`unexpected captcha widget request: ${path}`);
	};

	let cap: InstanceType<typeof Cap> | null = null;
	try {
		cap = new Cap({ apiEndpoint: API_ENDPOINT });
		await cap.solve();
	} finally {
		cap?.widget.remove();
		if (previousFetch === undefined) delete window.CAP_CUSTOM_FETCH;
		else window.CAP_CUSTOM_FETCH = previousFetch;
	}

	const solution = captured.value;
	if (solution === null || solution.token === "" || solution.solutions.length === 0) {
		throw new Error("the captcha widget did not return a solution");
	}
	return solution;
}
