import { fauxAssistantMessage, fauxText, fauxToolCall } from "../../server/test/e2e/harness.ts";
import { expect, newSession, sendMessage, test } from "./fixtures.ts";

test.use({ withAgent: true });

test("a subagent session appears in its parent's child list", async ({ adminPage: page, crhs }) => {
	crhs.faux.setResponses([
		fauxAssistantMessage(
			[
				fauxToolCall("subagent", { task: "say one" }, { id: "s1" }),
				fauxToolCall("subagent", { task: "say two" }, { id: "s2" }),
			],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage([fauxText("child one")]),
		fauxAssistantMessage([fauxText("child two")]),
		fauxAssistantMessage([fauxText("both children answered")]),
	]);
	await newSession(page, "Parent session", "Yolo");
	await sendMessage(page, "delegate to two subagents");

	// Both children come from GET /sessions/:id/children (through the subagent tool update),
	// newest first, each with its own state dot.
	const children = page.getByTestId("child-session");
	await expect(children).toHaveCount(2, { timeout: 30_000 });
	await expect(children.first()).toHaveAttribute("data-state", "idle", { timeout: 30_000 });
	const urls = await children.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-session-id")));
	expect(urls.filter((id): id is string => id !== null)).toHaveLength(2);

	// Opening one shows the child's breadcrumb back to the parent and its own transcript.
	await children.first().click();
	await expect(page).toHaveURL(/\/sessions\/[^/]+$/);
	await expect(page.getByTestId("session-breadcrumb")).toContainText("Parent session");
	await expect(page.getByTestId("transcript-scroller")).toContainText("child", { timeout: 20_000 });
});
