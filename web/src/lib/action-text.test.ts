import { i18n } from "@lingui/core";
import { beforeAll, describe, expect, test } from "vitest";
import { activateLocale } from "@/lib/i18n";
import { actionText } from "./action-text";

beforeAll(async () => {
	await activateLocale("en");
});

describe("actionText", () => {
	test("renders every action in the one shared form", () => {
		expect(actionText(i18n, { type: "exec", command: "systemctl restart nginx" })).toBe("systemctl restart nginx");
		expect(actionText(i18n, { type: "file", operation: "read", path: "/etc/hosts", lines: { start: 2, end: 4 } })).toBe(
			"Read file /etc/hosts (lines 2-4)",
		);
		expect(actionText(i18n, { type: "file", operation: "write", path: "/etc/x" })).toBe("Write file /etc/x");
		expect(actionText(i18n, { type: "file", operation: "push", path: "/srv/a" })).toBe("Push file /srv/a");
		expect(actionText(i18n, { type: "file", operation: "pull", path: "/srv/a" })).toBe("Pull file /srv/a");
		expect(actionText(i18n, { type: "file", operation: "edit", path: "/srv/a" })).toBe("Edit file /srv/a");
		expect(actionText(i18n, { type: "file", operation: "stat", path: "/srv/a" })).toBe("Stat file /srv/a");
		expect(actionText(i18n, { type: "file", operation: "list", path: "/srv" })).toBe("List directory /srv");
		expect(actionText(i18n, { type: "api_request", method: "POST", path: "/api/sessions" })).toBe("POST /api/sessions");
		expect(actionText(i18n, { type: "extension_tool", extension: "github", tool: "create_issue" })).toBe(
			"github/create_issue",
		);
	});

	test("keeps a command on one line", () => {
		expect(actionText(i18n, { type: "exec", command: "echo a\necho b" })).toBe("echo a echo b");
	});
});
