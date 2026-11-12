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

test("edit a node's trust configuration and export the snippet", async ({ page }) => {
	await mockApi(page, {
		state: {
			nodes: [nodeView({ id: "node-1", name: "worker-01" })],
			signingCredentials: [
				{
					id: "credential-1",
					kind: "ssh",
					name: "laptop",
					createdAt: "2026-01-01T00:00:00.000Z",
					publicKey: "ssh-ed25519 AAAAlaptop laptop",
					fingerprint: "SHA256:laptop",
					credentialId: null,
					rpId: null,
					origins: [],
				},
			],
		},
	});
	await login(page);
	await page.goto("/nodes/node-1");
	await expect(page.getByTestId("node-detail")).toBeVisible();
	await expect(page.getByTestId("node-trust")).toContainText("crhs");

	const editor = page.getByTestId("trust-editor");
	await expect(editor).toBeVisible();
	await page.getByTestId("trust-source").click();
	await page.getByRole("option", { name: "laptop", exact: true }).click();
	await expect(editor).toContainText('role          = "user"');
	await expect(editor).not.toContainText("require_uv");

	await page.getByRole("checkbox", { name: "Require user verification" }).check();
	await expect(editor).toContainText("require_uv    = true");

	await page.getByLabel("Max TTL").fill("2h");
	await expect(editor).toContainText('max_ttl       = "2h"');
	await expect(editor).toContainText('key           = "ssh-ed25519 AAAAlaptop laptop"');
});
