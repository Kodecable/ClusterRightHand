import { describe, expect, test } from "vitest";
import { renderWithI18n } from "@/test/render";
import { PageHeader } from "./page-header";

const COMMAND = `rm -f /tmp/${"a".repeat(120)}; ls -la /var/log/${"b".repeat(120)}`;

function heading(container: HTMLElement): HTMLElement {
	const element = container.querySelector("h1");
	if (element === null) throw new Error("no page title");
	return element;
}

describe("PageHeader", () => {
	test("a long title wraps, clamps to two lines and keeps the full text in the tooltip", () => {
		const { container } = renderWithI18n(<PageHeader title={COMMAND} />);
		const title = heading(container);
		expect(title).toHaveClass("line-clamp-2", "break-words", "[overflow-wrap:anywhere]");
		expect(title).not.toHaveClass("truncate");
		expect(title).toHaveAttribute("title", COMMAND);
	});

	test("a rendered title takes its plain text for the tooltip", () => {
		const { container } = renderWithI18n(
			<PageHeader title={<span className="font-mono">{COMMAND}</span>} titleText={COMMAND} />,
		);
		const title = heading(container);
		expect(title).toHaveAttribute("title", COMMAND);
		expect(title.querySelector(".font-mono")).toHaveTextContent(COMMAND);
	});
});
