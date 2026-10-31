import { Trans } from "@lingui/react/macro";
import { PageNotBuilt } from "@/components/page-not-built";

export function NodesPage() {
	return <PageNotBuilt title={<Trans>Nodes</Trans>} />;
}

export function NodeDetailPage() {
	return <PageNotBuilt title={<Trans>Node</Trans>} />;
}
