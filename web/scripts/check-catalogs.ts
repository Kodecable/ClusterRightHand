/**
 * Fails when a zh-CN message is missing.
 *
 * Run with `pnpm i18n:check` (Node's built-in TypeScript stripping). The PO
 * files are the source of truth for the compiled catalogs: lingi's Vite
 * plugin turns them into runtime catalogs, and Lingui macros compile to
 * message ids, so a missing msgstr means an untranslated id at runtime.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

interface Entry {
	id: string;
	value: string;
	line: number;
}

function unquote(rest: string): string {
	const trimmed = rest.trim();
	if (!trimmed.startsWith('"')) return trimmed;
	try {
		return JSON.parse(trimmed) as string;
	} catch {
		return trimmed.replace(/^"|"$/g, "");
	}
}

function parsePo(source: string): Entry[] {
	const entries: Entry[] = [];
	const lines = source.split("\n");
	let current: { id: string; value: string; line: number } | null = null;
	let field: "id" | "value" | null = null;

	const flush = () => {
		if (current && current.id !== "") entries.push(current);
		current = null;
		field = null;
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		if (line.startsWith("#~")) continue; // obsolete
		if (line.trim() === "") {
			flush();
			continue;
		}
		if (line.startsWith("msgid ")) {
			if (current && current.id !== "") entries.push(current);
			current = { id: unquote(line.slice("msgid ".length)), value: "", line: i + 1 };
			field = "id";
			continue;
		}
		if (line.startsWith("msgstr ") && current) {
			current.value = unquote(line.slice("msgstr ".length));
			field = "value";
			continue;
		}
		if (line.startsWith('"') && current) {
			if (field === "id") current.id += unquote(line);
			else if (field === "value") current.value += unquote(line);
		}
	}
	flush();
	return entries;
}

const root = resolve(import.meta.dirname, "..");
const en = parsePo(readFileSync(resolve(root, "src/locales/en.po"), "utf8"));
const zh = parsePo(readFileSync(resolve(root, "src/locales/zh-CN.po"), "utf8"));
const zhById = new Map(zh.map((entry) => [entry.id, entry]));

const missing: string[] = [];
for (const entry of en) {
	const translated = zhById.get(entry.id);
	if (!translated || translated.value.trim() === "") {
		missing.push(`${JSON.stringify(entry.id)} (en.po line ${entry.line})`);
	}
}

const enIds = new Set(en.map((entry) => entry.id));
const extra = zh.filter((entry) => !enIds.has(entry.id));

if (missing.length > 0) {
	console.error(`i18n check failed: ${missing.length} zh-CN message(s) missing:`);
	for (const id of missing) console.error(`  - ${id}`);
	process.exit(1);
}

if (extra.length > 0) {
	console.warn(`i18n check: ${extra.length} obsolete zh-CN message(s) present (run lingui extract --clean).`);
}

const placeholdersOk = en.every((entry) => {
	const translated = zhById.get(entry.id)?.value ?? "";
	const vars = (text: string) => (text.match(/\{[0-9]+\}/g) ?? []).sort().join(",");
	return vars(entry.value || entry.id) === vars(translated);
});
if (!placeholdersOk) {
	console.error("i18n check failed: placeholder mismatch between en and zh-CN.");
	process.exit(1);
}

console.log(`i18n check passed: ${en.length} messages translated in zh-CN.`);
