/**
 * SSH nodes: there is no crha and no resume, so a task runs over a pooled SSH connection and its
 * outcome is recorded when the remote command ends (doc/design/execution.md "SSH transport").
 */
import { type TaskSpec, taskResultToJson } from "@crh/protocol";
import type { Updateable } from "kysely";
import { openTransferLocation } from "../library/transfer-location.ts";
import type { TasksTable } from "../storage/schema.ts";
import type { ReadAnchors } from "../util/read-anchors.ts";
import type { ClusterCore } from "./core.ts";
import { parseTransferRecord } from "./data-transfer.ts";
import { dropLive, type Live } from "./live-output.ts";
import { getNode, markNodeSeen, type NodeRow, setSshNodeFacts } from "./nodes.ts";
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
import { FileTaskError, runSftpFileTask, type SftpTransfer } from "./ssh/file-task.ts";
import { finish, markUnknown, onAccepted } from "./task-end.ts";
import { writeTask } from "./task-rows.ts";
import { outputColumns } from "./task-view.ts";
import type { ClusterOptions } from "./types.ts";

/** One pooled SSH connection and the shell its probe found (doc/design/execution.md "SSH execution"). */
export interface SshConnection {
	session: SshSession;
	sh: string;
}

/** What a pooled session is opened for: a changed route must not reuse it. */
function routeDigest(node: NodeRow): string {
	return JSON.stringify([
		node.ssh_host,
		node.ssh_port,
		node.ssh_user,
		node.ssh_host_fingerprint,
		node.ssh_credential_id,
		node.ssh_jumps,
	]);
}

function routeGeneration(core: ClusterCore, nodeId: string): number {
	return core.sshRouteGenerations.get(nodeId) ?? 0;
}

/**
 * The pooled connection of an SSH node, after its first-time shell probe. Every new connection probes
 * before its first task: its tasks run on the sh it found, and the node's facts carry the result
 * (doc/design/execution.md "SSH execution"). A probe that fails keeps the previous facts and falls back to /bin/sh;
 * it never fails a task.
 *
 * A node row can be read before a route change: the connection re-reads the row and, when the node's route
 * generation moved while it dialled, closes that connection and retries once with the new route.
 */
function sshSession(core: ClusterCore, node: NodeRow): Promise<SshConnection> {
	const existing = core.sshSessions.get(node.id);
	if (existing) return existing;
	const { link, adopted } = openSshSession(core, node);
	core.sshSessions.set(node.id, link);
	link.then(
		(l) => {
			// The dial resolved to another dial's pooled connection: that dial owns it.
			if (adopted()) return;
			// A close may have landed between the generation check and this handler: do not keep that session.
			if (core.sshSessions.get(node.id) !== link) {
				l.session.close();
				return;
			}
			core.sshConnections.set(node.id, l);
			l.session.onClose(() => {
				if (core.sshSessions.get(node.id) === link) {
					core.sshSessions.delete(node.id);
					core.sshConnections.delete(node.id);
				}
			});
		},
		() => {
			// A delayed failure must not remove a newer entry for the same node.
			if (core.sshSessions.get(node.id) === link) {
				core.sshSessions.delete(node.id);
				core.sshConnections.delete(node.id);
			}
		},
	);
	return link;
}

/**
 * Dials the node's current route. `adopted()` is true when the dial gave up its own connection and resolved to
 * the one another dial pooled; its caller must then neither register nor close that connection.
 */
function openSshSession(core: ClusterCore, node: NodeRow): { link: Promise<SshConnection>; adopted: () => boolean } {
	const route = core.sshRoute as NonNullable<ClusterOptions["sshRoute"]>;
	let adopted = false;
	let link!: Promise<SshConnection>;
	link = (async (): Promise<SshConnection> => {
		for (let attempt = 0; ; attempt++) {
			const generation = routeGeneration(core, node.id);
			// Re-read the node: the row a waiting task was created with may name an old route.
			const current = (await getNode(core.db, node.id)) ?? node;
			const digest = routeDigest(current);
			const session = await connectSsh(await route(current));
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
			const fresh = await getNode(core.db, node.id);
			if (routeGeneration(core, node.id) === generation && fresh !== undefined && routeDigest(fresh) === digest) {
				// A concurrent dial may have pooled a connection first; use that one and close this duplicate.
				const pooled = core.sshSessions.get(node.id);
				if (pooled === undefined || pooled === link) {
					core.sshSessions.set(node.id, link);
					return { session, sh };
				}
				session.close();
				adopted = true;
				return pooled;
			}
			// The route changed while this connection was made: it is for the old one, so close it and use the
			// connection a newer dial may already have pooled, or dial the new route once more.
			if (core.sshSessions.get(node.id) === link) core.sshSessions.delete(node.id);
			session.close();
			const newer = core.sshSessions.get(node.id);
			if (newer !== undefined && newer !== link) {
				adopted = true;
				return newer;
			}
			if (attempt >= 1) throw new Error("the node's SSH route changed while connecting");
		}
	})();
	return { link, adopted: () => adopted };
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

/**
 * Closes one node's pooled session, e.g. after its route changed: the next task dials the new route.
 * Running tasks fail through the session's close and become `unknown(connection_lost)`. The route generation
 * is bumped even without a pooled session, so a connection still being made for the old route is closed.
 */
export function closeSshNode(core: ClusterCore, nodeId: string): void {
	core.sshRouteGenerations.set(nodeId, routeGeneration(core, nodeId) + 1);
	core.sshSessions.delete(nodeId);
	// Only a settled connection is closed here. A dial still in flight notices the new generation itself,
	// closes the connection it made for the old route and retries; closing its promise could close the new one.
	const connection = core.sshConnections.get(nodeId);
	core.sshConnections.delete(nodeId);
	connection?.session.close();
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
	// written still aborts this run (doc/design/execution.md "SSH transport").
	const ac = new AbortController();
	core.sshCancels.set(id, ac);
	const sink = {
		// The remote wrapper merged stderr into stdout after printing the pid, so this is the
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
	// rather than running on (doc/design/execution.md "SSH transport"). The connect and the shell probe can
	// take a long time, so the check is repeated around them, not left to the exec alone. A row a cancel
	// already ended also covers a cancel that came between the dispatch claim and this run.
	const cancelled = async (): Promise<boolean> => ac.signal.aborted || (await core.row(id))?.state === "cancelled";
	const cancelledFields = (): Updateable<TasksTable> => ({ state: "cancelled" });
	// SSH keeps no full output (no output file): status saves only the byte count, text its budgeted
	// tail, head the page's head. It sees the whole stream, so it also has the line count TaskExit
	// would report.
	const outputFields = () => ({ ...outputColumns(live.output.snapshot()), output_lines: lines.lines });
	// An SSH transfer streams directly from or to the stored location on the pooled connection; there
	// is no data connection (doc/design/library.md "SSH nodes"). A broken descriptor fails the task
	// through the catch below.
	try {
		const transferRecord = parseTransferRecord((await core.row(id))?.transfer ?? null);
		const location = transferRecord ? openTransferLocation(core.transferContext(), transferRecord.location) : undefined;
		const sftpTransfer: SftpTransfer | undefined = location
			? { openRead: () => location.openRead(), openWrite: () => location.openWrite() }
			: undefined;
		// SSH has no privileged mode: the task runs as the SSH user. The notice is crhs's own, so it lives
		// in tasks.notice and never in the output; every output mode keeps it, status included.
		if (privileged) {
			await writeTask(
				core.db,
				id,
				{ states: ["dispatched", "running"], nodeId: node.id },
				{ notice: SSH_PRIVILEGED_NOTICE },
			);
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
				fields = await sshTask(link, spec, input, timeoutMs, ac.signal, sink, sftpTransfer, core.readAnchors, node.id);
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
				finish(core, node.id, id, { state: "errored", error_code: code, error_message: (err as Error).message }),
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
	transfer: SftpTransfer | undefined,
	anchors: ReadAnchors,
	nodeId: string,
): Promise<Updateable<TasksTable>> {
	const session = link.session;
	if (spec.kind === "exec") {
		const res = await runSshExec(session, spec, input, sink, { timeoutMs, signal, sh: link.sh });
		return {
			state: res.cancelled ? "cancelled" : res.error ? "errored" : "exited",
			exit_code: res.exitCode ?? null,
			signal: res.signal ?? null,
			error_code: res.cancelled ? null : (res.error?.code ?? null),
			error_message: res.cancelled ? null : (res.error?.message ?? null),
			timed_out: res.timedOut ? 1 : 0,
		};
	}
	const sftp = await session.sftp();
	sink.started();
	try {
		const result = await runSftpFileTask(sftp, spec, input, sink.stdout, signal, transfer, anchors, nodeId);
		return { state: "exited", exit_code: 0, result: result === null ? null : JSON.stringify(taskResultToJson(result)) };
	} catch (err) {
		if (!(err instanceof FileTaskError) || session.closed) throw new SshConnectionLost("connection lost");
		return {
			state: err.code === "cancelled" ? "cancelled" : "errored",
			error_code: err.code === "cancelled" ? null : err.code,
			error_message: err.code === "cancelled" ? null : err.message,
		};
	} finally {
		sftp.end();
	}
}
