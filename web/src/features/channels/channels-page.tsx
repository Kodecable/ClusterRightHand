import type { ChannelView } from "@crh/api";
import { Trans, useLingui } from "@lingui/react/macro";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { useMemo, useState } from "react";
import { actionsHeader, DataTable, type DataTableColumn } from "@/components/data-table";
import { ConfirmDialog } from "@/components/dialogs";
import { EmptyState } from "@/components/empty-state";
import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";
import { RelativeTime } from "@/components/relative-time";
import { StatusText } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { MONO_CELL } from "@/lib/utils";
import { useChannels, useDeleteChannel } from "./api";
import { ChannelDialog } from "./channel-dialog";

/**
 * The Channels page (administrators only, doc/design/channels.md "Channels"): the bots crhs runs as, their
 * connection state, the account and the last error. Editing opens a dialog; credentials are write-only.
 */
export function ChannelsPage() {
	const { t } = useLingui();
	const channels = useChannels();
	const remove = useDeleteChannel();
	const [editing, setEditing] = useState<ChannelView | "new">();
	const [deleting, setDeleting] = useState<ChannelView>();

	const columns = useMemo<DataTableColumn<ChannelView>[]>(
		() => [
			{
				id: "name",
				header: t`Name`,
				minSize: 140,
				cell: ({ row }) => <span className="truncate font-medium">{row.original.name}</span>,
				meta: { title: (channel: ChannelView) => channel.name },
			},
			{
				id: "kind",
				header: t`Kind`,
				size: 100,
				cell: ({ row }) => <span>{row.original.kind === "telegram" ? "Telegram" : "Satori"}</span>,
			},
			{
				id: "state",
				header: t`State`,
				size: 120,
				cell: ({ row }) => {
					const channel = row.original;
					if (!channel.enabled) return <StatusText tone="muted">{t`Disabled`}</StatusText>;
					switch (channel.status.state) {
						case "connected":
							return <StatusText tone="ok">{t`Connected`}</StatusText>;
						case "connecting":
							return <StatusText tone="info">{t`Connecting`}</StatusText>;
						case "unavailable":
							return <StatusText tone="danger">{t`Unavailable`}</StatusText>;
						default:
							return <StatusText tone="muted">{t`Disabled`}</StatusText>;
					}
				},
			},
			{
				id: "account",
				header: t`Bot account`,
				minSize: 120,
				cell: ({ row }) =>
					row.original.status.account === null ? (
						<span className="text-muted-foreground">–</span>
					) : (
						<code className={MONO_CELL}>{row.original.status.account}</code>
					),
			},
			{
				id: "error",
				header: t`Last error`,
				minSize: 180,
				cell: ({ row }) =>
					row.original.status.lastError === null ? (
						<span className="text-muted-foreground">–</span>
					) : (
						<span className="truncate text-danger">{row.original.status.lastError}</span>
					),
				meta: { title: (channel: ChannelView) => channel.status.lastError ?? undefined },
			},
			{
				id: "next",
				header: t`Next attempt`,
				size: 120,
				cell: ({ row }) =>
					row.original.status.nextAttemptAt === null ? (
						<span className="text-muted-foreground">–</span>
					) : (
						<RelativeTime value={row.original.status.nextAttemptAt} />
					),
			},
			{
				id: "actions",
				header: actionsHeader,
				size: 150,
				cell: ({ row }) => (
					<span className="flex flex-nowrap items-center gap-1">
						<Button
							type="button"
							size="xs"
							variant="outline"
							aria-label={t`Edit ${row.original.name}`}
							onClick={() => setEditing(row.original)}
						>
							<Trans>Edit</Trans>
						</Button>
						<Button
							type="button"
							size="xs"
							variant="destructive"
							aria-label={t`Delete ${row.original.name}`}
							onClick={() => setDeleting(row.original)}
						>
							<Trash2Icon />
							<Trans>Delete</Trans>
						</Button>
					</span>
				),
			},
		],
		[t],
	);

	return (
		<Page data-testid="channels-page">
			<PageHeader
				title={<Trans>Channels</Trans>}
				actions={
					<Button type="button" onClick={() => setEditing("new")} data-testid="add-channel">
						<PlusIcon />
						<Trans>New channel</Trans>
					</Button>
				}
			/>
			<DataTable
				label={t`Channels`}
				columns={columns}
				data={channels.data ?? []}
				getRowId={(channel) => channel.id}
				loading={channels.isLoading}
				error={channels.isError ? channels.error : undefined}
				onRetry={() => void channels.refetch()}
				empty={<EmptyState bare title={<Trans>No channels yet</Trans>} />}
			/>
			{editing !== undefined && (
				<ChannelDialog existing={editing === "new" ? undefined : editing} onClose={() => setEditing(undefined)} />
			)}
			<ConfirmDialog
				open={deleting !== undefined}
				onOpenChange={(open) => {
					if (!open) setDeleting(undefined);
				}}
				title={deleting ? t`Delete channel ${deleting.name}?` : ""}
				description={
					<Trans>
						Its linked accounts and threads are removed, so people stop reaching crhs from that bot. Its stored token is
						deleted.
					</Trans>
				}
				confirmLabel={<Trans>Delete channel</Trans>}
				busy={remove.isPending}
				onConfirm={() => {
					if (!deleting) return;
					remove.mutate(deleting.name, { onSuccess: () => setDeleting(undefined) });
				}}
			/>
		</Page>
	);
}
