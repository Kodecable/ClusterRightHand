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
	env: async ({ withNode, withAgent }, use) => {
		if (!withNode) return use(undefined);
		const dir = await mkdtemp(join(tmpdir(), "crh-ui-"));
		const env = await Env.create(CRHA_BIN, dir, {}, { webRoot: WEB_DIST }, { agent: withAgent });
		try {
			await env.bringUp();
			await use(env);
		} finally {
			await env.destroy();
			await rm(dir, { recursive: true, force: true });
		}
	},
	crhs: async ({ env, withAgent }, use) => {
		if (env) return use(env.crhs);
		const dir = await mkdtemp(join(tmpdir(), "crh-ui-agent-"));
		const crhs = await InProcessCrhs.create({}, { webRoot: WEB_DIST }, withAgent ? dir : undefined);
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

/** Logs in through the login form. */
export async function login(page: Page, user = ADMIN): Promise<void> {
	await page.goto("/");
	await page.getByLabel("Username").fill(user.username);
	await page.getByLabel("Password").fill(user.password);
	await page.getByRole("button", { name: "Sign in" }).click();
}
