import { expect, test } from "./fixtures.ts";

test("an administrator changes the public URL and adds and deletes a signing key", async ({
	adminPage: page,
	crhs,
}) => {
	await page.goto("/settings/system");
	await expect(page.getByTestId("page-title")).toHaveText("System settings");
	await expect(
		page.getByTestId("system-settings-page").getByRole("heading", { name: "System settings" }),
	).toBeVisible();

	// General: save the public URL and nothing else.
	const general = page.getByTestId("general-section");
	const save = general.getByRole("button", { name: "Save" });
	await expect(save).toBeDisabled();
	await general.getByLabel("Public URL").fill("https://crh.example.test");
	await expect(save).toBeEnabled();
	await save.click();
	await expect(save).toBeDisabled();
	await expect
		.poll(async () => (await crhs.api("/api/settings")).json.settings.publicUrl)
		.toBe("https://crh.example.test");

	// Add a signing key; the dialog shows its public key line for privileged.toml.
	await page.getByTestId("add-signing-key").click();
	const add = page.getByRole("dialog", { name: "Add signing key" });
	await add.getByLabel("Name").fill("e2e key");
	await add.getByRole("button", { name: "Add signing key" }).click();
	const created = page.getByTestId("signing-key-created");
	await expect(created).toBeVisible();
	await expect(created.locator("code")).toContainText("ssh-ed25519");
	await expect(created.getByRole("button", { name: "Copy public key" })).toBeVisible();
	await created.getByRole("button", { name: "Close", exact: true }).last().click();
	await expect(created).toHaveCount(0);

	const row = page.getByRole("row").filter({ hasText: "e2e key" });
	await expect(row).toBeVisible();
	await expect(row).toContainText("No node trusts it");

	// Delete it again: no node trusts the key, so the first confirmation is enough.
	await row.getByRole("button", { name: "Delete signing key e2e key" }).click();
	const confirm = page.getByRole("dialog", { name: "Delete signing key?" });
	await confirm.getByRole("button", { name: "Delete" }).click();
	await expect(page.getByRole("row").filter({ hasText: "e2e key" })).toHaveCount(0);
	await expect
		.poll(async () =>
			(await crhs.api("/api/privilege/signing-keys")).json.keys.some(
				(key: { name: string | null }) => key.name === "e2e key",
			),
		)
		.toBe(false);
});
