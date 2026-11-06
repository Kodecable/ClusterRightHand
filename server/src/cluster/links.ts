/**
 * The node links: one authenticated connection per node, its handshake (`hello`), its status, the
 * reconnect grace and the inbound commands an active node may send (doc/execution-plane.md#注册,
 * doc/protocol.md#hello). A link is `ready` only once its hello was reconciled, which is when tasks
 * may be dispatched over it.
 */
import {
	type AfterResponse,
	afterResponse,
	ConnectionError,
	type Facts,
	factsToJson,
	type Hello,
	type NodeStatus,
	type OutputAck,
	RemoteError,
	type TaskStatus,
	type Welcome,
} from "@crh/protocol";
import { onLocalDecision } from "./authorization/local-approval.ts";
import type { NodeConnection } from "./connection.ts";
import type { ClusterCore } from "./core.ts";
import { dropLive, newLive, ownLive } from "./live-output.ts";
import { getNode, markNodeSeen, type NodeRow, updateNodeFacts } from "./nodes.ts";
import { markUnknown, onAccepted, onExit } from "./task-end.ts";
import { onTrustSummary } from "./trust-cache.ts";
import { recorded, TERMINAL } from "./types.ts";

/** One node's live connection and what crhs knows about it. */
export interface NodeLink {
	conn: NodeConnection;
	active: boolean;
	/** Set once Hello has been reconciled; tasks are dispatched only after that. */
	ready: boolean;
	/** Task ids we asked about with TaskQuery after Hello. */
	queried: Set<string>;
	/** Whether this connection has reported its trust summary; the cached report is stale until then. */
	trustFresh: boolean;
	/** Dispatches waiting for the first trust summary of this connection. */
	trustWaiters: Set<() => void>;
}

export function isConnected(core: ClusterCore, nodeId: string): boolean {
	return core.links.get(nodeId)?.ready === true;
}

/** Whether the cached trust report of the node came from the current connection (otherwise it is stale). */
export function trustFresh(core: ClusterCore, nodeId: string): boolean {
	return core.links.get(nodeId)?.trustFresh === true;
}

/**
 * Settles the tasks a previous process left unfinished (doc/execution-plane.md#断线恢复). A client
 * node's dispatched or running tasks are treated as detached now, so the reconnect grace they get is
 * the same as after a disconnect: a node that comes back within it resolves them through hello, and
 * one that does not leaves them `unknown`. An SSH node has no connection to resume: its tasks are
 * `unknown(connection_lost)` at once. Called at startup, before any node connects.
 */
export async function recover(core: ClusterCore): Promise<void> {
	if (core.closing) return;
	const rows = await core.db
		.selectFrom("tasks")
		.select(["id", "node_id"])
		.where("state", "in", ["dispatched", "running"])
		.execute();
	const nodes = new Map<string, NodeRow | undefined>();
	for (const row of rows) {
		if (!nodes.has(row.node_id)) nodes.set(row.node_id, await getNode(core.db, row.node_id));
		if (nodes.get(row.node_id)?.transport === "ssh") {
			await core.taskQueue.run(row.id, () => markUnknown(core, row.id, "connection_lost"));
			continue;
		}
		armGrace(core, row.node_id);
	}
}

/** Arms the grace timer of a node that has no connection, unless one is armed already. */
function armGrace(core: ClusterCore, nodeId: string): void {
	if (core.links.has(nodeId) || core.graceTimers.has(nodeId)) return;
	core.graceTimers.set(
		nodeId,
		setTimeout(() => {
			core.graceTimers.delete(nodeId);
			core.background("node expiry failed", expireNode(core, nodeId));
		}, core.graceMs),
	);
}

/** Called by AgentServer after a successful handshake. */
export function attach(core: ClusterCore, conn: NodeConnection, node: NodeRow): void {
	if (core.closing) {
		conn.close("server shutting down");
		return;
	}
	const previous = core.links.get(node.id);
	const link: NodeLink = {
		conn,
		active: node.status === "active",
		ready: false,
		queried: new Set(),
		trustFresh: false,
		trustWaiters: new Set(),
	};
	core.links.set(node.id, link);
	// A dispatch waiting out the offline grace re-checks the link now, then waits for hello.
	core.notifyLink(node.id);
	previous?.conn.close("replaced by a new connection");
	const timer = core.graceTimers.get(node.id);
	if (timer) clearTimeout(timer);
	core.graceTimers.delete(node.id);

	const idle = setTimeout(() => conn.close("idle timeout"), core.idleMs);
	conn.onActivity(() => idle.refresh());
	if (link.active) registerActive(core, conn, link);
	else registerRestricted(core, conn);
	conn.onClose(() => {
		clearTimeout(idle);
		detach(core, link);
	});
	core.background("markNodeSeen failed", markNodeSeen(core.db, node.id));
	if (link.active) auditConnection(core, link, "node.connected");
}

/** Closes a node's connection, e.g. after approval (crha reconnects as active) or deletion. */
export function disconnect(core: ClusterCore, nodeId: string, reason: string): void {
	core.links.get(nodeId)?.conn.close(reason);
}

/**
 * Tells a connected node about a status change, then closes the connection: crha reconnects as an
 * active node after approval, or stops (rejected) after deletion. See doc/execution-plane.md#注册.
 */
export function notifyNodeStatus(core: ClusterCore, nodeId: string, state: NodeStatus["state"], message: string): void {
	const link = core.links.get(nodeId);
	if (!link) return;
	try {
		link.conn.peer.emit("node.status", { nodeId, state, message });
	} catch {
		// The peer is already going away; the close below finishes it.
	}
	link.conn.close(message);
}

/** Closes every node link and clears the reconnect grace of the nodes that have none. */
export function closeLinks(core: ClusterCore): void {
	for (const link of core.links.values()) link.conn.close("server shutting down");
	for (const t of core.graceTimers.values()) clearTimeout(t);
	core.graceTimers.clear();
}

function detach(core: ClusterCore, link: NodeLink): void {
	const nodeId = link.conn.nodeId;
	if (core.links.get(nodeId) !== link) return; // already replaced
	core.links.delete(nodeId);
	core.notifyLink(nodeId);
	if (!link.active) return;
	auditConnection(core, link, "node.disconnected");
	core.background("markNodeSeen failed", markNodeSeen(core.db, nodeId));
	armGrace(core, nodeId);
}

function auditConnection(core: ClusterCore, link: NodeLink, action: "node.connected" | "node.disconnected"): void {
	core.auditLater({
		actor: { type: "system", id: "cluster" },
		action,
		target: { type: "node", id: link.conn.nodeId },
	});
}

/** The node did not come back in time: its unfinished tasks become unknown. */
async function expireNode(core: ClusterCore, nodeId: string): Promise<void> {
	if (core.links.has(nodeId)) return;
	const rows = await core.db
		.selectFrom("tasks")
		.select(["id", "state"])
		.where("node_id", "=", nodeId)
		.where("state", "in", ["dispatched", "running"])
		.execute();
	for (const row of rows) {
		const reason = row.state === "dispatched" ? "dispatch_unconfirmed" : "connection_lost";
		await core.taskQueue.run(row.id, () => markUnknown(core, row.id, reason));
	}
}

// ---- incoming commands and events ----

/** An active node: the full command and event set of doc/protocol.md. */
function registerActive(core: ClusterCore, conn: NodeConnection, link: NodeLink): void {
	const peer = conn.peer;
	peer.onRequest("hello", (hello: Hello) => core.trackHandler(onHello(core, link, hello)));
	peer.onRequest("ping", (ping) => ping);
	peer.onEvent("task.output", (output) => {
		const live = ownLive(core, conn.nodeId, output.taskId);
		if (!live) return;
		// A gap means the client could not resend; keep going, the record shows the byte count.
		live.output.append(output.offset, output.data);
	});
	peer.onEvent("task.exit", (exit) =>
		core.trackHandler(core.taskQueue.run(exit.taskId, () => onExit(core, conn, exit))),
	);
	peer.onEvent("facts", (facts) => core.trackHandler(onFacts(core, conn.nodeId, facts)));
	// Pushed once after hello and again on every change (doc/protocol.md#新增命令和事件11可选).
	peer.onEvent("trust.summary", (report) => core.trackHandler(onTrustSummary(core, link, report)));
	peer.onEvent("local.decision", (decision) => core.trackHandler(onLocalDecision(core, link, decision)));
}

/**
 * A pending node may only report facts and ping; hello is answered with an empty welcome. Everything
 * else is `node_pending` (doc/protocol.md#受限连接).
 */
function registerRestricted(core: ClusterCore, conn: NodeConnection): void {
	const peer = conn.peer;
	peer.onRequest("hello", () => afterResponse<Welcome>({ acks: [] }, () => {}));
	peer.onRequest("ping", (ping) => ping);
	peer.onEvent("facts", (facts) => core.trackHandler(onFacts(core, conn.nodeId, facts)));
	const pending = () => {
		throw new RemoteError("node_pending", "node is pending approval");
	};
	peer.onRequest("task.start", pending);
	peer.onRequest("task.input", pending);
	peer.onRequest("task.cancel", pending);
	peer.onRequest("task.query", pending);
}

async function onFacts(core: ClusterCore, nodeId: string, facts: Facts): Promise<void> {
	await updateNodeFacts(core.db, nodeId, { facts: factsToJson(facts) });
	// A clock far from crhs only makes authorization deadlines unreliable; warn, do nothing else
	// (doc/privilege.md#时钟). The offset is an optional fact: an absent one says nothing.
	const offset = facts.clockOffsetMs;
	if (core.clockWarnMs > 0 && offset !== undefined && Math.abs(offset) > core.clockWarnMs) {
		const ms = Math.abs(offset);
		const seconds = ms % 1000 === 0 ? String(ms / 1000) : (ms / 1000).toFixed(1);
		console.warn(`node ${nodeId}: clock differs from crhs by ${seconds} s (more than ${core.clockWarnMs / 1000} s)`);
	}
}

/** Waits for this connection's first trust summary; crhs does not query it itself. */
export function waitTrust(core: ClusterCore, link: NodeLink, timeoutMs?: number): Promise<void> {
	return core.waitTrust(link, timeoutMs);
}

/** Reconciles the client's task list with ours, answers with Welcome, then queries the rest. */
async function onHello(core: ClusterCore, link: NodeLink, hello: Hello): Promise<AfterResponse<Welcome>> {
	const nodeId = link.conn.nodeId;
	// How the node handles privileged tasks is reported here and nowhere else (doc/protocol.md#hello).
	if (hello.privilegedMode) {
		await core.db
			.updateTable("nodes")
			.set({ privileged_mode: hello.privilegedMode })
			.where("id", "=", nodeId)
			.execute();
	}
	const acks: OutputAck[] = [];
	const reported = new Set<string>();
	for (const t of hello.tasks) {
		const row = await core.row(t.taskId);
		if (!row || row.node_id !== nodeId) continue;
		reported.add(t.taskId);
		// It ran because the client had accepted it, but the success response never reached us.
		if (row.state === "dispatched") await core.taskQueue.run(t.taskId, () => onAccepted(core, nodeId, t.taskId));
		// A recorded result needs no output: ack the stored totals, so crha drops its buffer instead of
		// resending it and charging the group budget a second time. An `unknown` task still accepts a late
		// result, so it keeps the old behaviour and may resend (doc/execution-plane.md#输出).
		if (recorded(row.state)) {
			acks.push({ taskId: t.taskId, offset: Number(row.output_bytes) });
			continue;
		}
		// After a crhs restart the output is gone from memory: start over and let the client resend it all.
		const live =
			core.live.get(t.taskId) ??
			newLive(core, t.taskId, nodeId, row.output_mode, row.task_group_id, row.max_lines, row.max_bytes);
		acks.push({ taskId: t.taskId, offset: live.output.end });
	}
	// The queries must not overtake the welcome, so they start only once it has been sent.
	const open = await core.db
		.selectFrom("tasks")
		.select("id")
		.where("node_id", "=", nodeId)
		.where("state", "in", ["dispatched", "running"])
		.execute();
	// An unknown task whose output is still kept is asked about as well: when the client does not know
	// it either, no task.exit will ever complete it and its buffer can go (onStatus drops it).
	const buffered = [...core.live.values()].filter((live) => live.nodeId === nodeId).map((live) => live.id);
	if (buffered.length > 0) {
		open.push(
			...(await core.db
				.selectFrom("tasks")
				.select("id")
				.where("id", "in", buffered)
				.where("node_id", "=", nodeId)
				.where("state", "=", "unknown")
				.execute()),
		);
	}
	return afterResponse({ acks }, () => {
		link.ready = true;
		core.notifyLink(nodeId);
		for (const { id } of open) {
			if (reported.has(id)) continue;
			link.queried.add(id);
			link.conn.peer.request("task.query", { taskId: id }).then(
				(status) => {
					core.background(
						"task.query status failed",
						core.taskQueue.run(id, () => onStatus(core, link, status)),
					);
				},
				(err: unknown) => {
					if (err instanceof ConnectionError) return;
					console.error("task.query failed:", err);
				},
			);
		}
	});
}

async function onStatus(core: ClusterCore, link: NodeLink, status: TaskStatus): Promise<void> {
	if (!link.queried.delete(status.taskId)) return;
	if (status.state !== "unknown") return; // it will show up in the next Hello or send TaskExit
	const row = await core.row(status.taskId);
	if (!row || row.node_id !== link.conn.nodeId) return;
	if (row.state === "unknown") {
		// Already reported unknown, and the client does not know it either: no exit can arrive, so the
		// output kept for a late result goes now (doc/execution-plane.md#输出).
		dropLive(core, row.id);
		return;
	}
	if (TERMINAL.has(row.state)) return;
	// Not accepted: the start may never have arrived. Accepted: the client restarted and lost it.
	await markUnknown(core, row.id, row.state === "dispatched" ? "dispatch_unconfirmed" : "executor_restarted");
	// Nothing will ever complete this buffer: the client has no such task (see above).
	dropLive(core, row.id);
}
