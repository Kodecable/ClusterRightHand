import type { ApprovalRequest, QuotaApproval } from "@crh/api";
import { i18n } from "@lingui/core";
import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, test } from "vitest";
import { activateLocale, renderWithRouter } from "@/test/render";
import { quotaCardContent, requestCardContent } from "./content";

const request = (overrides: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
	kind: "task",
	id: "task-1",
	phase: "awaiting_user",
	requester: { type: "session", sessionId: "root-1", title: "Clean up" },
	action: { type: "exec", command: "systemctl restart nginx" },
	nodes: ["worker-01"],
	privileged: false,
	alwaysAllow: [],
	...overrides,
});

const content = (overrides: Partial<ApprovalRequest> = {}, variant: "inline" | "page" = "inline") =>
	requestCardContent(request(overrides), { variant, i18n });

beforeEach(() => {
	activateLocale("en");
});

describe("requestCardContent", () => {
	test("renders an exec command on the detail line and no risk without a settled review", () => {
		const card = content();
		expect(card.title).toBe("Your approval is needed");
		expect(card.detail).toBe("systemctl restart nginx");
		expect(card.metaText).toBe("Nodes: worker-01");
		expect(card.risk).toBeUndefined();
		expect(card.reason).toBeUndefined();
	});

	test("renders a file operation with its path and line range", () => {
		const card = content({
			action: { type: "file", operation: "read", path: "/etc/hosts", lines: { start: 5, end: 7 } },
		});
		expect(card.detail).toBe("Read file /etc/hosts (lines 5-7)");
	});

	test("renders an API request by method and path, and an extension tool as extension/tool", () => {
		expect(content({ action: { type: "api_request", method: "POST", path: "/api/sessions" } }).detail).toBe(
			"POST /api/sessions",
		);
		expect(content({ action: { type: "extension_tool", extension: "github", tool: "create_issue" } }).detail).toBe(
			"github/create_issue",
		);
	});

	test("keeps the privileged flag on the title, and the capped node list with its remainder", () => {
		const card = content({ privileged: true, nodes: ["worker-01", "db-1"], moreNodes: 3 });
		expect(card.privileged).toBe(true);
		expect(card.metaText).toBe("Nodes: worker-01, db-1 and 3 more");
	});

	test("takes the risk and reason from a settled review", () => {
		const card = content({ review: { risk: "high", reason: "sends a credential\nover the network" } });
		expect(card.risk).toBe("high");
		expect(card.reason).toBe("sends a credential over the network");
	});

	test("a signature phase uses the signature title", () => {
		expect(content({ phase: "awaiting_signature" }).title).toBe("Your signature is needed");
	});

	test("an inline card never shows the requester", () => {
		const card = content();
		expect(card.metaText).not.toContain("From session");
		expect(card.metaText).toBe("Nodes: worker-01");
	});

	test("a page card appends the requester to the meta line and links a session title", async () => {
		const card = content({}, "page");
		expect(card.metaText).toBe("Nodes: worker-01 · From session “Clean up”");
		await renderWithRouter(
			<p data-testid="decision-meta" title={card.metaText}>
				{card.meta}
			</p>,
		);
		const link = screen.getByRole("link", { name: "Clean up" });
		expect(link).toHaveAttribute("href", "/sessions/root-1");
		expect(screen.getByTestId("decision-meta")).toHaveAttribute("title", "Nodes: worker-01 · From session “Clean up”");
	});

	test("a page card names an API token or a user requester, and the untitled session", async () => {
		const token = content({ requester: { type: "api_token", tokenId: "t1", name: "deploy" } }, "page");
		expect(token.metaText).toContain("From API token “deploy”");
		const user = content({ requester: { type: "user", userId: "u1", username: "alice" } }, "page");
		expect(user.metaText).toContain("From user alice");
		const untitled = content({ requester: { type: "session", sessionId: "root-1", title: "" } }, "page");
		expect(untitled.metaText).toContain("From session “New Session”");
		await renderWithRouter(<div>{untitled.meta}</div>);
		expect(screen.getByRole("link", { name: "New Session" })).toHaveAttribute("href", "/sessions/root-1");
	});

	test("a page card with no nodes still shows the requester", () => {
		const card = content({ nodes: undefined }, "page");
		expect(card.metaText).toBe("From session “Clean up”");
	});
});

describe("quotaCardContent", () => {
	const wait: QuotaApproval = {
		sessionId: "s1",
		levelId: "lvl-root",
		title: "Nightly cluster check",
		since: "2026-01-01T00:00:00.000Z",
		budgetRemaining: -300,
		budgetUsedTokens: 12_000,
	};

	test("uses the session title and the budget as meta and detail, with no risk", () => {
		const card = quotaCardContent(wait, i18n);
		expect(card.title).toBe("Token quota used up");
		expect(card.meta).toBe("Nightly cluster check");
		expect(card.metaText).toBe("Nightly cluster check");
		expect(card.detail).toBe("used 12,000 · remaining -300");
		expect(card.risk).toBeUndefined();
	});

	test("falls back to the untitled session wording", () => {
		expect(quotaCardContent({ ...wait, title: null }, i18n).meta).toBe("New Session");
	});
});
