import { expect, test } from "./fixtures.ts";

// Needs an SSH server whose host key can be probed without authentication, e.g. CRH_TEST_SSH_JUMP=127.0.0.1:52222.
const jump = process.env.CRH_TEST_SSH_JUMP;
test.skip(!jump, "CRH_TEST_SSH_JUMP (host:port) is not set");

test("walks the Add SSH node wizard through credential, target and host key confirmation", async ({
	adminPage: page,
	crhs,
}) => {
	const [host, port] = (jump as string).split(":") as [string, string];
	await page.goto("/nodes");
	await page.getByTestId("add-ssh-node").click();
	const dialog = page.getByRole("dialog", { name: "Add SSH node" });
	await expect(dialog.getByTestId("ssh-wizard")).toBeVisible();

	await dialog.getByLabel("New credential name").fill("e2e-key");
	await dialog.getByRole("button", { name: "Create credential" }).click();
	await expect(dialog.getByRole("region", { name: "Public key" })).toContainText(/^ssh-ed25519 /);
	await dialog.getByTestId("ssh-next").click();

	await expect(dialog.getByTestId("ssh-step-route")).toBeVisible();
	await dialog.getByLabel("Host", { exact: true }).fill(host);
	await dialog.getByLabel("Port", { exact: true }).fill(port);
	await dialog.getByLabel("User", { exact: true }).fill("crh");
	await dialog.getByLabel("Node name").fill("ssh-e2e");
	await dialog.getByTestId("ssh-next").click();

	await expect(dialog.getByTestId("ssh-step-host-keys")).toBeVisible();
	await dialog.getByRole("button", { name: "Check the next host key" }).click();
	await expect(dialog.getByText(/^SHA256:/)).toBeVisible({ timeout: 20_000 });
	await dialog.getByRole("button", { name: "It matches, pin it" }).click();
	await expect(dialog.getByText("All host keys are confirmed.")).toBeVisible();
	await dialog.getByTestId("ssh-next").click();

	await expect(dialog.getByTestId("ssh-step-create")).toContainText(`crh@${host}:${port}`);
	// The new key is not in the server's authorized_keys, so the test must say so before creating.
	await dialog.getByRole("button", { name: "Test connection" }).click();
	await expect(dialog.getByRole("alert")).toContainText(/authentication|connect/i, { timeout: 15_000 });
	await dialog.getByTestId("ssh-create").click();
	await expect(page.getByTestId("page-title")).toHaveText("Nodes");
	await expect(page.getByRole("heading", { name: "ssh-e2e" })).toBeVisible();

	// The node page shows the route with its pinned key, and the owner can change the groups.
	const section = page.getByTestId("ssh-node-section");
	await expect(section.getByRole("table", { name: "SSH route" })).toContainText(`crh@${host}:${port}`);
	await expect(section.getByRole("table", { name: "SSH route" })).toContainText("SHA256:");
	await section.getByRole("button", { name: "Edit groups" }).click();
	await section.getByLabel("Groups").fill("edge, lab");
	await section.getByRole("button", { name: "Save" }).click();
	await expect(page.getByRole("definition").filter({ hasText: "edge, lab" })).toBeVisible();
	const { json } = await crhs.api("/api/nodes");
	expect(json.nodes.map((n: { name: string; transport: string }) => `${n.name}:${n.transport}`)).toContain(
		"ssh-e2e:ssh",
	);
});
