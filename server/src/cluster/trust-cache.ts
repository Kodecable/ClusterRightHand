/**
 * The node trust cache and the revocation pushes (doc/privilege.md#信任缓存, #吊销): a node's pushed
 * trust report is stored, the tasks waiting for a signature are re-planned when its digest changes,
 * and a revocation is pushed to every connected node of the organization so they stop accepting it.
 */
import { ConnectionError, type Revocation, type TrustReport } from "@crh/protocol";
import type { AuditActor } from "../audit/audit.ts";
import { replanAwaiting, resendLocalRequests, useStoredAuthorizations } from "./authorization-flow.ts";
import type { ClusterCore } from "./core.ts";
import type { NodeLink } from "./links.ts";
import { getNode } from "./nodes.ts";
import { batchRevocations, listRevocations, revokeAuthorizationRow } from "./revocations.ts";
import { recordTrustReport } from "./trust.ts";

/**
 * Revokes an authorization, audits it and pushes `revocations.add` to every connected node of its
 * organization (doc/privilege.md#吊销). Idempotent: a second call changes nothing and pushes nothing.
 */
export async function revokeAuthorization(
	core: ClusterCore,
	id: string,
	actor: AuditActor,
): Promise<{ id: string; revokedAt: string; changed: boolean }> {
	const { row, changed } = await revokeAuthorizationRow(core.db, id);
	const revokedAt = row.revoked_at as string;
	if (!changed) return { id, revokedAt, changed };
	await core.audit?.record({
		actor,
		action: "authorization.revoked",
		target: { type: "authorization", id },
		detail: { issuer_user_id: row.issuer_user_id, deadline: row.deadline, task_ids: row.task_ids },
	});
	// The privileged mode accepts pushed revocations without a signature; the push is best effort,
	// the next `ok` report sends the whole list again (doc/protocol.md#revocationsadd).
	const entries = await listRevocations(core.db, row.org_id);
	for (const link of core.links.values()) {
		const node = await getNode(core.db, link.conn.nodeId);
		if (node?.org_id === row.org_id) sendRevocations(link, entries);
	}
	return { id, revokedAt, changed };
}

/**
 * Applies a pushed trust report, then resends the organization's revocations and re-plans the tasks
 * that wait for an authorization signature (doc/privilege.md#信任缓存, #吊销).
 */
export async function onTrustSummary(core: ClusterCore, link: NodeLink, report: TrustReport): Promise<void> {
	const nodeId = link.conn.nodeId;
	const change = await core.trustQueue.run(nodeId, async () => {
		const result = await recordTrustReport(core.db, nodeId, report, { audit: core.audit });
		if (!link.trustFresh) {
			link.trustFresh = true;
			for (const wake of [...link.trustWaiters]) wake();
			link.trustWaiters.clear();
		}
		return result;
	});
	if (report.kind === "ok" && !link.conn.closed) {
		const node = await getNode(core.db, nodeId);
		if (node) sendRevocations(link, await listRevocations(core.db, node.org_id));
		// A privileged mode that restarted lost its in-memory approval requests (doc/protocol.md#taskstart).
		await resendLocalRequests(core, link);
		// A signature the owner submitted while the node was away is used now.
		await useStoredAuthorizations(core, nodeId);
	}
	// Only an `ok` report carries a digest worth re-planning against: a privileged mode that went
	// away must not fail the tasks that wait for a signature (it may come back with the same trust).
	if (change.changed && report.kind === "ok") await replanAwaiting(core, nodeId);
}

function sendRevocations(link: NodeLink, entries: readonly Revocation[]): void {
	// A restricted connection receives only node.status; everything else would break the handshake
	// contract of a pending node (doc/protocol.md#受限连接).
	if (!link.active) return;
	if (entries.length === 0 || link.conn.closed || !link.conn.optional.has("revocations.add")) return;
	for (const batch of batchRevocations(entries)) {
		void link.conn.peer.request("revocations.add", { entries: [...batch] }).catch((err: unknown) => {
			// Retried after the node's next `ok` report; a gone connection needs no log line.
			if (!(err instanceof ConnectionError)) console.error("revocations.add failed:", err);
		});
	}
}
