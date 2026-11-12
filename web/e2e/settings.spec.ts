import { expect, test } from "./fixtures.ts";

test("an administrator changes the public URL and adds and deletes an authorization signing key", async ({
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

	// Add a signing key; the confirmation has nothing to fill in, and the created dialog shows the
	// public key line for privileged.toml and the fingerprint that identifies the key.
	await page.getByTestId("add-signing-key").click();
	const add = page.getByRole("dialog", { name: "Add authorization signing key" });
	await add.getByRole("button", { name: "Add authorization signing key" }).click();
	const created = page.getByTestId("signing-key-created");
	await expect(created).toBeVisible();
	await expect(created.locator("code")).toContainText("ssh-ed25519");
	const fingerprint = (await created.getByText(/^SHA256:/).textContent())?.trim() ?? "";
	expect(fingerprint).toMatch(/^SHA256:/);
	await created.getByRole("button", { name: "Copy and close" }).click();
	await expect(created).toHaveCount(0);

	const row = page.getByRole("row").filter({ hasText: fingerprint });
	await expect(row).toBeVisible();
	await expect(row).toContainText("None");

	// Delete it again: no node trusts the key, so the first confirmation is enough.
	await row.getByRole("button", { name: `Delete authorization signing key ${fingerprint}` }).click();
	const confirm = page.getByRole("dialog", { name: "Delete authorization signing key?" });
	await confirm.getByRole("button", { name: "Delete" }).click();
	await expect(page.getByRole("row").filter({ hasText: fingerprint })).toHaveCount(0);
	await expect
		.poll(async () =>
			(await crhs.api("/api/privilege/signing-keys")).json.keys.some(
				(key: { fingerprint: string }) => key.fingerprint === fingerprint,
			),
		)
		.toBe(false);
});
