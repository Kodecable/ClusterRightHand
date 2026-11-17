import { render, screen, within } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { CodeFrame } from "./code-frame";

function slot(container: HTMLElement, name: string): HTMLElement {
	const element = container.querySelector<HTMLElement>(`[data-slot="code-frame-${name}"]`);
	if (element === null) throw new Error(`missing code-frame-${name}`);
	return element;
}

describe("CodeFrame", () => {
	test("renders the header title, optional meta and actions around the body", async () => {
		const { container } = render(
			<CodeFrame title="Standard output" meta="12 bytes" actions={<button type="button">Copy</button>}>
				<pre>hello</pre>
			</CodeFrame>,
		);
		const frame = container.querySelector('[data-slot="code-frame"]');
		await expect(frame).toHaveClass("rounded-lg", "border");
		const header = slot(container, "header");
		expect(header).toHaveTextContent("Standard output · 12 bytes");
		expect(within(header).getByRole("button", { name: "Copy" })).toBeInTheDocument();
		expect(header).toHaveClass("bg-muted");
		expect(slot(container, "body")).toHaveTextContent("hello");
		expect(container.querySelector('[data-slot="code-frame-footer"]')).toBeNull();
	});

	test("a body stays transparent and takes its scroll height from bodyClassName", async () => {
		const { container } = render(
			<CodeFrame bodyClassName="max-h-40 overflow-auto">
				<pre>body</pre>
			</CodeFrame>,
		);
		const body = slot(container, "body");
		expect(body).toHaveClass("max-h-40", "overflow-auto");
		expect(body.className).not.toContain("bg-");
		// No header or footer is rendered without a title/meta/actions/footer.
		expect(container.querySelector('[data-slot="code-frame-header"]')).toBeNull();
	});

	test("renders a solid muted footer when given one", async () => {
		const { container } = render(
			<CodeFrame footer={<span>Showing first 2 of 3 lines</span>}>
				<pre>body</pre>
			</CodeFrame>,
		);
		const footer = slot(container, "footer");
		expect(footer).toHaveTextContent("Showing first 2 of 3 lines");
		expect(footer).toHaveClass("bg-muted");
	});

	test("keeps its accessible name and data attributes on the frame", async () => {
		render(
			<CodeFrame aria-label="Command output" data-testid="frame" data-lang="bash">
				<pre>ls</pre>
			</CodeFrame>,
		);
		const frame = screen.getByTestId("frame");
		await expect(frame).toHaveAccessibleName("Command output");
		await expect(frame).toHaveAttribute("data-lang", "bash");
	});
});
