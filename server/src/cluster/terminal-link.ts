/**
 * The cluster side of the terminal subsystem (doc/design/pty.md): the sink the terminal service
 * installs to hear about node events, the node lookups it needs, the authorization planner for a
 * privileged terminal, and the one place a `pty.open` authorization is turned into wire bytes.
 *
 * The terminal service owns the objects, the screens and the idle timers; this module only gives it
 * the same privilege inputs a task's dispatch uses, so a privileged terminal is authorized exactly
 * like a privileged task: the same planner, stored owner authorizations, trust cache, cosign tickets
 * and attempt counter, with the terminal id standing in for the task id.
 */

import type { AuthorizationOption } from "@crh/api";
import type { TransportCiphers } from "@crh/noise";
import type { Peer } from "@crh/protocol";
import {
	type Authorization,
	authorizationCodec,
	decodeAuthorizationPayload,
	encode as encodeCbor,
	type PtyExited,
	type PtyStatus,
	type TaskSpec,
} from "@crh/protocol";
import type { WebSocket } from "ws";
import { authorizationDeadline } from "../privilege/payload.ts";
import { type PlannerNodeGroup, planAuthorization } from "../privilege/planner.ts";
import { ownerSigningCredentials } from "../privilege/signing-credentials.ts";
import { encodeAuthorization } from "../privilege/submission.ts";
import { signCosignTickets } from "./authorization/cosign-tickets.ts";
import { loadStoredOwnerAuthorizations } from "./authorization/owner-authorizations.ts";
import { optionRecords } from "./authorization.ts";
import type { ClusterCore } from "./core.ts";
import { nodeGroupsForNodes } from "./node-groups.ts";
import { getNode } from "./nodes.ts";
import { parseTrustReport, trustUnavailableMessage } from "./trust.ts";

/** What the terminal service hears from the cluster; every method is a notification, never awaited by a link. */
export interface TerminalSink {
	/** The node reported a trust summary (a changed digest or the first report on a connection). */
	onTrustSummary(nodeId: string): void;
	/** A user submitted an authorization; a terminal wait it may cover is planned again. */
	onAuthorizationSubmitted(userId: string, payload: { taskIds: readonly string[] | null }): void;
	/** A node's control connection ended; the terminals stay, their data connections died with it. */
	onLinkLost(nodeId: string): void;
	/** The node was deleted: its terminals close with `node_removed`. */
	onNodeRemoved(nodeId: string): void;
	/** The node's key was revoked (re-enrollment): close its terminals with `node_removed`. */
	nodeRevoked(nodeId: string): void;
	/** `pty.list`, sent after hello: continue what both hold and close what either no longer does. */
	onPtyList(nodeId: string, terminals: readonly PtyStatus[]): void;
	/** `pty.exited`: the process ended, or a relayed terminal lost its privileged mode. */
	onPtyExited(nodeId: string, exit: PtyExited): void;
	/** The output offset of a terminal a data connection names, or undefined when crhs does not hold it. */
	ptyConnectionOffset(nodeId: string, ptyId: string): number | undefined;
	/** A node's data connection handshake was accepted; the terminal service continues its streams. */
	onDataConnection(
		nodeId: string,
		ws: WebSocket,
		ciphers: TransportCiphers,
		init: { ptyId: string; inputReceived: number },
	): void;
}

/** The connection view the terminal service may use to send terminal commands. */
export interface TerminalNodeLink {
	peer: Peer;
	ready: boolean;
}

/** The node's link, when it can take terminal commands now. */
export function terminalNodeLink(core: ClusterCore, nodeId: string): TerminalNodeLink | undefined {
	const link = core.links.get(nodeId);
	if (!link || link.conn.closed || !link.ready) return undefined;
	return { peer: link.conn.peer, ready: link.ready };
}

/** The terminal service's sink, if one is installed. */
export function terminalsOf(core: ClusterCore): TerminalSink | undefined {
	return core.terminals;
}

// ---- privileged authorization ----

/** One planned way to authorize a privileged terminal. */
export type TerminalAuthorizationPlan =
	| {
			kind: "usable";
			via: "crhs" | "user";
			/** The complete encoded authorization object. */
			authorization: Uint8Array;
			/** The authorization id (SHA-256 of the payload), as `authorizations.id`. */
			authorizationId: string;
			/** The payload bytes, kept for the attempt's audit. */
			payloadBytes: Uint8Array;
			/** The cosign ticket, when the node requires crhs's cosignature for this use. */
			cosign: Uint8Array | null;
			deadline: string;
	  }
	| { kind: "options"; options: AuthorizationOption[] }
	| { kind: "failure"; code: string; message: string };

export interface TerminalPlanInput {
	ptyId: string;
	userId: string;
	nodeId: string;
	argv: string[];
	attempt: number;
	/** When the terminal was created (crhs clock, ms): the start of the signature count. */
	since: number;
	crhsRejected: { window: number | null } | null;
	rejectedBefore: string | null;
	/** The sign payload the waiting terminal holds now, kept when it is still valid. */
	currentOptions: readonly AuthorizationOption[];
}

/** The `pty.create` spec of a terminal's argv. */
export function ptyCreateSpec(argv: readonly string[]): TaskSpec {
	return { kind: "pty.create", argv: [...argv] };
}

/**
 * Plans a privileged terminal's authorization with the advisor's planner, then turns its answer into
 * what `pty.open` carries. A plan is only a prediction: crha re-verifies everything before running.
 */
export async function planTerminalAuthorization(
	core: ClusterCore,
	input: TerminalPlanInput,
): Promise<TerminalAuthorizationPlan> {
	const node = await getNode(core.db, input.nodeId);
	if (!node) return { kind: "failure", code: "node_removed", message: "the node no longer exists" };
	const report = parseTrustReport(node.trust_report);
	if (!report) {
		return {
			kind: "failure",
			code: "privileged_unavailable",
			message: "the node has not reported a trust summary; it cannot authorize a privileged terminal",
		};
	}
	if (report.kind !== "ok") {
		return { kind: "failure", code: "privileged_unavailable", message: trustUnavailableMessage(report) };
	}
	const groups: PlannerNodeGroup[] = ((await nodeGroupsForNodes(core.db, [node.id])).get(node.id) ?? []).map(
		(group) => ({ id: group.id, name: group.name }),
	);
	const spec = ptyCreateSpec(input.argv);
	const current = currentPayloadOf(input.currentOptions);
	const plan = await planAuthorization({
		target: {
			kind: "task",
			task: {
				id: input.ptyId,
				attempt: input.attempt,
				spec,
				node: { id: node.id, name: node.name, summary: report.summary, groups },
				taskGroup: false,
				online: terminalNodeLink(core, node.id) !== undefined,
				crhsRejected: input.crhsRejected,
				rejectedBefore: input.rejectedBefore === null ? null : Date.parse(input.rejectedBefore),
			},
		},
		owner: await ownerSigningCredentials(core.db, input.userId),
		keys: core.signingKeys.keys,
		stored: await loadStoredOwnerAuthorizations(core, input.userId, {
			since: input.since,
			taskIds: [input.ptyId],
		}),
		since: input.since,
		current,
		now: Date.now(),
	});
	if (plan.kind === "failure") return failurePlan(plan.failures);
	if (plan.kind === "options") {
		// A terminal is one task, so a plan that parks it always has its failure or its options.
		if (plan.failed.length > 0) return failurePlan(plan.failed);
		if (plan.options.length === 0) {
			return {
				kind: "failure",
				code: "authorization_required",
				message: "no one on this node can authorize this terminal",
			};
		}
		return { kind: "options", options: optionRecords(plan.options) };
	}
	const use = plan.uses[0];
	if (!use) return { kind: "failure", code: "authorization_required", message: "the plan authorized nothing" };
	if (use.kind === "crhs") {
		const key = core.signingKeys.byFingerprint(use.keyFingerprint);
		if (!key) {
			return {
				kind: "failure",
				code: "authorization_required",
				message: "crhs has no authorization signing key for this node",
			};
		}
		const wire: Authorization = {
			payload: use.authorization.bytes,
			signatures: [{ kind: "sshsig", blob: key.sign(use.authorization.bytes) }],
		};
		const encoded = Uint8Array.from(encodeCbor(authorizationCodec.encode(wire)));
		return {
			kind: "usable",
			via: "crhs",
			authorization: encoded,
			authorizationId: use.authorization.id,
			payloadBytes: use.authorization.bytes,
			cosign: null,
			deadline: authorizationDeadline(use.authorization.payload.deadlineMs),
		};
	}
	const encoded = encodeAuthorization(use.payloadBytes, use.signatures);
	let cosign: Uint8Array | null = null;
	if (use.cosign.length > 0) {
		const ticket = signCosignTickets(
			core,
			{ id: use.id, payloadBytes: use.payloadBytes, encodedBytes: encoded.length },
			use.cosign.map((entry) => ({
				node: entry.nodeId,
				taskId: entry.taskId,
				attempt: input.attempt,
				keyFingerprint: entry.keyFingerprint,
			})),
			input.userId,
		);
		cosign = ticket.get(input.ptyId) ?? null;
	}
	return {
		kind: "usable",
		via: "user",
		authorization: encoded,
		authorizationId: use.id,
		payloadBytes: use.payloadBytes,
		cosign,
		deadline: authorizationDeadline(use.payload.deadlineMs),
	};
}

function failurePlan(failures: readonly { code: string; taskId: string }[]): TerminalAuthorizationPlan {
	const failure = failures[0];
	if (!failure)
		return { kind: "failure", code: "authorization_required", message: "nothing can authorize this terminal" };
	const messages: Record<string, string> = {
		node_offline: "the node is offline",
		alias_missing: "the node does not trust the node group the authorization addresses as an alias",
		authorization_required: "no one on this node can authorize this terminal",
	};
	return {
		kind: "failure",
		code: failure.code === "alias_missing" ? "alias_missing" : failure.code,
		message: messages[failure.code] ?? "no one on this node can authorize this terminal",
	};
}

/** The sign payload the terminal's stored options hold, decoded for the planner to keep or replace. */
function currentPayloadOf(options: readonly AuthorizationOption[]): {
	payload: ReturnType<typeof decodeAuthorizationPayload>;
	bytes: Uint8Array;
	id: string;
} | null {
	for (const option of options) {
		if (option.kind !== "sign" || option.payload === null) continue;
		try {
			const bytes = Uint8Array.from(Buffer.from(option.payload.payload, "base64"));
			return { payload: decodeAuthorizationPayload(bytes), bytes, id: option.payload.id };
		} catch {
			return null;
		}
	}
	return null;
}
