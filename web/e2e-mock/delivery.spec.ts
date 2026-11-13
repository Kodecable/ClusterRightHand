import type { EntryRecord } from "@crh/api";
import { expect, test } from "@playwright/test";
import { login, mockApi, openSession, sessionListItem, sessionView, snapshotEvent, userEntry } from "./helpers";

const item = sessionListItem({ id: "s1", title: "Delivery session", updatedAt: new Date().toISOString() });

/** The offered library was renamed after the tool call; the card resolves it by id. */
const LIBRARY = {
	id: "lib-team",
	ref: "group:team-renamed",
	ownerKind: "group" as const,
	ownerId: "group-1",
	ownerName: "team-renamed",
	ownerDisplayName: "team-renamed",
	usage: { files: 0, bytes: 0 },
	limits: { files: 0, fileBytes: 0, totalBytes: 0 },
	capabilities: { write: true, manage: false },
};

/** A completed copy_file call that offered a library file to the user, as the server records it. */
function deliveryEntries(): EntryRecord[] {
	return [
		userEntry("u1", "hand me the report"),
		{
			id: "a1",
			kind: "pi.assistant",
			model: [
				{
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "call-1",
							name: "copy_file",
							arguments: { source: { library: "group:team", path: "docs/report.txt" }, to_user: true },
						},
					],
				},
			],
		},
		{
			id: "r1",
			kind: "pi.tool-result",
			model: [
				{
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "copy_file",
					content: [{ type: "text", text: "[copy_file offered report.txt, 1234 bytes, to the user for download]" }],
					isError: false,
					details: {
						delivery: {
							source: { library: "group:team", libraryId: "lib-team", path: "docs/report.txt" },
							name: "report.txt",
							bytes: 1234,
						},
					},
				},
			],
		},
	];
}

test("a copy_file delivery shows its file, source and path with a download link", async ({ page }) => {
	const api = await mockApi(page, {
		state: {
			sessions: [item],
			details: { s1: sessionView(item) },
			libraries: [LIBRARY],
			events: { s1: snapshotEvent(deliveryEntries(), null) },
		},
	});
	await login(page);
	await openSession(page, api, "s1");
	await expect(page.locator('[data-testid="session-page"]')).toBeVisible();

	const delivery = page.getByTestId("copy-delivery");
	await expect(delivery).toContainText("report.txt");
	await expect(delivery).toContainText("group:team");
	await expect(delivery).toContainText("docs/report.txt");
	await expect(delivery).toContainText("1.2 KiB");
	// The link follows the library id to the current reference, not the stored one.
	await expect(page.getByTestId("copy-delivery-download")).toHaveAttribute(
		"href",
		"/api/libraries/group%3Ateam-renamed/file?path=docs%2Freport.txt",
	);
});
