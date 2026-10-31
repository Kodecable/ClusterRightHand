// biome-ignore-all lint/suspicious/noArrayIndexKey: tokens and finished-line groups are an ordered append-only sequence.
import { Plural, useLingui } from "@lingui/react/macro";
import { memo, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { HighlighterGeneric, ThemedToken } from "shiki";
import { CopyButton } from "@/components/copy-button";
import { cn } from "@/lib/utils";
import {
	ensureLanguage,
	getHighlighter,
	getLanguageVersion,
	isLanguageLoaded,
	type LangKey,
	resolveLang,
	scheduleLanguagePrewarm,
	subscribeLanguages,
} from "./shiki/highlighter";
import { IncrementalTokenizer, type TokenSnapshot } from "./shiki/tokenizer";

/** Finished lines are memoised in groups of this size (doc/webui.md "SafeMarkdown" item 3). */
export const LINE_GROUP_SIZE = 100;

const TokenSpan = memo(function TokenSpan({ tokens }: { tokens: ThemedToken[] }) {
	if (tokens.length === 0) return <span className="shiki-line">{"\u200b"}</span>;
	return (
		<span className="shiki-line">
			{tokens.map((token, index) => (
				<span key={index} style={token.htmlStyle}>
					{token.content}
				</span>
			))}
		</span>
	);
});

/**
 * One group of at most 100 finished lines. The group's props (`lines`, `start`,
 * `end`) stay identical while later lines stream in, so React skips it and only
 * the last, growing group re-renders.
 */
const LineGroup = memo(function LineGroup({
	lines,
	start,
	end,
}: {
	lines: ThemedToken[][];
	start: number;
	end: number;
}) {
	const output = [];
	for (let i = start; i < end; i += 1) {
		output.push(<TokenSpan key={i} tokens={lines[i] ?? []} />);
	}
	return <>{output}</>;
});

const PartialLine = memo(function PartialLine({ tokens }: { tokens: ThemedToken[] | null }) {
	if (!tokens) return null;
	return (
		<span className="shiki-line" data-incomplete="true">
			{tokens.map((token, index) => (
				<span key={index} style={token.htmlStyle}>
					{token.content}
				</span>
			))}
		</span>
	);
});

function FinishedLines({ lines, count }: { lines: ThemedToken[][]; count: number }) {
	const groups = [];
	for (let start = 0; start < count; start += LINE_GROUP_SIZE) {
		groups.push(<LineGroup key={start} lines={lines} start={start} end={Math.min(start + LINE_GROUP_SIZE, count)} />);
	}
	return <>{groups}</>;
}

export interface CodeBlockProps {
	code: string;
	lang?: string;
	className?: string;
	/**
	 * The code will not grow again. A finished block's tokenised lines are then
	 * kept for the lifetime of the page: a virtualised transcript row that
	 * scrolled out of and back into the window mounts a new block, and
	 * re-tokenising a few thousand lines is the largest part of that frame.
	 */
	complete?: boolean;
}

/**
 * Tokenised lines of finished code blocks, keyed by language and source. The
 * snapshots are shallow copies (the token objects themselves are immutable),
 * so the incremental tokenizer of the original block can keep appending
 * without touching what was cached.
 */
const tokenCache = new Map<string, TokenSnapshot>();
const TOKEN_CACHE_LIMIT = 64;

function cachedSnapshot(key: string, snapshot: TokenSnapshot): TokenSnapshot {
	if (tokenCache.size >= TOKEN_CACHE_LIMIT) tokenCache.clear();
	const copy: TokenSnapshot = {
		lines: snapshot.lines.slice(),
		partial: snapshot.partial === null ? null : snapshot.partial.slice(),
		partialText: snapshot.partialText,
		preStyle: snapshot.preStyle,
	};
	tokenCache.set(key, copy);
	return copy;
}

/**
 * The shared incremental Shiki code block (doc/webui.md "SafeMarkdown").
 * Renders plain text until the language grammar chunk is loaded, and forever
 * for languages outside the supported set. Copy always copies the source.
 */
export function CodeBlock({ code, lang, className, complete = false }: CodeBlockProps) {
	const { t } = useLingui();
	const key = resolveLang(lang);
	// Subscribe to the language registry so a block re-renders when its grammar
	// finishes loading (possibly because another block requested it first).
	const version = useSyncExternalStore(subscribeLanguages, getLanguageVersion);
	void version;
	const ready = isLanguageLoaded(key);
	const [highlighter, setHighlighter] = useState<HighlighterGeneric<string, string> | null>(null);
	const [failed, setFailed] = useState(false);

	useEffect(() => {
		scheduleLanguagePrewarm();
	}, []);

	useEffect(() => {
		if (!key || failed) return;
		if (!ready) {
			let alive = true;
			void ensureLanguage(key).then((ok) => {
				if (alive && !ok) setFailed(true);
			});
			return () => {
				alive = false;
			};
		}
		let alive = true;
		void getHighlighter().then((instance) => {
			if (alive) setHighlighter(instance);
		});
		return () => {
			alive = false;
		};
	}, [key, ready, failed]);

	const tokenizerRef = useRef<{
		key: LangKey;
		instance: HighlighterGeneric<string, string>;
		tokenizer: IncrementalTokenizer;
	} | null>(null);

	const snapshot = useMemo<TokenSnapshot | null>(() => {
		if (!key || failed || !highlighter) return null;
		const cacheKey = `${key}\u0000${code}`;
		if (complete) {
			const hit = tokenCache.get(cacheKey);
			if (hit !== undefined) return hit;
		}
		let current = tokenizerRef.current;
		if (!current || current.key !== key || current.instance !== highlighter) {
			current = {
				key,
				instance: highlighter,
				tokenizer: new IncrementalTokenizer(highlighter, key),
			};
			tokenizerRef.current = current;
		}
		const result = current.tokenizer.update(code);
		return complete ? cachedSnapshot(cacheKey, result) : result;
	}, [key, failed, highlighter, code, complete]);

	const lineCount = useMemo(() => {
		let count = 1;
		for (let i = 0; i < code.length; i += 1) if (code.charCodeAt(i) === 10) count += 1;
		return count;
	}, [code]);

	const plain = snapshot === null;

	return (
		<div
			className={cn(
				"code-block my-3 overflow-hidden rounded-lg border bg-[var(--code)]",
				lineCount > 400 && "code-block--giant",
				className,
			)}
			data-testid="shiki-code-block"
			data-lang={key ?? lang ?? "text"}
			data-lines={lineCount}
			data-plain={plain ? "true" : "false"}
		>
			<div className="flex items-center gap-2 border-b px-3 py-1 text-xs text-muted-foreground">
				<span className="flex-1 font-mono" data-testid="code-lang">
					{lang !== undefined && lang !== "" ? lang : t`text`}
					{lineCount > 1 && (
						<>
							{" · "}
							<Plural value={lineCount} one="# line" other="# lines" />
						</>
					)}
				</span>
				<CopyButton text={code} label={t`Copy code`} showLabel />
			</div>
			<pre
				className={cn(
					"shiki-block max-h-[420px] overflow-auto p-3 text-xs leading-relaxed",
					lineCount > 400 && "max-h-[520px]",
				)}
				style={snapshot?.preStyle}
			>
				<code>
					{snapshot === null ? (
						<span className="shiki-plain">{code}</span>
					) : (
						<>
							<FinishedLines lines={snapshot.lines} count={snapshot.lines.length} />
							<PartialLine tokens={snapshot.partial} />
						</>
					)}
				</code>
			</pre>
		</div>
	);
}
