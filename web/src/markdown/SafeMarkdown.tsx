// biome-ignore-all lint/suspicious/noArrayIndexKey: Markdown blocks are an ordered sequence; an index is the stable identity of a block position.
import { cloneElement, isValidElement, memo, type ReactElement, type ReactNode, useMemo, useRef } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remend from "remend";
import { safeUrlTransform } from "@/lib/url";
import { cn } from "@/lib/utils";
import { type MarkdownBlock, MarkdownSplitter } from "./blocks";
import { CodeBlock } from "./CodeBlock";
import { SafeLink, TextImage } from "./safe-nodes";
import { type StreamingTextStore, useStreamingText } from "./stream-store";

const REMARK_PLUGINS = [remarkGfm];

function textOf(children: ReactNode): string {
	if (typeof children === "string") return children;
	if (typeof children === "number") return String(children);
	if (Array.isArray(children)) return children.map(textOf).join("");
	return "";
}

/**
 * `complete` tells a code block that it will not grow again, which lets it keep
 * its tokenised lines for a later mount (a virtualised row that scrolled out of
 * the window). Only the last block of a stream is incomplete.
 */
function markdownComponents(complete: boolean): Components {
	return {
		// `pre` only marks its child as a block; the shared CodeBlock renders its own
		// <pre>, so the wrapper must not be emitted twice.
		pre: ({ children }) => {
			if (isValidElement(children)) {
				return cloneElement(children as ReactElement<Record<string, unknown>>, { "data-block": "true" });
			}
			return <pre>{children}</pre>;
		},
		code: (props) => {
			const { className, children } = props;
			const isBlock = "data-block" in props;
			if (isBlock) {
				const code = textOf(children).replace(/\n$/, "");
				const lang = /language-([^\s]+)/.exec(className ?? "")?.[1];
				return <CodeBlock code={code} lang={lang} complete={complete} />;
			}
			return <code className={className}>{children}</code>;
		},
		a: SafeLink,
		img: TextImage,
	};
}

const MARKDOWN_COMPONENTS = markdownComponents(true);
const STREAMING_MARKDOWN_COMPONENTS = markdownComponents(false);

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
 */
const blockCache = new Map<string, ReactElement>();
const BLOCK_CACHE_LIMIT = 1_200;

function markdownBlockElement(text: string, reusable: boolean): ReactElement {
	const hit = reusable ? blockCache.get(text) : undefined;
	if (hit !== undefined) return hit;
	const element = ReactMarkdown({
		remarkPlugins: REMARK_PLUGINS,
		components: reusable ? MARKDOWN_COMPONENTS : STREAMING_MARKDOWN_COMPONENTS,
		urlTransform: safeUrlTransform,
		skipHtml: true,
		children: text,
	});
	// The growing last block of a stream is a new text on every frame; caching
	// it would only evict the finished blocks the cache exists for.
	if (!reusable) return element;
	if (blockCache.size >= BLOCK_CACHE_LIMIT) blockCache.clear();
	blockCache.set(text, element);
	return element;
}

const MarkdownBlockView = memo(function MarkdownBlockView({
	source,
	definitions,
	streaming,
}: {
	source: string;
	definitions: string;
	streaming: boolean;
}) {
	const repaired = streaming ? safeRemend(source) : source;
	// Definitions are prepended so references resolve even when the definition
	// itself arrives later in the message (doc/webui.md item 5).
	const text = definitions === "" ? repaired : `${definitions}\n\n${repaired}`;
	return markdownBlockElement(text, !streaming);
});

const CodeBlockView = memo(function CodeBlockView({ block, complete }: { block: MarkdownBlock; complete: boolean }) {
	return <CodeBlock code={(block.code?.text ?? "").replace(/\n$/, "")} lang={block.code?.lang} complete={complete} />;
});

function MarkdownView({ text, streaming, className }: { text: string; streaming: boolean; className?: string }) {
	const splitterRef = useRef<MarkdownSplitter | null>(null);
	splitterRef.current ??= new MarkdownSplitter();
	const result = useMemo(() => (splitterRef.current as MarkdownSplitter).update(text, streaming), [text, streaming]);
	const lastIndex = result.blocks.length - 1;

	return (
		<div className={cn("md-body", className)} data-testid="safe-markdown">
			{result.blocks.map((block, index) =>
				block.code !== undefined ? (
					<CodeBlockView key={index} block={block} complete={!(streaming && index === lastIndex)} />
				) : (
					<MarkdownBlockView
						key={index}
						source={block.source}
						definitions={result.definitions}
						streaming={streaming && index === lastIndex}
					/>
				),
			)}
		</div>
	);
}

/**
 * Safe Markdown rendering for assistant text and thinking
 * (doc/webui.md "SafeMarkdown"): no raw HTML, links limited to
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
