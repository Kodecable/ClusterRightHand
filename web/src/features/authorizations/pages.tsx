import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { RefreshCwIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { actionsHeader, DataTable, type DataTableColumn } from "@/components/data-table";
import { ConfirmDialog } from "@/components/dialogs";
import { EmptyState } from "@/components/empty-state";
import { KeyValueList } from "@/components/key-value";
import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";
import { DateTime } from "@/components/relative-time";
import { AuthorizationStatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useAuth } from "@/features/auth/session";
import type { AuthorizationSummary, DecodedAuthorizationPayload } from "@/lib/api/types";
import { useAuthorizations, useRevokeAuthorization } from "./api";

/** The command a payload authorizes, as one line. */
export function authorizationCommandText(command: DecodedAuthorizationPayload["command"]): string {
	if (command === null) return "any method and target";
	if (command.match === "exact") return `${command.method} exact ${command.target}`;
	return `${command.method} prefix ${command.target}`;
}

function PayloadDialog({ entry, onClose }: { entry: AuthorizationSummary; onClose: () => void }) {
	const { t } = useLingui();
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>
						<Trans>Authorization payload</Trans>
					</DialogTitle>
				</DialogHeader>
				<KeyValueList
					items={[
						{ label: t`Id`, value: entry.id, mono: true },
						{ label: t`Issuer`, value: entry.issuerUsername ?? entry.issuerUserId ?? "crhs" },
						{ label: t`Issued`, value: <DateTime value={entry.issuedAt} seconds /> },
						{ label: t`Deadline`, value: <DateTime value={entry.deadline} seconds /> },
						...(entry.attempt !== null ? [{ label: t`Attempt`, value: String(entry.attempt) }] : []),
						{ label: t`Command`, value: authorizationCommandText(entry.command), mono: true },
						{ label: t`Nodes`, value: entry.nodes.join(", ") || "–", mono: true },
						{ label: t`Tasks`, value: entry.taskIds === null ? t`reusable` : entry.taskIds.join(", "), mono: true },
						...(entry.note !== "" ? [{ label: t`Note`, value: entry.note }] : []),
						{ label: t`Revoked`, value: <DateTime value={entry.revokedAt} seconds /> },
					]}
				/>
			</DialogContent>
		</Dialog>
	);
}

/**
 * Authorizations (doc/m4.md M4.4, doc/privilege.md#吊销): what this user signed
 * — administrators see their organization's — and where to revoke it. A
 * revocation is pushed to the nodes with `revocations.add`; a node that is
 * offline gets it after its next trust report.
 */
export function AuthorizationsPage() {
	const { t } = useLingui();
	const user = useAuth().user;
	const authorizations = useAuthorizations();
	const revoke = useRevokeAuthorization();
	const [payload, setPayload] = useState<AuthorizationSummary>();
	const [revoking, setRevoking] = useState<AuthorizationSummary>();
	const rows = useMemo(() => authorizations.data?.pages.flatMap((page) => page.items) ?? [], [authorizations.data]);

	const columns = useMemo<DataTableColumn<AuthorizationSummary>[]>(
		() => [
			{
				id: "created",
				header: t`Created`,
				size: 150,
				cell: ({ row }) => <DateTime value={row.original.createdAt} seconds />,
			},
			{
				id: "issuer",
				header: t`Issuer`,
				size: 130,
				cell: ({ row }) => (
					<span className="truncate text-xs">
						{row.original.issuerUsername ??
							(row.original.issuerUserId !== null ? row.original.issuerUserId.slice(0, 8) : "crhs")}
					</span>
				),
			},
			{
				id: "nodes",
				header: t`Nodes`,
				size: 140,
				cell: ({ row }) => <span className="truncate font-mono text-xs">{row.original.nodes.join(", ") || "–"}</span>,
			},
			{
				id: "command",
				header: t`Command`,
				cell: ({ row }) => (
					<span className="truncate font-mono text-xs">{authorizationCommandText(row.original.command)}</span>
				),
			},
			{
				id: "deadline",
				header: t`Deadline`,
				size: 150,
				cell: ({ row }) => <DateTime value={row.original.deadline} />,
			},
			{
				id: "tasks",
				header: t`Tasks`,
				size: 100,
				cell: ({ row }) =>
					row.original.taskIds === null ? (
						<span className="text-xs">
							<Trans>reusable</Trans>
						</span>
					) : (
						<span className="text-xs">
							<Plural value={row.original.taskIds.length} one="# task" other="# tasks" />
						</span>
					),
			},
			{
				id: "status",
				header: t`Status`,
				size: 110,
				cell: ({ row }) => <AuthorizationStatusBadge status={row.original.revokedAt !== null ? "revoked" : "active"} />,
			},
			{
				id: "actions",
				header: actionsHeader,
				size: 170,
				cell: ({ row }) => {
					const entry = row.original;
					const canRevoke = entry.revokedAt === null && (user?.kind === "admin" || entry.issuerUserId === user?.id);
					return (
						<span className="flex flex-nowrap items-center gap-1">
							<Button type="button" size="xs" variant="outline" onClick={() => setPayload(entry)}>
								<Trans>Payload</Trans>
							</Button>
							{canRevoke && (
								<Button type="button" size="xs" variant="destructive" onClick={() => setRevoking(entry)}>
									<Trans>Revoke</Trans>
								</Button>
							)}
						</span>
					);
				},
			},
		],
		[t, user?.id, user?.kind],
	);

	return (
		<Page data-testid="authorizations-page">
			<PageHeader
				title={<Trans>Authorizations</Trans>}
				description={
					<Trans>
						An authorization is valid on the nodes its payload names until its deadline, until it is used up (one-shot
						authorizations) or until it is revoked here. Revocations reach a node that is offline after its next
						connection.
					</Trans>
				}
				actions={
					<Button type="button" variant="outline" onClick={() => void authorizations.refetch()}>
						<RefreshCwIcon />
						<Trans>Refresh</Trans>
					</Button>
				}
			/>
			<DataTable
				label={t`Authorizations`}
				columns={columns}
				data={rows}
				getRowId={(entry) => entry.id}
				loading={authorizations.isLoading}
				error={authorizations.isError ? authorizations.error : undefined}
				onRetry={() => void authorizations.refetch()}
				hasMore={authorizations.hasNextPage}
				loadingMore={authorizations.isFetchingNextPage}
				onLoadMore={() => void authorizations.fetchNextPage()}
				empty={
					<EmptyState
						title={<Trans>No authorizations yet</Trans>}
						description={<Trans>You have not signed any authorization yet.</Trans>}
					/>
				}
			/>
			{payload && <PayloadDialog entry={payload} onClose={() => setPayload(undefined)} />}
			<ConfirmDialog
				open={revoking !== undefined}
				onOpenChange={(open) => {
					if (!open) setRevoking(undefined);
				}}
				title={revoking ? t`Revoke authorization ${revoking.id.slice(0, 12)}…?` : ""}
				description={
					<Trans>
						Nodes that trust it drop its permissions. This cannot be undone; the authorization stays listed as revoked.
					</Trans>
				}
				confirmLabel={<Trans>Revoke authorization</Trans>}
				busy={revoke.isPending}
				onConfirm={() => {
					if (!revoking) return;
					revoke.mutate(revoking.id, {
						onSuccess: () => {
							toast.success(t`Authorization revoked.`);
							setRevoking(undefined);
						},
					});
				}}
			/>
		</Page>
	);
}
