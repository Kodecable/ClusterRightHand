import type { Page } from "@playwright/test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "../../server/test/e2e/harness.ts";
import { expect, newSession, sendMessage, test } from "./fixtures.ts";

test.use({ withAgent: true, withNode: true, streamRate: 100 });

/** Records every `data-state` value the session's list row takes, in order (duplicates collapsed). */
async function recordSessionStates(page: Page, sessionId: string): Promise<void> {
	await page.evaluate((id) => {
		const target = window as unknown as { __crhStates: string[] };
		target.__crhStates = [];
		const read = () => {
			const element = document.querySelector(`[data-session-id="${id}"][data-state]`);
			const state = element?.getAttribute("data-state");
			if (state !== null && state !== undefined) target.__crhStates.push(state);
		};
		read();
		new MutationObserver(read).observe(document.body, {
			subtree: true,
			attributes: true,
			attributeFilter: ["data-state"],
		});
	}, sessionId);
}

async function sessionStates(page: Page): Promise<string[]> {
	const raw = await page.evaluate(() => (window as unknown as { __crhStates: string[] }).__crhStates);
	return raw.filter((state, index) => index === 0 || state !== raw[index - 1]);
}

/** Whether `wanted` appears in `states` in this order (gaps allowed). */
function inOrder(states: string[], wanted: string[]): boolean {
	let at = 0;
	for (const state of states) {
		if (state === wanted[at]) at += 1;
		if (at === wanted.length) return true;
	}
	return false;
}

test("a faux-model session streams text, runs a tool call, waits for an inline approval and settles", async ({
	adminPage: page,
	crhs,
	env,
}) => {
	if (!env) throw new Error("withNode");
	crhs.faux.setResponses([
		fauxAssistantMessage(
			[fauxToolCall("exec", { node: env.nodeId, cmd: "sleep 0.4; echo approve-me" }, { id: "call-1" })],
			{
				stopReason: "toolUse",
			},
		),
		fauxAssistantMessage([fauxText(`Approved and done. ${"The command printed approve-me. ".repeat(40)}`)]),
	]);
	await newSession(page, "Transcript run", "Yolo");
	// Switch to Ask: the tool call then waits for the owner's approval.
	await page.getByRole("button", { name: "Session settings" }).click();
	await page.getByLabel("Preset").click();
	await page.getByRole("option", { name: "Ask", exact: true }).click();
	await page.keyboard.press("Escape");

	const sessionId = await page.evaluate(() =>
		document.querySelector("[data-testid=session-page]")?.getAttribute("data-session-id"),
	);
	expect(sessionId).toBeTruthy();
	await recordSessionStates(page, sessionId as string);

	await sendMessage(page, "run the command");

	// The tool call shows up as a card while the model's message streams.
	const card = page.getByTestId("tool-card").filter({ hasText: "exec" });
	await expect(card).toBeVisible({ timeout: 15_000 });
	await expect(page.getByTestId("waiting-reason")).toContainText("waiting for an approval");

	// State dot: running while the model streams, awaiting while the approval is open.
	await expect.poll(() => sessionStates(page), { timeout: 15_000 }).toEqual(expect.arrayContaining(["running"]));
	await expect
		.poll(
			() =>
				page.evaluate(
					(id) => document.querySelector(`[data-session-id="${id}"]`)?.getAttribute("data-state"),
					sessionId,
				),
			{
				timeout: 15_000,
			},
		)
		.toBe("awaiting");

	// The inline card (the same one the Approvals page shows) approves the task.
	const wait = page.getByTestId("session-waits");
	await expect(wait.getByRole("region", { name: /^Task / })).toBeVisible({ timeout: 15_000 });
	await wait.getByRole("button", { name: "Approve", exact: true }).click();

	// The run continues: the answer is streamed into a growing row, then the task's result arrives.
	await expect(page.getByTestId("streaming-text")).toBeVisible({ timeout: 15_000 });
	await expect(page.getByTestId("transcript-scroller")).toContainText("Approved and done.", { timeout: 30_000 });
	await expect(card).toHaveAttribute("data-tool-status", "done", { timeout: 30_000 });

	// running → awaiting → running → idle, as the list stream publishes the root's state.
	await expect
		.poll(
			() =>
				page.evaluate(
					(id) => document.querySelector(`[data-session-id="${id}"]`)?.getAttribute("data-state"),
					sessionId,
				),
			{
				timeout: 30_000,
			},
		)
		.toBe("idle");
	const states = await sessionStates(page);
	expect(inOrder(states, ["running", "awaiting", "running", "idle"]), `states: ${states.join(" → ")}`).toBe(true);
});

test("the transcript renders Markdown safely with no remote request", async ({ adminPage: page, crhs }) => {
	crhs.faux.setResponses([
		fauxAssistantMessage([
			fauxText(
				[
					'<img src="https://evil.example/tracking.png" onerror="window.__crhPwned=1">',
					"![remote](https://evil.example/image.png)",
					"[bad](javascript:window.__crhPwned=2)",
					"<script>window.__crhPwned=3</script>",
					"Normal **text** with `code`.",
				].join("\n\n"),
			),
		]),
	]);
	let remoteRequests = 0;
	await page.route("**/*", (route) => {
		const url = route.request().url();
		if (url.startsWith(crhs.url) || url === "about:blank") return route.fallback();
		remoteRequests += 1;
		return route.abort();
	});
	await newSession(page, "Safe markdown");
	await sendMessage(page, "show me");
	await expect(page.getByTestId("safe-markdown").first()).toBeVisible({ timeout: 20_000 });
	await expect(page.getByTestId("transcript-scroller")).toContainText("Normal");
	expect(remoteRequests).toBe(0);
	expect(await page.evaluate(() => (window as unknown as { __crhPwned?: number }).__crhPwned)).toBeUndefined();
	expect(await page.locator('[data-testid="safe-markdown"] img').count()).toBe(0);
});
