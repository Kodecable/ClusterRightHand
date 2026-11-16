import { expect, test } from "@playwright/test";
import {
	assistantEntry,
	login,
	mockApi,
	openSession,
	sessionListItem,
	sessionView,
	snapshotEvent,
	userEntry,
} from "./helpers";

/** Open a session whose only turn ended with the given final answer (unless the detail says it is running). */
async function openTurn(
	page: import("@playwright/test").Page,
	options: { state?: "idle" | "running"; owner?: boolean } = {},
) {
	const item = sessionListItem({ id: "s1", title: "Deploy the cluster" });
	const viewer = options.owner === false;
	const detail = sessionView(item, {
		...(options.state === undefined ? {} : { state: options.state }),
		...(viewer
			? {
					relationship: "shared",
					capabilities: { view: true, chat: false, manageShares: false, createShares: false, configure: false },
				}
			: {}),
	});
	const api = await mockApi(page, {
		state: {
			sessions: viewer ? [{ ...item, ownerUserId: "user-2", ownerName: "Bob", shared: true }] : [item],
			details: { s1: detail },
			events: { s1: snapshotEvent([userEntry("1", "question"), assistantEntry("2", "the answer")], null) },
		},
	});
	await login(page);
	await openSession(page, api, "s1");
	return api;
}

test("the owner forks an ended turn and lands on the new session", async ({ page }) => {
	const api = await openTurn(page);
	await page.getByTestId("message").last().hover();
	await page.getByRole("button", { name: "Fork from here" }).click();

	await expect(page).toHaveURL(/\/sessions\/fork-1$/);
	await expect(page.getByTestId("forked-from")).toHaveText("Forked from Deploy the cluster");
	await expect(page.getByTestId("forked-from").getByRole("link", { name: "Deploy the cluster" })).toHaveAttribute(
		"href",
		"/sessions/s1",
	);

	const request = api.state.requests.find((candidate) => candidate.url.endsWith("/api/sessions/s1/fork"));
	if (request === undefined) throw new Error("the fork request was not made");
	expect(request.method).toBe("POST");
	expect(request.body).toMatchObject({ entryId: 2 });
	expect(typeof (request.body as { requestId?: unknown }).requestId).toBe("string");
});

test("a share viewer sees the copy action but no fork", async ({ page }) => {
	await openTurn(page, { owner: false });
	await page.getByTestId("message").last().hover();
	await expect(page.getByRole("button", { name: "Copy reply" })).toBeVisible();
	await expect(page.getByRole("button", { name: "Fork from here" })).toHaveCount(0);
});

test("a running turn's final reply is not forkable yet", async ({ page }) => {
	await openTurn(page, { state: "running" });
	await page.getByTestId("message").last().hover();
	await expect(page.getByRole("button", { name: "Copy reply" })).toBeVisible();
	await expect(page.getByRole("button", { name: "Fork from here" })).toHaveCount(0);
});
