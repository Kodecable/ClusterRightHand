import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const target = "http://127.0.0.1:8080";

export default defineConfig({
	plugins: [react()],
	// e2e/*.spec.ts are Playwright tests (`pnpm test:ui`), not vitest ones.
	test: { include: ["src/**/*.test.ts"] },
	server: {
		proxy: {
			"/api": target,
			"/ws": { target, ws: true },
		},
	},
});
