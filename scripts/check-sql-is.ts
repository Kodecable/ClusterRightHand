#!/usr/bin/env node
// Rejects SQL `IS` comparisons with a value, which SQLite accepts and PostgreSQL refuses.
//
// PostgreSQL takes `IS` only before NULL, TRUE, FALSE or DISTINCT FROM, never before a parameter, so
// Kysely's `.where(col, "is", value)` compiles to `col is $1` and fails there with a syntax error while
// every SQLite test passes. Compare with `"is"` / `"is not"` only against a literal null, true or false,
// and with `=` otherwise (a nullable value takes both branches). The check covers:
//
// - a call whose last argument follows `"is"` or `"is not"`: `.where(col, "is", x)`, `eb(col, "is", x)`,
//   `.on(…)`, `.having(…)`; the last argument must be `null`, `true` or `false`;
// - `sql` templates with `is ${…}` or `is not ${…}`.
//
// Plain Node TypeScript, no dependencies. Scans server/src and server/test.
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const SCAN = [join(root, "server", "src"), join(root, "server", "test")];
const SKIP_DIRS = new Set(["node_modules", "dist"]);
const LITERALS = new Set(["null", "true", "false"]);

interface Violation {
	file: string;
	line: number;
	text: string;
}

/** Blank out comments but keep strings and line numbers intact. */
function blankComments(source: string): string {
	const out: string[] = [];
	let i = 0;
	while (i < source.length) {
		const ch = source.charAt(i);
		if (ch === "/" && source.charAt(i + 1) === "/") {
			while (i < source.length && source.charAt(i) !== "\n") {
				out.push(" ");
				i += 1;
			}
			continue;
		}
		if (ch === "/" && source.charAt(i + 1) === "*") {
			out.push(" ", " ");
			i += 2;
			while (i < source.length && !(source[i] === "*" && source.charAt(i + 1) === "/")) {
				out.push(source.charAt(i) === "\n" ? "\n" : " ");
				i += 1;
			}
			if (i < source.length) {
				out.push(" ", " ");
				i += 2;
			}
			continue;
		}
		if (ch === '"' || ch === "'" || ch === "`") {
			const end = skipString(source, i);
			out.push(source.slice(i, end));
			i = end;
			continue;
		}
		out.push(ch);
		i += 1;
	}
	return out.join("");
}

/** The index just past the string or template literal starting at `start` (templates may nest `${…}`). */
function skipString(source: string, start: number): number {
	const quote = source.charAt(start);
	let i = start + 1;
	while (i < source.length) {
		const ch = source.charAt(i);
		if (ch === "\\") {
			i += 2;
			continue;
		}
		if (ch === quote) return i + 1;
		if (quote === "`" && ch === "$" && source.charAt(i + 1) === "{") {
			i = skipBalanced(source, i + 1);
			continue;
		}
		if (quote !== "`" && ch === "\n") return i;
		i += 1;
	}
	return i;
}

/** The index just past the bracket group opening at `start`. */
function skipBalanced(source: string, start: number): number {
	let depth = 0;
	let i = start;
	while (i < source.length) {
		const ch = source.charAt(i);
		if (ch === '"' || ch === "'" || ch === "`") {
			i = skipString(source, i);
			continue;
		}
		if (ch === "(" || ch === "[" || ch === "{") depth += 1;
		else if (ch === ")" || ch === "]" || ch === "}") {
			depth -= 1;
			if (depth === 0) return i + 1;
		}
		i += 1;
	}
	return i;
}

/**
 * The argument expression that starts at `start`: its text and the character that ends it at depth 0
 * (`,`, `)`, `]` or `}`), or null when the source ends first.
 */
function argumentAt(source: string, start: number): { text: string; end: string } | null {
	let i = start;
	while (i < source.length) {
		const ch = source.charAt(i);
		if (ch === '"' || ch === "'" || ch === "`") {
			i = skipString(source, i);
			continue;
		}
		if (ch === "(" || ch === "[" || ch === "{") {
			i = skipBalanced(source, i);
			continue;
		}
		if (ch === "," || ch === ")" || ch === "]" || ch === "}") {
			const text = source.slice(start, i).trim();
			// A trailing comma before the closing parenthesis still ends the call's last argument.
			if (ch === "," && /^,\s*\)/.test(source.slice(i))) return { text, end: ")" };
			return { text, end: ch };
		}
		i += 1;
	}
	return null;
}

function lineOf(source: string, index: number): number {
	let line = 1;
	for (let i = 0; i < index; i++) if (source.charCodeAt(i) === 10) line += 1;
	return line;
}

function check(file: string, source: string): Violation[] {
	const code = blankComments(source);
	const violations: Violation[] = [];
	// An operator argument: preceded by another argument, followed by the compared value.
	for (const match of code.matchAll(/,\s*(["'])is( not)?\1\s*,/g)) {
		const valueStart = (match.index ?? 0) + match[0].length;
		const value = argumentAt(code, valueStart);
		// A value that is not the call's last argument is not a comparison (a word list, say).
		if (value?.end !== ")") continue;
		if (LITERALS.has(value.text)) continue;
		violations.push({
			file,
			line: lineOf(code, match.index ?? 0),
			text: `"is${match[2] ?? ""}" compared with ${value.text}: use "${match[2] ? "<>" : "="}", and "is${match[2] ?? ""}" only with null, true or false`,
		});
	}
	for (const match of code.matchAll(/\bsql`/g)) {
		const start = (match.index ?? 0) + 3;
		const end = skipString(code, start);
		const template = code.slice(start, end);
		for (const inner of template.matchAll(/\bis\s+(not\s+)?\$\{/gi)) {
			violations.push({
				file,
				line: lineOf(code, start + (inner.index ?? 0)),
				text: "sql template compares an interpolated value with is: use = or <>, and is only with null, true or false written out",
			});
		}
	}
	return violations;
}

async function* sourceFiles(dir: string): AsyncGenerator<string> {
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			if (!SKIP_DIRS.has(entry.name)) yield* sourceFiles(join(dir, entry.name));
		} else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
			yield join(dir, entry.name);
		}
	}
}

const violations: Violation[] = [];
for (const dir of SCAN) {
	for await (const file of sourceFiles(dir)) {
		violations.push(...check(relative(root, file), await readFile(file, "utf8")));
	}
}
if (violations.length > 0) {
	console.error("SQL `is` with a value (PostgreSQL accepts `is` only before null, true or false):");
	for (const v of violations) console.error(`  ${v.file}:${v.line}: ${v.text}`);
	process.exit(1);
}
