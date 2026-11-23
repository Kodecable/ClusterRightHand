import { devices, expect, type Page, test } from "@playwright/test";
import { BASE_FONT_SIZE, fitGrid, MIN_FONT_SIZE } from "../src/features/terminals/fit";
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
		title?: string;
	} = {},
): Promise<void> {
	const {
		data = "worker-01 uptime\r\n$ ",
		rows = 24,
		cols = 80,
		viewers = [],
		state = "running",
		exitCode = 0,
		title = "",
	} = options;
	await page.routeWebSocket("**/api/ptys/*/attach", (ws) => {
		ws.send(JSON.stringify({ type: "snapshot", data, rows, cols }));
		ws.send(JSON.stringify({ type: "state", rows, cols, title, state, viewers }));
		if (state === "exited") ws.send(JSON.stringify({ type: "exited", exitCode, reason: "exited" }));
	});
}

test("the list shows the terminals and the nav entry exists while the subsystem is on", async ({ page }) => {
	const api = await mockApi(page, {
		state: {
			ptyEnabled: true,
			ptys: [
				ptyView({ id: "pty-1", nodeName: "worker-01", title: "build log" }),
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
	await expect(table).toContainText("build log");
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
	await expect(page.getByRole("option", { name: /worker-01/ })).toBeVisible();
	// SSH nodes never have terminals.
	await expect(page.getByRole("option", { name: /jump-host/ })).toHaveCount(0);
	await page.getByRole("option", { name: /worker-01/ }).click();
	await page.getByLabel("Command").fill("htop -d 5");
	await dialog.getByRole("button", { name: "Open terminal" }).click();

	await expect(page).toHaveURL(/\/terminals\/pty-1$/);
	const created = api.state.requests.find((request) => request.method === "POST" && request.url === "/api/ptys");
	expect(created?.body).toEqual({ node: "node-1", argv: ["htop", "-d", "5"] });
	await expect(page.getByTestId("terminal-screen")).toBeVisible();
	// The new page focuses the terminal, so the first key goes to the shell.
	await expect
		.poll(() => page.evaluate(() => document.activeElement?.classList.contains("xterm-helper-textarea")))
		.toBe(true);
});

test("attach renders the screen, the program title and the viewers merged per user", async ({ page }) => {
	await mockApi(page, { state: { ptyEnabled: true, ptys: [ptyView({ id: "pty-1" })] } });
	await login(page);
	await mockAttach(page, {
		data: "worker-01 uptime\r\n$ ",
		rows: 30,
		cols: 100,
		title: "build log",
		viewers: [
			{
				id: "viewer-1",
				userId: "user-1",
				username: "Ada Ops",
				clientAddress: "10.0.0.5",
				attachedAt: "2026-01-01T00:00:00.000Z",
			},
			{
				id: "viewer-2",
				userId: "user-1",
				username: "Ada Ops",
				clientAddress: "10.0.0.6",
				attachedAt: "2026-01-01T00:01:00.000Z",
			},
		],
	});
	await page.goto("/terminals/pty-1");

	await expect(page.getByTestId("terminal-screen")).toBeVisible();
	await expect(page.getByTestId("terminal-size")).toHaveText("Size: 100 × 30");
	await expect(page.getByTestId("terminal-title")).toHaveText("build log");
	await expect(page).toHaveTitle("build log · worker-01 · ClusterRightHand");
	const viewers = page.getByTestId("terminal-viewers-panel");
	await expect(viewers).toContainText("Ada Ops");
	await expect(viewers).toContainText("×2");
	// Addresses and attach times are audit data, not UI.
	await expect(viewers).not.toContainText("10.0.0.5");
	// The whole terminal fits by font size, and the explicit resize stays available.
	await expect(page.getByTestId("terminal-fit")).toBeEnabled();
});

test("scales the font so the full grid fits, focuses the terminal and keeps page scroll horizontal-free", async ({
	page,
}) => {
	await mockApi(page, { state: { ptyEnabled: true, ptys: [ptyView({ id: "pty-1" })] } });
	await login(page);
	await mockAttach(page, { rows: 50, cols: 160, data: "wide terminal\r\n$ " });
	await page.goto("/terminals/pty-1");
	const area = page.getByTestId("terminal-screen");
	const screen = page.locator(".xterm-screen");
	await expect(screen).toBeVisible();
	await expect
		.poll(async () => {
			const [areaBox, screenBox] = await Promise.all([area.boundingBox(), screen.boundingBox()]);
			if (areaBox === null || screenBox === null) return false;
			return screenBox.width <= areaBox.width + 1 && screenBox.height <= areaBox.height + 1;
		})
		.toBe(true);
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(
		true,
	);
	await expect
		.poll(() => page.evaluate(() => document.activeElement?.classList.contains("xterm-helper-textarea")))
		.toBe(true);

	// A window resize recomputes the font against the same grid instead of cropping it.
	await page.setViewportSize({ width: 900, height: 700 });
	await expect
		.poll(async () => {
			const [areaBox, screenBox] = await Promise.all([area.boundingBox(), screen.boundingBox()]);
			if (areaBox === null || screenBox === null) return false;
			return screenBox.width <= areaBox.width + 1 && screenBox.height <= areaBox.height + 1;
		})
		.toBe(true);
});

test("centers a grid narrower than the area horizontally, keeping it at the top", async ({ page }) => {
	await mockApi(page, { state: { ptyEnabled: true, ptys: [ptyView({ id: "pty-1" })] } });
	await login(page);
	// A small grid grows to the maximum font, so the free width is real rather than a measurement artefact.
	await mockAttach(page, { rows: 8, cols: 30, data: "narrow terminal\r\n$ " });
	await page.goto("/terminals/pty-1");

	const area = page.getByTestId("terminal-screen");
	const screen = page.locator(".xterm-screen");
	await expect(screen).toBeVisible();
	await expect
		.poll(async () => {
			const [areaBox, screenBox] = await Promise.all([area.boundingBox(), screen.boundingBox()]);
			if (areaBox === null || screenBox === null || screenBox.width >= areaBox.width - 32) return false;
			const areaCenter = areaBox.x + areaBox.width / 2;
			const screenCenter = screenBox.x + screenBox.width / 2;
			return Math.abs(areaCenter - screenCenter) <= 2;
		})
		.toBe(true);

	const [areaBox, screenBox] = await Promise.all([area.boundingBox(), screen.boundingBox()]);
	if (areaBox === null || screenBox === null) throw new Error("the terminal was not laid out");
	// Top-aligned: only the area's border and padding sit above the grid.
	expect(screenBox.y - areaBox.y).toBeLessThan(20);
	// Centering must not make the page itself scroll horizontally.
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(
		true,
	);
});

test("Fit to window sends the grid that fills the area at the default font size", async ({ page }) => {
	const api = await mockApi(page, { state: { ptyEnabled: true, ptys: [ptyView({ id: "pty-1" })] } });
	await login(page);
	// A grid far past the area pins the viewer at the minimum font. Measuring the cells at that known
	// scale lets the test reproduce the default-font computation without depending on the font file.
	await mockAttach(page, { rows: 200, cols: 400, data: "$ " });
	await page.goto("/terminals/pty-1");
	await expect(page.getByTestId("terminal-size")).toHaveText("Size: 400 × 200");
	const screen = page.locator(".xterm-screen");
	await expect(screen).toBeVisible();
	await expect.poll(() => screen.evaluate((element) => element.getBoundingClientRect().height / 200)).toBeLessThan(11);

	const measured = await page.evaluate(() => {
		const area = document.querySelector<HTMLElement>('[data-testid="terminal-screen"]');
		const screen = document.querySelector<HTMLElement>(".xterm-screen");
		if (area === null || screen === null) return null;
		const style = getComputedStyle(area);
		const rect = screen.getBoundingClientRect();
		return {
			area: {
				width: area.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight),
				height: area.clientHeight - Number.parseFloat(style.paddingTop) - Number.parseFloat(style.paddingBottom),
			},
			cell: { width: rect.width / 400, height: rect.height / 200 },
		};
	});
	if (measured === null) throw new Error("the terminal was not laid out");
	const expected = fitGrid(measured.area, measured.cell, MIN_FONT_SIZE, BASE_FONT_SIZE);
	expect(expected).toBeDefined();

	await page.getByTestId("terminal-fit").click();
	await expect
		.poll(() =>
			api.state.requests.some((request) => request.method === "POST" && request.url === "/api/ptys/pty-1/resize"),
		)
		.toBe(true);
	const resize = api.state.requests.find(
		(request) => request.method === "POST" && request.url === "/api/ptys/pty-1/resize",
	);
	expect(resize?.body).toEqual(expected);
	await expect(page.getByTestId("terminal-size")).toHaveText(`Size: ${expected?.cols} × ${expected?.rows}`);
});

test("a grid too large for the minimum font scrolls inside the terminal area", async ({ page }) => {
	await mockApi(page, { state: { ptyEnabled: true, ptys: [ptyView({ id: "pty-1" })] } });
	await login(page);
	await mockAttach(page, { rows: 200, cols: 300, data: "huge grid\r\n$ " });
	await page.goto("/terminals/pty-1");

	const area = page.getByTestId("terminal-screen");
	await expect(page.locator(".xterm-screen")).toBeVisible();
	await expect
		.poll(() =>
			area.evaluate(
				(element) => element.scrollHeight > element.clientHeight || element.scrollWidth > element.clientWidth,
			),
		)
		.toBe(true);
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(
		true,
	);
});

test("an exited terminal keeps its screen and shows the exit code in the meta line", async ({ page }) => {
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

	await expect(page.getByTestId("terminal-meta")).toContainText("Exit code 7");
	await expect(page.getByTestId("terminal-exited")).toHaveCount(0);
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
	await page.getByRole("option", { name: /Second session/ }).click();
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

test("desktop hides the extra keys until its toggle shows them", async ({ page }) => {
	await mockApi(page, { state: { ptyEnabled: true, ptys: [ptyView({ id: "pty-1" })] } });
	await login(page);
	await mockAttach(page);
	await page.goto("/terminals/pty-1");

	const toggle = page.getByTestId("terminal-extra-keys-toggle");
	await expect(toggle).toBeVisible();
	await expect(page.getByTestId("terminal-extra-keys-bar")).toHaveCount(0);
	await toggle.click();
	await expect(page.getByTestId("terminal-extra-keys-bar")).toBeVisible();
	await expect(page.getByTestId("extra-key-ctrl")).toBeVisible();
	await toggle.click();
	await expect(page.getByTestId("terminal-extra-keys-bar")).toHaveCount(0);
});

const { defaultBrowserType: _defaultBrowserType, ...PIXEL_7 } = devices["Pixel 7"];

test.describe("on a coarse-pointer viewport", () => {
	test.use(PIXEL_7);

	test("the extra keys bar is shown by default", async ({ page }) => {
		await mockApi(page, { state: { ptyEnabled: true, ptys: [ptyView({ id: "pty-1" })] } });
		await login(page);
		await mockAttach(page);
		await page.goto("/terminals/pty-1");

		await expect(page.getByTestId("terminal-extra-keys-bar")).toBeVisible();
		await expect(page.getByTestId("extra-key-ctrl")).toBeVisible();
		await expect(page.getByTestId("terminal-mouse-hint")).toContainText("Shift");
	});
});
