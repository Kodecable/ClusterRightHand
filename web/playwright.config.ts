import { defineConfig, devices } from "@playwright/test";

// Browser tests of the WebUI against an in-process crhs (and real crha where needed); see e2e/fixtures.ts.
// CRH_CHROMIUM points at a system Chromium instead of the one `playwright install` downloads.
export default defineConfig({
	testDir: "e2e",
	globalSetup: "./e2e/global-setup.ts",
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 1 : 0,
	reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
	timeout: 60_000,
	use: {
		...devices["Desktop Chrome"],
		trace: "retain-on-failure",
		screenshot: "only-on-failure",
		launchOptions: process.env.CRH_CHROMIUM ? { executablePath: process.env.CRH_CHROMIUM } : {},
	},
});
