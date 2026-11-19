import { randomBytes } from "node:crypto";
import type { ExecSpec } from "@crh/protocol";
import { shellQuote } from "../../util/shell-quote.ts";
import type { SshSession } from "./connection.ts";

export const DEFAULT_KILL_GRACE_MS = 5_000;
/**
 * How much stderr is buffered while the wrapper's pgid marker is looked for. A login shell that prints
 * noise (a broken profile, `/etc/motd` from `.profile`) does not make the marker unrecognizable, but a
 * stream with no marker at all must still be forwarded, so the search stops here.
 */
const PGID_MARKER_LIMIT = 64 * 1024;
/** The prefix of the wrapper's pgid line; the per-run nonce and the digits follow. */
const PGID_PREFIX = "crh-pgid:";
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface SshExecResult {
	exitCode?: number;
	signal?: string;
	error?: { code: string; message: string };
	timedOut: boolean;
	cancelled: boolean;
}

export interface SshExecSink {
	stdout(data: Uint8Array): void;
	stderr(data: Uint8Array): void;
	/** The remote process started. */
	started(): void;
}

/**
 * The first stderr line of a privileged task on an SSH node: SSH has no privileged mode, so the task
 * runs as the SSH user and says so (doc/design/execution.md "SSH transport"). Ordinary tasks get nothing.
 */
export const SSH_PRIVILEGED_NOTICE = "crh: privileged was ignored: SSH nodes run tasks as the SSH user\n";

/** The notice to write before a task's own output, or undefined for an ordinary task. */
export function sshPrivilegedNotice(privileged: boolean): Uint8Array | undefined {
	return privileged ? Buffer.from(SSH_PRIVILEGED_NOTICE) : undefined;
}

/** The shells a node's connection probe found; null when `/etc/shells` and `command -v` had none. */
export interface SshShells {
	sh: string | null;
	bash: string | null;
}

/**
 * The probe every new SSH connection runs before its first task. It follows crha's order: the first
 * absolute path in /etc/shells whose base name is sh (or bash) that exists and is executable, then
 * `command -v`. One line per shell, so the caller does not depend on the remote's shell syntax beyond
 * POSIX sh (doc/design/execution.md "SSH execution").
 */
export const SHELL_PROBE_COMMAND =
	"for n in sh bash; do f=; " +
	"while IFS= read -r l; do " +
	"case $l in ''|'#'*) continue;; esac; " +
	"case $l in /*) ;; *) continue;; esac; " +
	`case \${l##*/} in "$n") ;; *) continue;; esac; ` +
	'[ -f "$l" ] && [ -x "$l" ] && { f=$l; break; }; ' +
	"done </etc/shells 2>/dev/null; " +
	'[ -n "$f" ] || f=$(command -v "$n" 2>/dev/null); ' +
	`printf 'crh-shell %s %s\\n' "$n" "$f"; done`;

/**
 * Parses the probe's output; a missing line means the shell was not found. Only absolute paths are
 * accepted: a relative one is no shell this node reported (doc/design/execution.md "SSH execution").
 */
export function parseShellProbe(output: string): SshShells {
	const shells: SshShells = { sh: null, bash: null };
	for (const line of output.split("\n")) {
		const [tag, name, path] = line.trim().split(/\s+/);
		if (tag !== "crh-shell" || (name !== "sh" && name !== "bash")) continue;
		shells[name] = path?.startsWith("/") ? path : null;
	}
	return shells;
}

/**
 * Runs the shell probe on a freshly connected session. A probe that takes longer than `timeoutMs`
 * is abandoned: it only feeds the fallback shell and must never hold a task hostage.
 */
export function probeShells(session: SshSession, timeoutMs = 10_000): Promise<SshShells> {
	return new Promise((resolve, reject) => {
		let channel: { close(): void } | undefined;
		let output = "";
		const timer = setTimeout(() => {
			channel?.close();
			reject(new Error(`the shell probe timed out after ${timeoutMs} ms`));
		}, timeoutMs);
		session
			.exec(SHELL_PROBE_COMMAND, (ch) => {
				channel = ch;
				ch.on("data", (data: Buffer) => {
					output += data.toString("utf8");
				});
				ch.stderr.resume();
				ch.on("close", (code: number | null) => {
					clearTimeout(timer);
					if (code !== 0) reject(new Error(`the shell probe exited with ${code ?? "a signal"}`));
					else resolve(parseShellProbe(output));
				});
			})
			.catch((err: unknown) => {
				clearTimeout(timer);
				reject(err);
			});
	});
}

/**
 * The remote command line. sshd starts every command as a session leader, so the shell's pid is also its
 * process group id; `exec` keeps that pid through env and the wrapper, which reports it on stderr as
 * `crh-pgid:<nonce>:<pgid>` so that cancel and timeout can signal the whole group, then merges stderr
 * into stdout so the task has one output stream. (setsid(1) would fork here, because the caller already
 * leads its group, and the exit status would be lost.) The nonce is per run: a login shell may print to
 * stderr before the wrapper runs, so the marker is not necessarily the first line, and the nonce keeps a
 * task from forging it (doc/design/execution.md "SSH execution").
 *
 * sh is the shell the connection's probe found: `shell` commands run on it, while authorization and
 * display keep rendering them as /bin/sh -c (doc/design/execution.md "SSH execution"). LANG and LC_ALL are always
 * set; a task's own variables follow and win, because env(1) applies them in order.
 */
export function buildCommand(spec: ExecSpec, sh = "/bin/sh", nonce = newPgidNonce()): string {
	let argv: string[];
	if ("argv" in spec.command) {
		if (spec.command.argv.length === 0) throw new SshExecError("invalid_spec", "argv or shell is required");
		argv = spec.command.argv;
	} else if (spec.command.shell) {
		argv = [sh, "-c", spec.command.shell];
	} else {
		throw new SshExecError("invalid_spec", "argv or shell is required");
	}
	const cwd = spec.cwd || "/";
	if (!cwd.startsWith("/")) throw new SshExecError("invalid_spec", "cwd must be absolute");
	const env = Object.entries(spec.env)
		.filter(([k]) => !k.startsWith("CRHA_TASK_"))
		.map(([k, v]) => {
			if (!ENV_NAME.test(k)) throw new SshExecError("invalid_spec", `invalid environment variable name ${k}`);
			return shellQuote(`${k}=${v}`);
		});
	// The pid goes to stderr first; `exec 2>&1` then merges the rest into stdout, so the task has one
	// output stream and crhs never merges two (doc/design/execution.md "SSH execution").
	const wrapper = `printf '${PGID_PREFIX}${nonce}:%s\\n' "$$" >&2; exec 2>&1; exec "$@"`;
	return [
		`cd ${shellQuote(cwd)} || exit 127;`,
		"exec env -- LANG=C.UTF-8 LC_ALL=C.UTF-8",
		...env,
		`${shellQuote(sh)} -c ${shellQuote(wrapper)} crh`,
		...argv.map(shellQuote),
	].join(" ");
}

/** The random part of a run's pgid marker: hexadecimal, so it needs no shell quoting. */
function newPgidNonce(): string {
	return randomBytes(8).toString("hex");
}

/**
 * Finds the wrapper's `crh-pgid:<nonce>:<pgid>` line in a task's stderr. A login shell that writes to
 * stderr before the wrapper runs (a broken profile, a greeting) puts other lines first, so the line is
 * searched for rather than assumed first: the search buffers up to PGID_MARKER_LIMIT bytes, forwarding
 * everything that is not the marker line, and after the limit forwards everything and gives up on the
 * process group (cancel then only closes the channel, and 127 stays a cwd failure).
 */
export class PgidScanner {
	readonly #marker: Buffer;
	readonly #sink: (data: Uint8Array) => void;
	readonly #limit: number;
	#buffer: Buffer = Buffer.alloc(0);
	#done = false;
	pgid: number | undefined;

	constructor(nonce: string, sink: (data: Uint8Array) => void, limit = PGID_MARKER_LIMIT) {
		this.#marker = Buffer.from(`${PGID_PREFIX}${nonce}:`, "latin1");
		this.#sink = sink;
		this.#limit = limit;
	}

	push(data: Uint8Array): void {
		if (this.#done) {
			this.#sink(data);
			return;
		}
		this.#buffer = Buffer.concat([this.#buffer, Buffer.from(data)]);
		if (this.#find()) return;
		if (this.#buffer.length >= this.#limit) this.#flush();
	}

	/** Forwards what is still buffered, e.g. when the channel closes before the marker arrived. */
	flush(): void {
		if (this.#done) return;
		this.#flush();
	}

	#flush(): void {
		this.#done = true;
		const rest = this.#buffer;
		this.#buffer = Buffer.alloc(0);
		if (rest.length > 0) this.#sink(rest);
	}

	#find(): boolean {
		let from = 0;
		for (;;) {
			const at = this.#buffer.indexOf(this.#marker, from);
			if (at < 0) return false;
			// Only the first PGID_MARKER_LIMIT bytes are searched: a marker later than that is ignored.
			if (at >= this.#limit) return false;
			// The marker is a whole line: nothing before it on its line.
			if (at === 0 || this.#buffer[at - 1] === 0x0a) {
				const nl = this.#buffer.indexOf(0x0a, at + this.#marker.length);
				if (nl >= 0) {
					const digits = this.#buffer.subarray(at + this.#marker.length, nl).toString("latin1");
					if (/^\d+$/.test(digits)) {
						const before = this.#buffer.subarray(0, at);
						const after = this.#buffer.subarray(nl + 1);
						this.pgid = Number(digits);
						this.#done = true;
						this.#buffer = Buffer.alloc(0);
						if (before.length > 0) this.#sink(before);
						if (after.length > 0) this.#sink(after);
						return true;
					}
				}
			}
			from = at + 1;
		}
	}
}

export class SshExecError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.code = code;
	}
}

export class SshConnectionLost extends Error {}

/**
 * Runs an exec task over SSH. Cancelling `signal` or the timeout sends SIGTERM to the task's process
 * group, then SIGKILL after the grace period. Throws SshConnectionLost if the connection drops while
 * the task runs (its outcome is then unknown).
 */
export async function runSshExec(
	session: SshSession,
	spec: ExecSpec,
	stdin: Uint8Array | undefined,
	sink: SshExecSink,
	options: { timeoutMs?: number; killGraceMs?: number; signal?: AbortSignal; sh?: string },
): Promise<SshExecResult> {
	let command: string;
	const nonce = newPgidNonce();
	try {
		command = buildCommand(spec, options.sh, nonce);
	} catch (err) {
		if (err instanceof SshExecError)
			return { error: { code: err.code, message: err.message }, timedOut: false, cancelled: false };
		throw err;
	}
	const result: SshExecResult = { timedOut: false, cancelled: false };
	// A cancellation that fired while the connection was being made (or the shell probed) is already set
	// when the run starts: nothing has run, so the task is cancelled and the command is never sent.
	if (options.signal?.aborted) {
		result.cancelled = true;
		return result;
	}
	let pgid: number | undefined;
	let stderrScan: PgidScanner | undefined = new PgidScanner(nonce, (data) => sink.stderr(data));
	let exited = false;
	let closed = false;
	const closeWaiters: (() => void)[] = [];

	// Attach every listener synchronously when the channel opens (see SshSession.exec).
	const channel = await session.exec(command, (ch) => {
		ch.on("data", (data: Buffer) => sink.stdout(data));
		ch.stderr.on("data", (data: Buffer) => {
			if (stderrScan === undefined) return sink.stderr(data);
			stderrScan.push(data);
			const found = stderrScan.pgid;
			if (found !== undefined) pgid = found;
		});
		ch.on("exit", (code: number | null, signal?: string) => {
			exited = true;
			if (signal) result.signal = signal.replace(/^SIG/, "");
			else result.exitCode = code ?? undefined;
		});
		ch.on("close", () => {
			closed = true;
			for (const w of closeWaiters) w();
		});
	});
	sink.started();
	const timers: NodeJS.Timeout[] = [];

	const kill = (sig: "TERM" | "KILL") => {
		if (pgid === undefined) {
			channel.close();
			return;
		}
		session.exec(`kill -${sig} -- -${pgid} 2>/dev/null`).then(
			(c) => c.resume().on("close", () => {}),
			() => {},
		);
	};
	const terminate = () => {
		kill("TERM");
		timers.push(setTimeout(() => kill("KILL"), options.killGraceMs ?? DEFAULT_KILL_GRACE_MS));
	};

	return new Promise((resolve, reject) => {
		const onAbort = () => {
			result.cancelled = true;
			terminate();
		};
		options.signal?.addEventListener("abort", onAbort, { once: true });
		// The signal may have fired while the channel was being opened, before the listener existed:
		// the abort event is already gone, so act on the state itself.
		if (options.signal?.aborted) onAbort();
		if (options.timeoutMs) {
			timers.push(
				setTimeout(() => {
					result.timedOut = true;
					terminate();
				}, options.timeoutMs),
			);
		}
		let settled = false;
		const finish = (err?: Error) => {
			if (settled) return;
			settled = true;
			for (const t of timers) clearTimeout(t);
			options.signal?.removeEventListener("abort", onAbort);
			unwatch();
			if (err) reject(err);
			else resolve(result);
		};
		const unwatch = session.onClose(() => finish(new SshConnectionLost("connection lost")));
		const onClosed = () => {
			// Whatever stderr was still buffered (no marker yet) is the task's: forward it.
			if (stderrScan) {
				stderrScan.flush();
				stderrScan = undefined;
			}
			if (!exited && session.closed) return finish(new SshConnectionLost("connection lost"));
			if (!exited) result.error = { code: "io_error", message: "the channel closed without an exit status" };
			// 127 before the wrapper ran: the working directory does not exist. A marker that arrived
			// means the wrapper ran, so 127 is the command's own exit code.
			else if (pgid === undefined && result.exitCode === 127) {
				result.error = { code: "not_found", message: `cannot change to ${spec.cwd || "/"}` };
				result.exitCode = undefined;
			}
			finish();
		};
		if (closed) onClosed();
		else closeWaiters.push(onClosed);

		if (stdin && stdin.length > 0) channel.end(Buffer.from(stdin));
		else channel.end();
	});
}
