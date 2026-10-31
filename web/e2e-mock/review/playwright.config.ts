import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

/** The review screenshots (every page × four variants) build and serve their own instance. */
const root = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig({
	testDir: ".",
	timeout: 120_000,
	workers: 4,
	fullyParallel: true,
	reporter: [["list"]],
	use: { baseURL: "http://localhost:4181", ...devices["Desktop Chrome"] },
	webServer: {
		command: "./node_modules/.bin/vite build && ./node_modules/.bin/vite preview --port 4181 --strictPort",
		cwd: root,
		url: "http://localhost:4181",
		reuseExistingServer: false,
		timeout: 300_000,
	},
});
