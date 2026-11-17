import { describe, expect, test } from "vitest";
import doc20k from "./__fixtures__/doc-20k.md?raw";
import doc50k from "./__fixtures__/doc-50k.md?raw";
import edgeCases from "./__fixtures__/edge-cases.md?raw";
import footnotesMath from "./__fixtures__/footnotes-math.md?raw";
import { collectReferenceDefinitions, fencedCodeOf, MarkdownSplitter, splitMarkdownBlocks } from "./blocks";

function stream(text: string, chunkSize: number): ReturnType<MarkdownSplitter["update"]> {
	const splitter = new MarkdownSplitter();
	let _result = splitter.update("", true);
	for (let i = chunkSize; i < text.length; i += chunkSize) {
		_result = splitter.update(text.slice(0, i), true);
	}
	return splitter.update(text, true);
}

/**
 * Stream the text in chunks and then finish it, the way a committed message does. The final
 * `streaming: false` update is where an unterminated `$$` must become ordinary Markdown again.
 */
function streamFinished(text: string, chunkSize: number): ReturnType<MarkdownSplitter["update"]> {
	const splitter = new MarkdownSplitter();
	let _result = splitter.update("", true);
	for (let i = chunkSize; i < text.length; i += chunkSize) {
		_result = splitter.update(text.slice(0, i), true);
	}
	splitter.update(text, true);
	return splitter.update(text, false);
}

const sources = (result: ReturnType<MarkdownSplitter["update"]>) => result.blocks.map((block) => block.source);

describe("splitMarkdownBlocks", () => {
	test("blocks concatenate back to the document", () => {
		for (const text of [doc20k, doc50k, edgeCases, footnotesMath]) {
			const result = splitMarkdownBlocks(text);
			expect(result.blocks.map((block) => block.source).join("")).toBe(text);
		}
	});

	test("collects reference definitions across the document, including late ones", () => {
		const definitions = collectReferenceDefinitions(edgeCases);
		expect(definitions).toContain("[late-ref]: https://example.com/late-reference");
		expect(definitions).toContain("[late-ref-2]: https://example.com/another-late-reference");
	});

	test("collects footnote definitions in their own field", () => {
		const text = "See the note[^1] and the other[^b].\n\n[^1]: The first note\n[^b]: The second note\n\nAfter.\n";
		const result = splitMarkdownBlocks(text);
		expect(result.footnotes).toBe("[^1]: The first note\n[^b]: The second note");
		expect(result.blocks.filter((block) => block.footnotes !== "")).toHaveLength(1);
		expect(result.blocks.map((block) => block.source).join("")).toBe(text);
	});

	test("collects a footnote definition marked lexes as a reference definition", () => {
		// marked has no footnote token and can take `[^NOTE]: Body` for a link definition.
		const text = "See[^NOTE].\n\n[^NOTE]: Body\n";
		const result = splitMarkdownBlocks(text);
		expect(result.footnotes).toBe("[^NOTE]: Body\n");
		expect(result.definitions).toBe("");
		expect(result.blocks.filter((block) => block.footnotes !== "")).toHaveLength(1);
		expect(result.blocks.map((block) => block.source).join("")).toBe(text);
	});

	test("does not treat footnote-like lines inside a fence as definitions", () => {
		const text = "```\n[^1]: not a footnote\n```\n";
		const result = splitMarkdownBlocks(text);
		expect(result.footnotes).toBe("");
	});

	test("keeps a display formula with blank lines in one block", () => {
		const text = "before\n\n$$\na\n\nb\n$$\n\nafter\n";
		const result = splitMarkdownBlocks(text);
		const formula = result.blocks.find((block) => block.source.startsWith("$$"));
		expect(formula?.source).toBe("$$\na\n\nb\n$$");
		expect(result.blocks.map((block) => block.source).join("")).toBe(text);
	});

	test("a closed inline formula does not absorb the following block", () => {
		const text = "before\n\n$$x + y$$\n\nafter\n";
		const result = splitMarkdownBlocks(text);
		expect(result.blocks.map((block) => block.source)).toContain("$$x + y$$");
		expect(result.blocks.map((block) => block.source).join("")).toBe(text);
	});

	test("a display formula with a stray $$ inside it closes at its line-ending fence", () => {
		const text = "$$\na $$ b\n$$\n\nafter\n";
		const result = splitMarkdownBlocks(text);
		expect(result.blocks.some((block) => block.unclosedMath === true)).toBe(false);
		expect(result.blocks.map((block) => block.source).join("")).toBe(text);
		expect(result.blocks.some((block) => block.source.trim() === "after")).toBe(true);
	});

	test("a stray display opener in a finished document does not swallow the rest", () => {
		const text = "before\n\n$$\nnot a formula\n\nafter\n";
		const result = splitMarkdownBlocks(text);
		expect(result.blocks.some((block) => block.unclosedMath === true)).toBe(false);
		expect(result.blocks.map((block) => block.source).join("")).toBe(text);
		expect(result.blocks.some((block) => block.source.trim() === "after")).toBe(true);
	});

	test("does not treat definition-like lines inside a fence as definitions", () => {
		const text = "```\n[not-a-ref]: https://evil.example\n```\n";
		expect(collectReferenceDefinitions(text)).toEqual([]);
	});

	test("flags an unterminated fence as a code block", () => {
		const text = "before\n\n```bash\nkubectl get pods\n";
		const result = splitMarkdownBlocks(text);
		const last = result.blocks.at(-1);
		expect(last?.code).toBeDefined();
		expect(last?.code?.lang).toBe("bash");
		expect(last?.code?.text).toContain("kubectl get pods");
	});

	test("ordinary text is not a code block", () => {
		expect(fencedCodeOf({ type: "paragraph", raw: "x", text: "x", tokens: [] } as never)).toBeUndefined();
	});
});

describe("MarkdownSplitter (incremental)", () => {
	test("finished blocks are not re-lexed", () => {
		const splitter = new MarkdownSplitter();
		const first = "one\n\ntwo\n\nthree";
		const result = splitter.update(first, true);
		// Paragraphs and the blank-line `space` tokens between them; the last
		// content block is still growing, so the earlier ones are memoised.
		expect(result.blocks.map((block) => block.source)).toEqual(["one", "\n\n", "two", "\n\n", "three"]);
		const stableBefore = result.blocks[0];
		const grown = splitter.update(`${first} more`, true);
		expect(grown.blocks[0]).toBe(stableBefore);
	});

	test("a replaced text resets the memoised prefix", () => {
		const splitter = new MarkdownSplitter();
		splitter.update("alpha\n\nbeta", true);
		const replaced = splitter.update("gamma", true);
		expect(replaced.blocks.map((block) => block.source)).toEqual(["gamma"]);
	});

	test("streamed final blocks equal a one-shot render for 20K / 50K", () => {
		for (const text of [doc20k, doc50k]) {
			const oneShot = splitMarkdownBlocks(text);
			for (const chunkSize of [1, 8, 40]) {
				const result = stream(text, chunkSize);
				expect(sources(result), `chunk ${chunkSize}`).toEqual(sources(oneShot));
				expect(result.definitions).toBe(oneShot.definitions);
			}
		}
	}, 300_000);

	test("streamed final blocks equal a one-shot render for the footnotes-math fixture (chunks 1 / 2 / 3 / 8 / 40)", () => {
		const oneShot = splitMarkdownBlocks(footnotesMath);
		expect(sources(oneShot).join("")).toBe(footnotesMath);
		expect(oneShot.footnotes).not.toBe("");
		for (const chunkSize of [1, 2, 3, 8, 40]) {
			const result = streamFinished(footnotesMath, chunkSize);
			expect(sources(result), `chunk ${chunkSize}`).toEqual(sources(oneShot));
			expect(sources(result).join(""), `chunk ${chunkSize}`).toBe(footnotesMath);
			expect(result.definitions, `chunk ${chunkSize}`).toBe(oneShot.definitions);
			expect(result.footnotes, `chunk ${chunkSize}`).toBe(oneShot.footnotes);
			// The stray `$$` opener near the end is only source while a stream is in flight.
			expect(
				result.blocks.some((block) => block.unclosedMath === true),
				`chunk ${chunkSize}`,
			).toBe(false);
		}
	}, 120_000);

	test("late definitions are present in the split result", () => {
		const result = splitMarkdownBlocks("A [link][x].\n\n[x]: https://example.com/x\n");
		expect(result.definitions).toContain("[x]: https://example.com/x");
	});

	test("streaming an unclosed display formula keeps the tail in one block", () => {
		const splitter = new MarkdownSplitter();
		const partial = "before\n\n$$\na\n\nb";
		const open = splitter.update(partial, true);
		const openTail = open.blocks.at(-1);
		expect(openTail?.source).toBe("$$\na\n\nb");
		expect(open.blocks.map((block) => block.source).join("")).toBe(partial);
		// Only the streaming tail is shown as source; the earlier paragraph is a normal block.
		expect(open.blocks.filter((block) => block.unclosedMath === true)).toHaveLength(1);
		expect(open.blocks.at(-1)?.unclosedMath).toBe(true);

		const closed = splitter.update(`${partial}\n$$`, true);
		expect(closed.blocks.at(-1)?.source).toBe("$$\na\n\nb\n$$");
	});

	test("a finished document never flags an unclosed formula", () => {
		const splitter = new MarkdownSplitter();
		const text = "before\n\n$$\nnot closed\n\nafter";
		const streamed = splitter.update(text, true);
		expect(streamed.blocks.some((block) => block.unclosedMath === true)).toBe(true);

		const finished = splitter.update(text, false);
		expect(finished.blocks.some((block) => block.unclosedMath === true)).toBe(false);
		expect(finished.blocks.map((block) => block.source).join("")).toBe(text);
	});
});
