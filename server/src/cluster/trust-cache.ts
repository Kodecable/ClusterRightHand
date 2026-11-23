/**
 * The node trust cache (doc/design/privilege.md "Trust cache"): a node's pushed trust report is stored, and
 * the units with a task waiting on the node are synced when its digest changes or it reports for the
 * first time on a connection.
 */
import type { TrustReport } from "@crh/protocol";
import { syncNodeAuthorizations } from "./authorization/sync.ts";
import type { ClusterCore } from "./core.ts";
import type { NodeLink } from "./links.ts";
import { recordTrustReport } from "./trust.ts";

/**
 * Applies a pushed trust report and syncs the units with a task waiting on the node
 * (doc/design/privilege.md "Trust cache").
 */
export async function onTrustSummary(core: ClusterCore, link: NodeLink, report: TrustReport): Promise<void> {
	const nodeId = link.conn.nodeId;
	const firstReport = !link.trustFresh;
	const change = await core.trustQueue.run(nodeId, async () => {
		const result = await recordTrustReport(core.db, nodeId, report, { audit: core.audit });
		link.trustFresh = true;
		return result;
	});
	// Only an `ok` report carries a digest worth planning against: a privileged mode that went
	// away must not fail the tasks that wait (it may come back with the same trust). The first report
	// on a connection syncs too, so a signature the owner submitted while the node was away is used as
	// soon as it reconnects (doc/design/privilege.md "Trust cache").
	if (report.kind === "ok" && !link.conn.closed && (change.changed || firstReport)) {
		try {
			await syncNodeAuthorizations(core, nodeId);
		} catch (err) {
			console.error(`syncing the waiting authorizations of node ${nodeId} failed:`, err);
		}
		// A privileged terminal waiting on the tool's signature is planned again too.
		core.terminals?.onTrustSummary(nodeId);
	}
}
