import { expect, test } from "@playwright/test";
import { login, mockApi, nodeView, sshCredentialView } from "./helpers";

test("add an SSH node through the wizard", async ({ page }) => {
	const api = await mockApi(page, {
		state: { sshCredentials: [sshCredentialView()] },
	});
	await login(page);
	await page.goto("/nodes");
	await expect(page.getByTestId("nodes-page")).toBeVisible();

	await page.getByTestId("add-ssh-node").click();
	const dialog = page.getByRole("dialog", { name: "New SSH node" });
	await expect(dialog).toBeVisible();
	await expect(dialog.getByTestId("ssh-step-route")).toBeVisible();

	// Step 1 is the route table: jumps first, the target last, with a credential and a pinned
	// host fingerprint per hop.
	await page.getByLabel("Node name").fill("edge");
	await page.getByLabel("Host — Target").fill("target.example");
	await page.getByLabel("User — Target").fill("deploy");
	await page.getByRole("combobox", { name: "Credential — Target" }).click();
	await page.getByRole("option", { name: /laptop/ }).click();

	await page.getByRole("button", { name: "Probe — Target" }).click();
	const pin = page.getByRole("dialog", { name: "Pin the host fingerprint of the Target?" });
	await expect(pin).toBeVisible();
	await expect(pin).toContainText("SHA256:hop-0");
	await pin.getByRole("button", { name: "Matches, pin it" }).click();
	await expect(page.getByText("SHA256:hop-0")).toBeVisible();

	await page.getByTestId("ssh-next").click();

	// Step 2 summarises the route, offers the connection test and creates the node.
	await expect(page.getByTestId("ssh-step-create")).toContainText("deploy@target.example:22");
	await page.getByTestId("ssh-route-test").getByRole("button", { name: "Test connection" }).click();
	await expect(page.getByTestId("ssh-route-test")).toContainText("Connection works.");
	await page.getByTestId("ssh-create").click();

	await expect(page).toHaveURL(/\/nodes\/ssh-node-1$/);
	await expect(page.getByRole("heading", { name: "edge" })).toBeVisible();
	const section = page.getByTestId("ssh-node-section");
	await expect(section).toContainText("deploy@target.example:22");
	await expect(section).toContainText("laptop");
	await expect(section).toContainText("SHA256:hop-0");

	const created = api.state.requests.find((request) => request.method === "POST" && request.url === "/api/ssh-nodes");
	expect(created?.body).toMatchObject({
		host: "target.example",
		port: 22,
		user: "deploy",
		hostFingerprint: "SHA256:hop-0",
		credentialId: "cred-1",
		name: "edge",
		jumps: [],
	});
});

test("an administrator edits a node's user remark on its card", async ({ page }) => {
	const api = await mockApi(page, { state: { nodes: [nodeView()] } });
	await login(page);
	await page.goto("/nodes");

	const card = page.getByTestId("node-card");
	await expect(card).toBeVisible();
	await card.getByRole("button", { name: "Click to edit remark" }).click();
	const input = card.getByTestId("node-user-remark-input");
	await expect(input).toBeFocused();
	await input.fill("rack 4, lab");
	await input.press("Enter");

	// The card shows the saved user remark in place, and no click in it opened the node page.
	await expect(card.getByTestId("node-user-remark-input")).toHaveCount(0);
	await expect(card.getByRole("button", { name: "rack 4, lab" })).toHaveAttribute("title", "rack 4, lab");
	await expect(page).toHaveURL(/\/nodes$/);
	const saved = api.state.requests.find(
		(request) => request.method === "PUT" && request.url === "/api/nodes/node-1/user-remark",
	);
	expect(saved?.body).toEqual({ userRemark: "rack 4, lab" });

	// Escape leaves the user remark untouched.
	await card.getByRole("button", { name: "rack 4, lab" }).click();
	await card.getByTestId("node-user-remark-input").fill("discarded");
	await card.getByTestId("node-user-remark-input").press("Escape");
	await expect(card.getByTestId("node-user-remark-input")).toHaveCount(0);
	await expect(page.getByRole("button", { name: "rack 4, lab" })).toBeVisible();
});

test("an administrator sets a node emoji from the node page heading", async ({ page }) => {
	const api = await mockApi(page, {
		state: { nodes: [nodeView({ nodeGroups: [{ id: "group-1", name: "web", emoji: null }] })] },
	});
	// Every request the picker makes must stay on this origin: the emoji data is crhs's own copy.
	const hosts = new Set<string>();
	page.on("request", (request) => {
		const url = new URL(request.url());
		if (url.protocol === "http:" || url.protocol === "https:") hosts.add(url.host);
	});
	await login(page);
	await page.goto("/nodes/node-1");
	await expect(page.getByRole("heading", { name: "worker-01" })).toBeVisible();

	const button = page.getByTestId("node-emoji-button");
	await expect(button).toHaveAccessibleName("Set emoji");
	await button.click();

	// The picker is a lazy chunk: the search field appears once frimousse has loaded.
	const search = page.getByLabel("Search emoji");
	await expect(search).toBeVisible();
	await search.fill("grinning");
	// frimousse renders each emoji as a grid cell (its buttons carry role="gridcell").
	await page.getByRole("gridcell", { name: "Grinning face", exact: true }).click();

	// The heading shows the emoji left of the name and the API stored it.
	await expect(page.getByTestId("node-emoji-button")).toContainText("😀");
	await expect(page.getByRole("heading", { name: "worker-01" })).toContainText("😀");
	const saved = api.state.requests.find(
		(request) => request.method === "PUT" && request.url === "/api/nodes/node-1/emoji",
	);
	expect(saved?.body).toEqual({ emoji: "😀" });

	// Every request went to the preview server: frimousse's emoji data came from crhs, not a CDN.
	expect([...hosts]).toEqual(["localhost:4173"]);
});

test("the node list defaults to cards, shows the figures and remembers the table view", async ({ page }) => {
	await mockApi(page, {
		state: {
			nodes: [
				nodeView({
					nodeGroups: [{ id: "group-1", name: "web", emoji: null }],
					metrics: {
						at: new Date().toISOString(),
						up: 1,
						cpu: 0.42,
						memUsed: 0.5,
						memUsedBytes: 4 * 1024 ** 3,
						memTotalBytes: 8 * 1024 ** 3,
						uptimeSec: 7200,
						disk: {
							name: "root",
							usedRatio: 0.2,
							usedBytes: 20 * 1024 ** 3,
							totalBytes: 100 * 1024 ** 3,
						},
						rxBytesPerSec: 2048,
						txBytesPerSec: 1024,
						stale: false,
					},
					traffic: {
						periodStart: "2026-11-01T00:00:00.000Z",
						nextResetAt: "2026-12-01T00:00:00.000Z",
						rxBytes: 2 * 1024 ** 3,
						txBytes: 1024 ** 3,
					},
				}),
			],
			nodeGroups: [{ id: "group-1", name: "web", emoji: null, memberIds: ["node-1"] }],
		},
	});
	await login(page);
	await page.goto("/nodes");

	await expect(page.getByTestId("nodes-cards")).toBeVisible();
	await expect(page.getByTestId("nodes-view-cards")).toHaveAttribute("aria-pressed", "true");
	const card = page.getByTestId("node-card");
	await expect(card).toBeVisible();
	await expect(card.getByRole("link", { name: "worker-01", exact: true })).toHaveAttribute("href", "/nodes/node-1");
	await expect(card.getByRole("link", { name: "web", exact: true })).toHaveAttribute("href", "/node-groups/group-1");
	await expect(card).toContainText("CPU usage");
	await expect(card).toContainText("42%");
	await expect(card).toContainText("Memory usage");
	await expect(card).not.toContainText("4 GiB / 8 GiB");
	await expect(card.locator('[title="4 GiB / 8 GiB"]')).toBeVisible();
	await expect(card).toContainText("Disk usage");
	await expect(card).not.toContainText("20 GiB / 100 GiB");
	await expect(card.locator('[title="root: 20 GiB / 100 GiB"]')).toBeVisible();
	// Live traffic moved to the Metrics tab; the card keeps total traffic, uptime and the user remark row.
	await expect(card.getByTestId("live-traffic")).toHaveCount(0);
	await expect(card).not.toContainText("Live traffic");
	await expect(card.getByTestId("total-traffic")).toHaveAttribute("title", /^Since .+ · Next reset .+$/);
	await expect(card).toContainText("Uptime");
	await expect(card).toContainText("2h 00m");
	await expect(card).toContainText("Click to edit remark");

	await page.getByTestId("nodes-view-table").click();
	await expect(page.getByTestId("nodes-view-table")).toHaveAttribute("aria-pressed", "true");
	await expect(page.locator('[data-slot="data-table"]')).toBeVisible();
	await expect(page.getByRole("columnheader", { name: "Name", exact: true })).toBeVisible();

	// The choice is persisted: a reload lands on the table, and the toggle returns to cards.
	await page.reload();
	await expect(page.locator('[data-slot="data-table"]')).toBeVisible();
	await page.getByTestId("nodes-view-cards").click();
	await expect(page.getByTestId("node-card")).toBeVisible();
});
