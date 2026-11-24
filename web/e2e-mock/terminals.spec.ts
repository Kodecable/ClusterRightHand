import { devices, expect, type Page, test } from "@playwright/test";
import { BASE_FONT_SIZE, fitGrid, TERMINAL_FONT_FAMILY, TERMINAL_LINE_HEIGHT } from "../src/features/terminals/fit";
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
				ptyView({ id: "pty-3", nodeName: "worker-03", title: "root shell", privileged: true }),
			],
		},
	});
	await login(page);
	await expect(page.getByTestId("nav-terminals")).toBeVisible();
	// The entry sits directly below Library in the Work group.
	const [library, terminals, schedules] = await Promise.all([
		page.getByTestId("nav-library").boundingBox(),
		page.getByTestId("nav-terminals").boundingBox(),
		page.getByTestId("nav-schedules").boundingBox(),
	]);
	expect(library).not.toBeNull();
	expect(terminals).not.toBeNull();
	expect(schedules).not.toBeNull();
	expect(terminals?.y).toBeGreaterThan(library?.y ?? 0);
	expect(terminals?.y).toBeLessThan(schedules?.y ?? 0);

	await page.goto("/terminals");
	await expect(page.getByTestId("terminals-page")).toBeVisible();

	const table = page.getByRole("table", { name: "Terminals" });
	await expect(table).toContainText("worker-01");
	await expect(table).toContainText("worker-02");
	await expect(table).toContainText("Running");
	await expect(table).toContainText("Exited");
	await expect(table).toContainText("build log");
	// The list has no Viewers or Privileged column; the privileged mark sits beside the title.
	await expect(page.getByRole("columnheader", { name: "Viewers" })).toHaveCount(0);
	await expect(page.getByRole("columnheader", { name: "Privileged" })).toHaveCount(0);
	const privilegedTitle = page.getByTestId("terminal-title-cell").filter({ hasText: "root shell" });
	await expect(privilegedTitle.getByText("Privileged")).toBeVisible();
	await expect(page.getByRole("link", { name: "worker-01" })).toHaveAttribute("href", "/terminals/pty-1");
	expect(api.state.requests.some((request) => request.url === "/api/ptys")).toBe(true);
});

test("only the user name in the list links to the user; the rest of the cell keeps the row link", async ({ page }) => {
	await mockApi(page, { state: { ptyEnabled: true, ptys: [ptyView({ id: "pty-1" })] } });
	await login(page);
	await page.goto("/terminals");

	const link = page.getByRole("link", { name: "ops" });
	const cell = page.getByRole("cell", { name: "ops", exact: true });
	await expect(link).toHaveAttribute("href", "/users/user-1");
	const [cellBox, linkBox] = await Promise.all([cell.boundingBox(), link.boundingBox()]);
	if (cellBox === null || linkBox === null) throw new Error("the user cell was not laid out");
	// The link's hit area is its text, not the whole cell.
	expect(linkBox.width).toBeLessThan(cellBox.width - 8);

	// The link is no wider than its text: a link stretched across the cell would take clicks beside the name.
	const textWidth = await link.evaluate((element) => {
		const range = document.createRange();
		range.selectNodeContents(element);
		return range.getBoundingClientRect().width;
	});
	expect(linkBox.width).toBeLessThanOrEqual(textWidth + 1);

	await cell.click({ position: { x: cellBox.width - 4, y: cellBox.height / 2 } });
	await expect(page).toHaveURL(/\/terminals\/pty-1$/);

	await page.goBack();
	await page.getByRole("link", { name: "ops" }).click();
	await expect(page).toHaveURL(/\/users\/user-1$/);
});

test("an empty title and command fall back to Terminal in the heading, tab and top bar", async ({ page }) => {
	await mockApi(page, { state: { ptyEnabled: true, ptys: [ptyView({ id: "pty-1" })] } });
	await login(page);
	await mockAttach(page);
	await page.goto("/terminals/pty-1");

	await expect(page.getByTestId("terminal-heading")).toHaveText("Terminal");
	await expect(page).toHaveTitle("Terminal · worker-01 · ClusterRightHand");
	await expect(page.getByTestId("page-title")).toHaveText("Terminal · worker-01");
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
	await expect(page.getByTestId("terminal-heading")).toHaveText("build log");
	await expect(page).toHaveTitle("build log · worker-01 · ClusterRightHand");
	const viewers = page.getByTestId("terminal-viewers-panel");
	await expect(viewers).toContainText("Ada Ops");
	await expect(viewers).toContainText("×2");
	// Addresses and attach times are audit data, not UI.
	await expect(viewers).not.toContainText("10.0.0.5");
	// The whole terminal fits by font size, and the explicit resize stays available.
	await expect(page.getByTestId("terminal-fit")).toBeEnabled();
});

/** The viewer's own fit inputs: the terminal's inner width, its height budget and one cell at 13px. */
async function fitInputs(page: Page, cols: number, rows: number) {
	return page.evaluate(
		({ cols, rows, family, lineHeight, baseFont }) => {
			const area = document.querySelector<HTMLElement>('[data-testid="terminal-screen"]');
			if (area === null) return null;
			const style = getComputedStyle(area);
			const width = area.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight);
			// The same budget the viewer uses: the layout viewport minus the box's top in the unscrolled
			// layout (everything above it, the top bar included), the extra-keys bar and the box's own
			// vertical padding and border.
			let scrolled = 0;
			for (let ancestor = area.parentElement; ancestor !== null; ancestor = ancestor.parentElement) {
				scrolled += ancestor.scrollTop;
			}
			const boxTop = area.getBoundingClientRect().top + scrolled;
			const extraKeys =
				document.querySelector<HTMLElement>('[data-testid="terminal-extra-keys-bar"]')?.getBoundingClientRect()
					.height ?? 0;
			const boxChrome =
				Number.parseFloat(style.paddingTop) +
				Number.parseFloat(style.paddingBottom) +
				Number.parseFloat(style.borderTopWidth) +
				Number.parseFloat(style.borderBottomWidth);
			const height = window.innerHeight - boxTop - extraKeys - boxChrome;
			// xterm measures a glyph with an offscreen canvas, then rounds its cell to device pixels.
			const canvas = new OffscreenCanvas(100, 100);
			const context = canvas.getContext("2d");
			if (context === null) return null;
			context.font = `${baseFont}px ${family}`;
			const metrics = context.measureText("W");
			const dpr = window.devicePixelRatio || 1;
			const charHeight = metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent;
			const deviceCellHeight = Math.floor(Math.ceil(charHeight * dpr) * lineHeight);
			return {
				area: { width, height },
				cell: {
					width: Math.round(metrics.width * cols) / cols,
					height: Math.round((deviceCellHeight * rows) / dpr) / rows,
				},
			};
		},
		{ cols, rows, family: TERMINAL_FONT_FAMILY, lineHeight: TERMINAL_LINE_HEIGHT, baseFont: BASE_FONT_SIZE },
	);
}

/** The layout the font rule reads: the area's inner width, the grid's box and the height budget. */
async function fitLayout(page: Page) {
	return page.evaluate(() => {
		const area = document.querySelector<HTMLElement>('[data-testid="terminal-screen"]');
		const screen = document.querySelector<HTMLElement>(".xterm-screen");
		if (area === null || screen === null) return null;
		const style = getComputedStyle(area);
		// The box's top as if the page were scrolled to the start; the budget must not move with scrolling.
		let scrolled = 0;
		for (let ancestor = area.parentElement; ancestor !== null; ancestor = ancestor.parentElement) {
			scrolled += ancestor.scrollTop;
		}
		const boxTop = area.getBoundingClientRect().top + scrolled;
		const extraKeys =
			document.querySelector<HTMLElement>('[data-testid="terminal-extra-keys-bar"]')?.getBoundingClientRect().height ??
			0;
		const rect = screen.getBoundingClientRect();
		return {
			innerWidth: area.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight),
			paddingY: Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom),
			borderY: Number.parseFloat(style.borderTopWidth) + Number.parseFloat(style.borderBottomWidth),
			boxHeight: area.offsetHeight,
			screenWidth: rect.width,
			screenHeight: rect.height,
			budget: window.innerHeight - boxTop - extraKeys,
		};
	});
}

test("the width decides the font and the box is exactly the grid's height", async ({ page }) => {
	await mockApi(page, { state: { ptyEnabled: true, ptys: [ptyView({ id: "pty-1" })] } });
	await login(page);
	await mockAttach(page, { rows: 50, cols: 160, data: "wide terminal\r\n$ " });
	await page.goto("/terminals/pty-1");
	const screen = page.locator(".xterm-screen");
	await expect(screen).toBeVisible();
	// Width-driven: the grid almost fills the width, so the width picked the font, and it still fits the
	// height budget.
	await expect
		.poll(async () => {
			const layout = await fitLayout(page);
			if (layout === null) return false;
			return layout.screenWidth > layout.innerWidth * 0.9 && layout.boxHeight <= layout.budget + 1;
		})
		.toBe(true);
	const layout = await fitLayout(page);
	if (layout === null) throw new Error("the terminal was not laid out");
	// xterm sizes its element to the grid, so the whole box is the grid plus the area's padding and border.
	expect(Math.abs(layout.boxHeight - (layout.screenHeight + layout.paddingY + layout.borderY))).toBeLessThanOrEqual(
		1.5,
	);
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
			const next = await fitLayout(page);
			if (next === null) return false;
			return next.screenWidth <= next.innerWidth + 1 && next.screenHeight <= next.budget + 1;
		})
		.toBe(true);
});

test("the height budget caps the font of a tall grid", async ({ page }) => {
	await mockApi(page, { state: { ptyEnabled: true, ptys: [ptyView({ id: "pty-1" })] } });
	await login(page);
	// At the width's font this grid would stand several screens high, so the budget decides instead.
	await mockAttach(page, { rows: 50, cols: 20, data: "$ " });
	await page.goto("/terminals/pty-1");
	await expect(page.locator(".xterm-screen")).toBeVisible();
	await expect
		.poll(async () => {
			const layout = await fitLayout(page);
			if (layout === null) return false;
			// The box fits the budget; the lower bound tolerates the device-pixel rounding of a small
			// font, which can leave a few rows' worth of slack without overflowing.
			return layout.boxHeight <= layout.budget + 1 && layout.screenHeight > layout.budget * 0.75;
		})
		.toBe(true);
	const layout = await fitLayout(page);
	if (layout === null) throw new Error("the terminal was not laid out");
	// The width has room left over; the height is the constraint, and the whole box (with the area's
	// padding and border) together with everything above it and the extra-keys bar fits the budget.
	expect(layout.screenWidth).toBeLessThan(layout.innerWidth * 0.5);
	expect(layout.boxHeight).toBeLessThanOrEqual(layout.budget + 1);
	expect(Math.abs(layout.boxHeight - (layout.screenHeight + layout.paddingY + layout.borderY))).toBeLessThanOrEqual(
		1.5,
	);

	// A shorter layout viewport refits the same grid into the new budget, at the same width.
	await page.setViewportSize({ width: 1440, height: 700 });
	await expect
		.poll(async () => {
			const next = await fitLayout(page);
			if (next === null) return false;
			return next.screenHeight < layout.screenHeight && next.boxHeight <= next.budget + 1;
		})
		.toBe(true);
});

test("a visual-viewport or container-height change does not refit the font", async ({ page }) => {
	await mockApi(page, { state: { ptyEnabled: true, ptys: [ptyView({ id: "pty-1" })] } });
	await login(page);
	// A tall grid, so the height budget is what picks this font: a refit with a different budget would
	// visibly change it.
	await mockAttach(page, { rows: 50, cols: 20, data: "$ " });
	await page.goto("/terminals/pty-1");
	const screen = page.locator(".xterm-screen");
	await expect(screen).toBeVisible();
	await expect.poll(async () => ((await fitLayout(page))?.screenHeight ?? 0) > 0).toBe(true);
	const before = await screen.evaluate((element) => element.getBoundingClientRect().height);

	// A soft keyboard shrinks the visual viewport and fires its resize event; the layout viewport, and
	// therefore the font, must not change.
	await page.evaluate(() => {
		const listeners: ((event: Event) => void)[] = [];
		Object.defineProperty(window, "visualViewport", {
			configurable: true,
			value: {
				height: 320,
				width: window.innerWidth,
				scale: 1,
				offsetTop: 0,
				offsetLeft: 0,
				pageTop: 0,
				pageLeft: 0,
				addEventListener: (type: string, listener: (event: Event) => void) => {
					if (type === "resize") listeners.push(listener);
				},
				removeEventListener: (type: string, listener: (event: Event) => void) => {
					if (type !== "resize") return;
					const index = listeners.indexOf(listener);
					if (index >= 0) listeners.splice(index, 1);
				},
				dispatchEvent: (event: Event) => {
					for (const listener of listeners) listener(event);
					return true;
				},
			},
		});
		window.visualViewport?.dispatchEvent(new Event("resize"));
	});
	// The observed box only changes height here, which must not trigger a refit either.
	await page.evaluate(() => {
		const area = document.querySelector<HTMLElement>('[data-testid="terminal-screen"]');
		if (area !== null) area.style.minHeight = "1500px";
	});
	await page.waitForTimeout(400);

	expect(await screen.evaluate((element) => element.getBoundingClientRect().height)).toBe(before);
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

test("Fit to window measures one cell at exactly the default font and keeps the 80:24 shape", async ({ page }) => {
	const api = await mockApi(page, { state: { ptyEnabled: true, ptys: [ptyView({ id: "pty-1" })] } });
	await login(page);
	// A grid far past the area pins the viewer at the minimum font. Computing the answer from those
	// cells would be wrong; the viewer has to measure at 13px itself.
	await mockAttach(page, { rows: 200, cols: 400, data: "$ " });
	await page.goto("/terminals/pty-1");
	await expect(page.getByTestId("terminal-size")).toHaveText("Size: 400 × 200");
	const screen = page.locator(".xterm-screen");
	await expect(screen).toBeVisible();
	await expect.poll(() => screen.evaluate((element) => element.getBoundingClientRect().height / 200)).toBeLessThan(11);

	const inputs = await fitInputs(page, 400, 200);
	if (inputs === null) throw new Error("the terminal was not laid out");
	const expected = fitGrid(inputs.area, inputs.cell);
	expect(expected).toBeDefined();
	if (expected === undefined) throw new Error("no fit proposal");
	// The old linear scaling from the minimum font would be off by more than twice.
	expect(expected.cols).toBeLessThan(200);
	// The width fills first and the 80:24 shape gives the rows, so extra height never stretches the grid.
	expect(Math.abs(expected.rows - (expected.cols * 24) / 80)).toBeLessThanOrEqual(1);

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
	await expect(page.getByTestId("terminal-size")).toHaveText(`Size: ${expected.cols} × ${expected.rows}`);
});

test("scrolling the page does not change the Fit to window proposal", async ({ page }) => {
	const api = await mockApi(page, { state: { ptyEnabled: true, ptys: [ptyView({ id: "pty-1" })] } });
	await login(page);
	// A height where the page above the box changes which dimension decides the grid, so a budget that
	// followed the scroll position would propose a visibly different size.
	await page.setViewportSize({ width: 1440, height: 700 });
	// A huge grid makes the page scroll well past the terminal box, which is what the budget must ignore.
	await mockAttach(page, { rows: 200, cols: 400, data: "$ " });
	await page.goto("/terminals/pty-1");
	await expect(page.getByTestId("terminal-size")).toHaveText("Size: 400 × 200");
	await expect(page.locator(".xterm-screen")).toBeVisible();

	const inputs = await fitInputs(page, 400, 200);
	if (inputs === null) throw new Error("the terminal was not laid out");
	const expected = fitGrid(inputs.area, inputs.cell);
	if (expected === undefined) throw new Error("no fit proposal");

	const scrolled = await page.evaluate(() => {
		const scroller = document.querySelector<HTMLElement>('[data-testid="terminal-page"]');
		if (scroller === null) return 0;
		scroller.scrollTop = 300;
		return scroller.scrollTop;
	});
	expect(scrolled).toBe(300);

	// Click without letting Playwright scroll the button back into view. The viewer adds the page's
	// scroll offset back, so it proposes the same grid as it did at the top of the page.
	await page.evaluate(() => document.querySelector<HTMLElement>('[data-testid="terminal-fit"]')?.click());
	await expect
		.poll(() =>
			api.state.requests.some((request) => request.method === "POST" && request.url === "/api/ptys/pty-1/resize"),
		)
		.toBe(true);
	const resize = api.state.requests.find(
		(request) => request.method === "POST" && request.url === "/api/ptys/pty-1/resize",
	);
	expect(resize?.body).toEqual(expected);
});

test("a grid too large for the minimum font scrolls its area sideways and the page down", async ({ page }) => {
	await mockApi(page, { state: { ptyEnabled: true, ptys: [ptyView({ id: "pty-1" })] } });
	await login(page);
	await mockAttach(page, { rows: 200, cols: 600, data: "huge grid\r\n$ " });
	await page.goto("/terminals/pty-1");

	const area = page.getByTestId("terminal-screen");
	await expect(page.locator(".xterm-screen")).toBeVisible();
	// The width still cannot fit even at the minimum font, so the area scrolls sideways.
	await expect.poll(() => area.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
	// The box is the full grid height, so the page scrolls down to show the rest rather than cropping it.
	await expect
		.poll(() =>
			page.evaluate(() => {
				const page = document.querySelector<HTMLElement>('[data-testid="terminal-page"]');
				return page !== null && page.scrollHeight > page.clientHeight;
			}),
		)
		.toBe(true);
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(
		true,
	);
});

test("the size in the meta line opens a resize dialog and applies a new size", async ({ page }) => {
	const api = await mockApi(page, { state: { ptyEnabled: true, ptys: [ptyView({ id: "pty-1" })] } });
	await login(page);
	await mockAttach(page, { rows: 30, cols: 100, data: "$ " });
	await page.goto("/terminals/pty-1");
	await expect(page.getByTestId("terminal-size")).toHaveText("Size: 100 × 30");

	await page.getByTestId("terminal-size-button").click();
	const dialog = page.getByTestId("terminal-resize-dialog");
	await expect(dialog).toBeVisible();
	await expect(dialog.getByLabel("Columns")).toHaveValue("100");
	await expect(dialog.getByLabel("Rows")).toHaveValue("30");

	await dialog.getByLabel("Columns").fill("120");
	await dialog.getByLabel("Rows").fill("40");
	await dialog.getByRole("button", { name: "Apply" }).click();

	await expect(dialog).toHaveCount(0);
	await expect(page.getByTestId("terminal-size")).toHaveText("Size: 120 × 40");
	const resize = api.state.requests.find(
		(request) => request.method === "POST" && request.url === "/api/ptys/pty-1/resize",
	);
	expect(resize?.body).toEqual({ cols: 120, rows: 40 });
});

test("Use window size fills the resize dialog with the same shape-preserving proposal as Fit to window", async ({
	page,
}) => {
	await mockApi(page, { state: { ptyEnabled: true, ptys: [ptyView({ id: "pty-1" })] } });
	await login(page);
	await mockAttach(page, { rows: 24, cols: 80, data: "$ " });
	await page.goto("/terminals/pty-1");
	await expect(page.locator(".xterm-screen")).toBeVisible();
	const inputs = await fitInputs(page, 80, 24);
	if (inputs === null) throw new Error("the terminal was not laid out");
	const expected = fitGrid(inputs.area, inputs.cell);
	if (expected === undefined) throw new Error("no fit proposal");
	expect(Math.abs(expected.rows - (expected.cols * 24) / 80)).toBeLessThanOrEqual(1);

	await page.getByTestId("terminal-size-button").click();
	const dialog = page.getByTestId("terminal-resize-dialog");
	await dialog.getByTestId("terminal-use-window-size").click();

	await expect(dialog.getByLabel("Columns")).toHaveValue(String(expected.cols));
	await expect(dialog.getByLabel("Rows")).toHaveValue(String(expected.rows));
});

test("the resize dialog refuses a size outside 1..1000", async ({ page }) => {
	await mockApi(page, { state: { ptyEnabled: true, ptys: [ptyView({ id: "pty-1" })] } });
	await login(page);
	await mockAttach(page, { rows: 30, cols: 100, data: "$ " });
	await page.goto("/terminals/pty-1");
	await page.getByTestId("terminal-size-button").click();
	const dialog = page.getByTestId("terminal-resize-dialog");
	await dialog.getByLabel("Columns").fill("0");
	await dialog.getByRole("button", { name: "Apply" }).click();

	await expect(dialog.getByRole("alert")).toContainText("Enter whole numbers from 1 to 1000.");
	await expect(dialog).toBeVisible();
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
	// A terminal that is not running has nothing to resize: plain text, and no Fit button.
	await expect(page.getByTestId("terminal-size-button")).toHaveCount(0);
	await expect(page.getByTestId("terminal-fit")).toBeDisabled();
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

test("the mouse hint shares the extra-keys toggle's row and wraps on a narrow screen", async ({ page }) => {
	await mockApi(page, { state: { ptyEnabled: true, ptys: [ptyView({ id: "pty-1" })] } });
	await login(page);
	await mockAttach(page);
	await page.goto("/terminals/pty-1");

	const hint = page.getByTestId("terminal-mouse-hint");
	const toggle = page.getByTestId("terminal-extra-keys-toggle");
	await expect(hint).toBeVisible();
	await expect(toggle).toBeVisible();
	await expect(page.getByTestId("terminal-extra-keys-header")).toContainText("Hold Shift");
	const [hintBox, toggleBox] = await Promise.all([hint.boundingBox(), toggle.boundingBox()]);
	if (hintBox === null || toggleBox === null) throw new Error("the hint row was not laid out");
	// The hint is left of the toggle on the same row.
	expect(Math.abs(hintBox.y + hintBox.height / 2 - (toggleBox.y + toggleBox.height / 2))).toBeLessThan(4);
	expect(hintBox.x + hintBox.width).toBeLessThanOrEqual(toggleBox.x + 1);

	await page.setViewportSize({ width: 420, height: 720 });
	const [narrowHint, narrowToggle] = await Promise.all([hint.boundingBox(), toggle.boundingBox()]);
	if (narrowHint === null || narrowToggle === null) throw new Error("the hint row was not laid out");
	// The toggle wraps under the hint instead of pushing the row off the page.
	expect(narrowToggle.y).toBeGreaterThanOrEqual(narrowHint.y + narrowHint.height - 1);
	expect(narrowToggle.x + narrowToggle.width).toBeLessThanOrEqual(420);
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(
		true,
	);
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

	test("the height budget leaves room for the extra-keys bar", async ({ page }) => {
		await mockApi(page, { state: { ptyEnabled: true, ptys: [ptyView({ id: "pty-1" })] } });
		await login(page);
		// A tall grid, so the height budget (which must leave room for the bar and the box's chrome)
		// picks the font rather than the width.
		await mockAttach(page, { rows: 50, cols: 20, data: "$ " });
		await page.goto("/terminals/pty-1");
		await expect(page.getByTestId("terminal-extra-keys-bar")).toBeVisible();

		await expect
			.poll(() =>
				page.evaluate(() => {
					const area = document.querySelector<HTMLElement>('[data-testid="terminal-screen"]');
					const bar = document.querySelector<HTMLElement>('[data-testid="terminal-extra-keys-bar"]');
					if (area === null || bar === null) return false;
					// The box's top in the unscrolled layout, like the height budget reads it.
					let scrolled = 0;
					for (let ancestor = area.parentElement; ancestor !== null; ancestor = ancestor.parentElement) {
						scrolled += ancestor.scrollTop;
					}
					const boxTop = area.getBoundingClientRect().top + scrolled;
					// The whole box (its padding and border included), the extra-keys bar and everything
					// above the box fit the layout viewport together.
					return area.offsetHeight + bar.getBoundingClientRect().height + boxTop < window.innerHeight + 1;
				}),
			)
			.toBe(true);
	});
});
