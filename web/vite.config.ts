import { fileURLToPath } from "node:url";
import { lingui } from "@lingui/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { resolveVersion } from "../scripts/version.ts";

const target = "http://127.0.0.1:8080";

export default defineConfig(async () => ({
	plugins: [lingui({ macroTransform: true }), react(), tailwindcss()],
	resolve: {
		alias: {
			"@": fileURLToPath(new URL("./src", import.meta.url)),
		},
	},
	define: {
		__CRH_VERSION__: JSON.stringify(await resolveVersion()),
	},
	server: {
		proxy: {
			"/api": target,
			"/agent": target,
		},
	},
}));
