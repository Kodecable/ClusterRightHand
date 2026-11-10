import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const root = fileURLToPath(new URL("../..", import.meta.url));

/**
 * The performance runs (doc/design/webui.md "Performance targets"). A separate config because
 * the measurement takes minutes, runs one worker at a time, and owns its own
 * preview port so it can never talk to a stray `test:ui:mock` server.
 */
export default defineConfig({
	testDir: ".",
	fullyParallel: false,
	workers: 1,
	retries: 0,
	timeout: 30 * 60_000,
	reporter: [["list"]],
	use: {
		baseURL: "http://localhost:4174",
		locale: "en-US",
		viewport: { width: 1440, height: 900 },
	},
	webServer: {
		command:
			"./node_modules/.bin/vite build --logLevel warn && ./node_modules/.bin/vite preview --port 4174 --strictPort",
		cwd: root,
		url: "http://localhost:4174",
		reuseExistingServer: true,
		timeout: 600_000,
	},
	projects: [
		{
			name: "chromium",
			use: { ...devices["Desktop Chrome"], locale: "en-US", viewport: { width: 1440, height: 900 } },
		},
	],
});
