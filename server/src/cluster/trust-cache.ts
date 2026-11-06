/**
 * The node trust cache (doc/privilege.md#信任缓存): a node's pushed trust report is stored, the tasks
 * waiting for a signature are re-planned when its digest changes, and an owner's stored signatures
 * are used once the node reports again.
 */
import type { TrustReport } from "@crh/protocol";
import { resendLocalRequests } from "./authorization/local-approval.ts";
import { replanAwaiting, useStoredAuthorizations } from "./authorization/sweeps.ts";
import type { ClusterCore } from "./core.ts";
import type { NodeLink } from "./links.ts";
import { recordTrustReport } from "./trust.ts";

/**
 * Applies a pushed trust report and re-plans the tasks that wait for an authorization signature
 * (doc/privilege.md#信任缓存).
 */
export async function onTrustSummary(core: ClusterCore, link: NodeLink, report: TrustReport): Promise<void> {
	const nodeId = link.conn.nodeId;
	const change = await core.trustQueue.run(nodeId, async () => {
		const result = await recordTrustReport(core.db, nodeId, report, { audit: core.audit });
		if (!link.trustFresh) {
			link.trustFresh = true;
			for (const wake of [...link.trustWaiters]) wake();
			link.trustWaiters.clear();
			core.notifyLink(nodeId);
		}
		return result;
	});
	if (report.kind === "ok" && !link.conn.closed) {
		// A privileged mode that restarted lost its in-memory approval requests (doc/protocol.md#taskstart).
		await resendLocalRequests(core, link);
		// A signature the owner submitted while the node was away is used now.
		await useStoredAuthorizations(core, nodeId);
	}
	// Only an `ok` report carries a digest worth re-planning against: a privileged mode that went
	// away must not fail the tasks that wait for a signature (it may come back with the same trust).
	if (change.changed && report.kind === "ok") await replanAwaiting(core, nodeId);
}
