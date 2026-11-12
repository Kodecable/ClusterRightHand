#!/usr/bin/env node
// Rejects runtime import cycles between the top-level modules of server/src.
//
// Each directory under server/src is a module; the root files config.ts, version.ts and main.ts are
// modules of their own. Type-only imports and re-exports are not runtime edges and are ignored. The
// check builds the module graph, computes its strongly connected components (Tarjan) and fails when one
// holds more than one module, listing the edges inside it.
//
// Plain Node TypeScript, no dependencies.
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const sourceRoot = join(root, "server", "src");
const TEST_DIRS = new Set(["test", "tests", "__tests__"]);

interface ParsedImport {
	/** The import specifier as written. */
	specifier: string;
	/** True when every binding of the statement is a type (or the statement starts with `import type`). */
	typeOnly: boolean;
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

/** The top-level type test: a clause of only `type X` specifiers has no runtime binding. */
function isTypeOnlyClause(clause: string): boolean {
	const brace = clause.indexOf("{");
	if (brace === -1) return false;
	// A default import or a namespace import before the named list makes the statement runtime.
	if (clause.slice(0, brace).replace(/[\s,]/g, "") !== "") return false;
	const close = clause.lastIndexOf("}");
	if (close < brace) return false;
	const inner = clause.slice(brace + 1, close);
	const specifiers = inner
		.split(",")
		.map((part) => part.trim())
		.filter((part) => part.length > 0);
	return specifiers.length > 0 && specifiers.every((part) => /^type\s+[A-Za-z_$]/.test(part));
}

/** Parse the runtime/type-only import and re-export statements of one file. */
export function parseImports(source: string): ParsedImport[] {
	const lines = blankComments(source).split("\n");
	const parsed: ParsedImport[] = [];
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		if (line === undefined) continue;
		const start = /^[ \t]*(import|export)\b/.exec(line);
		if (!start) continue;
		// A multi-line named list keeps the statement open until its braces close.
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
			parsed.push({ specifier: sideEffectSpecifier, typeOnly: false });
			continue;
		}
		const match = /^(import|export)\s+(type\s+)?([\s\S]+?)\s+from\s*["']([^"']+)["']\s*;?$/.exec(statement);
		if (!match) continue; // `export function`, `export const`, ...: not a re-export
		const prefix = match[2];
		const clause = match[3];
		const specifier = match[4];
		if (clause === undefined || specifier === undefined) continue;
		parsed.push({
			specifier,
			typeOnly: prefix !== undefined || isTypeOnlyClause(clause),
		});
	}
	return parsed;
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

/** The module a server/src file belongs to: its top directory, or the file itself for a root file. */
function moduleOf(relativePath: string): string {
	const parts = relativePath.split(sep);
	const first = parts[0] ?? "";
	return parts.length > 1 ? first : first.replace(/\.ts$/, "");
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
			entry.name.endsWith(".ts") &&
			!entry.name.endsWith(".d.ts") &&
			!/\.(test|spec)\.ts$/.test(entry.name)
		) {
			out.push(path);
		}
	}
	return out;
}

interface Edge {
	fromFile: string;
	toFile: string;
	fromModule: string;
	toModule: string;
}

/** Tarjan's strongly connected components, iterative so a deep graph cannot overflow the stack. */
function stronglyConnected(nodes: readonly string[], adjacency: ReadonlyMap<string, string[]>): string[][] {
	let nextIndex = 0;
	const index = new Map<string, number>();
	const low = new Map<string, number>();
	const onStack = new Set<string>();
	const stack: string[] = [];
	const components: string[][] = [];

	for (const start of nodes) {
		if (index.has(start)) continue;
		const work: { node: string; edge: number }[] = [{ node: start, edge: 0 }];
		while (work.length > 0) {
			const frame = work[work.length - 1];
			if (!frame) break;
			const node = frame.node;
			if (frame.edge === 0) {
				index.set(node, nextIndex);
				low.set(node, nextIndex);
				nextIndex += 1;
				stack.push(node);
				onStack.add(node);
			}
			const neighbors = adjacency.get(node) ?? [];
			if (frame.edge < neighbors.length) {
				const next = neighbors[frame.edge];
				frame.edge += 1;
				if (next === undefined) continue;
				if (!index.has(next)) {
					work.push({ node: next, edge: 0 });
				} else if (onStack.has(next)) {
					const nodeLow = low.get(node) ?? Number.POSITIVE_INFINITY;
					const nextIndex = index.get(next) ?? Number.POSITIVE_INFINITY;
					low.set(node, Math.min(nodeLow, nextIndex));
				}
				continue;
			}
			work.pop();
			const parent = work[work.length - 1];
			if (parent) {
				const parentLow = low.get(parent.node) ?? Number.POSITIVE_INFINITY;
				const nodeLow = low.get(node) ?? Number.POSITIVE_INFINITY;
				low.set(parent.node, Math.min(parentLow, nodeLow));
			}
			if (low.get(node) === index.get(node)) {
				const component: string[] = [];
				for (;;) {
					const member = stack.pop();
					if (member === undefined) break;
					onStack.delete(member);
					component.push(member);
					if (member === node) break;
				}
				components.push(component);
			}
		}
	}
	return components;
}

async function main(): Promise<void> {
	let files: string[];
	try {
		files = (await typescriptFiles(sourceRoot)).sort();
	} catch (err) {
		console.error(`check-module-cycles: cannot read ${sourceRoot}: ${(err as Error).message}`);
		process.exitCode = 1;
		return;
	}

	const adjacency = new Map<string, string[]>();
	const edges: Edge[] = [];
	const unresolved: string[] = [];
	for (const file of files) {
		const fromModule = moduleOf(relative(sourceRoot, file));
		if (!adjacency.has(fromModule)) adjacency.set(fromModule, []);
		const imports = parseImports(await readFile(file, "utf8"));
		for (const parsed of imports) {
			if (parsed.typeOnly) continue;
			if (!parsed.specifier.startsWith(".")) continue; // a package, not a server module
			const target = resolve(dirname(file), parsed.specifier);
			if (!files.includes(target)) {
				unresolved.push(`${relative(root, file)}: cannot resolve "${parsed.specifier}"`);
				continue;
			}
			const toModule = moduleOf(relative(sourceRoot, target));
			if (fromModule === toModule) continue; // inside one module: not an edge between modules
			adjacency.get(fromModule)?.push(toModule);
			edges.push({
				fromFile: relative(root, file),
				toFile: relative(root, target),
				fromModule,
				toModule,
			});
		}
	}

	if (unresolved.length > 0) {
		console.error("check-module-cycles: unresolved relative imports:");
		for (const line of unresolved) console.error(`  ${line}`);
		process.exitCode = 1;
		return;
	}

	const modules = [...adjacency.keys()].sort();
	// A module importing itself is an edge inside one module and is skipped above, so a cycle needs
	// at least two modules.
	const cycles = stronglyConnected(modules, adjacency).filter((component) => component.length > 1);

	if (cycles.length === 0) {
		console.log(`check-module-cycles: no runtime cycles between the ${modules.length} modules of server/src`);
		return;
	}

	console.error(`check-module-cycles: ${cycles.length} runtime module ${cycles.length === 1 ? "cycle" : "cycles"}:`);
	for (const component of cycles) {
		const members = new Set(component);
		console.error("");
		console.error(`  cycle: ${[...component].sort().join(" ↔ ")}`);
		for (const edge of edges) {
			if (members.has(edge.fromModule) && members.has(edge.toModule) && edge.fromModule !== edge.toModule) {
				console.error(`    ${edge.fromFile} → ${edge.toFile}`);
			}
		}
	}
	process.exitCode = 1;
}

// Run only when executed, not when the unit test imports the parser.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
