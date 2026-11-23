import type { PtyView } from "@crh/api";
import { QueryClientProvider } from "@tanstack/react-query";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";
import { renderWithRouter, type TestLocale, testQueryClient } from "@/test/render";
import { TerminalPage, TerminalsPage } from "./pages";

/** The route params `useParams` returns; each test sets the id the page reads. */
const route = vi.hoisted(() => ({ params: {} as Record<string, string> }));

vi.mock("@tanstack/react-router", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@tanstack/react-router")>();
	return { ...actual, useParams: () => route.params };
});

afterEach(() => {
	route.params = {};
	vi.unstubAllGlobals();
});

function terminal(overrides: Partial<PtyView> = {}): PtyView {
	return {
		id: "term-1",
		nodeId: "node-1",
		nodeName: "worker-01",
		userId: "user-1",
		username: "ops",
		privileged: false,
		argv: [],
		size: { rows: 24, cols: 80 },
		title: "",
		state: "running",
		exitCode: null,
		creatingSessionId: null,
		sessionIds: [],
		idleTimeoutMs: null,
		openedAt: "2026-01-01T00:00:00.000Z",
		endedAt: null,
		lastActivityAt: "2026-01-01T00:00:00.000Z",
		viewers: [],
		authorization: null,
		authorizationPhase: null,
		rejection: null,
		approval: null,
		approvalRequest: null,
		...overrides,
	};
}

function json(payload: unknown, status = 200): Response {
	return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

/** Answers the terminal page's reads; `terminalStatus` and the terminal body are per test. */
function mockApi(options: { terminal?: PtyView; terminalStatus?: number; enabled?: boolean; list?: PtyView[] } = {}) {
	const { terminal: view = terminal(), terminalStatus = 200, enabled = true, list = [] } = options;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			const url = new URL(String(input), "http://localhost");
			const path = url.pathname;
			if (path === "/api/ptys/enabled") return json({ enabled });
			if (path === "/api/ptys" && view === undefined) return json({ enabled, terminals: list });
			if (path === "/api/ptys") return json({ enabled, terminals: list });
			if (path === `/api/ptys/${view.id}`) {
				return terminalStatus === 200 ? json({ terminal: view }) : json({ error: "no such terminal" }, terminalStatus);
			}
			if (path === `/api/ptys/${view.id}/authorization`) return json({ phase: "preparing", authorization: null });
			if (path.startsWith("/api/sessions")) return json({ items: [], nextCursor: null });
			if (path === "/api/nodes") return json({ nodes: [] });
			return json({});
		}),
	);
}

function renderTerminalPage(page: React.ReactElement, locale: TestLocale = "en") {
	return renderWithRouter(<QueryClientProvider client={testQueryClient()}>{page}</QueryClientProvider>, locale, {
		path: "/terminals/$id",
		initialEntries: ["/terminals/term-1"],
	});
}

describe("TerminalPage", () => {
	test("a privileged opening terminal waits on the signature panel, not on a screen", async () => {
		route.params = { id: "term-1" };
		mockApi({
			terminal: terminal({ privileged: true, state: "opening", authorizationPhase: "preparing" }),
		});
		renderTerminalPage(<TerminalPage />);

		expect(await screen.findByText("Your signature is needed")).toBeVisible();
		expect(await screen.findByText("Preparing the payload to sign…")).toBeVisible();
		expect(screen.getByText("Opening")).toBeVisible();
		expect(screen.queryByTestId("terminal-screen")).not.toBeInTheDocument();
	});

	test("shows the server-built approval request inline, with the terminal screen", async () => {
		route.params = { id: "term-1" };
		mockApi({
			terminal: terminal({
				state: "running",
				creatingSessionId: "session-1",
				approval: {
					id: "approval-1",
					method: "pty.io",
					privileged: false,
					argv: [],
					input: "rm -rf /",
					keys: ["Enter"],
					screen: "$ rm -rf /\n[yes/no]",
					createdAt: "2026-01-01T00:00:00.000Z",
					alwaysAllow: [],
				},
				approvalRequest: {
					kind: "pty",
					id: "term-1",
					phase: "awaiting_user",
					source: { type: "session", sessionId: "session-1", title: "Terminal work" },
					action: { type: "pty.io", input: "rm -rf /", keys: ["Enter"], screen: "$ rm -rf /\n[yes/no]" },
					nodes: ["worker-01"],
					privileged: false,
					alwaysAllow: [],
				},
			}),
		});
		renderTerminalPage(<TerminalPage />);

		expect(await screen.findByText("Your approval is needed")).toBeVisible();
		expect(screen.getByText("rm -rf / [Enter]")).toBeVisible();
		expect(screen.getByText(/\[yes\/no\]/)).toBeVisible();
		expect(screen.getByRole("button", { name: "Approve" })).toBeVisible();
		expect(screen.getByRole("tab", { name: "Reject" })).toBeVisible();
		// Approving uses the shared decision body on the terminal's approval route.
		await userEvent.setup().click(screen.getByRole("button", { name: "Approve" }));
		await waitFor(() => {
			const call = vi
				.mocked(fetch)
				.mock.calls.find(
					([input, init]) =>
						String(input).endsWith("/api/ptys/term-1/approval") && (init as RequestInit | undefined)?.method === "POST",
				);
			expect(call).toBeDefined();
			expect(JSON.parse(String((call?.[1] as RequestInit | undefined)?.body))).toEqual({ decision: "approve" });
		});
	});

	test("shows the program title as a secondary line and the facts in one meta line", async () => {
		route.params = { id: "term-1" };
		mockApi({ terminal: terminal({ title: "build log" }) });
		renderTerminalPage(<TerminalPage />);

		expect(await screen.findByTestId("terminal-title")).toHaveTextContent("build log");
		const meta = await screen.findByTestId("terminal-meta");
		expect(meta).toHaveTextContent("Running");
		expect(meta).toHaveTextContent("worker-01");
		expect(meta).toHaveTextContent("Size: 80 × 24");
		expect(meta).toHaveTextContent("ops");
		expect(screen.queryByTestId("terminal-facts")).not.toBeInTheDocument();
	});

	test("an exited terminal shows its exit code in the meta line, not a banner", async () => {
		route.params = { id: "term-1" };
		mockApi({ terminal: terminal({ state: "exited", exitCode: 7, title: "build log" }) });
		renderTerminalPage(<TerminalPage />);

		expect(await screen.findByTestId("terminal-exit-code")).toHaveTextContent("Exit code 7");
		expect(screen.queryByTestId("terminal-exited")).not.toBeInTheDocument();
	});

	test("merges viewers per user and shows no address or attach time", async () => {
		route.params = { id: "term-1" };
		mockApi({
			terminal: terminal({
				viewers: [
					{
						id: "viewer-1",
						userId: "user-1",
						username: "ops",
						clientAddress: "10.0.0.5",
						attachedAt: "2026-01-01T00:00:00.000Z",
					},
					{
						id: "viewer-2",
						userId: "user-1",
						username: "ops",
						clientAddress: "10.0.0.6",
						attachedAt: "2026-01-01T00:01:00.000Z",
					},
				],
			}),
		});
		renderTerminalPage(<TerminalPage />);

		const viewers = await screen.findByTestId("terminal-viewers");
		expect(viewers).toHaveTextContent("ops");
		expect(viewers).toHaveTextContent("×2");
		expect(screen.queryByText("10.0.0.5")).not.toBeInTheDocument();
		expect(screen.queryByText("10.0.0.6")).not.toBeInTheDocument();
	});

	test("a 404 after the retention window shows a clear gone state", async () => {
		route.params = { id: "term-1" };
		mockApi({ terminalStatus: 404 });
		renderTerminalPage(<TerminalPage />);

		expect(await screen.findByText("The terminal is gone")).toBeVisible();
		expect(screen.getByText("All terminals")).toBeVisible();
	});
});

describe("TerminalsPage", () => {
	test("lists the terminals with a row link to the terminal page", async () => {
		mockApi({ list: [terminal({ id: "term-1" }), terminal({ id: "term-2", nodeName: "worker-02" })] });
		renderTerminalPage(<TerminalsPage />);

		const link = await screen.findByRole("link", { name: "worker-01" });
		expect(link).toHaveAttribute("href", "/terminals/term-1");
		expect(screen.getByRole("link", { name: "worker-02" })).toHaveAttribute("href", "/terminals/term-2");
		expect(screen.getAllByText("Running")).toHaveLength(2);
	});

	test("the New terminal button opens the dialog", async () => {
		mockApi({ list: [] });
		renderTerminalPage(<TerminalsPage />);

		await userEvent.setup().click(await screen.findByTestId("new-terminal"));
		expect(await screen.findByTestId("new-terminal-dialog")).toBeInTheDocument();
		expect(screen.getByRole("heading", { name: "New terminal" })).toBeInTheDocument();
	});

	test("shows the off state instead of the page while the subsystem is disabled", async () => {
		mockApi({ enabled: false, list: [terminal()] });
		renderTerminalPage(<TerminalsPage />);

		expect(await screen.findByText("The terminal subsystem is turned off")).toBeVisible();
		expect(screen.queryByTestId("new-terminal")).not.toBeInTheDocument();
	});
});

describe("the zh-CN locale", () => {
	test("translates the terminal node placeholder, the extra-keys toggle and the mouse hint", async () => {
		// The new terminal dialog's node picker defaults to the kind's "Choose a crha node" placeholder.
		mockApi({ list: [] });
		const list = await renderTerminalPage(<TerminalsPage />, "zh-CN");
		await userEvent.setup().click(await screen.findByTestId("new-terminal"));
		expect(await screen.findByText("选择一个 crha 节点")).toBeVisible();
		list.unmount();

		route.params = { id: "term-1" };
		mockApi({ terminal: terminal() });
		await renderTerminalPage(<TerminalPage />, "zh-CN");
		expect(await screen.findByRole("button", { name: "额外按键" })).toBeVisible();
		expect(await screen.findByTestId("terminal-mouse-hint")).toHaveTextContent(
			"程序使用鼠标时，按住 Shift 再选择文字。",
		);
	});
});
