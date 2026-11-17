import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act, render, waitFor } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { activateLocale } from "@/test/render";
import doc20k from "./__fixtures__/doc-20k.md?raw";
import doc50k from "./__fixtures__/doc-50k.md?raw";
import edgeCases from "./__fixtures__/edge-cases.md?raw";
import footnotesMath from "./__fixtures__/footnotes-math.md?raw";
import malicious from "./__fixtures__/malicious.md?raw";
import { SafeMarkdown, StreamingMarkdown } from "./SafeMarkdown";
import { StreamingTextStore } from "./stream-store";

function withI18n(node: React.ReactElement) {
	activateLocale();
	return <I18nProvider i18n={i18n}>{node}</I18nProvider>;
}

function renderMarkdown(node: React.ReactElement) {
	return render(withI18n(node));
}

function normalise(text: string | null | undefined): string {
	return (text ?? "").replace(/\s+/g, " ").trim();
}

const SAFE_LINK = /^(https?|mailto):/i;

function unsafeAnchors(root: ParentNode): string[] {
	return Array.from(root.querySelectorAll("a[href]"))
		.map((anchor) => anchor.getAttribute("href") ?? "")
		.filter((href) => !SAFE_LINK.test(href));
}

function onAttributes(root: ParentNode): string[] {
	const found: string[] = [];
	for (const element of Array.from(root.querySelectorAll("*"))) {
		for (const attribute of Array.from(element.attributes)) {
			if (attribute.name.toLowerCase().startsWith("on")) found.push(attribute.name);
		}
	}
	return found;
}

function formulaElements(root: ParentNode): Element[] {
	return Array.from(root.querySelectorAll('[data-testid="math"]'));
}

function mathFallbacks(root: ParentNode): Element[] {
	return Array.from(root.querySelectorAll('[data-testid="math-source"]'));
}

function footnoteNumbers(root: ParentNode): (string | null)[] {
	return Array.from(root.querySelectorAll("a[data-footnote-ref]")).map((anchor) => normalise(anchor.textContent));
}

describe("SafeMarkdown security", () => {
	test("the malicious fixture renders nothing executable and no image", () => {
		(window as unknown as { __pwned?: boolean }).__pwned = undefined;
		const { container } = renderMarkdown(<SafeMarkdown text={malicious} />);
		expect(container.querySelectorAll("script")).toHaveLength(0);
		expect(container.querySelectorAll("iframe")).toHaveLength(0);
		expect(container.querySelectorAll("img")).toHaveLength(0);
		expect(onAttributes(container)).toEqual([]);
		expect(unsafeAnchors(container)).toEqual([]);
		expect((window as unknown as { __pwned?: boolean }).__pwned).toBeUndefined();
		// Markdown images are text links, never requests.
		expect(container.textContent).toContain("[image: beacon image]");
		// The benign links survive.
		const runbook = container.querySelector('a[href="https://runbooks.acme.internal/clusterright/hand"]');
		expect(runbook).not.toBeNull();
		expect(runbook).toHaveAttribute("target", "_blank");
		expect(runbook).toHaveAttribute("rel", "noopener noreferrer");
		expect(runbook?.className).toContain("text-primary");
		expect(container.querySelector('a[href="mailto:oncall@acme.internal"]')).not.toBeNull();
	});

	test("blocked links are downgraded to spans", () => {
		const { container } = renderMarkdown(
			<SafeMarkdown
				text={[
					"[js](javascript:alert(1))",
					"[case](JaVaScRiPt:alert(2))",
					"[space]( javascript:alert(3))",
					"[entity](jav&#x61;script:alert(4))",
					"[decimal](jav&#97;script:alert(5))",
					"[data](data:text/html,<script>alert(6)</script>)",
					"[file](file:///etc/passwd)",
					"[vb](vbscript:msgbox(7))",
					"[good](https://example.com/ok)",
					"[mail](mailto:a@example.com)",
				].join("\n\n")}
			/>,
		);
		expect(unsafeAnchors(container)).toEqual([]);
		const hrefs = Array.from(container.querySelectorAll("a[href]")).map((a) => a.getAttribute("href"));
		expect(hrefs.sort()).toEqual(["https://example.com/ok", "mailto:a@example.com"]);
		expect(container.querySelectorAll('[data-link="blocked"]').length).toBeGreaterThanOrEqual(8);
	});

	test("raw HTML anchors and event handlers never reach the DOM", () => {
		const { container } = renderMarkdown(
			<SafeMarkdown
				text={
					'<a href="javascript:alert(1)">x</a>\n\n<img src=x onerror="alert(1)">\n\n<div onclick="alert(1)">y</div>'
				}
			/>,
		);
		expect(container.querySelectorAll("a")).toHaveLength(0);
		expect(container.querySelectorAll("img")).toHaveLength(0);
		expect(container.querySelectorAll("script")).toHaveLength(0);
		expect(onAttributes(container)).toEqual([]);
	});

	test("image URLs are never loaded", () => {
		const { container } = renderMarkdown(
			<SafeMarkdown text={"![tracking pixel](https://tracker.example/pixel.png)\n\n![bad](javascript:alert(1))"} />,
		);
		expect(container.querySelectorAll("img")).toHaveLength(0);
		expect(container.querySelector('a[href="https://tracker.example/pixel.png"]')).not.toBeNull();
		expect(container.textContent).toContain("[image: tracking pixel]");
		expect(container.textContent).toContain("[image: bad]");
	});
});

describe("SafeMarkdown correctness", () => {
	test("late reference definitions resolve", () => {
		const text =
			"See [the runbook][rb] and [another][x].\n\n[rb]: https://example.com/rb\n[x]: https://example.com/x\n";
		const { container } = renderMarkdown(<SafeMarkdown text={text} />);
		expect(container.querySelector('a[href="https://example.com/rb"]')).not.toBeNull();
		expect(container.querySelector('a[href="https://example.com/x"]')).not.toBeNull();
	});

	test("a footnote resolves before its definition and renders one section at the end", () => {
		const text = "First[^a] reference.\n\nMiddle paragraph.\n\n[^a]: The note body.\n";
		const { container } = renderMarkdown(<SafeMarkdown text={text} />);
		const reference = container.querySelector<HTMLAnchorElement>("a[data-footnote-ref]");
		expect(reference).not.toBeNull();
		expect(reference?.textContent).toBe("1");
		const referenceId = reference?.id ?? "";
		expect(referenceId).toMatch(/^md-[a-z0-9-]+-fnref-a$/);
		expect(reference?.getAttribute("href")).toBe(`#${referenceId.replace("fnref-", "fn-")}`);

		const section = container.querySelector("[data-footnotes]");
		expect(section).not.toBeNull();
		expect(section?.querySelector("li")?.id).toBe(referenceId.replace("fnref-", "fn-"));
		expect(normalise(section?.textContent)).toContain("The note body");
		// The definition block is not also rendered where it stood.
		expect(container.textContent?.match(/The note body/g)).toHaveLength(1);
		// One section, after the whole message.
		expect(container.querySelectorAll("[data-footnotes]")).toHaveLength(1);
		expect(container.querySelector(".md-body")?.lastElementChild).toBe(section);
		const backLink = section?.querySelector("a[data-footnote-backref]");
		expect(backLink?.getAttribute("href")).toBe(`#${referenceId}`);
	});

	test("a footnote definition in the middle leaves the following text in place", () => {
		const text = "Use[^x] here.\n\n[^x]: middle note\n\nAfter the definition.\n";
		const { container } = renderMarkdown(<SafeMarkdown text={text} />);
		expect(container.querySelector("a[data-footnote-ref]")).not.toBeNull();
		expect(normalise(container.textContent)).toContain("After the definition.");
		expect(normalise(container.textContent)).toContain("middle note");
		expect(container.querySelectorAll("[data-footnotes]")).toHaveLength(1);
		expect(container.textContent?.match(/middle note/g)).toHaveLength(1);
	});

	test("two messages on one page never share footnote ids", () => {
		const { container } = renderMarkdown(
			<div>
				<SafeMarkdown text={"One[^1].\n\n[^1]: first note\n"} />
				<SafeMarkdown text={"Two[^1].\n\n[^1]: second note\n"} />
			</div>,
		);
		const references = Array.from(container.querySelectorAll<HTMLAnchorElement>("a[data-footnote-ref]"));
		expect(references).toHaveLength(2);
		expect(references[0]?.id).not.toBe(references[1]?.id);
		expect(references[0]?.getAttribute("href")).not.toBe(references[1]?.getAttribute("href"));
		const items = Array.from(container.querySelectorAll("[data-footnotes] li")).map((item) => item.id);
		expect(items).toHaveLength(2);
		expect(items[0]).not.toBe(items[1]);
		expect(references[0]?.getAttribute("href")).toBe(`#${items[0]}`);
	});

	test("footnote numbers, ids and descriptions are message-wide (the reported reproduction)", async () => {
		const text =
			"First[^a].\n\nSecond[^b] and again[^a].\n\n[^a]: Note A\n[^b]: Note B\n\nUse \\[x^2\\] and \\(y\\). Cost $5 and $10. See \\[link\\] text.";
		const { container } = renderMarkdown(<SafeMarkdown text={text} />);

		// The numbers follow the order of first reference across the message, not per block.
		const references = Array.from(container.querySelectorAll<HTMLAnchorElement>("a[data-footnote-ref]"));
		expect(references.map((reference) => reference.textContent)).toEqual(["1", "2", "1"]);

		const section = container.querySelector("[data-footnotes]");
		expect(section).not.toBeNull();
		const items = Array.from(section?.querySelectorAll("li") ?? []);
		expect(items.map((item) => normalise(item.querySelector("p")?.textContent))).toEqual(["Note A ↩", "Note B ↩"]);
		expect(references[0]?.getAttribute("href")).toBe(`#${items[0]?.id}`);
		expect(references[1]?.getAttribute("href")).toBe(`#${items[1]?.id}`);
		expect(references[2]?.getAttribute("href")).toBe(`#${items[0]?.id}`);

		// Only the first reference of a label keeps the id; a repeated one in another block drops it.
		expect(references[0]?.hasAttribute("id")).toBe(true);
		expect(references[2]?.hasAttribute("id")).toBe(false);
		const ids = Array.from(container.querySelectorAll("[id]")).map((element) => element.id);
		expect(new Set(ids).size).toBe(ids.length);

		// Every reference points at the one footnotes heading, which exists.
		const label = section?.querySelector("h2")?.id ?? "";
		expect(label).toMatch(/^md-[a-z0-9-]+-footnote-label$/);
		for (const reference of references) {
			expect(reference.getAttribute("aria-describedby")).toBe(label);
		}
		expect(document.getElementById(label)).not.toBeNull();

		// The back-link closes the note's last line instead of sitting on a line below it.
		expect(items[0]?.querySelector("p a[data-footnote-backref]")).not.toBeNull();
		expect(normalise(items[0]?.textContent)).toBe("Note A ↩");

		// Mid-line escaped brackets are literal text; `\(…\)` is still inline math.
		expect(normalise(container.textContent)).toContain("Use [x^2] and");
		expect(normalise(container.textContent)).toContain("See [link] text.");
		expect(normalise(container.textContent)).toContain("Cost $5 and $10.");
		await waitFor(() => expect(container.querySelector('[data-testid="math"]')).not.toBeNull());
	});

	test("uppercase footnote labels share their case-folded anchor", () => {
		const { container } = renderMarkdown(<SafeMarkdown text={"One[^Note].\n\n[^NOTE]: Body\n"} />);
		const reference = container.querySelector<HTMLAnchorElement>("a[data-footnote-ref]");
		const item = container.querySelector("[data-footnotes] li");
		expect(reference?.textContent).toBe("1");
		expect(item?.id).toMatch(/-fn-note$/);
		expect(reference?.id).toMatch(/-fnref-note$/);
		expect(reference?.getAttribute("href")).toBe(`#${item?.id}`);
	});

	test("non-ASCII footnote labels are encoded identically in the reference and the section", () => {
		const { container } = renderMarkdown(<SafeMarkdown text={"说明[^注释].\n\n[^注释]: 这是注释\n"} />);
		const reference = container.querySelector<HTMLAnchorElement>("a[data-footnote-ref]");
		const item = container.querySelector("[data-footnotes] li");
		// The encoding `mdast-util-to-hast` uses for the label `注释`.
		const encoded = "%E6%B3%A8%E9%87%8A";
		expect(reference?.textContent).toBe("1");
		expect(item?.id).toMatch(new RegExp(`-fn-${encoded}$`));
		expect(reference?.id).toMatch(new RegExp(`-fnref-${encoded}$`));
		expect(reference?.getAttribute("href")).toBe(`#${item?.id}`);
		expect(normalise(item?.textContent)).toContain("这是注释");
		expect(document.getElementById(reference?.getAttribute("aria-describedby") ?? "")).not.toBeNull();
	});

	test("the footnote back-link is inline at the end of the note's last paragraph", () => {
		const { container } = renderMarkdown(<SafeMarkdown text={"A[^1].\n\n[^1]: First line\n    second line\n"} />);
		const paragraph = container.querySelector("[data-footnotes] li p");
		expect(normalise(paragraph?.textContent)).toBe("First line second line ↩");
		expect(paragraph?.lastElementChild?.tagName).toBe("A");
		expect(paragraph?.lastElementChild).toHaveAttribute("data-footnote-backref");
	});

	test("streaming a footnote arrives at the reference once its definition appears", () => {
		const store = new StreamingTextStore();
		const view = renderMarkdown(<StreamingMarkdown store={store} />);
		act(() => {
			store.setText("Ref[^1]");
			store.flush();
		});
		expect(view.container.querySelector("a[data-footnote-ref]")).toBeNull();
		expect(view.container.textContent).toContain("[^1]");
		act(() => {
			store.setText("Ref[^1]\n\n[^1]: the streamed note\n");
			store.flush();
		});
		expect(view.container.querySelector("a[data-footnote-ref]")).not.toBeNull();
		expect(normalise(view.container.querySelector("[data-footnotes]")?.textContent)).toContain("the streamed note");
		act(() => store.finish());
	});

	test("inline math renders as MathML and keeps single dollars as text", async () => {
		const { container } = renderMarkdown(<SafeMarkdown text={"Euler: \\(e^{i\\pi} + 1 = 0\\) and $5 and $10."} />);
		expect(container.textContent).toContain("$5 and $10");
		await waitFor(() => expect(container.querySelector('[data-testid="math"]')).not.toBeNull());
		expect(container.querySelector("math")).not.toBeNull();
		expect(container.textContent).not.toContain("\\(");
	});

	test("display math with blank lines stays one block and scrolls in place", async () => {
		const { container } = renderMarkdown(<SafeMarkdown text={"$$\nx + y\n\nz = 1\n$$"} />);
		await waitFor(() => expect(container.querySelector("math")).not.toBeNull());
		const display = container.querySelector<HTMLElement>('[data-testid="math"]');
		expect(display?.className).toContain("math-display");
		expect(display?.className).toContain("overflow-x-auto");
		expect(container.querySelectorAll("math")).toHaveLength(1);
	});

	test("TeX-style display delimiters become display math", async () => {
		const { container } = renderMarkdown(<SafeMarkdown text={"Before\n\n\\[\na = b\n\\]\n\nAfter"} />);
		await waitFor(() => expect(container.querySelector("math")).not.toBeNull());
		expect(container.querySelector('[data-testid="math"]')?.className).toContain("math-display");
		expect(container.textContent).toContain("After");
	});

	test("a line-own \\[x\\] becomes display math", async () => {
		const { container } = renderMarkdown(<SafeMarkdown text={"Before\n\n\\[x\\]\n\nAfter"} />);
		await waitFor(() => expect(container.querySelector('[data-testid="math"]')).not.toBeNull());
		expect(container.querySelector('[data-testid="math"]')?.className).toContain("math-display");
		expect(container.textContent).not.toContain("\\[");
		expect(container.textContent).toContain("After");
	});

	test("an indented line-own formula stays one display block", async () => {
		const { container } = renderMarkdown(<SafeMarkdown text={"Before\n\n  \\[x\\]\n\nAfter"} />);
		await waitFor(() => expect(container.querySelector('[data-testid="math"]')).not.toBeNull());
		expect(container.querySelectorAll('[data-testid="math"]')).toHaveLength(1);
		expect(container.textContent).not.toContain("\\[");
	});

	test("mid-line \\[...\\] stays literal text instead of breaking the paragraph", () => {
		const { container } = renderMarkdown(<SafeMarkdown text={"See \\[link\\] text and \\[x^2\\] too."} />);
		expect(normalise(container.textContent)).toBe("See [link] text and [x^2] too.");
		expect(container.querySelector('[data-testid="math"]')).toBeNull();
		expect(container.querySelector('[data-testid="math-source"]')).toBeNull();
	});

	test("a finished message with a stray $$ opener renders the following paragraphs", () => {
		const text = "Before.\n\n$$\nnot closed\n\nAfter **bold**.\n";
		const { container } = renderMarkdown(<SafeMarkdown text={text} />);
		expect(container.querySelector('[data-testid="unclosed-math"]')).toBeNull();
		expect(normalise(container.textContent)).toContain("Before.");
		expect(container.querySelector("strong")?.textContent).toBe("bold");
		expect(normalise(container.textContent)).toContain("After bold.");
	});

	test("streaming an open $$ shows source only in the last block", () => {
		const store = new StreamingTextStore();
		const view = renderMarkdown(<StreamingMarkdown store={store} />);
		act(() => {
			store.setText("Earlier paragraph.\n\n$$\nx + y");
			store.flush();
		});
		expect(view.container.querySelectorAll('[data-testid="unclosed-math"]')).toHaveLength(1);
		const source = view.container.querySelector('[data-testid="unclosed-math"]');
		expect(source).toHaveAttribute("data-slot", "code-frame");
		expect(normalise(source?.textContent)).toContain("$$ x + y");
		expect(view.container.querySelector("p")?.textContent).toBe("Earlier paragraph.");
		act(() => store.finish());
		// Once the message is finished there is no stream in flight, so nothing is shown as source.
		expect(view.container.querySelector('[data-testid="unclosed-math"]')).toBeNull();
	});

	test("invalid TeX shows its source instead of a broken formula", async () => {
		const { container } = renderMarkdown(<SafeMarkdown text={"$$\n{\n$$"} />);
		await waitFor(() => expect(container.querySelector('[data-testid="math-source"]')).not.toBeNull());
		expect(container.querySelector('[data-testid="math-source"]')?.textContent).toContain("{");
		expect(container.querySelector("math")).toBeNull();
	});

	test("math delimiters inside code spans are untouched", () => {
		const { container } = renderMarkdown(<SafeMarkdown text={"`\\(x\\)` and `\\[y\\]`"} />);
		expect(container.querySelectorAll("code")).toHaveLength(2);
		expect(container.textContent).toContain("\\(x\\)");
		expect(container.querySelector("math")).toBeNull();
	});

	test("an incomplete display formula mid-stream stays text and does not throw", async () => {
		const store = new StreamingTextStore();
		const view = renderMarkdown(<StreamingMarkdown store={store} />);
		act(() => {
			store.setText("Math:\n\n$$\nx + y");
			store.flush();
		});
		expect(view.container.textContent).toContain("$$");
		act(() => {
			store.setText("Math:\n\n$$\nx + y\n$$");
			store.flush();
		});
		await waitFor(() => expect(view.container.querySelector("math")).not.toBeNull());
		act(() => store.finish());
	});

	test("a URL whose query contains &amp; is kept as written after one decode", () => {
		const { container } = renderMarkdown(<SafeMarkdown text={"[search](https://example.com/?q=1&amp;amp;b=2)"} />);
		// The markdown parser decodes `&amp;amp;` once; the transform must not turn
		// the resulting literal `&amp;` text into `&`.
		expect(container.querySelector('a[href="https://example.com/?q=1&amp;b=2"]')).not.toBeNull();
	});

	test("streaming a small document chunk by chunk matches the one-shot render", () => {
		const oneShot = renderMarkdown(<SafeMarkdown text={edgeCases} />);
		const expected = normalise(oneShot.container.textContent);
		oneShot.unmount();

		const store = new StreamingTextStore();
		const streamed = renderMarkdown(<StreamingMarkdown store={store} />);
		act(() => {
			for (let i = 40; i < edgeCases.length; i += 40) store.setText(edgeCases.slice(0, i));
			store.setText(edgeCases);
			store.finish();
		});
		expect(normalise(streamed.container.textContent)).toBe(expected);
	});

	test("an unterminated fence mid-stream renders as code", () => {
		const text = "Intro paragraph.\n\n```bash\nkubectl get pods -n prod\n";
		const { container } = renderMarkdown(<SafeMarkdown text={text} streaming />);
		const block = container.querySelector('[data-testid="shiki-code-block"]');
		expect(block).not.toBeNull();
		expect(block?.getAttribute("data-lang")).toBe("bash");
		expect(block?.textContent).toContain("kubectl get pods -n prod");
		const header = block?.querySelector('[data-slot="code-frame-header"]');
		expect(header).toHaveTextContent("bash");
		expect(header).not.toHaveTextContent(/\d+ lines?/);
		// The fence itself is not rendered as literal text.
		expect(container.textContent).not.toContain("```");
	});

	test("a streamed message keeps its rendered blocks when it is committed", () => {
		const text = doc20k;
		const oneShot = renderMarkdown(<SafeMarkdown text={text} />);
		const expected = normalise(oneShot.container.textContent);
		oneShot.unmount();

		const store = new StreamingTextStore();
		const view = renderMarkdown(<StreamingMarkdown store={store} />);
		act(() => {
			for (let i = 400; i < text.length; i += 400) store.setText(text.slice(0, i));
			store.flush();
		});
		const firstBlock = view.container.querySelector("h2, h1");
		expect(firstBlock, "the streamed document renders its first heading").not.toBeNull();

		// Completion: the store ends and the row passes the committed text. The
		// same component instance must keep its block tree (only the last block
		// re-renders), so the first block's DOM node survives.
		act(() => {
			store.finish();
			view.rerender(withI18n(<StreamingMarkdown store={store} text={text} />));
		});
		expect(normalise(view.container.textContent)).toBe(expected);
		expect(view.container.querySelector("h2, h1")).toBe(firstBlock);
	});

	const fixtures: [string, string][] = [
		["20K", doc20k],
		["50K", doc50k],
	];

	for (const [name, text] of fixtures) {
		test(`streamed final DOM equals a one-shot render for the ${name} fixture (chunks 1 / 8 / 40)`, () => {
			const oneShot = renderMarkdown(<SafeMarkdown text={text} />);
			const expected = normalise(oneShot.container.textContent);
			oneShot.unmount();

			for (const chunkSize of [1, 8, 40]) {
				const store = new StreamingTextStore();
				const streamed = renderMarkdown(<StreamingMarkdown store={store} />);
				act(() => {
					for (let i = chunkSize; i < text.length; i += chunkSize) store.setText(text.slice(0, i));
					store.setText(text);
					store.finish();
				});
				expect(normalise(streamed.container.textContent), `chunk ${chunkSize}`).toBe(expected);
				streamed.unmount();
			}
		}, 120_000);
	}

	test("streamed final DOM equals a one-shot render for the footnotes-math fixture (chunks 1 / 2 / 3 / 8 / 40)", async () => {
		// Every chunk is flushed, not just accumulated: a boundary can fall between the two `$` of a
		// `$$` pair, inside `\(`/`\[`, or in the middle of a footnote definition, and the splitter must
		// still arrive at the one-shot blocks once the message finishes.
		const oneShot = renderMarkdown(<SafeMarkdown text={footnotesMath} />);
		// Temml is a dynamic import. The fixture has exactly one invalid formula (`$${$$`), which keeps
		// showing its source; waiting for every other formula to render makes the expected DOM stable.
		await waitFor(
			() => {
				expect(formulaElements(oneShot.container).length).toBeGreaterThan(0);
				expect(mathFallbacks(oneShot.container)).toHaveLength(1);
			},
			{ timeout: 10_000 },
		);
		const expected = normalise(oneShot.container.textContent);
		const expectedMath = formulaElements(oneShot.container).length;
		const expectedNumbers = footnoteNumbers(oneShot.container);
		expect(expectedNumbers).not.toHaveLength(0);
		oneShot.unmount();

		for (const chunkSize of [1, 2, 3, 8, 40]) {
			const store = new StreamingTextStore();
			const streamed = renderMarkdown(<StreamingMarkdown store={store} />);
			for (let i = chunkSize; i < footnotesMath.length; i += chunkSize) {
				// One `act` per chunk: the store batches to an animation frame, so accumulating every
				// chunk inside one `act` would only ever render the final text and never the boundary.
				act(() => {
					store.setText(footnotesMath.slice(0, i));
					store.flush();
				});
			}
			act(() => {
				store.setText(footnotesMath);
				store.finish();
			});
			await waitFor(
				() => {
					expect(formulaElements(streamed.container).length, `chunk ${chunkSize}`).toBe(expectedMath);
					expect(mathFallbacks(streamed.container), `chunk ${chunkSize}`).toHaveLength(1);
				},
				{ timeout: 10_000 },
			);
			// The stray `$$` opener is only source while the stream is in flight.
			expect(streamed.container.querySelector('[data-testid="unclosed-math"]'), `chunk ${chunkSize}`).toBeNull();
			expect(normalise(streamed.container.textContent), `chunk ${chunkSize}`).toBe(expected);
			expect(footnoteNumbers(streamed.container), `chunk ${chunkSize}`).toEqual(expectedNumbers);
			const ids = Array.from(streamed.container.querySelectorAll("[id]")).map((element) => element.id);
			expect(new Set(ids).size, `chunk ${chunkSize}`).toBe(ids.length);
			streamed.unmount();
		}
	}, 180_000);
});

describe("streaming store", () => {
	test("batches updates until a flush and publishes once", () => {
		const store = new StreamingTextStore();
		let notifications = 0;
		const unsubscribe = store.subscribe(() => {
			notifications += 1;
		});
		store.setText("a");
		store.setText("ab");
		store.setText("abc");
		expect(store.getSnapshot()).toBe("");
		store.flush();
		expect(store.getSnapshot()).toBe("abc");
		expect(notifications).toBe(1);
		store.finish();
		expect(store.isDone()).toBe(true);
		unsubscribe();
	});

	test("append extends the pending text", () => {
		const store = new StreamingTextStore();
		store.append("a");
		store.append("b");
		store.flush();
		expect(store.getSnapshot()).toBe("ab");
		store.dispose();
	});
});
