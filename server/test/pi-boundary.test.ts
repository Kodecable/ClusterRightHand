import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The pi boundary (doc/agent-runtime.md#agentruntime-抽象): pi packages are implementation details of the agent
 * runtime and of the storage adapters that implement pi-durable's `Storage`. `@crh/api` is the only wire type the
 * WebUI sees (`server/src/agent/session-events.ts` converts it), and this test keeps every other part of the
 * server from importing pi directly, so a pi upgrade cannot ripple past those two directories.
 */

const SRC = resolve(import.meta.dirname, "../src");
const REPO = resolve(import.meta.dirname, "../..");
const PI_OWNERS = new Set(["agent", "storage"]);

/** `from "..."`, side-effect `import "..."`, dynamic `import("...")` and `require("...")`. */
const PI_IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["'](@earendil-works\/[^"']+)["']/g;

function sourceFiles(dir: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) files.push(...sourceFiles(path));
		else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(path);
	}
	return files;
}

function piImports(file: string): string[] {
	const text = readFileSync(file, "utf8");
	return [...text.matchAll(PI_IMPORT)].map((match) => match[1] as string);
}

/** The directory under `server/src` a file lives in, e.g. `agent`. */
function topLevelDir(file: string): string {
	return relative(SRC, file).split(sep)[0] ?? "";
}

describe("pi boundary", () => {
	it("imports pi packages only under server/src/agent and server/src/storage", () => {
		const offenders = sourceFiles(SRC)
			.filter((file) => !PI_OWNERS.has(topLevelDir(file)))
			.flatMap((file) => piImports(file).map((module) => `${relative(REPO, file)}: ${module}`));
		expect(offenders).toEqual([]);
	});

	it("finds the pi imports it exists to police", () => {
		// A broken path or a regex that stopped matching must fail loudly instead of passing with an empty scan.
		const owners = sourceFiles(SRC).filter((file) => PI_OWNERS.has(topLevelDir(file)));
		const modules = new Set(owners.flatMap(piImports));
		expect(sourceFiles(SRC).length).toBeGreaterThan(50);
		expect(modules).toContain("@earendil-works/pi-durable");
		expect(modules).toContain("@earendil-works/pi-ai");
	});
});
