import type { SessionExtension, SessionView } from "@crh/api";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { renderWithRouter } from "@/test/render";
import { SessionHeader } from "./session-header";

const EXTENSIONS: SessionExtension[] = [
	{
		name: "alpha",
		kind: "mcp",
		description: "Alpha tools",
		enabled: true,
		available: true,
		listDirectly: false,
	},
	{
		name: "beta",
		kind: "builtin",
		description: null,
		enabled: false,
		available: true,
		listDirectly: true,
	},
];

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
		todos: null,
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

test("the owner gets an extensions button that opens the per-extension toggles", async () => {
	const user = userEvent.setup();
	await renderWithRouter(<SessionHeader session={session({ extensions: EXTENSIONS })} />);

	const button = screen.getByTestId("session-extensions");
	expect(button).toHaveAttribute("aria-label", "Extensions: 1/2");
	expect(button).toHaveAttribute("title", "Extensions: 1/2");
	await user.click(button);
	const dialog = await screen.findByTestId("extensions-dialog");
	expect(dialog).toHaveTextContent("alpha");
	expect(dialog).toHaveTextContent("Alpha tools");
	expect(dialog).toHaveTextContent("beta");
});

test("administrators and share viewers do not see the extensions button", async () => {
	for (const relationship of ["admin", "shared"] as const) {
		const view = await renderWithRouter(<SessionHeader session={session({ relationship, extensions: EXTENSIONS })} />);
		expect(screen.queryByTestId("session-extensions")).not.toBeInTheDocument();
		view.unmount();
	}
});

test("a session without extensions has no extensions button", async () => {
	await renderWithRouter(<SessionHeader session={session()} />);
	expect(screen.queryByTestId("session-extensions")).not.toBeInTheDocument();
});
