import { fileURLToPath } from "node:url";
import { test } from "@playwright/test";
import {
	apiTokenView,
	assistantEntry,
	auditEvent,
	mockApi,
	nodeView,
	providerView,
	scheduleView,
	sessionListItem,
	snapshotEvent,
	sshCredentialView,
	taskView,
	toolEntries,
	USER,
	userEntry,
	userGroup,
} from "../helpers.ts";

/** Screenshots of every page in four variants, for a visual review of the WebUI. */
const OUT = fileURLToPath(new URL("./shots", import.meta.url));
const md = `Here is the plan:\n\n## Steps\n\n1. Check **disk** usage on \`db-1\`\n2. Rotate logs\n\n| Node | Free |\n|---|---|\n| db-1 | 12% |\n| web-1 | 64% |\n\n\`\`\`bash\ndf -h /var\njournalctl --vacuum-size=200M\n\`\`\`\n\n> Note: rotation is safe.\n\nSee [docs](https://example.com).`;
const entries = [
	userEntry("e1", "Check disk usage on all nodes and clean up if needed"),
	assistantEntry("e2", md),
	...toolEntries("e3", "df -h /var", "Filesystem Size Used Avail Use% Mounted on\n/dev/sda1 50G 44G 6G 88% /var"),
	assistantEntry("e4", "Disk on db-1 is at **88%**. I rotated logs; it is now at 61%."),
];
const sessions = [
	sessionListItem({ id: "s1", title: "Disk cleanup on db", state: "running" }),
	sessionListItem({ id: "s2", title: "Deploy check", state: "awaiting", waitingKind: "approval" }),
	sessionListItem({ id: "s3", title: "Nightly report", state: "idle", scheduleId: "schedule-1" }),
	sessionListItem({
		id: "s4",
		title: "Shared investigation of a very long title that should truncate nicely",
		state: "idle",
		shared: true,
	}),
];
// The directory resolves actor ids to names on the tasks, audit and node pages.
const state = {
	sessions,
	events: { s1: snapshotEvent(entries, null) },
	nodes: [
		nodeView(),
		nodeView({ id: "node-2", name: "web-1" } as never),
		nodeView({ id: "node-3", name: "ssh-1" } as never),
	],
	tasks: [
		taskView(),
		taskView({ id: "task-2", state: "awaiting_approval" } as never),
		taskView({ id: "task-3", state: "failed" } as never),
	],
	schedules: [scheduleView()],
	tokens: [apiTokenView()],
	audit: [auditEvent(), auditEvent({ id: "evt-2", action: "task.approved" } as never)],
	providers: [providerView()],
	models: [
		{
			provider: "faux",
			modelId: "faux-1",
			name: "Faux One",
			contextWindow: 128_000,
			thinkingLevels: ["off"],
			input: ["text"],
		},
	],
	directory: { users: [USER], userGroups: [userGroup()] },
	userGroups: [userGroup()],
	users: [USER],
	sshCredentials: [sshCredentialView()],
};
const routes = [
	["sessions", "/sessions"],
	["session", "/sessions/s1"],
	["schedules", "/schedules"],
	["schedule", "/schedules/schedule-1"],
	["nodes", "/nodes"],
	["node", "/nodes/node-1"],
	["tasks", "/tasks"],
	["task", "/tasks/task-1"],
	["approvals", "/approvals"],
	["signing-credentials", "/signing-credentials"],
	["authorizations", "/authorizations"],
	["tokens", "/tokens"],
	["audit", "/audit"],
	["models", "/settings/models"],
	["users", "/users"],
] as const;
const variants = [
	{ name: "light-desk", theme: "light", w: 1440, h: 900, locale: "en" },
	{ name: "dark-desk", theme: "dark", w: 1440, h: 900, locale: "en" },
	{ name: "light-mobile", theme: "light", w: 390, h: 844, locale: "en" },
	{ name: "dark-zh", theme: "dark", w: 1440, h: 900, locale: "zh-CN" },
];
for (const v of variants) {
	test(`${v.name} login`, async ({ page }) => {
		await page.setViewportSize({ width: v.w, height: v.h });
		await page.addInitScript(
			([t, l]) => {
				localStorage.setItem("crh.theme", t);
				localStorage.setItem("crh.locale", l);
			},
			[v.theme, v.locale],
		);
		await mockApi(page, { loggedIn: false });
		await page.goto("/login");
		await page.waitForTimeout(800);
		await page.screenshot({ path: `${OUT}/${v.name}-login.png` });
	});
	for (const [name, path] of routes) {
		test(`${v.name} ${name}`, async ({ page }) => {
			await page.setViewportSize({ width: v.w, height: v.h });
			await page.addInitScript(
				([t, l]) => {
					localStorage.setItem("crh.theme", t);
					localStorage.setItem("crh.locale", l);
				},
				[v.theme, v.locale],
			);
			const api = await mockApi(page, { loggedIn: true, state: state as never });
			await page.goto(path);
			if (name === "session") {
				await api.waitForStream("/api/sessions/s1/events").catch(() => {});
				await api.emit("/api/sessions/s1/events", "events", state.events.s1).catch(() => {});
			}
			await page.waitForTimeout(1500);
			await page.screenshot({ path: `${OUT}/${v.name}-${name}.png`, fullPage: v.w < 500 });
		});
	}
}

test("light-desk sessions without models shows the hint", async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.addInitScript(() => {
		localStorage.setItem("crh.theme", "light");
		localStorage.setItem("crh.locale", "en");
	});
	await mockApi(page, { loggedIn: true, state: { ...state, models: [] } as never });
	await page.goto("/sessions");
	await page.waitForTimeout(1000);
	await page.screenshot({ path: `${OUT}/light-desk-no-models.png` });
});
