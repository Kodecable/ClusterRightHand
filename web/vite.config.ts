import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { lingui } from "@lingui/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { resolveVersion } from "../scripts/version.ts";

const target = "http://127.0.0.1:8080";

/**
 * The emoji data frimousse fetches: exactly the two files of each bundled locale, from
 * `node_modules/emojibase-data`. The picker requests `${emojibaseUrl}/${locale}/data.json` and
 * `${emojibaseUrl}/${locale}/messages.json` (frimousse's default resolver), so only those four files
 * are copied. They live under `emojibase/` in the build and are served by the dev server too.
 */
const EMOJI_DATA_FILES = ["en/data.json", "en/messages.json", "zh/data.json", "zh/messages.json"] as const;

/**
 * Serves the emoji data from crhs instead of frimousse's default CDN (doc/design/webui.md "Node pages"):
 * crhs is self-hosted and may be offline, and the WebUI must not call a third party. The plugin also
 * rewrites frimousse's unused default CDN base, so no external URL ships in the bundle. The files are
 * emitted into the build's `emojibase/` directory and served from it, which is also what `pnpm build:crhs`
 * copies to `dist/crhs/web`.
 */
function emojibaseDataPlugin(): Plugin {
	const dataRoot = fileURLToPath(new URL("./node_modules/emojibase-data", import.meta.url));
	let base = "/";
	return {
		name: "crh-emojibase-data",
		configResolved(config) {
			base = config.base;
		},
		configureServer(server) {
			server.middlewares.use((req, res, next) => {
				const url = req.url?.split("?")[0] ?? "";
				const prefix = `${base}emojibase/`;
				if (!url.startsWith(prefix)) return next();
				const file = url.slice(prefix.length);
				if (!(EMOJI_DATA_FILES as readonly string[]).includes(file)) return next();
				try {
					const body = readFileSync(join(dataRoot, file));
					res.setHeader("Content-Type", "application/json; charset=utf-8");
					res.setHeader("Cache-Control", "no-cache");
					res.end(req.method === "HEAD" ? undefined : body);
				} catch {
					res.statusCode = 404;
					res.end();
				}
			});
		},
		generateBundle() {
			for (const file of EMOJI_DATA_FILES) {
				this.emitFile({ type: "asset", fileName: `emojibase/${file}`, source: readFileSync(join(dataRoot, file)) });
			}
		},
		renderChunk(code) {
			// EmojiPicker is always given `emojibaseUrl`, so frimousse's default is dead code; rewriting it
			// keeps a self-hosted build free of third-party URLs.
			const selfHosted = `${base}emojibase`;
			return code
				.replaceAll("https://cdn.jsdelivr.net/npm/emojibase-data@latest", selfHosted)
				.replaceAll("https://cdn.jsdelivr.net/npm/emojibase-data", selfHosted);
		},
	};
}

export default defineConfig(async () => ({
	plugins: [lingui({ macroTransform: true }), react(), tailwindcss(), emojibaseDataPlugin()],
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
