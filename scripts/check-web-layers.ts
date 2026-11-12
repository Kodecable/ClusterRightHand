#!/usr/bin/env node
// Rejects imports that cross the WebUI's layer boundaries.
//
// Shared layers (components/, lib/, hooks/, markdown/) may be used by any feature but must not
// import features/ or app/; features may import each other but must not import app/. Type imports
// count, because they still couple the layers. Tests are skipped: they may render shell pieces.
//
// Plain Node TypeScript, no dependencies.
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const sourceRoot = join(root, "web", "src");
const TEST_DIRS = new Set(["test", "tests", "__tests__"]);
const SHARED_LAYERS = new Set(["components", "lib", "hooks", "markdown"]);

interface ImportRef {
	/** The import specifier as written. */
	specifier: string;
	/** The 1-based line the statement starts on. */
	line: number;
}

interface Violation {
	file: string;
	line: number;
	specifier: string;
	reason: string;
}

/** Blank out comments but keep strings (and therefore import specifiers) and line numbers intact. */
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
			const quote = ch;
			out.push(ch);
			i += 1;
			while (i < source.length) {
				const c = source.charAt(i);
				out.push(c);
				i += 1;
				if (c === "\\" && i < source.length) {
					out.push(source.charAt(i));
					i += 1;
				} else if (c === quote) {
					break;
				} else if (quote === "`" && c === "$" && source.charAt(i) === "{") {
					out.push(source.charAt(i));
					i += 1;
					let depth = 1;
					while (i < source.length && depth > 0) {
						const d = source.charAt(i);
						out.push(d);
						i += 1;
						if (d === "{") depth += 1;
						else if (d === "}") depth -= 1;
					}
				}
			}
			continue;
		}
		out.push(ch);
		i += 1;
	}
	return out.join("");
}

/** The net `{`, `(`, `[` depth of one line, ignoring string contents. */
function bracketDepth(line: string): number {
	let depth = 0;
	let quote: string | undefined;
	for (let i = 0; i < line.length; i += 1) {
		const ch = line.charAt(i);
		if (quote !== undefined) {
			if (ch === "\\") i += 1;
			else if (ch === quote) quote = undefined;
			continue;
		}
		if (ch === '"' || ch === "'" || ch === "`") quote = ch;
		else if (ch === "{" || ch === "(" || ch === "[") depth += 1;
		else if (ch === "}" || ch === ")" || ch === "]") depth -= 1;
	}
	return depth;
}

/** The line a character index falls on, counting from 1. */
function lineAt(source: string, index: number): number {
	let line = 1;
	for (let i = 0; i < index; i += 1) {
		if (source.charAt(i) === "\n") line += 1;
	}
	return line;
}

/** Static `import ... from`, `export ... from` and side-effect imports, with line numbers. */
function parseStaticImports(source: string): ImportRef[] {
	const lines = blankComments(source).split("\n");
	const parsed: ImportRef[] = [];
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		if (line === undefined || !/^[ \t]*(import|export)\b/.test(line)) continue;
		const lineNumber = index + 1;
		// A multi-line named list keeps the statement open until its brackets close.
		let text = line;
		let depth = bracketDepth(text);
		while (depth > 0 && index + 1 < lines.length) {
			index += 1;
			const next = lines[index];
			if (next === undefined) break;
			text += `\n${next}`;
			depth += bracketDepth(next);
		}
		const statement = text.trim();
		const sideEffect = /^import\s+["']([^"']+)["']\s*;?$/.exec(statement);
		const sideEffectSpecifier = sideEffect?.[1];
		if (sideEffectSpecifier !== undefined) {
			parsed.push({ specifier: sideEffectSpecifier, line: lineNumber });
			continue;
		}
		const match = /^(import|export)\s+(?:type\s+)?([\s\S]+?)\s+from\s*["']([^"']+)["']\s*;?$/.exec(statement);
		const specifier = match?.[3];
		if (specifier !== undefined) parsed.push({ specifier, line: lineNumber });
	}
	return parsed;
}

/** All imports, including `import("...")` expressions. */
function parseImports(source: string): ImportRef[] {
	const parsed = parseStaticImports(source);
	const blanked = blankComments(source);
	for (const match of blanked.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) {
		const specifier = match[1];
		if (specifier === undefined || match.index === undefined) continue;
		parsed.push({ specifier, line: lineAt(blanked, match.index) });
	}
	return parsed;
}

/** The layer of a source-relative path: its first directory, or "" for a root file. */
function layerOf(relativePath: string): string {
	return relativePath.split(sep)[0] ?? "";
}

/** The layer an import specifier points at, or undefined for a package or a path outside web/src. */
function targetLayer(file: string, specifier: string): string | undefined {
	let target: string;
	if (specifier.startsWith("@/")) target = resolve(sourceRoot, specifier.slice(2));
	else if (specifier.startsWith(".")) target = resolve(dirname(file), specifier);
	else return undefined;
	const relativePath = relative(sourceRoot, target);
	if (relativePath === "" || relativePath.startsWith("..") || relativePath.includes(`..${sep}`)) return undefined;
	return layerOf(relativePath);
}

/** Why an edge is forbidden, or undefined when it is allowed. */
function violationReason(fromLayer: string, toLayer: string): string | undefined {
	if (SHARED_LAYERS.has(fromLayer) && (toLayer === "features" || toLayer === "app")) {
		return `${fromLayer}/ must not import ${toLayer}/`;
	}
	if (fromLayer === "features" && toLayer === "app") return "features/ must not import app/";
	return undefined;
}

async function typescriptFiles(dir: string): Promise<string[]> {
	const out: string[] = [];
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (TEST_DIRS.has(entry.name)) continue;
			out.push(...(await typescriptFiles(path)));
		} else if (
			entry.isFile() &&
			(entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) &&
			!entry.name.endsWith(".d.ts") &&
			!/\.(test|spec)\.tsx?$/.test(entry.name)
		) {
			out.push(path);
		}
	}
	return out;
}

async function main(): Promise<void> {
	let files: string[];
	try {
		files = (await typescriptFiles(sourceRoot)).sort();
	} catch (err) {
		console.error(`check-web-layers: cannot read ${sourceRoot}: ${(err as Error).message}`);
		process.exitCode = 1;
		return;
	}

	const violations: Violation[] = [];
	for (const file of files) {
		const fromLayer = layerOf(relative(sourceRoot, file));
		for (const parsed of parseImports(await readFile(file, "utf8"))) {
			const toLayer = targetLayer(file, parsed.specifier);
			if (toLayer === undefined) continue;
			const reason = violationReason(fromLayer, toLayer);
			if (reason === undefined) continue;
			violations.push({ file: relative(root, file), line: parsed.line, specifier: parsed.specifier, reason });
		}
	}

	if (violations.length > 0) {
		console.error(
			`check-web-layers: ${violations.length} import${violations.length === 1 ? "" : "s"} violate the WebUI layer rules:`,
		);
		for (const violation of violations) {
			console.error(`  ${violation.file}:${violation.line} → ${violation.specifier} (${violation.reason})`);
		}
		process.exitCode = 1;
		return;
	}

	console.log(`check-web-layers: ${files.length} files respect the WebUI layer boundaries`);
}

await main();
