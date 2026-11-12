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
	await expect(dialog.getByTestId("ssh-step-credential")).toBeVisible();

	await page.getByLabel("SSH credential").click();
	await page.getByRole("option", { name: "laptop" }).click();
	await page.getByTestId("ssh-next").click();

	await expect(page.getByTestId("ssh-step-route")).toBeVisible();
	await page.getByLabel("Host").fill("target.example");
	await page.getByLabel("User").fill("deploy");
	await page.getByLabel("Node name").fill("edge");
	await page.getByTestId("ssh-next").click();

	await expect(page.getByTestId("ssh-step-host-keys")).toBeVisible();
	await page.getByRole("button", { name: "Check the next host key" }).click();
	await expect(page.getByText("SHA256:probe")).toBeVisible();
	await page.getByRole("button", { name: "It matches, pin it" }).click();
	await expect(page.getByText("All host keys are confirmed.")).toBeVisible();
	await page.getByTestId("ssh-next").click();

	await expect(page.getByTestId("ssh-step-create")).toContainText("deploy@target.example:22");
	await page.getByTestId("ssh-create").click();

	await expect(page).toHaveURL(/\/nodes\/ssh-node-1$/);
	await expect(page.getByRole("heading", { name: "edge" })).toBeVisible();
	await expect(page.getByTestId("ssh-node-section")).toBeVisible();

	const created = api.state.requests.find((request) => request.method === "POST" && request.url === "/api/ssh-nodes");
	expect(created?.body).toMatchObject({
		host: "target.example",
		port: 22,
		user: "deploy",
		hostFingerprint: "SHA256:probe",
		credentialId: "cred-1",
		name: "edge",
	});
});
