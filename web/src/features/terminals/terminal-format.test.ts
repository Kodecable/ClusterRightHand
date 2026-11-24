import type { PublicNode } from "@crh/api";
import { i18n } from "@lingui/core";
import { beforeAll, describe, expect, test } from "vitest";
import { activateLocale } from "@/lib/i18n";
import {
	selectableTerminalNodes,
	terminalCommand,
	terminalHeading,
	terminalStateLabel,
	terminalStateTone,
} from "./terminal-format";

beforeAll(async () => {
	await activateLocale("en");
});

function node(overrides: Partial<PublicNode>): PublicNode {
	return {
		id: "node-1",
		name: "worker-01",
		transport: "client",
		status: "active",
		hostname: "worker-01.local",
		clientVersion: "1.0.0",
		privilegedMode: null,
		lastSeenAt: "2026-01-01T00:00:00.000Z",
		createdAt: "2026-01-01T00:00:00.000Z",
		approvedAt: "2026-01-01T00:00:00.000Z",
		nodeGroups: [],
		access: "admin",
		facts: null,
		keyFingerprint: null,
		connected: true,
		clockWarning: null,
		trustWarnings: [],
		...overrides,
	};
}

describe("terminalStateLabel", () => {
	test("labels every lifecycle state", () => {
		expect(terminalStateLabel(i18n, "opening")).toBe("Opening");
		expect(terminalStateLabel(i18n, "running")).toBe("Running");
		expect(terminalStateLabel(i18n, "exited")).toBe("Exited");
	});

	test("keeps an unknown state visible instead of hiding it", () => {
		expect(terminalStateLabel(i18n, "something_else")).toBe("something_else");
	});

	test("tones opening as a wait and running as healthy", () => {
		expect(terminalStateTone("opening")).toBe("warn");
		expect(terminalStateTone("running")).toBe("info");
		expect(terminalStateTone("exited")).toBe("muted");
	});
});

describe("terminalHeading", () => {
	test("prefers the program's title", () => {
		expect(terminalHeading("build log", [], "Terminal")).toBe("build log");
	});

	test("treats a whitespace-only title as no title", () => {
		expect(terminalHeading("   ", ["top"], "Terminal")).toBe("top");
	});

	test("falls back to the argv joined with spaces", () => {
		expect(terminalHeading("", ["bash", "-lc", "echo 'hi'"], "Terminal")).toBe("bash -lc echo 'hi'");
	});

	test("falls back to the generic terminal label for an empty argv", () => {
		expect(terminalHeading("", [], "Terminal")).toBe("Terminal");
	});
});

describe("terminalCommand", () => {
	test("shell-quotes every argument and names the login shell for an empty argv", () => {
		expect(terminalCommand([], "login shell")).toBe("login shell");
		expect(terminalCommand(["top", "-d", "5"], "login shell")).toBe("top -d 5");
		expect(terminalCommand(["bash", "-lc", "echo 'hi'"], "login shell")).toBe("bash -lc 'echo '\\''hi'\\'''");
	});
});

describe("selectableTerminalNodes", () => {
	test("offers only active crha nodes, never SSH nodes", () => {
		const active = node({ id: "node-1" });
		const pending = node({ id: "node-2", status: "pending" });
		const ssh = node({ id: "node-3", transport: "ssh" });
		expect(selectableTerminalNodes([active, pending, ssh]).map((entry) => entry.id)).toEqual(["node-1"]);
	});
});
