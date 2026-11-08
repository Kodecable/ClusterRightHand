import type { ApiTokenView } from "@crh/api";
import { Trans, useLingui } from "@lingui/react/macro";
import { KeySquareIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { actionsHeader, DataTable, type DataTableColumn } from "@/components/data-table";
import { ConfirmDialog } from "@/components/dialogs";
import { EmptyState } from "@/components/empty-state";
import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";
import { DateTime } from "@/components/relative-time";
import { TokenStatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { rulePresetLabel } from "@/lib/rule-preset";
import { useApiTokens, useDeleteApiToken, useRevokeApiToken } from "./api";
import { CreateTokenDialog } from "./create-token-dialog";
import { RulesDialog } from "./rules-dialog";
import { tokenStatus } from "./tokenStatus";

/**
 * API tokens (doc/mcp.md): create once-shown secrets, edit the rule preset and the
 * extra rules, revoke an active token or delete an inactive one.
 */
export function TokensPage() {
	const { t } = useLingui();
	const tokens = useApiTokens();
	const revoke = useRevokeApiToken();
	const remove = useDeleteApiToken();
	const [creating, setCreating] = useState(false);
	const [rules, setRules] = useState<ApiTokenView>();
	const [revoking, setRevoking] = useState<ApiTokenView>();
	const [deleting, setDeleting] = useState<ApiTokenView>();

	const columns = useMemo<DataTableColumn<ApiTokenView>[]>(
		() => [
			{
				id: "name",
				header: t`Name`,
				cell: ({ row }) => <span className="truncate font-medium">{row.original.name}</span>,
			},
			{
				id: "rulePreset",
				header: t`Rule preset`,
				size: 110,
				cell: ({ row }) => {
					const rulePreset = row.original.rules?.rulePreset;
					return <span className="text-xs">{rulePreset === undefined ? "–" : rulePresetLabel(rulePreset)}</span>;
				},
			},
			{
				id: "created",
				header: t`Created`,
				size: 150,
				cell: ({ row }) => <DateTime value={row.original.createdAt} />,
			},
			{
				id: "expires",
				header: t`Expires`,
				size: 150,
				cell: ({ row }) =>
					row.original.expiresAt === null ? (
						<Badge variant="secondary">
							<Trans>never</Trans>
						</Badge>
					) : (
						<DateTime value={row.original.expiresAt} />
					),
			},
			{
				id: "lastUsed",
				header: t`Last used`,
				size: 150,
				cell: ({ row }) => <DateTime value={row.original.lastUsedAt} />,
			},
			{
				id: "status",
				header: t`Status`,
				size: 110,
				cell: ({ row }) => <TokenStatusBadge status={tokenStatus(row.original)} />,
			},
			{
				id: "actions",
				header: actionsHeader,
				size: 200,
				cell: ({ row }) => {
					const token = row.original;
					const status = tokenStatus(token);
					return status === "active" ? (
						<span className="flex flex-nowrap items-center gap-1">
							<Button type="button" size="xs" variant="outline" onClick={() => setRules(token)}>
								<Trans>Rules</Trans>
							</Button>
							<Button type="button" size="xs" variant="destructive" onClick={() => setRevoking(token)}>
								<Trans>Revoke</Trans>
							</Button>
						</span>
					) : (
						<Button type="button" size="xs" variant="destructive" onClick={() => setDeleting(token)}>
							<Trash2Icon />
							<Trans>Delete</Trans>
						</Button>
					);
				},
			},
		],
		[t],
	);

	return (
		<Page data-testid="tokens-page">
			<PageHeader
				title={<Trans>API tokens</Trans>}
				actions={
					<Button type="button" onClick={() => setCreating(true)} data-testid="create-token">
						<PlusIcon />
						<Trans>Create token</Trans>
					</Button>
				}
			/>
			<DataTable
				label={t`API tokens`}
				columns={columns}
				data={tokens.data ?? []}
				getRowId={(token) => token.id}
				loading={tokens.isLoading}
				error={tokens.isError ? tokens.error : undefined}
				onRetry={() => void tokens.refetch()}
				empty={
					<EmptyState
						icon={<KeySquareIcon className="size-6" />}
						title={<Trans>No API tokens yet</Trans>}
						description={<Trans>Create a token to connect an MCP client.</Trans>}
					/>
				}
			/>
			{creating && <CreateTokenDialog onClose={() => setCreating(false)} onCreated={() => void tokens.refetch()} />}
			{rules && <RulesDialog token={rules} onClose={() => setRules(undefined)} />}
			<ConfirmDialog
				open={revoking !== undefined}
				onOpenChange={(open) => {
					if (!open) setRevoking(undefined);
				}}
				title={revoking ? t`Revoke token ${revoking.name}?` : ""}
				description={<Trans>Anything using this token stops working immediately. This cannot be undone.</Trans>}
				confirmLabel={<Trans>Revoke token</Trans>}
				busy={revoke.isPending}
				onConfirm={() => {
					if (!revoking) return;
					revoke.mutate(revoking.id, {
						onSuccess: () => {
							toast.success(t`Token revoked.`);
							setRevoking(undefined);
						},
					});
				}}
			/>
			<ConfirmDialog
				open={deleting !== undefined}
				onOpenChange={(open) => {
					if (!open) setDeleting(undefined);
				}}
				title={deleting ? t`Delete token ${deleting.name}?` : ""}
				description={<Trans>Its audit trail stays; the token itself is removed.</Trans>}
				confirmLabel={<Trans>Delete token</Trans>}
				busy={remove.isPending}
				onConfirm={() => {
					if (!deleting) return;
					remove.mutate(deleting.id, {
						onSuccess: () => {
							toast.success(t`Token deleted.`);
							setDeleting(undefined);
						},
					});
				}}
			/>
		</Page>
	);
}
