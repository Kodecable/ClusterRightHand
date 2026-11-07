/**
 * SSH nodes: there is no crha and no resume, so a task runs over a pooled SSH connection and its
 * outcome is recorded when the remote command ends (doc/execution-plane.md#ssh-传输).
 */
import { type TaskSpec, taskResultToJson } from "@crh/protocol";
import type { Updateable } from "kysely";
import type { TasksTable } from "../storage/schema.ts";
import type { ClusterCore } from "./core.ts";
import { dropLive, type Live } from "./live-output.ts";
import { markNodeSeen, type NodeRow, setSshNodeFacts } from "./nodes.ts";
import { LineCounter } from "./output.ts";
import { connect as connectSsh, SshError, type SshSession } from "./ssh/connection.ts";
import {
	probeShells,
	runSshExec,
	SSH_PRIVILEGED_NOTICE,
	SshConnectionLost,
	type SshExecSink,
	type SshShells,
} from "./ssh/exec.ts";
import { FileTaskError, runSftpFileTask } from "./ssh/file-task.ts";
import { finish, markUnknown, onAccepted } from "./task-end.ts";
import { outputColumns } from "./task-view.ts";
import type { ClusterOptions } from "./types.ts";

/** One pooled SSH connection and the shell its probe found (doc/execution-plane.md#执行). */
export interface SshConnection {
	session: SshSession;
	sh: string;
}

/**
 * The pooled connection of an SSH node, after its first-time shell probe. Every new connection probes
 * before its first task: its tasks run on the sh it found, and the node's facts carry the result
 * (doc/execution-plane.md#执行). A probe that fails keeps the previous facts and falls back to /bin/sh;
 * it never fails a task.
 */
function sshSession(core: ClusterCore, node: NodeRow): Promise<SshConnection> {
	const existing = core.sshSessions.get(node.id);
	if (existing) return existing;
	const route = core.sshRoute as NonNullable<ClusterOptions["sshRoute"]>;
	const link = (async (): Promise<SshConnection> => {
		const session = await connectSsh(await route(node));
		let shells: SshShells | null = null;
		try {
			shells = await probeShells(session);
		} catch (err) {
			console.warn(`node ${node.id}: shell probe failed: ${err instanceof Error ? err.message : String(err)}`);
		}
		const sh = shells?.sh ?? "/bin/sh";
		if (shells !== null) {
			await setSshNodeFacts(core.db, node.id, { sh, bash: shells.bash }).catch((err: unknown) =>
				console.warn(`node ${node.id}: store shell facts: ${err instanceof Error ? err.message : String(err)}`),
			);
		}
		return { session, sh };
	})();
	core.sshSessions.set(node.id, link);
	link.then(
		(l) => l.session.onClose(() => core.sshSessions.get(node.id) === link && core.sshSessions.delete(node.id)),
		() => core.sshSessions.delete(node.id),
	);
	return link;
}

/** Aborts every running SSH task and closes every pooled session; close() waits for the writes. */
export function closeSsh(core: ClusterCore): void {
	for (const ac of core.sshCancels.values()) ac.abort();
	for (const s of core.sshSessions.values())
		void s
			.then(
				(x) => x.session.close(),
				() => {},
			)
			.catch((err: unknown) => console.error("ssh session close failed:", err));
}

export async function runSsh(
	core: ClusterCore,
	id: string,
	node: NodeRow,
	spec: TaskSpec,
	input: Uint8Array | undefined,
	timeoutMs: number | undefined,
	privileged: boolean,
): Promise<void> {
	const live = core.live.get(id) as Live;
	// crhs sees all of an SSH task's output itself, so it counts the single stream's lines here.
	const lines = new LineCounter();
	let isStarted = false;
	// Registered before the first await so a cancel that arrives while the notice or the connection is
	// written still aborts this run (doc/execution-plane.md#ssh-传输).
	const ac = new AbortController();
	core.sshCancels.set(id, ac);
	const sink = {
		// The remote wrapper merged stderr into stdout after printing the pid (D114), so this is the
		// single output stream. Anything the wrapper still writes on stderr is appended defensively.
		stdout: (d: Uint8Array) => {
			lines.add(d);
			live.output.append(live.output.end, d);
		},
		stderr: (d: Uint8Array) => {
			lines.add(d);
			live.output.append(live.output.end, d);
		},
		started: () => {
			isStarted = true;
			core.background(
				"task acceptance failed",
				core.taskQueue.run(id, () => onAccepted(core, node.id, id)),
			);
		},
	};
	// Cancelled before the remote command started: nothing ran, so the task ends as a cancellation
	// rather than running on (doc/execution-plane.md#ssh-传输). The connect and the shell probe can
	// take a long time, so the check is repeated around them, not left to the exec alone. The row's
	// flag also covers a cancel that came between the dispatch claim and this run.
	const cancelled = async (): Promise<boolean> => ac.signal.aborted || (await core.row(id))?.cancelled === 1;
	const cancelledFields = (): Updateable<TasksTable> => ({ state: "exited", cancelled: 1 });
	// SSH keeps no full output (no output file): status saves only the byte count, text its budgeted
	// tail, head the page's head. It sees the whole stream, so it also has the line count TaskExit
	// would report.
	const outputFields = () => ({ ...outputColumns(live.output.snapshot()), output_lines: lines.lines });
	try {
		// SSH has no privileged mode: the task runs as the SSH user. The notice is crhs's own, so it lives
		// in tasks.notice and never in the output (D114); every output mode keeps it, status included.
		if (privileged) {
			await core.db.updateTable("tasks").set({ notice: SSH_PRIVILEGED_NOTICE }).where("id", "=", id).execute();
		}
		let fields: Updateable<TasksTable>;
		// A pooled connection may have died without notice; nothing has run yet, so retry once fresh.
		for (let attempt = 0; ; attempt++) {
			if (await cancelled()) {
				fields = cancelledFields();
				break;
			}
			const link = await sshSession(core, node);
			if (await cancelled()) {
				fields = cancelledFields();
				break;
			}
			try {
				fields = await sshTask(link, spec, input, timeoutMs, ac.signal, sink);
				break;
			} catch (err) {
				if (isStarted || attempt > 0 || !(err instanceof SshError) || ac.signal.aborted) throw err;
				link.session.close();
			}
		}
		// For SSH nodes "last seen" is the last task that reached the node.
		core.background("markNodeSeen failed", markNodeSeen(core.db, node.id));
		await core.taskQueue.run(id, () => finish(core, node.id, id, { ...fields, ...outputFields() }));
	} catch (err) {
		// Once the remote side started, the outcome is unknown; before that, nothing ran: a cancelled
		// task ends as a cancellation and anything else as the connection error.
		if (isStarted) {
			await core.taskQueue.run(id, () => markUnknown(core, id, "connection_lost"));
		} else if (ac.signal.aborted) {
			await core.taskQueue.run(id, () => finish(core, node.id, id, { ...cancelledFields(), ...outputFields() }));
		} else {
			const code = err instanceof SshError ? err.code : "connect_failed";
			await core.taskQueue.run(id, () =>
				finish(core, node.id, id, { state: "failed", error_code: code, error_message: (err as Error).message }),
			);
		}
	} finally {
		core.sshCancels.delete(id);
		if (core.live.get(id) === live) dropLive(core, id);
	}
}

async function sshTask(
	link: SshConnection,
	spec: TaskSpec,
	input: Uint8Array | undefined,
	timeoutMs: number | undefined,
	signal: AbortSignal,
	sink: SshExecSink,
): Promise<Updateable<TasksTable>> {
	const session = link.session;
	if (spec.kind === "exec") {
		const res = await runSshExec(session, spec, input, sink, { timeoutMs, signal, sh: link.sh });
		return {
			state: res.error ? "failed" : "exited",
			exit_code: res.exitCode ?? null,
			signal: res.signal ?? null,
			error_code: res.error?.code ?? null,
			error_message: res.error?.message ?? null,
			timed_out: res.timedOut ? 1 : 0,
			cancelled: res.cancelled ? 1 : 0,
		};
	}
	const sftp = await session.sftp();
	sink.started();
	try {
		const result = await runSftpFileTask(sftp, spec, input, sink.stdout, signal);
		return { state: "exited", exit_code: 0, result: JSON.stringify(taskResultToJson(result)) };
	} catch (err) {
		if (!(err instanceof FileTaskError) || session.closed) throw new SshConnectionLost("connection lost");
		return {
			state: "failed",
			error_code: err.code,
			error_message: err.message,
			cancelled: err.code === "cancelled" ? 1 : 0,
		};
	} finally {
		sftp.end();
	}
}
