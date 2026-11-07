import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import type { SshSession } from "../src/cluster/ssh/connection.ts";
import {
	buildCommand,
	parseShellProbe,
	probeShells,
	runSshExec,
	SHELL_PROBE_COMMAND,
} from "../src/cluster/ssh/exec.ts";

/**
 * The remote command line of an SSH task and the per-connection shell probe
 * (doc/execution-plane.md#执行). The SSH integration tests need a real sshd (the M4 container);
 * these checks are unit level.
 */

const WRAPPER = `'printf '\\''crh-pgid:%s\\n'\\'' "$$" >&2; exec 2>&1; exec "$@"'`;

/** A session whose one exec channel emits output and then closes with code. */
function fakeSession(command: string, output: string, code: number | null): SshSession {
	const session = {
		exec: async (actual: string, onChannel: (channel: unknown) => void) => {
			expect(actual).toBe(command);
			const handlers = new Map<string, (arg?: unknown) => void>();
			const channel = {
				on: (event: string, fn: (arg?: unknown) => void) => handlers.set(event, fn),
				stderr: { resume: () => {} },
				close: () => {},
			};
			onChannel(channel);
			setImmediate(() => {
				handlers.get("data")?.(Buffer.from(output));
				handlers.get("close")?.(code);
			});
			return channel;
		},
	};
	return session as unknown as SshSession;
}

function execSpec(
	command: { argv: string[] } | { shell: string },
	env: Record<string, string> = {},
	cwd = "",
): {
	kind: "exec";
	command: { argv: string[] } | { shell: string };
	env: Record<string, string>;
	cwd: string;
	stdin: null;
} {
	return { kind: "exec", command, env, cwd, stdin: null };
}

describe("SSH remote command", () => {
	it("execs an argv task through the probed sh with LANG and LC_ALL set", () => {
		expect(buildCommand(execSpec({ argv: ["id", "-u"] }), "/usr/bin/sh")).toBe(
			`cd / || exit 127; exec env -- LANG=C.UTF-8 LC_ALL=C.UTF-8 /usr/bin/sh -c ${WRAPPER} crh id -u`,
		);
	});

	it("runs a shell command as <sh> -c <cmd>", () => {
		expect(buildCommand(execSpec({ shell: "echo hi; whoami" }, {}, "/tmp/x"), "/usr/local/bin/sh")).toBe(
			`cd /tmp/x || exit 127; exec env -- LANG=C.UTF-8 LC_ALL=C.UTF-8 /usr/local/bin/sh -c ${WRAPPER} crh /usr/local/bin/sh -c 'echo hi; whoami'`,
		);
	});

	it("falls back to /bin/sh when the probe found none", () => {
		expect(buildCommand(execSpec({ argv: ["true"] }))).toContain("exec env -- LANG=C.UTF-8 LC_ALL=C.UTF-8 /bin/sh -c");
	});

	it("passes the task's own variables after LANG and LC_ALL so they win", () => {
		const command = buildCommand(execSpec({ argv: ["env"] }, { LANG: "de_DE.UTF-8", A: "b c" }));
		expect(command).toContain("LANG=C.UTF-8 LC_ALL=C.UTF-8 LANG=de_DE.UTF-8 'A=b c'");
	});

	it("drops CRHA_TASK_* variables and rejects invalid names", () => {
		const command = buildCommand(execSpec({ argv: ["env"] }, { CRHA_TASK_HOME: "/root", KEEP: "1" }));
		expect(command).not.toContain("CRHA_TASK_HOME");
		expect(command).toContain("KEEP=1");
		expect(() => buildCommand(execSpec({ argv: ["env"] }, { "A=B": "1" }))).toThrow(/invalid environment/);
	});

	it("rejects an empty command and a relative cwd", () => {
		expect(() => buildCommand(execSpec({ argv: [] }))).toThrow(/argv or shell/);
		expect(() => buildCommand(execSpec({ argv: [""] }, {}, "tmp"))).toThrow(/cwd must be absolute/);
	});
});

describe("SSH shell probe", () => {
	it("parses the probe's lines and treats a missing path as not found", () => {
		expect(parseShellProbe("crh-shell sh /bin/sh\ncrh-shell bash /usr/bin/bash\n")).toEqual({
			sh: "/bin/sh",
			bash: "/usr/bin/bash",
		});
		expect(parseShellProbe("crh-shell sh /bin/sh\ncrh-shell bash \n")).toEqual({
			sh: "/bin/sh",
			bash: null,
		});
		expect(parseShellProbe("noise\ncrh-shell dash /bin/dash\n")).toEqual({ sh: null, bash: null });
		// A relative path is not a discovered shell: the caller falls back to /bin/sh.
		expect(parseShellProbe("crh-shell sh sh\n")).toEqual({ sh: null, bash: null });
	});

	it("is a POSIX sh script that reads /etc/shells and falls back to command -v", () => {
		expect(SHELL_PROBE_COMMAND).toContain("</etc/shells");
		expect(SHELL_PROBE_COMMAND).toContain("command -v");
	});

	it("collects the probe output of a new connection", async () => {
		const session = fakeSession(SHELL_PROBE_COMMAND, "crh-shell sh /bin/sh\ncrh-shell bash /usr/bin/bash\n", 0);
		await expect(probeShells(session)).resolves.toEqual({ sh: "/bin/sh", bash: "/usr/bin/bash" });
	});

	it("fails when the probe command fails", async () => {
		const session = fakeSession(SHELL_PROBE_COMMAND, "", 1);
		await expect(probeShells(session)).rejects.toThrow(/exited with 1/);
	});

	it("gives up on a probe that never answers", async () => {
		const session = {
			exec: async (_command: string, onChannel: (channel: unknown) => void) => {
				const channel = { on: () => {}, stderr: { resume: () => {} }, close: () => {} };
				onChannel(channel);
				return channel;
			},
		} as unknown as SshSession;
		await expect(probeShells(session, 10)).rejects.toThrow(/timed out/);
	});

	it("finds an executable sh on this host", () => {
		// The same command the pooled connection runs, through the same interpreter sshd uses.
		const output = execFileSync("sh", ["-c", SHELL_PROBE_COMMAND], { encoding: "utf8" });
		const shells = parseShellProbe(output);
		expect(shells.sh).toMatch(/^\//);
		expect(() => execFileSync("test", ["-x", shells.sh as string])).not.toThrow();
	});
});

describe("SSH exec cancellation", () => {
	/** A session that records the commands it is asked to run; the channel is never answered. */
	function recordingSession(): { session: SshSession; commands: string[] } {
		const commands: string[] = [];
		const session = {
			exec: async (command: string, onChannel?: (channel: unknown) => void) => {
				commands.push(command);
				const channel = { on: () => {}, stderr: { on: () => {}, resume: () => {} }, close: () => {}, end: () => {} };
				onChannel?.(channel);
				return channel;
			},
			onClose: () => () => {},
			closed: false,
		};
		return { session: session as unknown as SshSession, commands };
	}

	it("acts on an abort that fired while the exec channel was opening", async () => {
		const handlers = new Map<string, (arg?: unknown) => void>();
		let closes = 0;
		let release!: () => void;
		const channel = {
			on: (event: string, fn: (arg?: unknown) => void) => handlers.set(event, fn),
			stderr: { on: () => {}, resume: () => {} },
			end: () => {},
			close: () => {
				closes++;
				handlers.get("exit")?.(null);
				handlers.get("close")?.();
			},
		};
		const session = {
			exec: (_command: string, onChannel?: (channel: unknown) => void) =>
				new Promise((resolve) => {
					release = () => {
						onChannel?.(channel);
						resolve(channel);
					};
				}),
			onClose: () => () => {},
			closed: false,
		} as unknown as SshSession;

		const controller = new AbortController();
		const running = runSshExec(
			session,
			execSpec({ argv: ["sleep", "30"] }),
			undefined,
			{ stdout: () => {}, stderr: () => {}, started: () => {} },
			{ signal: controller.signal },
		);
		// The channel is still opening: the abort fires before the listener can be attached.
		controller.abort();
		release();
		const result = await running;
		// The cancellation is acted on as soon as the channel exists instead of being lost.
		expect(result.cancelled).toBe(true);
		expect(closes).toBe(1);
	});

	it("runs nothing when the task was cancelled before it started", async () => {
		const { session, commands } = recordingSession();
		const controller = new AbortController();
		controller.abort();
		const started: string[] = [];
		const result = await runSshExec(
			session,
			execSpec({ argv: ["rm", "-rf", "/tmp/crh-cancelled"] }),
			undefined,
			{ stdout: () => {}, stderr: () => {}, started: () => started.push("started") },
			{ signal: controller.signal },
		);
		// The cancellation fired during the connection, before the exec: nothing is sent to the node.
		expect(result).toEqual({ timedOut: false, cancelled: true });
		expect(commands).toHaveLength(0);
		expect(started).toHaveLength(0);
	});
});
