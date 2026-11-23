/**
 * Fails when a zh-CN message is missing.
 *
 * Run with `pnpm i18n:check` (Node's built-in TypeScript stripping). The PO
 * files are the source of truth for the compiled catalogs: lingi's Vite
 * plugin turns them into runtime catalogs, and Lingui macros compile to
 * message ids, so a missing msgstr means an untranslated id at runtime.
 *
 * Since the check exists to catch what the runtime would show, it also
 * rejects unquoted PO values: Lingui's parser only reads quoted strings, so
 * `msgstr 翻译` (without quotes) is silently dropped at compile time and the
 * UI falls back to English even though this file "has" the translation.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

interface Entry {
	id: string;
	value: string;
	line: number;
}

interface Unquoted {
	file: "en.po" | "zh-CN.po";
	field: "msgid" | "msgstr";
	line: number;
	value: string;
}

function unquote(
	rest: string,
	file: Unquoted["file"],
	field: "msgid" | "msgstr",
	line: number,
	unquoted: Unquoted[],
): string {
	const trimmed = rest.trim();
	if (!trimmed.startsWith('"')) {
		unquoted.push({ file, field, line, value: trimmed });
		return trimmed;
	}
	try {
		return JSON.parse(trimmed) as string;
	} catch {
		return trimmed.replace(/^"|"$/g, "");
	}
}

function parsePo(source: string, file: Unquoted["file"]): { entries: Entry[]; unquoted: Unquoted[] } {
	const entries: Entry[] = [];
	const unquoted: Unquoted[] = [];
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
			current = { id: unquote(line.slice("msgid ".length), file, "msgid", i + 1, unquoted), value: "", line: i + 1 };
			field = "id";
			continue;
		}
		if (line.startsWith("msgstr ") && current) {
			current.value = unquote(line.slice("msgstr ".length), file, "msgstr", i + 1, unquoted);
			field = "value";
			continue;
		}
		if (line.startsWith('"') && current) {
			if (field === "id") current.id += unquote(line, file, "msgid", i + 1, unquoted);
			else if (field === "value") current.value += unquote(line, file, "msgstr", i + 1, unquoted);
		}
	}
	flush();
	return { entries, unquoted };
}

const root = resolve(import.meta.dirname, "..");
const enPo = parsePo(readFileSync(resolve(root, "src/locales/en.po"), "utf8"), "en.po");
const zhPo = parsePo(readFileSync(resolve(root, "src/locales/zh-CN.po"), "utf8"), "zh-CN.po");
const unquoted = [...enPo.unquoted, ...zhPo.unquoted];
if (unquoted.length > 0) {
	console.error(`i18n check failed: ${unquoted.length} unquoted PO value(s) that Lingui ignores:`);
	for (const entry of unquoted) {
		console.error(`  - ${entry.file}:${entry.line} ${entry.field}: ${JSON.stringify(entry.value)}`);
	}
	console.error("Quote the value, then run `pnpm run i18n:extract`.");
	process.exit(1);
}
const en = enPo.entries;
const zh = zhPo.entries;
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
