import { describe, expect, test } from "vitest";
import doc20k from "./__fixtures__/doc-20k.md?raw";
import doc50k from "./__fixtures__/doc-50k.md?raw";
import edgeCases from "./__fixtures__/edge-cases.md?raw";
import { collectReferenceDefinitions, fencedCodeOf, MarkdownSplitter, splitMarkdownBlocks } from "./blocks";

function stream(text: string, chunkSize: number): ReturnType<MarkdownSplitter["update"]> {
	const splitter = new MarkdownSplitter();
	let _result = splitter.update("", true);
	for (let i = chunkSize; i < text.length; i += chunkSize) {
		_result = splitter.update(text.slice(0, i), true);
	}
	return splitter.update(text, true);
}

const sources = (result: ReturnType<MarkdownSplitter["update"]>) => result.blocks.map((block) => block.source);

describe("splitMarkdownBlocks", () => {
	test("blocks concatenate back to the document", () => {
		for (const text of [doc20k, doc50k, edgeCases]) {
			const result = splitMarkdownBlocks(text);
			expect(result.blocks.map((block) => block.source).join("")).toBe(text);
		}
	});

	test("collects reference definitions across the document, including late ones", () => {
		const definitions = collectReferenceDefinitions(edgeCases);
		expect(definitions).toContain("[late-ref]: https://example.com/late-reference");
		expect(definitions).toContain("[late-ref-2]: https://example.com/another-late-reference");
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

	test("late definitions are present in the split result", () => {
		const result = splitMarkdownBlocks("A [link][x].\n\n[x]: https://example.com/x\n");
		expect(result.definitions).toContain("[x]: https://example.com/x");
	});
});
