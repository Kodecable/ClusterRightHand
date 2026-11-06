import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test as base, expect, type Page } from "@playwright/test";
import { Env, InProcessCrhs } from "../../server/test/e2e/harness.ts";
import { CRHA_BIN, WEB_DIST } from "./global-setup.ts";

export { expect };

export const ADMIN = { username: "root", password: "admin-password" };

interface Options {
	/** Also enroll, approve and connect a real crha node (`test.use({ withNode: true })`). */
	withNode: boolean;
	/** Run the agent runtime (sessions) with the faux model: `crhs.faux` scripts it (`test.use({ withAgent: true })`). */
	withAgent: boolean;
	/** Tokens per second of the faux model's stream; 0 streams as fast as possible. */
	streamRate: number;
}

interface Fixtures {
	/** The node environment when withNode is set. */
	env: Env | undefined;
	/** A fresh crhs serving the built WebUI, with the administrator ADMIN logged in through the API. */
	crhs: InProcessCrhs;
	/** `page`, already logged in as ADMIN. */
	adminPage: Page;
}

export const test = base.extend<Options & Fixtures>({
	withNode: [false, { option: true }],
	withAgent: [false, { option: true }],
	streamRate: [0, { option: true }],
	env: async ({ withNode, withAgent, streamRate }, use) => {
		if (!withNode) return use(undefined);
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
	crhs: async ({ env, withAgent, streamRate }, use) => {
		if (env) return use(env.crhs);
		const dir = await mkdtemp(join(tmpdir(), "crh-ui-agent-"));
		const crhs = await InProcessCrhs.create(
			{},
			{ webRoot: WEB_DIST },
			withAgent ? dir : undefined,
			streamRate > 0 ? { tokensPerSecond: streamRate } : undefined,
		);
		await crhs.loginAdmin();
		await use(crhs);
		await crhs.destroy();
		await rm(dir, { recursive: true, force: true });
	},
	baseURL: async ({ crhs }, use) => use(crhs.url),
	adminPage: async ({ page, crhs }, use) => {
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

/** Creates a session through the UI dialog, leaving its page open. */
export async function newSession(
	page: Page,
	title: string,
	rulePreset: "Ask" | "Yolo" | "Auto Review" = "Ask",
): Promise<void> {
	await page.goto("/sessions");
	await page.getByTestId("new-session-button").click();
	const dialog = page.getByRole("dialog", { name: "New session" });
	await dialog.getByLabel("Title").fill(title);
	await dialog.getByLabel("Rule preset").click();
	await page.getByRole("option", { name: rulePreset, exact: true }).click();
	await dialog.getByRole("button", { name: "Create session" }).click();
	await expect(page.getByTestId("session-title")).toHaveValue(title);
}

/** Types into the message composer and sends with Enter. */
export async function sendMessage(page: Page, text: string): Promise<void> {
	const input = page.getByTestId("composer-input");
	await input.fill(text);
	await input.press("Enter");
}
