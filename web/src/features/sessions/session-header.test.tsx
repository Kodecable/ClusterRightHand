import type { SessionView } from "@crh/api";
import { screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { renderWithRouter } from "@/test/render";
import { SessionHeader } from "./session-header";

/** The header's own fields; the fork origin is what these tests exercise. */
function session(overrides: Partial<SessionView> = {}): SessionView {
	return {
		id: "fork-1",
		title: "Deploy plan (fork)",
		ownerUserId: "u1",
		parentSessionId: null,
		forkedFrom: null,
		scheduleId: null,
		model: { provider: "faux", modelId: "faux-1" },
		status: "active",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		rules: null,
		refs: {},
		relationship: "owner",
		capabilities: { view: true, chat: true, manageShares: true, createShares: true, configure: true },
		ownerUsername: "ops",
		state: "idle",
		waitingKind: null,
		waitingLevelId: null,
		budgetRemaining: null,
		budgetUsedTokens: 0,
		usageTokens: 0,
		contextTokens: null,
		stats: {
			turns: 0,
			steps: 0,
			ttftMs: 0,
			ttftSteps: 0,
			decodeMs: 0,
			decodeTokens: 0,
			promptTokens: 0,
			cacheReadTokens: 0,
		},
		...overrides,
	};
}

test("a fork's header links to its source title", async () => {
	const { router } = await renderWithRouter(
		<SessionHeader session={session({ forkedFrom: { sessionId: "source-1", title: "Deploy plan", entryId: 9 } })} />,
	);
	expect(screen.getByTestId("forked-from")).toHaveTextContent("Forked from Deploy plan");
	const link = screen.getByRole("link", { name: "Deploy plan" });
	expect(link).toHaveAttribute("href", "/sessions/source-1");
	await router.navigate({ href: "/sessions/source-1" });
	expect(router.state.location.pathname).toBe("/sessions/source-1");
});

test("a session without a fork origin shows no line", async () => {
	await renderWithRouter(<SessionHeader session={session()} />);
	expect(screen.queryByTestId("forked-from")).not.toBeInTheDocument();
});

test("the line is translated", async () => {
	await renderWithRouter(
		<SessionHeader session={session({ forkedFrom: { sessionId: "source-1", title: "部署计划", entryId: 9 } })} />,
		"zh-CN",
	);
	expect(screen.getByTestId("forked-from")).toHaveTextContent("分叉自 部署计划");
});
