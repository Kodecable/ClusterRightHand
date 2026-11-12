import { expect, test } from "@playwright/test";
import { login, mockApi, sshCredentialView } from "./helpers";

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
