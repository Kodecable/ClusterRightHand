import type { TaskSpec } from "@crh/protocol";
import { taskSpecToJson } from "@crh/protocol";
import { describe, expect, it } from "vitest";
import { summarizeAction, taskActionFor, taskActionOfSpec, taskActionView } from "../src/cluster/action.ts";
import { summarize } from "../src/cluster/spec.ts";

const spec = (value: TaskSpec): string => JSON.stringify(taskSpecToJson(value));

const exec = (...argv: string[]): TaskSpec => ({
	kind: "exec",
	command: { argv },
	env: {},
	cwd: "",
	stdin: null,
});

describe("the one structured task action", () => {
	it("maps every exec and file spec", () => {
		expect(taskActionOfSpec(exec("systemctl", "restart", "nginx"))).toEqual({
			type: "exec",
			command: "systemctl restart nginx",
		});
		expect(
			taskActionOfSpec({ kind: "exec", command: { shell: "echo hi | wc -l" }, env: {}, cwd: "", stdin: null }),
		).toEqual({
			type: "exec",
			command: "echo hi | wc -l",
		});
		expect(taskActionOfSpec({ kind: "file.read", path: "/etc/hosts", startLine: 5, lineCount: 3 })).toEqual({
			type: "file",
			operation: "read",
			path: "/etc/hosts",
			lines: { start: 5, end: 7 },
		});
		expect(
			taskActionOfSpec({
				kind: "file.write",
				path: "/etc/x",
				content: { size: 0, sha256: new Uint8Array(32) },
				overwrite: true,
				mode: 0o644,
				owner: "",
				group: "",
				createParentDirs: false,
			}),
		).toMatchObject({
			type: "file",
			operation: "write",
			path: "/etc/x",
		});
	});

	it("clips a long command to one line as the chat card needs", () => {
		const action = taskActionOfSpec(exec("/bin/sh", "-c", "x".repeat(400)));
		expect(action.type).toBe("exec");
		if (action.type !== "exec") throw new Error("wrong action");
		expect(action.command).toHaveLength(300);
		expect(action.command.endsWith("…")).toBe(true);
	});

	it("summarize derives from the action, keeping transfer details from the spec", () => {
		expect(summarize(spec(exec("uptime")))).toBe("uptime");
		expect(summarize(spec({ kind: "file.read", path: "/etc/hosts", startLine: 2, lineCount: 3 }))).toBe(
			"/etc/hosts (lines 2-4)",
		);
		expect(
			summarize(
				spec({
					kind: "file.push",
					path: "/srv/a",
					size: 12,
					sha256: new Uint8Array(32),
					overwrite: true,
					mode: 0o644,
					owner: "",
					group: "",
					createParentDirs: false,
					endpoint: { kind: "crhs", transferId: "tr1" },
				} as TaskSpec),
			),
		).toBe(`push /srv/a (12 bytes, sha256 ${"0".repeat(64)})`);
		expect(summarize("not json")).toBe("");
	});

	it("falls back for an unreadable stored spec", () => {
		expect(taskActionFor(null, "exec", "uptime")).toEqual({ type: "exec", command: "uptime" });
		expect(taskActionFor("not json", "file.read", "")).toEqual({ type: "exec", command: "file.read" });
	});
});

describe("taskActionView", () => {
	it("parses once and produces the same action and summary the view carries", () => {
		const { action, summary } = taskActionView(spec(exec("echo", "hi")), "exec");
		expect(action).toEqual({ type: "exec", command: "echo hi" });
		expect(summary).toBe("echo hi");
	});

	it("keeps the kind as the fallback command when the row is unreadable", () => {
		const { action, summary } = taskActionView("{", "file.stat");
		expect(action).toEqual({ type: "exec", command: "file.stat" });
		expect(summary).toBe("");
	});

	it("summarizes an api_request action independently of a spec", () => {
		expect(summarizeAction({ type: "api_request", method: "POST", path: "/api/sessions" })).toBe("POST /api/sessions");
		expect(summarizeAction({ type: "extension_tool", extension: "github", tool: "create_issue" })).toBe(
			"github/create_issue",
		);
	});
});
