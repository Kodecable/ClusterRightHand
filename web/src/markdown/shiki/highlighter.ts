import { createJavaScriptRegexEngine } from "@shikijs/engine-javascript";
import githubDark from "@shikijs/themes/github-dark";
import githubLight from "@shikijs/themes/github-light";
import type { HighlighterGeneric, LanguageInput } from "shiki/core";
import { createHighlighterCore } from "shiki/core";

/**
 * Shiki setup shared by every code block.
 *
 * - `createHighlighterCore` + the JavaScript regex engine: no wasm, no
 *   oniguruma asset loading, works in a plain Vite build.
 * - Only two themes are loaded up front; every language is a separate dynamic
 *   import pulled in on first use, so each one becomes its own lazy chunk.
 */

export const THEME_NAMES = { light: "github-light", dark: "github-dark" } as const;

export const LAZY_LANGS = [
	"bash",
	"shellsession",
	"json",
	"yaml",
	"diff",
	"ini",
	"toml",
	"dockerfile",
	"python",
	"go",
	"typescript",
	"javascript",
	"sql",
	"nginx",
] as const;

export type LazyLang = (typeof LAZY_LANGS)[number];

/** Languages that are built into Shiki core (ANSI is special-cased there). */
export type BuiltinLang = "ansi";

export type LangKey = LazyLang | BuiltinLang;

type LangModule = { default: LanguageInput };

/** One dynamic import per language; each becomes its own lazy chunk. */
export const LANGUAGE_LOADERS: Record<LazyLang, () => Promise<LangModule>> = {
	bash: () => import("@shikijs/langs/bash"),
	shellsession: () => import("@shikijs/langs/shellsession"),
	json: () => import("@shikijs/langs/json"),
	yaml: () => import("@shikijs/langs/yaml"),
	diff: () => import("@shikijs/langs/diff"),
	ini: () => import("@shikijs/langs/ini"),
	toml: () => import("@shikijs/langs/toml"),
	dockerfile: () => import("@shikijs/langs/dockerfile"),
	python: () => import("@shikijs/langs/python"),
	go: () => import("@shikijs/langs/go"),
	typescript: () => import("@shikijs/langs/typescript"),
	javascript: () => import("@shikijs/langs/javascript"),
	sql: () => import("@shikijs/langs/sql"),
	nginx: () => import("@shikijs/langs/nginx"),
};

const ALIASES: Record<string, LangKey> = {
	sh: "bash",
	shell: "bash",
	shellscript: "bash",
	zsh: "bash",
	"sh-session": "shellsession",
	console: "shellsession",
	shellsession: "shellsession",
	yml: "yaml",
	docker: "dockerfile",
	containerfile: "dockerfile",
	py: "python",
	golang: "go",
	ts: "typescript",
	tsx: "typescript",
	js: "javascript",
	jsx: "javascript",
	postgres: "sql",
	postgresql: "sql",
	mysql: "sql",
	term: "ansi",
	terminal: "ansi",
	log: "ansi",
};

export const BUILTIN_LANGS: ReadonlySet<string> = new Set<BuiltinLang>(["ansi"]);

/** The language key of a fenced code block's info string, or null for plain text. */
export function resolveLang(raw: string | undefined | null): LangKey | null {
	if (typeof raw !== "string") return null;
	const cleaned = raw
		.trim()
		.toLowerCase()
		.replace(/^language-/, "")
		.replace(/^\{\.?/, "")
		.replace(/\}$/, "")
		.trim();
	if (cleaned.length === 0) return null;
	if (BUILTIN_LANGS.has(cleaned)) return cleaned as BuiltinLang;
	if (Object.hasOwn(LANGUAGE_LOADERS, cleaned)) return cleaned as LazyLang;
	return Object.hasOwn(ALIASES, cleaned) ? (ALIASES[cleaned] ?? null) : null;
}

let corePromise: Promise<HighlighterGeneric<string, string>> | null = null;

export function getHighlighter(): Promise<HighlighterGeneric<string, string>> {
	// `createHighlighterCore` is typed with `never` for bundled keys; the
	// language names are only known at runtime (each is a dynamic import), so
	// the generic is widened to `string`.
	corePromise ??= createHighlighterCore({
		themes: [githubLight, githubDark],
		langs: [],
		engine: createJavaScriptRegexEngine({ forgiving: true }),
	}) as Promise<HighlighterGeneric<string, string>>;
	return corePromise;
}

/* ------------------------------------------------------------------ state */

const loaded = new Set<LangKey>();
const inflight = new Map<LangKey, Promise<boolean>>();
const listeners = new Set<() => void>();
let version = 0;

export function subscribeLanguages(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

export function getLanguageVersion(): number {
	return version;
}

export function isLanguageLoaded(key: LangKey | null): boolean {
	if (key === null) return true;
	if (BUILTIN_LANGS.has(key)) return true;
	return loaded.has(key as LazyLang);
}

export function ensureLanguage(key: LangKey): Promise<boolean> {
	// `ansi` is handled inside Shiki core, not by a grammar chunk.
	if (BUILTIN_LANGS.has(key)) return Promise.resolve(true);
	if (loaded.has(key)) return Promise.resolve(true);
	const existing = inflight.get(key);
	if (existing) return existing;

	const task = (async () => {
		try {
			// The key comes from resolveLang or PREWARM_LANGS; an inherited name has no own loader.
			const loader = Object.hasOwn(LANGUAGE_LOADERS, key) ? LANGUAGE_LOADERS[key as LazyLang] : undefined;
			if (!loader) return false;
			const module = await loader();
			const highlighter = await getHighlighter();
			await highlighter.loadLanguage(module.default);
			loaded.add(key as LazyLang);
			version += 1;
			for (const listener of listeners) listener();
			return true;
		} catch (error) {
			console.error(`[shiki] failed to load language "${key}"`, error);
			return false;
		} finally {
			inflight.delete(key);
		}
	})();

	inflight.set(key, task);
	return task;
}

/** Languages that the agent produces most often: loaded while the main thread is idle. */
export const PREWARM_LANGS: LangKey[] = ["bash", "shellsession", "json", "yaml", "diff", "ansi"];

let prewarmStarted = false;

/**
 * Load the common grammars in idle time (doc/design/webui.md "SafeMarkdown").
 * Other languages load on first use and render as plain text until then.
 */
export function scheduleLanguagePrewarm(): void {
	if (prewarmStarted) return;
	prewarmStarted = true;
	const run = () => {
		for (const lang of PREWARM_LANGS) void ensureLanguage(lang);
	};
	if (typeof window === "undefined") return;
	if (typeof window.requestIdleCallback === "function") {
		window.requestIdleCallback(run, { timeout: 3_000 });
	} else {
		window.setTimeout(run, 1_500);
	}
}
