import { expect, test } from "@playwright/test";
import { login, mockApi, openSession, sessionListItem, sessionView, snapshotEvent, userEntry } from "./helpers";

const item = sessionListItem({ id: "s1", title: "Attachment session", updatedAt: new Date().toISOString() });

const LIBRARY = {
	id: "lib-ops",
	ref: "user:ops",
	ownerKind: "user" as const,
	ownerId: "user-1",
	ownerName: "ops",
	ownerDisplayName: "Ada Ops",
	usage: { files: 0, bytes: 0 },
	limits: { files: 256, fileBytes: 32 * 1024 * 1024, totalBytes: 256 * 1024 * 1024 },
	capabilities: { write: true, manage: true },
};

test("the owner attaches an uploaded file and the message carries it", async ({ page }) => {
	const api = await mockApi(page, {
		state: {
			sessions: [item],
			details: { s1: sessionView(item) },
			libraries: [LIBRARY],
			libraryFiles: { "user:ops": [] },
			events: { s1: snapshotEvent([userEntry("u1", "hello")], null) },
		},
	});
	await login(page);
	await openSession(page, api, "s1");
	await expect(page.locator('[data-testid="session-page"]')).toBeVisible();

	await page.getByTestId("composer-attach").click();
	await expect(page.getByTestId("composer-upload")).toContainText("Upload files");
	await expect(page.getByTestId("composer-choose-library")).toContainText("Choose from library");
	await page.keyboard.press("Escape");
	await page.getByTestId("composer-upload-input").setInputFiles({
		name: "notes.txt",
		mimeType: "text/plain",
		buffer: Buffer.from("hello"),
	});
	await expect(page.getByTestId("composer-attachments")).toContainText("notes.txt");
	await expect(page.getByTestId("composer-attachment")).toHaveAttribute("data-status", "done");

	await page.getByTestId("composer-input").fill("see attached");
	await page.getByTestId("composer-send").click();
	await expect
		.poll(
			() => api.state.requests.find((request) => request.method === "POST" && request.url.endsWith("/messages"))?.body,
		)
		.toMatchObject({
			text: "see attached",
			attachments: [{ library: "user:ops" }],
		});
	const sent = api.state.requests.find((request) => request.method === "POST" && request.url.endsWith("/messages"));
	const body = sent?.body as { attachments?: { path?: string }[] };
	expect(body.attachments?.[0]?.path).toMatch(/^attachments\/\d{4}-\d{2}\/notes\.txt$/);
});
