import type { LibraryFile, LibraryView, User } from "@crh/api";
import { expect, test } from "@playwright/test";
import { login, mockApi, USER } from "./helpers";

const OPS_LIBRARY: LibraryView = {
	id: "lib-ops",
	ref: "user:ops",
	ownerKind: "user",
	ownerId: "user-1",
	ownerName: "ops",
	ownerDisplayName: "Ada Ops",
	usage: { files: 2, bytes: 15 },
	limits: { files: 256, fileBytes: 32 * 1024 * 1024, totalBytes: 256 * 1024 * 1024 },
	capabilities: { write: true, manage: true },
};

const TEAM_LIBRARY: LibraryView = {
	id: "lib-team",
	ref: "user_group:ops-team",
	ownerKind: "user_group",
	ownerId: "group-1",
	ownerName: "ops-team",
	ownerDisplayName: "ops-team",
	usage: { files: 0, bytes: 0 },
	limits: { files: 16, fileBytes: 1024 * 1024, totalBytes: 16 * 1024 * 1024 },
	capabilities: { write: true, manage: false },
};

const ADMIN: User = { ...USER, kind: "admin" };
const ALICE: User = { ...USER, id: "user-2", username: "alice", displayName: "Alice" };

const ALICE_LIBRARY: LibraryView = {
	...OPS_LIBRARY,
	id: "lib-alice",
	ref: "user:alice",
	ownerId: "user-2",
	ownerName: "alice",
	ownerDisplayName: "Alice",
	usage: { files: 0, bytes: 0 },
	capabilities: { write: true, manage: true },
};

const PNG: LibraryFile = {
	path: "pic.png",
	size: 10,
	sha256: "a".repeat(64),
	mediaType: "image/png",
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
};

const NOTES: LibraryFile = {
	path: "docs/notes.txt",
	size: 5,
	sha256: "b".repeat(64),
	mediaType: "text/plain",
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
};

test("browse, preview, upload and delete files in a library", async ({ page }) => {
	const api = await mockApi(page, {
		state: {
			libraries: [OPS_LIBRARY, TEAM_LIBRARY],
			libraryFiles: { "user:ops": [PNG, NOTES] },
		},
	});
	await login(page);
	await page.goto("/library/user%3Aops");

	await expect(page.getByTestId("library-page")).toBeVisible();
	await expect(page.getByTestId("library-page").getByRole("heading", { name: "Library" })).toBeVisible();
	await expect(page.getByTestId("library-selector")).toContainText("User Ada Ops's library");
	await expect(page.getByTestId("library-usage")).toContainText("0%");

	await page.getByTestId("library-usage").hover();
	const tooltip = page.locator('[data-slot="tooltip-content"]:visible').filter({ hasText: "File count limit" });
	await expect(tooltip).toContainText("File count limit: 1% (2/256)");
	await expect(tooltip).toContainText("Total size limit: 0% (15 B/256 MiB)");

	const root = page.getByRole("table", { name: "Files in User Ada Ops's library" });
	await expect(root).toContainText("pic.png");
	await page.getByRole("button", { name: "docs", exact: true }).click();
	await expect(page.getByRole("table", { name: "Files in docs" })).toContainText("notes.txt");

	await page.getByRole("button", { name: "User Ada Ops's library" }).click();
	await page.getByRole("button", { name: "Preview pic.png" }).click();
	await expect(page.getByTestId("file-preview-image")).toBeVisible();
	await page.getByRole("button", { name: "Close" }).click();

	await page.getByTestId("file-upload-input").setInputFiles({
		name: "hello.txt",
		mimeType: "text/plain",
		buffer: Buffer.from("hello"),
	});
	const upload = page.getByTestId("upload-progress-dialog");
	await expect(upload).toContainText("1 / 1");
	await upload.getByRole("button", { name: "Close" }).click();
	await expect(page.getByRole("table", { name: "Files in User Ada Ops's library" })).toContainText("hello.txt");

	await page.getByRole("button", { name: "Delete hello.txt" }).click();
	const dialog = page.getByRole("dialog", { name: "Delete hello.txt?" });
	await dialog.getByRole("button", { name: "Delete" }).click();
	await expect(page.getByRole("table", { name: "Files in User Ada Ops's library" })).not.toContainText("hello.txt");

	expect(
		api.state.requests.some((request) => request.method === "PUT" && request.url.includes("/file?path=hello.txt")),
	).toBe(true);
	expect(
		api.state.requests.some((request) => request.method === "DELETE" && request.url.includes("/file?path=hello.txt")),
	).toBe(true);
});

test("the one control switches to a user group library", async ({ page }) => {
	await mockApi(page, {
		user: { ...USER, kind: "member" },
		state: {
			libraries: [OPS_LIBRARY, TEAM_LIBRARY],
			libraryFiles: { "user:ops": [PNG], "user_group:ops-team": [] },
		},
	});
	await login(page);
	await page.goto("/library/user%3Aops");

	await page.getByRole("combobox", { name: "Library" }).click();
	await page.getByRole("option").filter({ hasText: "ops-team" }).click();
	await expect(page.getByTestId("library-selector")).toContainText("User group ops-team's library");
	await expect(page).toHaveURL(/user_group(%3A|:)ops-team/);
});

test("a refused upload is skipped and listed with its error", async ({ page }) => {
	await mockApi(page, {
		state: {
			libraries: [OPS_LIBRARY, TEAM_LIBRARY],
			libraryFiles: { "user:ops": [PNG, NOTES] },
			libraryUploadErrors: { "big.bin": "the file is larger than the library's one-file size limit" },
		},
	});
	await login(page);
	await page.goto("/library/user%3Aops");

	await page.getByTestId("file-upload-input").setInputFiles([
		{ name: "big.bin", mimeType: "application/octet-stream", buffer: Buffer.alloc(1) },
		{ name: "small.txt", mimeType: "text/plain", buffer: Buffer.from("ok") },
	]);
	const upload = page.getByTestId("upload-progress-dialog");
	await expect(upload.getByTestId("upload-failures")).toContainText("big.bin");
	await expect(upload.getByTestId("upload-failures")).toContainText(
		"the file is larger than the library's one-file size limit",
	);
	await expect(upload).toContainText("1 / 2");
	await upload.getByRole("button", { name: "Close" }).click();
	await expect(page.getByRole("table", { name: "Files in User Ada Ops's library" })).toContainText("small.txt");
	await expect(page.getByRole("table", { name: "Files in User Ada Ops's library" })).not.toContainText("big.bin");
});

test("an administrator opens any user's library from the control", async ({ page }) => {
	await mockApi(page, {
		user: ADMIN,
		state: {
			users: [ALICE],
			libraries: [OPS_LIBRARY, ALICE_LIBRARY],
			libraryFiles: { "user:ops": [PNG], "user:alice": [] },
		},
	});
	await login(page);
	await page.goto("/library/user%3Aops");

	await page.getByRole("combobox", { name: "Library" }).click();
	await page.getByRole("combobox", { name: "Search users and user groups…" }).fill("alice");
	await page.getByRole("option").filter({ hasText: "alice" }).click();
	await expect(page.getByTestId("library-selector")).toContainText("User Alice's library");
	await expect(page).toHaveURL(/user(%3A|:)alice/);
});

test("hides the size and updated columns on a narrow screen", async ({ page }) => {
	await page.setViewportSize({ width: 700, height: 900 });
	await mockApi(page, {
		state: {
			libraries: [OPS_LIBRARY, TEAM_LIBRARY],
			libraryFiles: { "user:ops": [PNG, NOTES] },
		},
	});
	await login(page);
	await page.goto("/library/user%3Aops");

	await expect(page.getByRole("table", { name: "Files in User Ada Ops's library" })).toBeVisible();
	await expect(page.getByRole("columnheader", { name: "Size" })).toHaveCount(0);
	await expect(page.getByRole("columnheader", { name: "Updated" })).toHaveCount(0);
	await expect(page.getByRole("columnheader", { name: "Name" })).toBeVisible();
});
