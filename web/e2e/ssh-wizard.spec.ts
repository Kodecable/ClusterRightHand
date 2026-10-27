import { expect, test } from "./fixtures.ts";

// Needs an SSH server whose host key can be probed without authentication, e.g. CRH_TEST_SSH_JUMP=127.0.0.1:52222.
const jump = process.env.CRH_TEST_SSH_JUMP;
test.skip(!jump, "CRH_TEST_SSH_JUMP (host:port) is not set");

test("walks the Add SSH node wizard through credential, target and host key confirmation", async ({
	adminPage: page,
	crhs,
}) => {
	const [host, port] = (jump as string).split(":") as [string, string];
	await page.goto("/");
	await page.getByRole("button", { name: "Add SSH node" }).click();
	const dialog = page.getByRole("dialog", { name: "Add SSH node" });

	await dialog.getByLabel("New credential name").fill("e2e-key");
	await dialog.getByRole("button", { name: "Create credential" }).click();
	await expect(dialog.locator("pre")).toContainText(/^ssh-ed25519 /);
	await dialog.getByRole("button", { name: "Next" }).click();

	await dialog.getByLabel("Host", { exact: true }).fill(host);
	await dialog.getByLabel("Port", { exact: true }).fill(port);
	await dialog.getByLabel("User", { exact: true }).fill("crh");
	await dialog.getByLabel("Node name").fill("ssh-e2e");
	await dialog.getByRole("button", { name: "Next" }).click();

	await dialog.getByRole("button", { name: "Check host key of target" }).click();
	await expect(dialog.getByText(/^SHA256:/)).toBeVisible({ timeout: 20_000 });
	await dialog.getByRole("button", { name: "It matches, pin it" }).click();
	await expect(dialog.getByText("All host keys are confirmed.")).toBeVisible();
	await dialog.getByRole("button", { name: "Next" }).click();

	await expect(dialog.getByText(`crh@${host}:${port}`)).toBeVisible();
	await dialog.getByRole("button", { name: "Create node" }).click();
	await expect(page.getByRole("heading", { name: "ssh-e2e" })).toBeVisible();
	const { json } = await crhs.api("/api/nodes");
	expect(json.nodes.map((n: { name: string; transport: string }) => `${n.name}:${n.transport}`)).toContain(
		"ssh-e2e:ssh",
	);
});
