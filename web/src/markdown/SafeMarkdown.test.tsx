import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act, render } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { activateLocale } from "@/test/render";
import doc20k from "./__fixtures__/doc-20k.md?raw";
import doc50k from "./__fixtures__/doc-50k.md?raw";
import edgeCases from "./__fixtures__/edge-cases.md?raw";
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
		expect(container.querySelector('a[href="https://runbooks.acme.internal/clusterright/hand"]')).not.toBeNull();
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
