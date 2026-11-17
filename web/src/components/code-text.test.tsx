import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test } from "vitest";
import { renderWithI18n } from "@/test/render";
import { CodeText } from "./code-text";

function headerOf(element: HTMLElement): HTMLElement {
	const header = element.querySelector<HTMLElement>('[data-slot="code-frame-header"]');
	if (header === null) throw new Error("missing code frame header");
	return header;
}

function footerOf(element: HTMLElement): HTMLElement {
	const footer = element.querySelector<HTMLElement>('[data-slot="code-frame-footer"]');
	if (footer === null) throw new Error("missing code frame footer");
	return footer;
}

describe("CodeText", () => {
	test("puts the label and copy action in the frame header", async () => {
		await renderWithI18n(<CodeText text={"one\ntwo"} label="Command output" />);
		const block = screen.getByLabelText("Command output");
		const header = headerOf(block);
		expect(header).toHaveTextContent("Command output");
		expect(header).toHaveClass("bg-muted");
		expect(within(header).getByRole("button", { name: "Copy Command output" })).toBeInTheDocument();
		expect(block).toHaveTextContent("one");
		// No header line count, collapsed or not.
		expect(header).not.toHaveTextContent(/\d+ lines?/);
	});

	test("collapses after maxLines and keeps the cut notice in the footer", async () => {
		const text = "one\ntwo\nthree\nfour";
		const user = userEvent.setup();
		await renderWithI18n(<CodeText text={text} maxLines={2} label="Output" />);
		const block = screen.getByLabelText("Output");
		expect(block).toHaveTextContent("one");
		expect(block).toHaveTextContent("two");
		expect(block).not.toHaveTextContent("three");
		expect(footerOf(block)).toHaveTextContent("Showing first 2 of 4 lines");

		await user.click(within(block).getByRole("button", { name: "Show all" }));
		expect(block).toHaveTextContent("three");
		expect(block).toHaveTextContent("four");
		const footer = footerOf(block);
		expect(footer).toHaveTextContent("Show less");
		expect(footer).not.toHaveTextContent("lines");
		expect(footer).not.toHaveTextContent("Showing first");
	});

	test("shows no footer when collapsing is disabled", async () => {
		await renderWithI18n(<CodeText text={"one\ntwo\nthree"} maxLines={0} label="Output" />);
		expect(screen.getByLabelText("Output").querySelector('[data-slot="code-frame-footer"]')).toBeNull();
	});

	test("copy={false} renders no copy action and no empty header", async () => {
		const { container } = await renderWithI18n(<CodeText text="one" maxLines={0} copy={false} />);
		const block = container.querySelector('[data-slot="code-frame"]');
		expect(block).not.toBeNull();
		expect(within(block as HTMLElement).queryByRole("button")).not.toBeInTheDocument();
		expect(block?.querySelector('[data-slot="code-frame-header"]')).toBeNull();
	});

	test("preClassName still controls the pre and the scroll height, e.g. a dialog that owns the scroll", async () => {
		await renderWithI18n(<CodeText text={"one\ntwo"} preClassName="max-h-none whitespace-pre" label="JSON" />);
		const block = screen.getByLabelText("JSON");
		expect(block.querySelector('[data-slot="code-frame-body"]')).toHaveClass("max-h-none");
		expect(block.querySelector("pre")).toHaveClass("max-h-none", "whitespace-pre");
	});
});
