import type { AuthorizationSummary, DecodedAuthorizationPayload } from "@crh/api";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { useMemo, useState } from "react";
import { actionsHeader, DataTable, type DataTableColumn } from "@/components/data-table";
import { EmptyState } from "@/components/empty-state";
import { KeyValueList } from "@/components/key-value";
import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";
import { DateTime } from "@/components/relative-time";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useAuthorizations } from "./api";

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
						{ label: t`Issued`, value: <DateTime value={entry.issuedAt} /> },
						{ label: t`Deadline`, value: <DateTime value={entry.deadline} /> },
						...(entry.attempt !== null ? [{ label: t`Attempt`, value: String(entry.attempt) }] : []),
						{ label: t`Command`, value: authorizationCommandText(entry.command), mono: true },
						{ label: t`Nodes`, value: entry.nodes.join(", ") || "–", mono: true },
						{ label: t`Tasks`, value: entry.taskIds === null ? t`reusable` : entry.taskIds.join(", "), mono: true },
						...(entry.note !== "" ? [{ label: t`Note`, value: entry.note }] : []),
					]}
				/>
			</DialogContent>
		</Dialog>
	);
}

/**
 * Authorizations (doc/m4.md M4.4): every authorization of the organization, for administrators.
 * An authorization is valid until its deadline or until it is used up; it is withdrawn by deleting
 * the node's trust entry or rotating its key, not from here.
 */
export function AuthorizationsPage() {
	const { t } = useLingui();
	const authorizations = useAuthorizations();
	const [payload, setPayload] = useState<AuthorizationSummary>();
	const rows = useMemo(() => authorizations.data?.pages.flatMap((page) => page.items) ?? [], [authorizations.data]);

	const columns = useMemo<DataTableColumn<AuthorizationSummary>[]>(
		() => [
			{
				id: "created",
				header: t`Created`,
				size: 200,
				cell: ({ row }) => <DateTime value={row.original.createdAt} />,
			},
			{
				id: "issuer",
				header: t`Issuer`,
				size: 130,
				cell: ({ row }) => (
					<span className="truncate">
						{row.original.issuerUsername ??
							(row.original.issuerUserId !== null ? row.original.issuerUserId.slice(0, 8) : "crhs")}
					</span>
				),
			},
			{
				id: "nodes",
				header: t`Nodes`,
				size: 140,
				cell: ({ row }) => {
					const nodes = row.original.nodes.join(", ");
					return (
						<span className="truncate font-mono text-xs">
							{nodes === "" ? <span className="text-muted-foreground">–</span> : nodes}
						</span>
					);
				},
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
				size: 200,
				cell: ({ row }) => <DateTime value={row.original.deadline} />,
			},
			{
				id: "tasks",
				header: t`Tasks`,
				size: 100,
				cell: ({ row }) =>
					row.original.taskIds === null ? (
						<span>
							<Trans>reusable</Trans>
						</span>
					) : (
						<span>
							<Plural value={row.original.taskIds.length} one="# task" other="# tasks" />
						</span>
					),
			},
			{
				id: "actions",
				header: actionsHeader,
				size: 90,
				cell: ({ row }) => (
					<Button type="button" size="xs" variant="outline" onClick={() => setPayload(row.original)}>
						<Trans>Payload</Trans>
					</Button>
				),
			},
		],
		[t],
	);

	return (
		<Page data-testid="authorizations-page">
			<PageHeader
				title={<Trans>Authorizations</Trans>}
				description={
					<Trans>
						Every authorization carries a deadline. It is valid on the nodes its payload names until that deadline or
						until it is used up (one-shot authorizations).
					</Trans>
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
						description={<Trans>No one has signed an authorization yet.</Trans>}
					/>
				}
			/>
			{payload && <PayloadDialog entry={payload} onClose={() => setPayload(undefined)} />}
		</Page>
	);
}
