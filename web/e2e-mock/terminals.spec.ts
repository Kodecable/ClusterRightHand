import { expect, type Page, test } from "@playwright/test";
import { login, mockApi, nodeView, ptyView, sessionListItem } from "./helpers";

/** Mock the attach WebSocket: the server starts with a snapshot, then the state changes. */
async function mockAttach(
	page: Page,
	options: {
		data?: string;
		rows?: number;
		cols?: number;
		viewers?: { id: string; userId: string; username: string; clientAddress: string | null; attachedAt: string }[];
		state?: "running" | "exited";
		exitCode?: number;
	} = {},
): Promise<void> {
	const {
		data = "worker-01 uptime\r\n$ ",
		rows = 24,
		cols = 80,
		viewers = [],
		state = "running",
		exitCode = 0,
	} = options;
	await page.routeWebSocket("**/api/ptys/*/attach", (ws) => {
		ws.send(JSON.stringify({ type: "snapshot", data, rows, cols }));
		ws.send(JSON.stringify({ type: "state", rows, cols, state, viewers }));
		if (state === "exited") ws.send(JSON.stringify({ type: "exited", exitCode, reason: "exited" }));
	});
}

test("the list shows the terminals and the nav entry exists while the subsystem is on", async ({ page }) => {
	const api = await mockApi(page, {
		state: {
			ptyEnabled: true,
			ptys: [
				ptyView({ id: "pty-1", nodeName: "worker-01" }),
				ptyView({
					id: "pty-2",
					nodeName: "worker-02",
					state: "exited",
					exitCode: 0,
					endedAt: "2026-01-01T00:01:00.000Z",
				}),
			],
		},
	});
	await login(page);
	await expect(page.getByTestId("nav-terminals")).toBeVisible();
	await page.goto("/terminals");
	await expect(page.getByTestId("terminals-page")).toBeVisible();

	const table = page.getByRole("table", { name: "Terminals" });
	await expect(table).toContainText("worker-01");
	await expect(table).toContainText("worker-02");
	await expect(table).toContainText("Running");
	await expect(table).toContainText("Exited");
	await expect(page.getByRole("link", { name: "worker-01" })).toHaveAttribute("href", "/terminals/pty-1");
	expect(api.state.requests.some((request) => request.url === "/api/ptys")).toBe(true);
});

test("New terminal offers only active crha nodes and opens the created terminal", async ({ page }) => {
	const api = await mockApi(page, {
		state: {
			ptyEnabled: true,
			nodes: [
				nodeView({ id: "node-1", name: "worker-01" }),
				nodeView({ id: "ssh-1", name: "jump-host", transport: "ssh", connected: null }),
			],
		},
	});
	await login(page);
	await mockAttach(page);
	await page.goto("/terminals");
	await page.getByTestId("new-terminal").click();
	const dialog = page.getByTestId("new-terminal-dialog");
	await expect(dialog).toBeVisible();

	await page.getByLabel("Node").click();
	await expect(page.getByRole("option", { name: "worker-01" })).toBeVisible();
	// SSH nodes never have terminals.
	await expect(page.getByRole("option", { name: "jump-host" })).toHaveCount(0);
	await page.getByRole("option", { name: "worker-01" }).click();
	await page.getByLabel("Command").fill("htop -d 5");
	await dialog.getByRole("button", { name: "Open terminal" }).click();

	await expect(page).toHaveURL(/\/terminals\/pty-1$/);
	const created = api.state.requests.find((request) => request.method === "POST" && request.url === "/api/ptys");
	expect(created?.body).toEqual({ node: "node-1", argv: ["htop", "-d", "5"] });
	await expect(page.getByTestId("terminal-screen")).toBeVisible();
});

test("attach renders the screen and the live state, and Fit sends an explicit resize", async ({ page }) => {
	const api = await mockApi(page, { state: { ptyEnabled: true, ptys: [ptyView({ id: "pty-1" })] } });
	await login(page);
	await mockAttach(page, {
		data: "worker-01 uptime\r\n$ ",
		rows: 30,
		cols: 100,
		viewers: [
			{
				id: "viewer-1",
				userId: "user-1",
				username: "Ada Ops",
				clientAddress: "10.0.0.5",
				attachedAt: "2026-01-01T00:00:00.000Z",
			},
		],
	});
	await page.goto("/terminals/pty-1");

	await expect(page.getByTestId("terminal-screen")).toBeVisible();
	await expect(page.getByTestId("terminal-size")).toHaveText("Size: 100 × 30");
	await expect(page.getByTestId("terminal-viewers-panel")).toContainText("Ada Ops");
	await expect(page.getByTestId("terminal-viewers-panel")).toContainText("10.0.0.5");

	await page.getByTestId("terminal-fit").click();
	await expect
		.poll(() =>
			api.state.requests.some((request) => request.method === "POST" && request.url === "/api/ptys/pty-1/resize"),
		)
		.toBe(true);
	const resize = api.state.requests.find(
		(request) => request.method === "POST" && request.url === "/api/ptys/pty-1/resize",
	);
	const size = resize?.body as { rows: number; cols: number };
	expect(size.rows).toBeGreaterThan(0);
	expect(size.cols).toBeGreaterThan(0);
	expect(api.state.ptys[0]?.size).toEqual(size);
});

test("an exited terminal keeps its screen and shows the exit code", async ({ page }) => {
	await mockApi(page, {
		state: {
			ptyEnabled: true,
			ptys: [
				ptyView({
					id: "pty-1",
					state: "exited",
					exitCode: 7,
					endedAt: "2026-01-01T00:01:00.000Z",
				}),
			],
		},
	});
	await login(page);
	await mockAttach(page, { state: "exited", exitCode: 7, data: "make: *** [build] Error 1\r\n" });
	await page.goto("/terminals/pty-1");

	await expect(page.getByTestId("terminal-exited")).toContainText("The process exited with code 7.");
	await expect(page.getByTestId("terminal-screen")).toBeVisible();
	await expect(page.getByTestId("terminal-size")).toHaveText("Size: 80 × 24");
});

test("removing and adding an association calls the session routes", async ({ page }) => {
	const api = await mockApi(page, {
		state: {
			ptyEnabled: true,
			ptys: [ptyView({ id: "pty-1", sessionIds: ["s1"] })],
			sessions: [sessionListItem({ id: "s1" }), sessionListItem({ id: "s2", title: "Second session" })],
		},
	});
	await login(page);
	await mockAttach(page);
	await page.goto("/terminals/pty-1");
	const panel = page.getByTestId("terminal-associations");

	await panel.getByRole("button", { name: "Remove session s1" }).click();
	await expect
		.poll(() =>
			api.state.requests.some(
				(request) => request.method === "DELETE" && request.url === "/api/ptys/pty-1/sessions/s1",
			),
		)
		.toBe(true);

	await panel.getByLabel("Associate a session").click();
	await page.getByRole("option", { name: "Second session" }).click();
	await panel.getByRole("button", { name: "Associate" }).click();
	await expect
		.poll(() =>
			api.state.requests.some((request) => request.method === "PUT" && request.url === "/api/ptys/pty-1/sessions/s2"),
		)
		.toBe(true);
});

test("a privileged opening terminal shows the signature wait", async ({ page }) => {
	await mockApi(page, {
		state: {
			ptyEnabled: true,
			ptys: [
				ptyView({
					id: "pty-1",
					privileged: true,
					state: "opening",
					authorizationPhase: "preparing",
					authorization: { options: [], lastRejection: null },
				}),
			],
		},
	});
	await login(page);
	await page.goto("/terminals/pty-1");

	await expect(page.getByText("Your signature is needed")).toBeVisible();
	await expect(page.getByText("Preparing the payload to sign…")).toBeVisible();
	await expect(page.getByTestId("terminal-screen")).toHaveCount(0);
});

test("the nav entry is hidden and the page is off while the subsystem is disabled", async ({ page }) => {
	await mockApi(page, { state: { ptyEnabled: false, ptys: [ptyView()] } });
	await login(page);
	await expect(page.getByTestId("nav-terminals")).toHaveCount(0);
	await page.goto("/terminals");
	await expect(page.getByText("The terminal subsystem is turned off")).toBeVisible();
	await expect(page.getByTestId("new-terminal")).toHaveCount(0);
});
