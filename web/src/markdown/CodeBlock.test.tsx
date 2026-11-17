import { screen, within } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { renderWithI18n } from "@/test/render";
import { CodeBlock } from "./CodeBlock";

describe("CodeBlock", () => {
	test("renders the language and copy action in the shared frame header, never a line count", async () => {
		await renderWithI18n(<CodeBlock code={"echo one\necho two\necho three"} lang="bash" />);
		const block = screen.getByTestId("shiki-code-block");
		const header = block.querySelector<HTMLElement>('[data-slot="code-frame-header"]');
		expect(header).not.toBeNull();
		expect(header).toHaveTextContent("bash");
		expect(header).not.toHaveTextContent(/\d+ lines?/);
		expect(within(header as HTMLElement).getByRole("button", { name: "Copy code" })).toBeInTheDocument();
		expect(block).toHaveAttribute("data-lang", "bash");
		expect(block).toHaveAttribute("data-lines", "3");
		expect(block).toHaveTextContent("echo one");
	});

	test("an unknown language still shows its name without tokenized lines", async () => {
		await renderWithI18n(<CodeBlock code="plain text" lang="nosuchlang" />);
		const block = screen.getByTestId("shiki-code-block");
		expect(block.querySelector('[data-slot="code-frame-title"]')).toHaveTextContent("nosuchlang");
		expect(block).toHaveAttribute("data-plain", "true");
		expect(block).not.toHaveTextContent(/\d+ lines?/);
	});

	test("a block without a language is titled text", async () => {
		await renderWithI18n(<CodeBlock code="just one line" />);
		const block = screen.getByTestId("shiki-code-block");
		expect(block.querySelector('[data-slot="code-frame-title"]')).toHaveTextContent("text");
		expect(block).not.toHaveTextContent(/\d+ lines?/);
	});
});
