import { fileURLToPath } from "node:url";
import { test } from "@playwright/test";
import {
	assistantEntry,
	mockApi,
	sessionListItem,
	sessionView,
	snapshotEvent,
	toolEntries,
	userEntry,
} from "../helpers.ts";

/**
 * The session page's review screenshots (doc/webui.md "会话界面"): light and dark, desktop and phone.
 * `CRH_SHOT_DIR` puts them outside the repository (the UI4 task's report lists them there); the default is a
 * folder next to this spec.
 */
const OUT = process.env.CRH_SHOT_DIR ?? fileURLToPath(new URL("./session-shots", import.meta.url));

const now = new Date();
const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();
const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();

const s1 = sessionListItem({ id: "s1", title: "Disk cleanup on db-1", state: "running", updatedAt: ago(0) });
const sessions = [
	s1,
	sessionListItem({
		id: "s2",
		title: "Deploy check",
		state: "awaiting",
		waitingKind: "approval",
		updatedAt: ago(90),
	}),
	sessionListItem({
		id: "s3",
		title: "Nightly report",
		state: "idle",
		scheduleId: "schedule-1",
		updatedAt: daysAgo(1),
	}),
	sessionListItem({ id: "s4", title: "Investigate the auth gateway", state: "idle", updatedAt: daysAgo(4) }),
	sessionListItem({ id: "s5", title: "Rotate the staging keys", state: "idle", shared: true, updatedAt: daysAgo(12) }),
	sessionListItem({ id: "s6", title: "Quarterly capacity review", state: "idle", updatedAt: daysAgo(45) }),
];

const children = [
	sessionListItem({
		id: "c1",
		title: "Measure disk usage",
		parentSessionId: "s1",
		state: "running",
		updatedAt: ago(2),
	}),
	sessionListItem({
		id: "c2",
		title: "Rotate the logs",
		parentSessionId: "s1",
		state: "awaiting",
		waitingKind: "approval",
		updatedAt: ago(4),
	}),
	sessionListItem({
		id: "c3",
		title: "Summarize the findings",
		parentSessionId: "s1",
		state: "idle",
		updatedAt: ago(6),
	}),
];

const markdown = `Here is the plan:\n\n## Steps\n\n1. Check **disk** usage on \`db-1\`\n2. Rotate logs\n\n| Node | Free |\n|---|---|\n| db-1 | 12% |\n| web-1 | 64% |\n\n\`\`\`bash\ndf -h /var\njournalctl --vacuum-size=200M\n\`\`\`\n\n> Rotation is safe.`;

const entries = [
	userEntry("e1", "Check disk usage on db-1 and clean up if needed"),
	assistantEntry("e2", markdown),
	// A returned, successful call: the wrench icon.
	...toolEntries(
		"e3",
		"df -h /var",
		JSON.stringify({ task_id: "task-ok", node: "db-1", state: "exited", exit_code: 0 }),
	),
	// A call that has not returned yet: the spinner icon.
	{
		id: "e4",
		kind: "pi.assistant",
		model: [
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "call-running",
						name: "exec",
						arguments: { cmd: "journalctl --vacuum-size=200M", targets: ["db-1"] },
					},
				],
			},
		],
	},
	// A returned task failure (exit 2): the danger-coloured wrench icon.
	{
		id: "e5",
		kind: "pi.assistant",
		model: [
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "call-failed",
						name: "exec",
						arguments: { cmd: "systemctl restart nginx", targets: ["db-1"] },
					},
				],
			},
		],
	},
	{
		id: "e6",
		kind: "pi.tool-result",
		model: [
			{
				role: "toolResult",
				toolCallId: "call-failed",
				toolName: "exec",
				content: [
					{
						type: "text",
						text: JSON.stringify({
							task_id: "task-failed",
							node: "db-1",
							state: "exited",
							exit_code: 2,
							stderr: "Job for nginx.service failed.",
						}),
					},
				],
				isError: false,
			},
		],
	},
	assistantEntry("e7", "Disk on db-1 is at **88%**. I rotated logs; it is now at 61%."),
];

/** The snapshot plus the event that puts the middle card in the running state. */
const events = [
	...snapshotEvent(entries, null),
	{
		type: "tool_execution_start" as const,
		toolCallId: "call-running",
		toolName: "exec",
		args: { cmd: "journalctl --vacuum-size=200M", targets: ["db-1"] },
	},
];

const state = {
	sessions,
	children: { s1: children },
	details: {
		s1: sessionView(s1, {
			budgetRemaining: 12_345,
			budgetUsedTokens: 42_000,
			usageTokens: 1_540_000,
			contextTokens: 81_000,
			state: "running",
		} as never),
	},
	models: [{ provider: "faux", modelId: "faux-1", name: "Faux One", contextWindow: 128_000 }],
	events: { s1: events },
};

const variants = [
	{ name: "light-desk", theme: "light", width: 1440, height: 900 },
	{ name: "dark-desk", theme: "dark", width: 1440, height: 900 },
	{ name: "light-mobile", theme: "light", width: 390, height: 844 },
	{ name: "dark-mobile", theme: "dark", width: 390, height: 844 },
];

for (const variant of variants) {
	test(`${variant.name} session page`, async ({ page }) => {
		await page.setViewportSize({ width: variant.width, height: variant.height });
		await page.addInitScript(
			([theme]) => {
				localStorage.setItem("crh.theme", theme);
				localStorage.setItem("crh.locale", "en");
			},
			[variant.theme],
		);
		const api = await mockApi(page, { loggedIn: true, state: state as never });
		await page.goto("/sessions/s1");
		await api.waitForStream("/api/sessions/s1/events").catch(() => {});
		await api.emit("/api/sessions/s1/events", "events", state.events.s1).catch(() => {});
		await page.waitForTimeout(1200);
		await page.screenshot({ path: `${OUT}/${variant.name}-session.png` });

		// The children tree, on the desktop sizes.
		if (variant.width === 1440) {
			await page.getByTestId("children-bar").click();
			await page.waitForTimeout(500);
			await page.screenshot({ path: `${OUT}/${variant.name}-session-children.png` });
		}
	});
}
