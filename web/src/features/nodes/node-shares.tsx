import { Trans, useLingui } from "@lingui/react/macro";
import { toast } from "sonner";
import { ErrorText } from "@/components/error-state";
import { ShareEditor } from "@/components/share-editor";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useShareNode, useUnshareNode } from "@/features/nodes/api";
import type { NodeShare, PublicNode } from "@/lib/api/types";

/**
 * The shares of a node (doc/access-control.md#归属与分享): who else may view
 * or operate it, and the form an owner or administrator uses to add one.
 */
export function NodeShares({ node, shares, canManage }: { node: PublicNode; shares: NodeShare[]; canManage: boolean }) {
	const { t } = useLingui();
	const share = useShareNode();
	const unshare = useUnshareNode();

	return (
		<section className="grid gap-2" aria-labelledby="node-shares-heading" data-testid="node-shares">
			<h2 id="node-shares-heading" className="text-sm font-semibold">
				<Trans>Shares</Trans>
			</h2>
			{shares.length === 0 ? (
				<p className="text-sm text-muted-foreground">
					<Trans>Not shared.</Trans>
				</p>
			) : (
				<div className="overflow-auto rounded-lg border">
					<Table aria-label={t`Node shares`}>
						<TableHeader>
							<TableRow>
								<TableHead>{t`Grantee`}</TableHead>
								<TableHead>{t`Access`}</TableHead>
								<TableHead className="w-24" />
							</TableRow>
						</TableHeader>
						<TableBody>
							{shares.map((entry) => (
								<TableRow key={entry.id}>
									<TableCell>
										<span className="text-xs text-muted-foreground">
											{entry.granteeType === "user" ? t`User` : t`User group`}
										</span>{" "}
										{entry.granteeName || <span className="font-mono text-xs">{entry.granteeId}</span>}
									</TableCell>
									<TableCell>{entry.access}</TableCell>
									<TableCell>
										<Button
											type="button"
											variant="destructive"
											size="xs"
											disabled={!canManage || unshare.isPending}
											aria-label={t`Remove access for ${entry.granteeName}`}
											onClick={() =>
												unshare.mutate(
													{ id: node.id, shareId: entry.id },
													{ onSuccess: () => toast.success(t`Access removed.`) },
												)
											}
										>
											<Trans>Remove</Trans>
										</Button>
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				</div>
			)}
			{canManage && (
				<ShareEditor
					layout="inline"
					accessOptions={[
						{ value: "view", label: <Trans>View</Trans> },
						{ value: "operate", label: <Trans>Operate</Trans> },
					]}
					defaultAccess="view"
					userGroupLabel={<Trans>User group</Trans>}
					busy={share.isPending}
					onAdd={async ({ granteeType, granteeId, access }) => {
						try {
							await share.mutateAsync({ id: node.id, granteeType, granteeId, access });
							toast.success(t`Share added.`);
							return true;
						} catch {
							return false;
						}
					}}
				/>
			)}
			<ErrorText error={share.error ?? unshare.error} />
		</section>
	);
}
