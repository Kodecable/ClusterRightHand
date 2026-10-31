import { Trans, useLingui } from "@lingui/react/macro";
import { useId, useMemo, useState } from "react";
import { toast } from "sonner";
import { ErrorText } from "@/components/error-state";
import { FieldShell } from "@/components/form";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useShareNode, useUnshareNode } from "@/features/nodes/api";
import { useDirectory } from "@/features/users/api";
import type { GranteeType, NodeShare, PublicNode, ShareAccess } from "@/lib/api/types";

/**
 * The shares of a node (doc/access-control.md#归属与分享): who else may view
 * or operate it, and the form an owner or administrator uses to add one.
 */
export function NodeShares({ node, shares, canManage }: { node: PublicNode; shares: NodeShare[]; canManage: boolean }) {
	const { t } = useLingui();
	const prefix = useId();
	const directory = useDirectory();
	const share = useShareNode();
	const unshare = useUnshareNode();
	const [granteeType, setGranteeType] = useState<GranteeType>("user");
	const [granteeId, setGranteeId] = useState("");
	const [access, setAccess] = useState<ShareAccess>("view");

	const options = useMemo(
		() =>
			granteeType === "user"
				? (directory.data?.users ?? []).map((user) => ({ id: user.id, label: user.displayName || user.username }))
				: (directory.data?.userGroups ?? []).map((group) => ({ id: group.id, label: group.name })),
		[directory.data, granteeType],
	);

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
											{entry.granteeType === "user" ? t`User` : t`Group`}
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
													{
														onSuccess: () => toast.success(t`Access removed.`),
														onError: (error) => toast.error(error.message),
													},
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
				<form
					className="flex flex-wrap items-end gap-2"
					onSubmit={(event) => {
						event.preventDefault();
						if (granteeId === "") return;
						share.mutate(
							{ id: node.id, granteeType, granteeId, access },
							{
								onSuccess: () => {
									toast.success(t`Share added.`);
									setGranteeId("");
								},
								onError: (error) => toast.error(error.message),
							},
						);
					}}
				>
					<FieldShell id={`${prefix}-type`} label={t`Type`}>
						<Select
							value={granteeType}
							onValueChange={(next) => {
								setGranteeType(next as GranteeType);
								setGranteeId("");
							}}
						>
							<SelectTrigger id={`${prefix}-type`} className="w-36">
								<SelectValue>{(current: string | null) => (current === "user_group" ? t`Group` : t`User`)}</SelectValue>
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="user">{t`User`}</SelectItem>
								<SelectItem value="user_group">{t`Group`}</SelectItem>
							</SelectContent>
						</Select>
					</FieldShell>
					<FieldShell id={`${prefix}-grantee`} label={t`Grantee`} className="min-w-48">
						<Select
							value={granteeId === "" ? null : granteeId}
							onValueChange={(next) => setGranteeId(String(next ?? ""))}
						>
							<SelectTrigger id={`${prefix}-grantee`} className="w-56">
								<SelectValue placeholder={t`Select…`}>
									{(current: string | null) => options.find((option) => option.id === current)?.label ?? t`Select…`}
								</SelectValue>
							</SelectTrigger>
							<SelectContent>
								{options.map((option) => (
									<SelectItem key={option.id} value={option.id}>
										{option.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</FieldShell>
					<FieldShell id={`${prefix}-access`} label={t`Access`}>
						<Select value={access} onValueChange={(next) => setAccess(next as ShareAccess)}>
							<SelectTrigger id={`${prefix}-access`} className="w-32">
								<SelectValue>{(current: string | null) => (current === "operate" ? t`Operate` : t`View`)}</SelectValue>
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="view">{t`View`}</SelectItem>
								<SelectItem value="operate">{t`Operate`}</SelectItem>
							</SelectContent>
						</Select>
					</FieldShell>
					<Button type="submit" disabled={share.isPending || granteeId === ""}>
						<Trans>Add share</Trans>
					</Button>
				</form>
			)}
			<ErrorText error={share.error ?? unshare.error} />
		</section>
	);
}
