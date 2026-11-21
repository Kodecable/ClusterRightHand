import type { NodeUpgradeResponse, NodeUpgradeSkipReason } from "@crh/api";
import type { I18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ErrorText } from "@/components/error-state";
import { Spinner } from "@/components/spinner";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { useUpgradeNodes } from "./api";

/** Why crhs skips a node, as one sentence. */
export function upgradeSkipText(i18n: I18n, reason: NodeUpgradeSkipReason): string {
	switch (reason) {
		case "not_crha":
			return i18n._(msg`not a crha node`);
		case "not_connected":
			return i18n._(msg`not connected`);
		case "self_upgrade_unavailable":
			return i18n._(msg`cannot be upgraded from crhs`);
		case "no_arch":
			return i18n._(msg`its crha is too old to report its architecture`);
		case "up_to_date":
			return i18n._(msg`already at this version`);
		case "newer_than_crhs":
			return i18n._(msg`newer than crhs; there is no downgrade`);
		case "not_a_release_version":
			return i18n._(msg`runs a build that is not a release`);
		case "upgrade_in_progress":
			return i18n._(msg`an upgrade of this node has not ended yet`);
	}
}

/** A node's own reason it cannot be upgraded (doc/design/distribution.md "Who can self-upgrade"). */
export function selfUpgradeReasonText(i18n: I18n, reason: string): string {
	switch (reason) {
		case "package_managed":
			return i18n._(msg`installed by the package manager (upgrade it with apt or dnf)`);
		case "not_systemd":
			return i18n._(msg`not started by systemd`);
		case "unmanaged_unit":
			return i18n._(msg`its systemd units were not written by crha enroll`);
		case "unit_mismatch":
			return i18n._(msg`its units do not start the running binary`);
		case "no_privilege":
			return i18n._(msg`nothing on the node can replace the binary as root`);
		case "privileged_not_root":
			return i18n._(msg`the privileged mode does not run as root`);
		case "privileged_unavailable":
			return i18n._(msg`the privileged mode is not reachable`);
		default:
			// A reason from a newer crha: shown as it is.
			return reason;
	}
}

/**
 * Plans an upgrade of `targets` (node or node group ids) to crhs's crha version, shows which nodes are
 * upgraded and which are skipped, then starts it. The upgrade is a privileged task group: it waits for its
 * authorization like any privileged task, on the task group's page.
 */
export function UpgradeCrhaDialog({ targets, onClose }: { targets: string[]; onClose: () => void }) {
	const { i18n } = useLingui();
	const navigate = useNavigate();
	const plan = useUpgradeNodes();
	const start = useUpgradeNodes();
	const [planned, setPlanned] = useState<NodeUpgradeResponse>();
	// Several architectures start several task groups: each is listed, as each waits for its own signature.
	const [started, setStarted] = useState<NodeUpgradeResponse["taskGroups"]>([]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: plan once, when the dialog opens.
	useEffect(() => {
		plan.mutate({ targets, dryRun: true }, { onSuccess: setPlanned });
	}, []);

	const running = planned?.upgrades.reduce((sum, upgrade) => sum + upgrade.runningTasks, 0) ?? 0;

	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			<DialogContent data-testid="upgrade-crha-dialog">
				<DialogHeader>
					<DialogTitle>
						<Trans>Upgrade crha</Trans>
					</DialogTitle>
					<DialogDescription>
						{planned ? (
							<Trans>
								Bring crha to crhs's version {planned.version}. crhs verifies the release first. The upgrade is a
								privileged task group: nodes that trust only users wait for a signature on its page.
							</Trans>
						) : (
							<Trans>Checking which nodes can be upgraded…</Trans>
						)}
					</DialogDescription>
				</DialogHeader>
				{plan.isPending && <Spinner />}
				{plan.error && <ErrorText error={plan.error} />}
				{planned && (
					<div className="grid gap-3 text-sm">
						{planned.upgrades.length > 0 ? (
							<section aria-label={i18n._(msg`Nodes to upgrade`)}>
								<p className="font-medium">
									<Trans>Upgraded</Trans>
								</p>
								<ul className="grid gap-1">
									{planned.upgrades.map((upgrade) => (
										<li key={upgrade.nodeId}>
											<Trans>
												{upgrade.name}: {upgrade.version} → {planned.version} ({upgrade.arch})
											</Trans>
										</li>
									))}
								</ul>
							</section>
						) : (
							<p>
								<Trans>None of these nodes can be upgraded now.</Trans>
							</p>
						)}
						{running > 0 && (
							<p role="alert" className="text-destructive">
								<Plural
									value={running}
									one="Restarting crha ends # running task; it will end as unknown."
									other="Restarting crha ends # running tasks; they will end as unknown."
								/>
							</p>
						)}
						{planned.skipped.length > 0 && (
							<section aria-label={i18n._(msg`Skipped nodes`)}>
								<p className="font-medium">
									<Trans>Skipped</Trans>
								</p>
								<ul className="grid gap-1 text-muted-foreground">
									{planned.skipped.map((skip) => (
										<li key={skip.nodeId}>
											{skip.name}: {upgradeSkipText(i18n, skip.reason)}
											{skip.nodeReasons.length > 0 &&
												` (${skip.nodeReasons.map((reason) => selfUpgradeReasonText(i18n, reason)).join(", ")})`}
										</li>
									))}
								</ul>
							</section>
						)}
					</div>
				)}
				{started.length > 1 && (
					<section aria-label={i18n._(msg`Started task groups`)} className="grid gap-1 text-sm">
						<p className="font-medium">
							<Trans>Started one task group per architecture; each waits for its authorization:</Trans>
						</p>
						<ul className="grid gap-1">
							{started.map((group) => (
								<li key={group.taskGroupId}>
									<Link
										to="/task-groups/$taskGroupId"
										params={{ taskGroupId: group.taskGroupId }}
										className="underline"
										onClick={onClose}
									>
										<Trans>Task group for {group.arch}</Trans>
									</Link>
								</li>
							))}
						</ul>
					</section>
				)}
				{start.error && <ErrorText error={start.error} />}
				<DialogFooter>
					<Button type="button" variant="outline" onClick={onClose}>
						<Trans>Cancel</Trans>
					</Button>
					<Button
						type="button"
						disabled={!planned || planned.upgrades.length === 0 || start.isPending || started.length > 0}
						onClick={() =>
							start.mutate(
								// Exactly the nodes shown: a node that joined a group since the plan was not confirmed.
								{ targets: planned?.upgrades.map((upgrade) => upgrade.nodeId) ?? [], dryRun: false },
								{
									onSuccess: (result) => {
										const [only, ...more] = result.taskGroups;
										if (only && more.length === 0) {
											onClose();
											void navigate({ to: "/task-groups/$taskGroupId", params: { taskGroupId: only.taskGroupId } });
										} else if (only) {
											setStarted(result.taskGroups);
										} else {
											onClose();
										}
									},
								},
							)
						}
					>
						{start.isPending && <Spinner />}
						<Trans>Upgrade</Trans>
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
