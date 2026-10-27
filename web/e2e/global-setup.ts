import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

export const WEB_DIST = resolve(import.meta.dirname, "../dist");
export const CRHA_BIN = resolve(import.meta.dirname, "../test-results/.bin/crha");

/** Builds the WebUI and crha once per run. */
export default function globalSetup(): void {
	execFileSync("pnpm", ["exec", "vite", "build", "--logLevel", "warn"], {
		cwd: resolve(import.meta.dirname, ".."),
		stdio: "inherit",
	});
	mkdirSync(resolve(CRHA_BIN, ".."), { recursive: true });
	execFileSync("go", ["build", "-o", CRHA_BIN, "./cmd/crha"], {
		cwd: resolve(import.meta.dirname, "../../client"),
		stdio: "inherit",
	});
}
