// biome-ignore-all lint/suspicious/noArrayIndexKey: Markdown blocks are an ordered sequence; an index is the stable identity of a block position.
import { Trans } from "@lingui/react/macro";
import {
	type ComponentProps,
	cloneElement,
	createContext,
	isValidElement,
	memo,
	type ReactElement,
	type ReactNode,
	useContext,
	useId,
	useMemo,
	useRef,
} from "react";
import ReactMarkdown, { type Components, type ExtraProps, type Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remend from "remend";
import { CodeFrame } from "@/components/code-frame";
import { safeUrlTransform } from "@/lib/url";
import { cn } from "@/lib/utils";
import { type MarkdownBlock, MarkdownSplitter } from "./blocks";
import { CodeBlock } from "./CodeBlock";
import { MathView } from "./MathView";
import { convertMathDelimiters } from "./math";
import { SafeLink, TextImage } from "./safe-nodes";
import { type StreamingTextStore, useStreamingText } from "./stream-store";

const REMARK_PLUGINS: NonNullable<Options["remarkPlugins"]> = [
	remarkGfm,
	[remarkMath, { singleDollarTextMath: false }],
];

/**
 * The constant clobber prefix every cached Markdown block is converted with: `blockCache` holds
 * converted elements for the whole page, so they cannot carry a per-message footnote prefix.
 * `MarkdownAnchor` swaps the placeholder for the message's real prefix (from `FootnoteContext`)
 * when the element renders; the placeholder itself never reaches the DOM.
 */
const PLACEHOLDER_CLOBBER_PREFIX = "md-placeholder-";

function textOf(children: ReactNode): string {
	if (typeof children === "string") return children;
	if (typeof children === "number") return String(children);
	if (Array.isArray(children)) return children.map(textOf).join("");
	return "";
}

function isMathClass(className: string | undefined): boolean {
	return className?.includes("language-math") ?? false;
}

/** ASCII characters `micromark-util-sanitize-uri` leaves unescaped in an id. */
const URI_SAFE_CHARACTER_RE = /[!#$&-;=?-Z_a-z~]/;

function isAsciiAlphanumeric(code: number): boolean {
	return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

/**
 * Percent-encode an identifier the way `mdast-util-to-hast` does for footnote ids (via
 * `micromark-util-sanitize-uri`): unsafe characters become `%XX`, existing `%XX` sequences are kept.
 * Encoding must match exactly, or the section's back-links point at ids the references never have.
 */
function encodeFootnoteId(value: string): string {
	let result = "";
	let start = 0;
	let skip = 0;
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		let replacement = "";
		if (
			code === 37 &&
			isAsciiAlphanumeric(value.charCodeAt(index + 1)) &&
			isAsciiAlphanumeric(value.charCodeAt(index + 2))
		) {
			skip = 2;
		} else if (code < 128) {
			const character = String.fromCharCode(code);
			if (!URI_SAFE_CHARACTER_RE.test(character)) replacement = character;
		} else if (code > 55_295 && code < 57_344) {
			// A surrogate pair is encoded as one code point; a lone surrogate becomes U+FFFD.
			const next = value.charCodeAt(index + 1);
			if (code < 56_320 && next > 56_319 && next < 57_344) {
				replacement = String.fromCharCode(code, next);
				skip = 1;
			} else {
				replacement = "\uFFFD";
			}
		} else {
			replacement = String.fromCharCode(code);
		}
		if (replacement !== "") {
			result += value.slice(start, index) + encodeURIComponent(replacement);
			start = index + skip + 1;
			replacement = "";
		}
		if (skip !== 0) {
			index += skip;
			skip = 0;
		}
	}
	return result + value.slice(start);
}

/**
 * The `safeId` `mdast-util-to-hast` gives a footnote label: the identifier is canonicalised
 * (whitespace collapsed, trimmed, lower- then uppercase) and then lowercased and percent-encoded.
 * Doing the same here keeps the section's `li` id, the reference `href` and the back-link identical
 * for labels with uppercase or non-ASCII characters.
 */
function footnoteSafeId(label: string): string {
	const identifier = label
		.replace(/[\t\n\r ]+/g, " ")
		.replace(/^ | $/g, "")
		.toLowerCase()
		.toUpperCase();
	return encodeFootnoteId(identifier.toLowerCase());
}

interface FootnoteDefinition {
	label: string;
	/** The encoded id used by the `fn-` and `fnref-` anchors. */
	safeId: string;
	body: string;
}

const FOOTNOTE_DEFINITION_RE = /^ {0,3}\[\^([^\]\s]+)\]:[ \t]?/;

/**
 * The definitions the splitter collected, as label and body. The renderer prepends the raw source to
 * every block so references resolve; this list is what the one footnotes section at the end shows.
 */
function parseFootnoteDefinitions(source: string): FootnoteDefinition[] {
	const definitions: FootnoteDefinition[] = [];
	let current: FootnoteDefinition | null = null;
	for (const line of source.split("\n")) {
		const match = FOOTNOTE_DEFINITION_RE.exec(line);
		if (match) {
			const label = match[1] ?? "";
			current = { label, safeId: footnoteSafeId(label), body: line.slice(match[0].length) };
			definitions.push(current);
		} else if (current) {
			// A continuation line is indented by up to four spaces (or a tab); the indentation is not content.
			current.body += `\n${line.replace(/^(?: {1,4}|\t)/, "")}`;
		}
	}
	return definitions.map((definition) => ({ ...definition, body: definition.body.trimEnd() }));
}

interface FootnoteNumbering {
	/** Definitions in reference order; definitions nobody refers to keep their document order at the end. */
	definitions: FootnoteDefinition[];
	/** safeId → the message-wide number its references show, matching the ordered list. */
	numbers: Map<string, number>;
	/** safeId → index of the block holding the message-wide first reference, the one that keeps the id. */
	firstBlocks: Map<string, number>;
}

/**
 * Numbers the definitions by the order of their first reference across the whole message. Each block
 * renders with its own remark-gfm run, so the numbers inside one block start at 1 again; the
 * message-wide number is supplied to the anchors at render time instead.
 */
function orderedFootnoteDefinitions(
	definitions: readonly FootnoteDefinition[],
	blocks: readonly MarkdownBlock[],
): FootnoteNumbering {
	const unique: FootnoteDefinition[] = [];
	const bySafeId = new Map<string, FootnoteDefinition>();
	for (const definition of definitions) {
		if (bySafeId.has(definition.safeId)) continue;
		bySafeId.set(definition.safeId, definition);
		unique.push(definition);
	}
	const ordered: FootnoteDefinition[] = [];
	const firstBlocks = new Map<string, number>();
	for (let index = 0; index < blocks.length; index += 1) {
		const block = blocks[index];
		// A definition block is not rendered in place, and a code block never makes a reference.
		if (block === undefined || block.footnotes !== "" || block.code !== undefined) continue;
		for (const match of block.source.matchAll(/\[\^([^\]\s]+)\](?!:)/g)) {
			const safeId = footnoteSafeId(match[1] ?? "");
			const definition = bySafeId.get(safeId);
			if (definition === undefined) continue;
			if (!firstBlocks.has(safeId)) firstBlocks.set(safeId, index);
			if (!ordered.includes(definition)) ordered.push(definition);
		}
	}
	for (const definition of unique) {
		if (!ordered.includes(definition)) ordered.push(definition);
	}
	const numbers = new Map<string, number>();
	for (const [index, definition] of ordered.entries()) numbers.set(definition.safeId, index + 1);
	return { definitions: ordered, numbers, firstBlocks };
}

/** The state every event anchor needs: the message's real prefix and its footnote numbering. */
const FootnoteContext = createContext<{ prefix: string; numbering: FootnoteNumbering } | null>(null);
/** The block a rendered Markdown element belongs to; `null` outside the message body (the footnotes list). */
const BlockIndexContext = createContext<number | null>(null);

/** Replace a cached block's placeholder prefix with the rendering message's real one. */
function withMessagePrefix(value: string, prefix: string): string {
	const hash = value.startsWith("#") ? "#" : "";
	const body = hash === "" ? value : value.slice(hash.length);
	return body.startsWith(PLACEHOLDER_CLOBBER_PREFIX)
		? `${hash}${prefix}${body.slice(PLACEHOLDER_CLOBBER_PREFIX.length)}`
		: value;
}

/**
 * Same-page links: remark-gfm's footnote references and back-links are fragments, which the URL policy
 * rejects. Cached blocks are converted with the placeholder prefix, so their footnote anchors are the
 * only ones allowed through; `MarkdownAnchor` rewrites them to the message's real prefix at render time.
 * Everything else, including arbitrary user `#fragment` links, still goes through `safeUrlTransform`.
 */
function markdownUrlTransform(url: string, _key: string, node: { tagName: string }): string {
	if (
		node.tagName === "a" &&
		(url.startsWith(`#${PLACEHOLDER_CLOBBER_PREFIX}fn-`) || url.startsWith(`#${PLACEHOLDER_CLOBBER_PREFIX}fnref-`))
	) {
		return url;
	}
	return safeUrlTransform(url);
}

function MarkdownAnchor({ href, node: _node, children, ...props }: ComponentProps<"a"> & ExtraProps) {
	const footnotes = useContext(FootnoteContext);
	const blockIndex = useContext(BlockIndexContext);
	if ("data-footnote-ref" in props && typeof href === "string" && footnotes !== null) {
		const target = `#${PLACEHOLDER_CLOBBER_PREFIX}fn-`;
		const safeId = href.startsWith(target) ? href.slice(target.length) : null;
		const number = safeId === null ? undefined : footnotes.numbering.numbers.get(safeId);
		const firstBlock = safeId === null ? undefined : footnotes.numbering.firstBlocks.get(safeId);
		const { id, "aria-describedby": _describedBy, ...rest } = props;
		// remark-gfm numbers each block on its own; the message-wide number comes from the context.
		// Only the message-wide first reference keeps its id (the back-link target): every later
		// block would otherwise repeat `fnref-a`, because remark-gfm only suffixes repeats inside
		// one block. The cached id and href carry the placeholder prefix, not this message's.
		const keepId = blockIndex !== null && firstBlock !== undefined && blockIndex === firstBlock;
		const realHref = safeId === null ? withMessagePrefix(href, footnotes.prefix) : `#${footnotes.prefix}fn-${safeId}`;
		const realId = id === undefined ? undefined : withMessagePrefix(id, footnotes.prefix);
		return (
			<a
				href={realHref}
				{...rest}
				{...(keepId && realId !== undefined ? { id: realId } : {})}
				aria-describedby={`${footnotes.prefix}footnote-label`}
			>
				{number ?? children}
			</a>
		);
	}
	if (typeof href === "string" && href.startsWith("#")) {
		const isBackReference =
			href.startsWith(`#${PLACEHOLDER_CLOBBER_PREFIX}fnref-`) ||
			(footnotes !== null && href.startsWith(`#${footnotes.prefix}fnref-`));
		const realHref = footnotes === null ? href : withMessagePrefix(href, footnotes.prefix);
		return (
			<a
				href={realHref}
				{...props}
				{...(isBackReference ? { className: cn("ml-1", props.className), "data-footnote-backref": "" } : {})}
			>
				{children}
			</a>
		);
	}
	return (
		<SafeLink href={href} className={props.className} title={props.title}>
			{children}
		</SafeLink>
	);
}

/**
 * `complete` tells a code block that it will not grow again, which lets it keep
 * its tokenised lines for a later mount (a virtualised row that scrolled out of
 * the window). Only the last block of a stream is incomplete.
 */
function markdownComponents(complete: boolean): Components {
	return {
		// `pre` only marks its child as a block; the shared CodeBlock renders its own
		// <pre>, so the wrapper must not be emitted twice. Display math is its own
		// block and the MathView wrapper replaces the <pre>.
		pre: ({ children }) => {
			if (isValidElement(children)) {
				const className = (children.props as { className?: string }).className;
				if (isMathClass(className)) return children;
				return cloneElement(children as ReactElement<Record<string, unknown>>, { "data-block": "true" });
			}
			return <pre>{children}</pre>;
		},
		code: (props) => {
			const { className, children } = props;
			if (isMathClass(className)) {
				return (
					<MathView tex={textOf(children).replace(/\n$/, "")} display={className?.includes("math-display") ?? false} />
				);
			}
			const isBlock = "data-block" in props;
			if (isBlock) {
				const code = textOf(children).replace(/\n$/, "");
				const lang = /language-([^\s]+)/.exec(className ?? "")?.[1];
				return <CodeBlock code={code} lang={lang} complete={complete} />;
			}
			return <code className={className}>{children}</code>;
		},
		// Each block runs its own react-markdown, so remark-gfm's footnote section
		// must not appear per block; the message renders one at the end instead.
		section: ({ node: _node, ...props }) => ("data-footnotes" in props ? null : <section {...props} />),
		a: MarkdownAnchor,
		img: TextImage,
	};
}

/**
 * `remend` closes the markdown constructs that are still open in the last
 * block (an unmatched `**`, an unfinished link). Its results are memoised by
 * source: the same text can be requested twice per frame (React strict mode).
 */
const remendCache = new Map<string, string>();
const REMEND_CACHE_LIMIT = 400;

function safeRemend(text: string): string {
	const hit = remendCache.get(text);
	if (hit !== undefined) return hit;
	let result: string;
	try {
		result = remend(text);
	} catch (error) {
		console.error("[markdown] remend failed", error);
		result = text;
	}
	if (remendCache.size >= REMEND_CACHE_LIMIT) remendCache.clear();
	remendCache.set(text, result);
	return result;
}

/**
 * The Markdown → React conversion is the expensive half of rendering a long
 * message: hundreds of blocks, about 120 ms for the 100K fixture on a fast CPU
 * and several times that under 4× throttling. A virtualised row that scrolled
 * out of and back into the window is a fresh component instance, which `memo`
 * cannot help; the converted element of a finished block is cached by its full
 * source instead. Elements are immutable descriptions, so a hit is safe to
 * render again. The cache is bounded and cleared as a whole: a session page
 * only has a handful of long messages on screen at a time.
 *
 * The key is the block's full source (collected definitions and footnotes
 * included) and carries no per-message data. Blocks are converted with one
 * constant placeholder clobber prefix, and `MarkdownAnchor` reads the real
 * message prefix and the footnote numbers from `FootnoteContext` when the
 * element renders, so a hit is also safe in another component instance.
 */
const blockCache = new Map<string, ReactElement>();
const BLOCK_CACHE_LIMIT = 1_200;

let blockConversions = 0;
let blockCacheHits = 0;

/** Test-only counters: a remount must serve finished blocks from the cache instead of converting them. */
export function markdownCacheStatsForTesting(): { conversions: number; hits: number } {
	return { conversions: blockConversions, hits: blockCacheHits };
}

/** Test-only: the placeholder prefix cached blocks are converted with; it must never reach the DOM. */
export const MARKDOWN_PLACEHOLDER_PREFIX_FOR_TESTING = PLACEHOLDER_CLOBBER_PREFIX;

function markdownBlockElement(text: string, reusable: boolean): ReactElement {
	const hit = reusable ? blockCache.get(text) : undefined;
	if (hit !== undefined) {
		blockCacheHits += 1;
		return hit;
	}
	const element = ReactMarkdown({
		remarkPlugins: REMARK_PLUGINS,
		components: markdownComponents(reusable),
		// react-markdown 10 passes the clobber prefix to remark-rehype, whose mdast-util-to-hast
		// prefixes footnote ids (it no longer takes a top-level `clobberPrefix` prop). The
		// placeholder is constant on purpose; the anchor component substitutes the real prefix.
		remarkRehypeOptions: { clobberPrefix: PLACEHOLDER_CLOBBER_PREFIX },
		urlTransform: markdownUrlTransform,
		skipHtml: true,
		children: text,
	});
	// The growing last block of a stream is a new text on every frame; caching
	// it would only evict the finished blocks the cache exists for.
	if (!reusable) return element;
	blockConversions += 1;
	if (blockCache.size >= BLOCK_CACHE_LIMIT) blockCache.clear();
	blockCache.set(text, element);
	return element;
}

const MarkdownBlockView = memo(function MarkdownBlockView({
	source,
	definitions,
	footnotes,
	streaming,
	blockIndex = null,
}: {
	source: string;
	definitions: string;
	footnotes: string;
	streaming: boolean;
	blockIndex?: number | null;
}) {
	const repaired = streaming ? safeRemend(source) : source;
	// Footnotes and reference definitions are prepended so references resolve
	// even when the definition itself arrives later in the message
	// (doc/design/webui.md "SafeMarkdown").
	const prelude = [footnotes, definitions].filter((value) => value !== "").join("\n");
	const text = prelude === "" ? repaired : `${prelude}\n\n${repaired}`;
	return (
		<BlockIndexContext.Provider value={blockIndex}>{markdownBlockElement(text, !streaming)}</BlockIndexContext.Provider>
	);
});

/**
 * The one footnotes section of a message: the collected definitions as an ordered list, each body
 * rendered by the same block renderer, with a back-link to its reference.
 */
function FootnotesSection({
	definitions,
	definitionsSource,
	prefix,
}: {
	definitions: readonly FootnoteDefinition[];
	definitionsSource: string;
	prefix: string;
}) {
	if (definitions.length === 0) return null;
	return (
		<section
			data-footnotes
			className="mt-4 border-t border-border pt-2 text-xs text-muted-foreground"
			data-testid="footnotes"
		>
			<h2 id={`${prefix}footnote-label`} className="sr-only">
				<Trans>Footnotes</Trans>
			</h2>
			<ol>
				{definitions.map((definition) => (
					<li key={definition.safeId} id={`${prefix}fn-${definition.safeId}`} className="mt-1">
						<MarkdownBlockView
							// The back-link belongs to the end of the note's last line, as GitHub renders it:
							// appending it to the body keeps it inside the final paragraph instead of on a line
							// of its own after the block. The placeholder prefix keeps the body identical across
							// messages so it can be cached; `MarkdownAnchor` writes the real prefix at render time.
							source={`${definition.body} [↩](#${PLACEHOLDER_CLOBBER_PREFIX}fnref-${definition.safeId})`}
							definitions={definitionsSource}
							footnotes=""
							streaming={false}
						/>
					</li>
				))}
			</ol>
		</section>
	);
}

const CodeBlockView = memo(function CodeBlockView({ block, complete }: { block: MarkdownBlock; complete: boolean }) {
	return <CodeBlock code={(block.code?.text ?? "").replace(/\n$/, "")} lang={block.code?.lang} complete={complete} />;
});

function MarkdownView({ text, streaming, className }: { text: string; streaming: boolean; className?: string }) {
	const splitterRef = useRef<MarkdownSplitter | null>(null);
	splitterRef.current ??= new MarkdownSplitter();
	// Every message owns its footnote anchor ids, so two messages on one page never collide.
	// React's id has characters that are awkward in CSS selectors; the prefix only needs to be unique.
	const instanceId = useId()
		.toLowerCase()
		.replace(/[^a-z0-9-]/g, "");
	const prefix = `md-${instanceId === "" ? "x" : instanceId}-`;
	// TeX-style delimiters are rewritten before splitting, so a display `\[…\]` becomes a `$$` fence
	// that the splitter keeps together (doc/design/webui.md "SafeMarkdown").
	const converted = useMemo(() => convertMathDelimiters(text), [text]);
	const result = useMemo(
		() => (splitterRef.current as MarkdownSplitter).update(converted, streaming),
		[converted, streaming],
	);
	const numbering = useMemo(
		() => orderedFootnoteDefinitions(parseFootnoteDefinitions(result.footnotes), result.blocks),
		[result.footnotes, result.blocks],
	);
	const footnoteContext = useMemo(() => ({ prefix, numbering }), [prefix, numbering]);
	const lastIndex = result.blocks.length - 1;

	return (
		<FootnoteContext.Provider value={footnoteContext}>
			<div className={cn("md-body", className)} data-testid="safe-markdown">
				{result.blocks.map((block, index) =>
					block.footnotes !== "" ? null : block.unclosedMath === true ? (
						// An incomplete display formula (still streaming) has no closing `$$`; rendering it as source
						// keeps the delimiters visible instead of turning the partial TeX into MathML early.
						<CodeFrame
							key={index}
							className="my-3"
							bodyClassName="overflow-x-auto p-3 font-mono text-xs whitespace-pre"
							data-testid="unclosed-math"
						>
							{block.source}
						</CodeFrame>
					) : block.code !== undefined ? (
						<CodeBlockView key={index} block={block} complete={!(streaming && index === lastIndex)} />
					) : (
						<MarkdownBlockView
							key={index}
							source={block.source}
							definitions={result.definitions}
							footnotes={result.footnotes}
							streaming={streaming && index === lastIndex}
							blockIndex={index}
						/>
					),
				)}
				<FootnotesSection definitions={numbering.definitions} definitionsSource={result.footnotes} prefix={prefix} />
			</div>
		</FootnoteContext.Provider>
	);
}

/**
 * Safe Markdown rendering for assistant text and thinking
 * (doc/design/webui.md "SafeMarkdown"): no raw HTML, links limited to
 * http(s)/mailto, images rendered as text, and code highlighted incrementally.
 */
export function SafeMarkdown({
	text,
	streaming = false,
	className,
}: {
	text: string;
	streaming?: boolean;
	className?: string;
}) {
	return <MarkdownView text={text} streaming={streaming} className={className} />;
}

/**
 * The streaming variant: the text lives in an external store (batched to one
 * update per animation frame) and is read with `useSyncExternalStore`.
 *
 * A row that outlives its stream passes `text`: from then on the committed
 * text is the source of truth and the renderer leaves streaming mode, but the
 * component instance and its incremental block tree stay — only the last block
 * is re-rendered (without `remend`).
 */
export function StreamingMarkdown({
	store,
	text,
	className,
}: {
	store: StreamingTextStore;
	text?: string;
	className?: string;
}) {
	const live = useStreamingText(store);
	const value = text ?? live.text;
	return <MarkdownView text={value} streaming={text === undefined && live.streaming} className={className} />;
}
