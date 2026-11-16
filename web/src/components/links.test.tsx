import { screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { renderWithI18n, renderWithRouter } from "@/test/render";
import { ExternalLink } from "./external-link";
import { InternalLink } from "./internal-link";

describe("InternalLink", () => {
	test("renders a validated internal path with the shared link style", async () => {
		await renderWithRouter(<InternalLink href="/tasks/t1">Task</InternalLink>);
		const link = screen.getByRole("link", { name: "Task" });
		expect(link).toHaveAttribute("href", "/tasks/t1");
		expect(link.className).toContain("underline");
		expect(link.className).toContain("decoration-foreground/30");
		expect(link.className).toContain("hover:decoration-foreground");
		expect(link.className).not.toContain("hover:decoration-2");
	});

	test("renders a typed route through the router", async () => {
		await renderWithRouter(
			<InternalLink to="/users/$userId" params={{ userId: "u1" }}>
				Alice
			</InternalLink>,
		);
		expect(await screen.findByRole("link", { name: "Alice" })).toHaveAttribute("href", "/users/u1");
	});

	test("renders nothing when the validated path is absent", async () => {
		await renderWithRouter(<InternalLink href={undefined}>Hidden</InternalLink>);
		expect(screen.queryByRole("link")).not.toBeInTheDocument();
	});
});

describe("ExternalLink", () => {
	test("opens in a new tab without an opener and marks the external text with an arrow", () => {
		const { container } = renderWithI18n(<ExternalLink href="https://example.com/docs">Docs</ExternalLink>);
		const link = screen.getByRole("link", { name: "Docs" });
		expect(link).toHaveAttribute("href", "https://example.com/docs");
		expect(link).toHaveAttribute("target", "_blank");
		expect(link).toHaveAttribute("rel", "noopener noreferrer");
		expect(link.className).toContain("text-primary");
		expect(link.className).toContain("decoration-primary/30");
		expect(link.className).toContain("hover:decoration-primary");
		expect(container.querySelector("svg")).not.toBeNull();
	});
});
