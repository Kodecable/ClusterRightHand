import { fileURLToPath } from "node:url";
import { lingui } from "@lingui/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [lingui({ macroTransform: true }), react()],
	resolve: {
		alias: {
			"@": fileURLToPath(new URL("./src", import.meta.url)),
		},
	},
	test: {
		environment: "jsdom",
		globals: false,
		include: ["src/**/*.test.{ts,tsx}"],
		setupFiles: ["./src/test/setup.ts"],
		css: false,
		restoreMocks: true,
	},
});
