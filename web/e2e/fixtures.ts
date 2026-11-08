import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test as base, expect, type Page } from "@playwright/test";
import type { AppOptions } from "../../server/src/api/app.ts";
import { createUser } from "../../server/src/users/service.ts";
import { Env, InProcessCrhs } from "../../server/test/e2e/harness.ts";
import { CRHA_BIN, WEB_DIST } from "./global-setup.ts";

export { expect };

export const ADMIN = { username: "root", password: "admin-password" };

type CaptchaMode = "cap" | "none";

interface Options {
	/** Also enroll, approve and connect a real crha node (`test.use({ withNode: true })`). */
	withNode: boolean;
	/** Run the agent runtime (sessions) with the faux model: `crhs.faux` scripts it (`test.use({ withAgent: true })`). */
	withAgent: boolean;
	/** Tokens per second of the faux model's stream; 0 streams as fast as possible. */
	streamRate: number;
	/** The server's `[auth] captcha`; the login-captcha spec opts into "cap" (default "none" keeps other specs fast). */
	captcha: CaptchaMode;
	/** Lower the proof-of-work cost for the captcha spec; null keeps the server's production defaults. */
	captchaChallenge: { challengeCount: number; challengeSize: number; challengeDifficulty: number } | null;
}

interface Fixtures {
	/** The node environment when withNode is set. */
	env: Env | undefined;
	/** A fresh crhs serving the built WebUI; ADMIN exists and is logged in through the API unless captcha is cap. */
	crhs: InProcessCrhs;
	/** `page`, already logged in as ADMIN. */
	adminPage: Page;
}

export const test = base.extend<Options & Fixtures>({
	withNode: [false, { option: true }],
	withAgent: [false, { option: true }],
	streamRate: [0, { option: true }],
	captcha: ["none" as CaptchaMode, { option: true }],
	captchaChallenge: [null, { option: true }],
	env: async ({ withNode, withAgent, streamRate, captcha }, use) => {
		if (!withNode) return use(undefined);
		if (captcha === "cap") {
			throw new Error("withNode does not support captcha: cap; the login-captcha spec runs without a node");
		}
		const dir = await mkdtemp(join(tmpdir(), "crh-ui-"));
		const env = await Env.create(
			CRHA_BIN,
			dir,
			{},
			{ webRoot: WEB_DIST },
			{
				agent: withAgent,
				...(streamRate > 0 ? { fauxOptions: { tokensPerSecond: streamRate } } : {}),
			},
		);
		try {
			await env.bringUp();
			await use(env);
		} finally {
			await env.destroy();
			await rm(dir, { recursive: true, force: true });
		}
	},
	crhs: async ({ env, withAgent, streamRate, captcha, captchaChallenge }, use) => {
		if (env) return use(env.crhs);
		const dir = await mkdtemp(join(tmpdir(), "crh-ui-agent-"));
		const appOptions: Partial<AppOptions> = { webRoot: WEB_DIST, captcha };
		if (captchaChallenge !== null) appOptions.captchaChallenge = captchaChallenge;
		const crhs = await InProcessCrhs.create(
			{},
			appOptions,
			withAgent ? dir : undefined,
			streamRate > 0 ? { tokensPerSecond: streamRate } : undefined,
		);
		if (captcha === "cap") {
			// loginAdmin() logs in through the API and cannot answer a challenge; create the account directly so
			// the spec can sign in through the real form.
			await createUser(crhs.db, { username: ADMIN.username, kind: "admin", password: ADMIN.password });
		} else {
			await crhs.loginAdmin();
		}
		await use(crhs);
		await crhs.destroy();
		await rm(dir, { recursive: true, force: true });
	},
	baseURL: async ({ crhs }, use) => use(crhs.url),
	adminPage: async ({ page, crhs, captcha }, use) => {
		if (captcha === "cap") {
			throw new Error("adminPage needs a session cookie; use the login form when captcha is cap");
		}
		const [name, value] = crhs.cookie.split("=", 2) as [string, string];
		await page.context().addCookies([{ name, value, url: crhs.url }]);
		await use(page);
	},
});

/** Fills and submits the login form; the caller waits for what it expects afterwards. */
export async function login(page: Page, user = ADMIN): Promise<void> {
	await page.goto("/");
	await page.getByLabel("Username").fill(user.username);
	await page.getByLabel("Password").fill(user.password);
	await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

/** The label of the faux model in the model picker. */
export function modelName(crhs: InProcessCrhs): string {
	return crhs.faux.getModel().name ?? crhs.faux.getModel().id;
}

/**
 * Creates a session through `POST /api/sessions` (D117): the first message is part of creation, so the
 * request carries a `message` and a `requestId`. Returns the new session's id.
 */
export async function createSessionViaApi(
	crhs: InProcessCrhs,
	input: {
		title: string;
		message: string;
		rulePreset?: "ask" | "yolo" | "auto_review";
		/** Defaults to ADMIN's cookie; a member's own cookie creates a session they own. */
		cookie?: string;
		requestId?: string;
	},
): Promise<string> {
	const response = await fetch(`${crhs.url}/api/sessions`, {
		method: "POST",
		headers: { "content-type": "application/json", cookie: input.cookie ?? crhs.cookie },
		body: JSON.stringify({
			requestId: input.requestId ?? crypto.randomUUID(),
			message: input.message,
			title: input.title,
			rulePreset: input.rulePreset ?? "ask",
			model: { provider: crhs.faux.provider.id, modelId: crhs.faux.getModel().id },
		}),
	});
	if (response.status !== 201) {
		throw new Error(`create session: ${response.status} ${await response.text()}`);
	}
	const json = (await response.json()) as { session?: { id: string } };
	if (!json.session) throw new Error("create session: no session in the response");
	return json.session.id;
}

/**
 * Creates a session through the draft page (D117), leaving its page open. The first message creates the
 * session; callers that script the faux model must queue their responses after this helper, because the
 * bootstrap message spends one model request. The title is set through the header afterwards.
 */
export async function newSession(
	page: Page,
	title: string,
	rulePreset: "Ask" | "Yolo" | "Auto Review" = "Ask",
): Promise<void> {
	await page.goto("/sessions");
	await page.getByTestId("new-session-button").click();
	await expect(page).toHaveURL(/\/sessions\/new$/);
	await page.getByTestId("composer-rules").click();
	await page.getByRole("option", { name: rulePreset, exact: true }).click();
	await page.getByTestId("new-session-input").fill("start");
	await page.getByTestId("new-session-input").press("Enter");
	await expect(page.getByTestId("session-page")).toBeVisible();
	const titleInput = page.getByTestId("session-title");
	await titleInput.fill(title);
	await titleInput.press("Enter");
	await expect(titleInput).toHaveValue(title);
	// The bootstrap run has no scripted answer: wait until it has settled, so a caller that queues its own
	// responses next cannot have them consumed by it (title generation included).
	await expect(page.getByTestId("abort-session")).toHaveCount(0, { timeout: 20_000 });
	await page.waitForTimeout(200);
}

/** Types into the message composer and sends with Enter. */
export async function sendMessage(page: Page, text: string): Promise<void> {
	const input = page.getByTestId("composer-input");
	await input.fill(text);
	await input.press("Enter");
}
