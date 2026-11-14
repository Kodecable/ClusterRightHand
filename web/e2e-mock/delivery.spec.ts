import type { EntryRecord } from "@crh/api";
import { expect, test } from "@playwright/test";
import { login, mockApi, openSession, sessionListItem, sessionView, snapshotEvent, userEntry } from "./helpers";

const item = sessionListItem({ id: "s1", title: "Delivery session", updatedAt: new Date().toISOString() });

/** The offered library was renamed after the tool call; the card resolves it by id. */
const LIBRARY = {
	id: "lib-team",
	ref: "user_group:team-renamed",
	ownerKind: "user_group" as const,
	ownerId: "group-1",
	ownerName: "team-renamed",
	ownerDisplayName: "team-renamed",
	usage: { files: 0, bytes: 0 },
	limits: { files: 0, fileBytes: 0, totalBytes: 0 },
	capabilities: { write: true, manage: false },
};

/** The file name is shown in the tool arguments, so the ordinary row keeps it too. */
function deliveryEntries(final = false): EntryRecord[] {
	const entries: EntryRecord[] = [
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
							arguments: {
								source: { library: "user_group:team", path: "docs/report.txt" },
								destination: { user_interface: true },
							},
						},
					],
					stopReason: "toolUse",
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
							source: { library: "user_group:team", libraryId: "lib-team", path: "docs/report.txt" },
							name: "report.txt",
							bytes: 1234,
						},
					},
				},
			],
		},
	];
	if (final) {
		entries.push({
			id: "a2",
			kind: "pi.assistant",
			model: [
				{
					role: "assistant",
					content: [{ type: "text", text: "Here it is." }],
					timestamp: 2_000,
					durationMs: 1_000,
					stopReason: "stop",
				},
			],
		});
	}
	return entries;
}

test("a copy_file delivery is an ordinary tool row plus one delivered-file box", async ({ page }) => {
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

	// The call itself is a normal tool row: no dedicated card.
	await expect(page.getByTestId("tool-card")).toHaveCount(1);
	await expect(page.getByTestId("copy-delivery")).toHaveCount(0);

	const delivery = page.getByTestId("delivery-box");
	await expect(delivery).toContainText("report.txt");
	await expect(delivery).toContainText("user_group:team");
	await expect(delivery).toContainText("1.2 KiB");
	// The link follows the library id to the current reference, not the stored one.
	await expect(page.getByTestId("delivery-download")).toHaveAttribute(
		"href",
		"/api/libraries/user_group%3Ateam-renamed/file?path=docs%2Freport.txt",
	);
});

test("delivered files stay visible when the turn is folded", async ({ page }) => {
	const entries = deliveryEntries(true);
	const user = entries[0] as EntryRecord;
	if (user.model?.[0]?.role === "user") user.model[0].timestamp = 1_000;
	const api = await mockApi(page, {
		state: {
			sessions: [item],
			details: { s1: sessionView(item) },
			libraries: [LIBRARY],
			events: { s1: snapshotEvent(entries, null) },
		},
	});
	await login(page);
	await openSession(page, api, "s1");
	await expect(page.locator('[data-testid="session-page"]')).toBeVisible();

	// The process is folded, but the delivered file follows the turn's final answer.
	await expect(page.getByTestId("turn-summary")).toBeVisible();
	await expect(page.getByTestId("tool-card")).toHaveCount(0);
	await expect(page.getByTestId("delivery-box")).toContainText("report.txt");
	await expect(page.getByTestId("delivery-download")).toHaveAttribute(
		"href",
		"/api/libraries/user_group%3Ateam-renamed/file?path=docs%2Freport.txt",
	);
});
