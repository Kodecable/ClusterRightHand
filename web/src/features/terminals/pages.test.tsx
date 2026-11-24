import type { PtyView } from "@crh/api";
import { QueryClientProvider } from "@tanstack/react-query";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";
import { renderWithI18n, renderWithRouter, type TestLocale, testQueryClient } from "@/test/render";
import { ResizeTerminalDialog, TerminalPage, TerminalsPage } from "./pages";

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
function mockApi(
	options: {
		terminal?: PtyView;
		terminalStatus?: number;
		enabled?: boolean;
		list?: PtyView[];
		resizeStatus?: number;
		resizeError?: string;
	} = {},
) {
	const {
		terminal: view = terminal(),
		terminalStatus = 200,
		enabled = true,
		list = [],
		resizeStatus = 200,
		resizeError = "the terminal is not running",
	} = options;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(String(input), "http://localhost");
			const path = url.pathname;
			if (path === "/api/ptys/enabled") return json({ enabled });
			if (path === "/api/ptys" && view === undefined) return json({ enabled, terminals: list });
			if (path === "/api/ptys") return json({ enabled, terminals: list });
			if (path === `/api/ptys/${view.id}/resize` && init?.method === "POST") {
				if (resizeStatus !== 200) return json({ error: resizeError }, resizeStatus);
				view.size = JSON.parse(String(init.body)) as PtyView["size"];
				return json({ terminal: view });
			}
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

	test("shows the server-built approval request inline without the terminal screen", async () => {
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
					createdAt: "2026-01-01T00:00:00.000Z",
					alwaysAllow: [],
				},
				approvalRequest: {
					kind: "pty",
					id: "term-1",
					phase: "awaiting_user",
					source: { type: "session", sessionId: "session-1", title: "Terminal work" },
					action: { type: "pty.io", input: "rm -rf /", keys: ["Enter"] },
					nodes: ["worker-01"],
					privileged: false,
					alwaysAllow: [],
				},
			}),
		});
		renderTerminalPage(<TerminalPage />);

		expect(await screen.findByText("Your approval is needed")).toBeVisible();
		expect(screen.getByText("rm -rf / [Enter]")).toBeVisible();
		expect(screen.getByTestId("decision-meta")).toHaveTextContent("Nodes: worker-01");
		// The screen is Auto Review's context on the server; no client renders it.
		expect(screen.queryByText(/\[yes\/no\]/)).not.toBeInTheDocument();
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

	test("uses the program's title as the heading, with the node in the tab and meta line", async () => {
		route.params = { id: "term-1" };
		mockApi({ terminal: terminal({ title: "build log", argv: ["bash"] }) });
		renderTerminalPage(<TerminalPage />);

		const heading = await screen.findByTestId("terminal-heading");
		expect(heading).toHaveTextContent("build log");
		expect(heading).toHaveAttribute("title", "build log");
		expect(document.title).toBe("build log · worker-01 · ClusterRightHand");
		// There is no second title line under the heading; the node stays in the meta line.
		expect(screen.queryByTestId("terminal-title")).not.toBeInTheDocument();
		const meta = await screen.findByTestId("terminal-meta");
		expect(meta).toHaveTextContent("worker-01");
		expect(meta).toHaveTextContent("Running");
		expect(meta).toHaveTextContent("Size: 80 × 24");
		expect(meta).toHaveTextContent("ops");
	});

	test("without a title, the heading is the argv joined with spaces", async () => {
		route.params = { id: "term-1" };
		mockApi({ terminal: terminal({ argv: ["bash", "-lc", "echo 'hi'"] }) });
		renderTerminalPage(<TerminalPage />);

		expect(await screen.findByTestId("terminal-heading")).toHaveTextContent("bash -lc echo 'hi'");
		expect(document.title).toBe("bash -lc echo 'hi' · worker-01 · ClusterRightHand");
	});

	test("an empty argv names the terminal in the heading and the tab", async () => {
		route.params = { id: "term-1" };
		mockApi({ terminal: terminal() });
		renderTerminalPage(<TerminalPage />);

		expect(await screen.findByTestId("terminal-heading")).toHaveTextContent("Terminal");
		expect(document.title).toBe("Terminal · worker-01 · ClusterRightHand");
	});

	test("keeps an untrusted title as plain, truncated text with the full text on hover", async () => {
		route.params = { id: "term-1" };
		const ugly = `<img src=x onerror="alert(1)"> ${"x".repeat(300)}`;
		mockApi({ terminal: terminal({ title: ugly }) });
		renderTerminalPage(<TerminalPage />);

		const heading = await screen.findByTestId("terminal-heading");
		expect(heading).toHaveTextContent(ugly);
		expect(heading).toHaveClass("truncate");
		expect(heading).toHaveAttribute("title", ugly);
		expect(document.querySelector("img")).toBeNull();
	});

	test("an exited terminal shows its exit code in the meta line, not a banner", async () => {
		route.params = { id: "term-1" };
		mockApi({ terminal: terminal({ state: "exited", exitCode: 7, title: "build log" }) });
		renderTerminalPage(<TerminalPage />);

		expect(await screen.findByTestId("terminal-exit-code")).toHaveTextContent("Exit code 7");
		expect(screen.queryByTestId("terminal-exited")).not.toBeInTheDocument();
	});

	test("the size opens a resize dialog prefilled with the live size", async () => {
		route.params = { id: "term-1" };
		mockApi({ terminal: terminal({ size: { rows: 30, cols: 100 } }) });
		renderTerminalPage(<TerminalPage />);

		const size = await screen.findByTestId("terminal-size");
		expect(size).toHaveTextContent("Size: 100 × 30");
		const trigger = screen.getByTestId("terminal-size-button");
		expect(trigger).toHaveAccessibleName("Resize terminal");
		await userEvent.setup().click(trigger);

		expect(await screen.findByTestId("terminal-resize-dialog")).toBeVisible();
		expect(screen.getByRole("heading", { name: "Resize terminal" })).toBeVisible();
		expect(screen.getByLabelText("Columns")).toHaveValue(100);
		expect(screen.getByLabelText("Rows")).toHaveValue(30);
	});

	test("Use window size fills the dialog from the viewer's shape-preserving proposal", async () => {
		mockApi();
		renderWithI18n(
			<ResizeTerminalDialog
				terminal={terminal()}
				size={{ rows: 24, cols: 80 }}
				windowSize={() => ({ cols: 132, rows: 39 })}
				onClose={() => {}}
				onResized={() => {}}
			/>,
		);

		await userEvent.setup().click(await screen.findByTestId("terminal-use-window-size"));

		expect(screen.getByLabelText("Columns")).toHaveValue(132);
		expect(screen.getByLabelText("Rows")).toHaveValue(39);
	});

	test("Apply sends the resize, closes the dialog and updates the live size", async () => {
		route.params = { id: "term-1" };
		mockApi({ terminal: terminal({ size: { rows: 24, cols: 80 } }) });
		renderTerminalPage(<TerminalPage />);

		const user = userEvent.setup();
		await user.click(await screen.findByTestId("terminal-size-button"));
		await user.clear(screen.getByLabelText("Columns"));
		await user.type(screen.getByLabelText("Columns"), "120");
		await user.clear(screen.getByLabelText("Rows"));
		await user.type(screen.getByLabelText("Rows"), "40");
		await user.click(screen.getByRole("button", { name: "Apply" }));

		await waitFor(() => expect(screen.queryByTestId("terminal-resize-dialog")).not.toBeInTheDocument());
		expect(await screen.findByTestId("terminal-size")).toHaveTextContent("Size: 120 × 40");
		const call = vi
			.mocked(fetch)
			.mock.calls.find(
				([input, init]) =>
					String(input).endsWith("/api/ptys/term-1/resize") && (init as RequestInit | undefined)?.method === "POST",
			);
		expect(call).toBeDefined();
		expect(JSON.parse(String((call?.[1] as RequestInit | undefined)?.body))).toEqual({ cols: 120, rows: 40 });
	});

	test("a refused resize keeps the dialog open with the server's error", async () => {
		route.params = { id: "term-1" };
		mockApi({ resizeStatus: 409, resizeError: "the terminal exited" });
		renderTerminalPage(<TerminalPage />);

		const user = userEvent.setup();
		await user.click(await screen.findByTestId("terminal-size-button"));
		await user.click(screen.getByRole("button", { name: "Apply" }));

		expect(await screen.findByRole("alert")).toHaveTextContent("the terminal exited");
		expect(screen.getByTestId("terminal-resize-dialog")).toBeVisible();
		// The live size is untouched.
		expect(screen.getByTestId("terminal-size")).toHaveTextContent("Size: 80 × 24");
	});

	test("the dialog refuses a size outside 1..1000 without calling the API", async () => {
		route.params = { id: "term-1" };
		mockApi();
		renderTerminalPage(<TerminalPage />);

		const user = userEvent.setup();
		await user.click(await screen.findByTestId("terminal-size-button"));
		await user.clear(screen.getByLabelText("Columns"));
		await user.click(screen.getByRole("button", { name: "Apply" }));

		expect(await screen.findByRole("alert")).toHaveTextContent("Enter whole numbers from 1 to 1000.");
		expect(
			vi
				.mocked(fetch)
				.mock.calls.some(
					([input, init]) =>
						String(input).endsWith("/api/ptys/term-1/resize") && (init as RequestInit | undefined)?.method === "POST",
				),
		).toBe(false);
	});

	test("a terminal that is not running shows the size as plain text", async () => {
		route.params = { id: "term-1" };
		mockApi({ terminal: terminal({ state: "exited", exitCode: 0 }) });
		renderTerminalPage(<TerminalPage />);

		const size = await screen.findByTestId("terminal-size");
		expect(size).toHaveTextContent("Size: 80 × 24");
		expect(screen.queryByTestId("terminal-size-button")).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Resize terminal" })).not.toBeInTheDocument();
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

	test("has no Viewers or Privileged column and marks a privileged title", async () => {
		mockApi({ list: [terminal({ privileged: true, title: "build log", viewers: [] })] });
		renderTerminalPage(<TerminalsPage />);

		expect(await screen.findByRole("columnheader", { name: "Title" })).toBeVisible();
		expect(screen.queryByRole("columnheader", { name: "Viewers" })).not.toBeInTheDocument();
		expect(screen.queryByRole("columnheader", { name: "Privileged" })).not.toBeInTheDocument();
		const titleCell = screen.getByTestId("terminal-title-cell");
		expect(titleCell).toHaveTextContent("build log");
		expect(within(titleCell).getByText("Privileged")).toBeVisible();
	});

	test("keeps the privileged mark beside an empty title", async () => {
		mockApi({ list: [terminal({ privileged: true, title: "" })] });
		renderTerminalPage(<TerminalsPage />);

		const titleCell = await screen.findByTestId("terminal-title-cell");
		expect(titleCell).toHaveTextContent("–");
		expect(within(titleCell).getByText("Privileged")).toBeVisible();
	});

	test("only the user name links to the user; the rest of the cell keeps the row link", async () => {
		mockApi({ list: [terminal({ id: "term-1" })] });
		const { router } = await renderTerminalPage(<TerminalsPage />);

		const userLink = await screen.findByRole("link", { name: "ops" });
		expect(userLink).toHaveAttribute("href", "/users/user-1");
		// An inline link's hit area is its text, not the whole cell.
		expect(getComputedStyle(userLink).display).toBe("inline");
		const cell = userLink.closest('[role="cell"]');
		if (cell === null) throw new Error("the user link is not in a cell");
		await userEvent.setup().click(cell);
		await waitFor(() => expect(router.state.location.pathname).toBe("/terminals/term-1"));
	});

	test("the New terminal button opens the dialog", async () => {
		mockApi({ list: [] });
		renderTerminalPage(<TerminalsPage />);

		await userEvent.setup().click(await screen.findByTestId("new-terminal"));
		expect(await screen.findByTestId("new-terminal-dialog")).toBeInTheDocument();
		expect(screen.getByRole("heading", { name: "New terminal" })).toBeInTheDocument();
		// The redundant descriptions are gone from the dialog.
		expect(
			screen.queryByText("Open an interactive shell on a crha node. Several people can watch and type in it."),
		).not.toBeInTheDocument();
		expect(
			screen.queryByText("Only active crha nodes have terminals; SSH nodes cannot open one."),
		).not.toBeInTheDocument();
		expect(
			screen.queryByText("A privileged terminal waits for your signature before it opens."),
		).not.toBeInTheDocument();
	});

	test("shows the off state instead of the page while the subsystem is disabled", async () => {
		mockApi({ enabled: false, list: [terminal()] });
		renderTerminalPage(<TerminalsPage />);

		expect(await screen.findByText("The terminal subsystem is turned off")).toBeVisible();
		expect(screen.queryByTestId("new-terminal")).not.toBeInTheDocument();
	});
});

describe("the zh-CN locale", () => {
	test("translates the generic terminal heading", async () => {
		route.params = { id: "term-1" };
		mockApi({ terminal: terminal() });
		await renderTerminalPage(<TerminalPage />, "zh-CN");

		expect(await screen.findByTestId("terminal-heading")).toHaveTextContent("终端");
		expect(document.title).toBe("终端 · worker-01 · ClusterRightHand");
	});

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
		const toggle = await screen.findByRole("button", { name: "额外按键" });
		expect(toggle).toBeVisible();
		const hint = await screen.findByTestId("terminal-mouse-hint");
		expect(hint).toHaveTextContent("程序使用鼠标时，按住 Shift 再选择文字。");
		// The hint is on the left of the toggle's row, and the row wraps instead of overflowing.
		expect(hint.parentElement).toBe(toggle.parentElement);
		expect(hint.parentElement).toHaveClass("flex-wrap");
		expect(hint.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	});

	test("translates the size link and the resize dialog", async () => {
		route.params = { id: "term-1" };
		mockApi({ terminal: terminal() });
		renderTerminalPage(<TerminalPage />, "zh-CN");

		expect(await screen.findByTestId("terminal-size")).toHaveTextContent("尺寸：80 × 24");
		const close = vi.fn();
		renderWithI18n(
			<ResizeTerminalDialog
				terminal={terminal()}
				size={{ rows: 24, cols: 80 }}
				windowSize={() => ({ cols: 132, rows: 39 })}
				onClose={close}
				onResized={() => {}}
			/>,
			"zh-CN",
		);
		expect(await screen.findByTestId("terminal-resize-dialog")).toHaveTextContent("调整终端尺寸");
		expect(screen.getByLabelText("列数")).toHaveValue(80);
		expect(screen.getByLabelText("行数")).toHaveValue(24);
		expect(screen.getByTestId("terminal-use-window-size")).toHaveTextContent("使用窗口尺寸");
		expect(screen.getByRole("button", { name: "应用" })).toBeVisible();
		expect(screen.getByRole("button", { name: "取消" })).toBeVisible();
	});
});
