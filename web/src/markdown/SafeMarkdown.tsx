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

const MARKDOWN_COMPONENTS: Components = {
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
			return <CodeBlock code={code} lang={lang} />;
		}
		return <code className={className}>{children}</code>;
	},
	a: SafeLink,
	img: TextImage,
};

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
	return (
		<ReactMarkdown
			remarkPlugins={REMARK_PLUGINS}
			components={MARKDOWN_COMPONENTS}
			urlTransform={safeUrlTransform}
			skipHtml
		>
			{text}
		</ReactMarkdown>
	);
});

const CodeBlockView = memo(function CodeBlockView({ block }: { block: MarkdownBlock }) {
	return <CodeBlock code={(block.code?.text ?? "").replace(/\n$/, "")} lang={block.code?.lang} />;
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
					<CodeBlockView key={index} block={block} />
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
 */
export function StreamingMarkdown({ store, className }: { store: StreamingTextStore; className?: string }) {
	const { text, streaming } = useStreamingText(store);
	return <MarkdownView text={text} streaming={streaming} className={className} />;
}
