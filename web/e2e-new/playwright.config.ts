import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const root = fileURLToPath(new URL("..", import.meta.url));

export default defineConfig({
	testDir: ".",
	timeout: 60_000,
	expect: { timeout: 10_000 },
	fullyParallel: false,
	workers: 1,
	retries: 0,
	reporter: [["list"]],
	use: {
		baseURL: "http://localhost:4173",
		locale: "en-US",
		viewport: { width: 1440, height: 900 },
		trace: "retain-on-failure",
		screenshot: "only-on-failure",
	},
	webServer: {
		command: "./node_modules/.bin/vite build && ./node_modules/.bin/vite preview --port 4173 --strictPort",
		cwd: root,
		url: "http://localhost:4173",
		reuseExistingServer: true,
		timeout: 300_000,
	},
	projects: [
		{
			name: "chromium",
			use: { ...devices["Desktop Chrome"], locale: "en-US", viewport: { width: 1440, height: 900 } },
		},
	],
});
