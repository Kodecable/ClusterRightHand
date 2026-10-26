import type { ExecSpec } from "@crh/protocol";
import type { SshSession } from "./connection.ts";

export const DEFAULT_KILL_GRACE_MS = 5_000;
const PGID_MARKER = /^crh-pgid:(\d+)\n/;
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

/** POSIX single quoting: the result is one shell word with no expansion. */
export function shellQuote(s: string): string {
	return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`;
}

/**
 * The remote command line. sshd starts every command as a session leader, so the shell's pid is also its
 * process group id; `exec` keeps that pid through env and the wrapper, which reports it on stderr's first
 * line so that cancel and timeout can signal the whole group. (setsid(1) would fork here, because the
 * caller already leads its group, and the exit status would be lost.)
 */
export function buildCommand(spec: ExecSpec): string {
	let argv: string[];
	if (spec.argv.length > 0 && spec.shell)
		throw new SshExecError("invalid_spec", "argv and shell are mutually exclusive");
	if (spec.argv.length > 0) argv = spec.argv;
	else if (spec.shell) argv = ["/bin/sh", "-c", spec.shell];
	else throw new SshExecError("invalid_spec", "argv or shell is required");
	const cwd = spec.cwd || "/";
	if (!cwd.startsWith("/")) throw new SshExecError("invalid_spec", "cwd must be absolute");
	const env = Object.entries(spec.env).map(([k, v]) => {
		if (!ENV_NAME.test(k)) throw new SshExecError("invalid_spec", `invalid environment variable name ${k}`);
		return shellQuote(`${k}=${v}`);
	});
	const wrapper = `printf 'crh-pgid:%s\\n' "$$" >&2; exec "$@"`;
	return [
		`cd ${shellQuote(cwd)} || exit 127;`,
		"exec",
		...(env.length > 0 ? ["env --", ...env] : []),
		`/bin/sh -c ${shellQuote(wrapper)} crh`,
		...argv.map(shellQuote),
	].join(" ");
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
	options: { timeoutMs?: number; killGraceMs?: number; signal?: AbortSignal },
): Promise<SshExecResult> {
	let command: string;
	try {
		command = buildCommand(spec);
	} catch (err) {
		if (err instanceof SshExecError)
			return { error: { code: err.code, message: err.message }, timedOut: false, cancelled: false };
		throw err;
	}
	const result: SshExecResult = { timedOut: false, cancelled: false };
	let pgid: number | undefined;
	let stderrHead: Buffer | undefined = Buffer.alloc(0);
	let exited = false;
	let closed = false;
	const closeWaiters: (() => void)[] = [];

	// Attach every listener synchronously when the channel opens (see SshSession.exec).
	const channel = await session.exec(command, (ch) => {
		ch.on("data", (data: Buffer) => sink.stdout(data));
		ch.stderr.on("data", (data: Buffer) => {
			if (stderrHead === undefined) return sink.stderr(data);
			// Strip the wrapper's first line; everything after it is the task's stderr.
			stderrHead = Buffer.concat([stderrHead, data]);
			const nl = stderrHead.indexOf(0x0a);
			if (nl < 0 && stderrHead.length < 64) return;
			const m = PGID_MARKER.exec(stderrHead.subarray(0, nl + 1).toString("latin1"));
			const rest = m ? stderrHead.subarray(nl + 1) : stderrHead;
			if (m) pgid = Number(m[1]);
			stderrHead = undefined;
			if (rest.length > 0) sink.stderr(rest);
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
			if (stderrHead && stderrHead.length > 0) sink.stderr(stderrHead);
			stderrHead = undefined;
			if (!exited && session.closed) return finish(new SshConnectionLost("connection lost"));
			if (!exited) result.error = { code: "io_error", message: "the channel closed without an exit status" };
			// 127 before the wrapper ran: the working directory does not exist.
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
