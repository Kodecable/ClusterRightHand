import { Trans } from "@lingui/react/macro";
import { PageNotBuilt } from "@/components/page-not-built";

export function TasksPage() {
	return <PageNotBuilt title={<Trans>Tasks</Trans>} />;
}

export function TaskPage() {
	return <PageNotBuilt title={<Trans>Task</Trans>} />;
}

export function TaskGroupPage() {
	return <PageNotBuilt title={<Trans>Task group</Trans>} />;
}
