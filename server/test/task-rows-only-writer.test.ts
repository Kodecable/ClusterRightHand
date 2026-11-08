import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../src", import.meta.url));
const WRITER = join(SRC, "cluster", "task-rows.ts");
const MIGRATIONS = join(SRC, "storage", "migrations") + sep;

/** Every .ts file below `dir`, in a stable order. */
function sourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...sourceFiles(path));
		else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(path);
	}
	return out;
}

describe("task rows have one writer", () => {
	it("keeps updateTable/insertInto on tasks inside cluster/task-rows.ts and the migrations", () => {
		const write = /\b(?:updateTable|insertInto)\(\s*["']tasks["']\s*\)/;
		const offenders = sourceFiles(SRC)
			.filter((file) => file !== WRITER && !file.startsWith(MIGRATIONS))
			.filter((file) => write.test(readFileSync(file, "utf8")))
			.map((file) => relative(SRC, file));
		expect(offenders).toEqual([]);
	});
});
