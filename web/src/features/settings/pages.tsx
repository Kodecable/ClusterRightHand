import { Trans, useLingui } from "@lingui/react/macro";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { actionsHeader, DataTable, type DataTableColumn } from "@/components/data-table";
import { ConfirmDialog } from "@/components/dialogs";
import { EmptyState } from "@/components/empty-state";
import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { ModelProviderView } from "@/lib/api/types";
import { useDeleteModelProvider, useModelProviders } from "./api";
import { ProviderDialog } from "./provider-dialog";
import { ReviewModelCard } from "./review-model-card";

/**
 * Model providers (administrators only, doc/webui.md "Models"): builtin
 * providers and OpenAI-compatible endpoints, their keys (never displayed
 * back), and the model Auto Review uses.
 */
export function ModelSettingsPage() {
	const { t } = useLingui();
	const providers = useModelProviders();
	const remove = useDeleteModelProvider();
	const [editing, setEditing] = useState<ModelProviderView | "new">();
	const [deleting, setDeleting] = useState<ModelProviderView>();

	const columns = useMemo<DataTableColumn<ModelProviderView>[]>(
		() => [
			{
				id: "id",
				header: t`Id`,
				size: 150,
				cell: ({ row }) => <code className="font-mono text-xs">{row.original.providerId}</code>,
			},
			{
				id: "kind",
				header: t`Kind`,
				size: 160,
				cell: ({ row }) => (
					<span className="text-xs">{row.original.kind === "builtin" ? t`Built-in` : t`OpenAI-compatible`}</span>
				),
			},
			{
				id: "name",
				header: t`Name`,
				cell: ({ row }) => <span className="truncate text-xs">{row.original.name}</span>,
			},
			{
				id: "baseUrl",
				header: t`Base URL`,
				size: 200,
				cell: ({ row }) => <span className="truncate font-mono text-xs">{row.original.baseUrl ?? "–"}</span>,
			},
			{
				id: "key",
				header: t`API key`,
				size: 100,
				cell: ({ row }) =>
					row.original.hasApiKey ? (
						<Badge variant="secondary">
							<Trans>set</Trans>
						</Badge>
					) : (
						<span className="text-xs text-muted-foreground">
							<Trans>not set</Trans>
						</span>
					),
			},
			{
				id: "enabled",
				header: t`Status`,
				size: 100,
				cell: ({ row }) =>
					row.original.enabled ? (
						<Badge variant="secondary">
							<Trans>enabled</Trans>
						</Badge>
					) : (
						<span className="text-xs text-muted-foreground">
							<Trans>disabled</Trans>
						</span>
					),
			},
			{
				id: "models",
				header: t`Models`,
				cell: ({ row }) => (
					<span className="truncate text-xs">
						{row.original.models ? row.original.models.map((model) => model.id).join(", ") : t`all built-in models`}
					</span>
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
							aria-label={t`Edit ${row.original.providerId}`}
							onClick={() => setEditing(row.original)}
						>
							<Trans>Edit</Trans>
						</Button>
						<Button
							type="button"
							size="xs"
							variant="destructive"
							aria-label={t`Delete ${row.original.providerId}`}
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
		<Page data-testid="models-page">
			<PageHeader
				title={<Trans>Model providers</Trans>}
				actions={
					<Button type="button" onClick={() => setEditing("new")} data-testid="add-provider">
						<PlusIcon />
						<Trans>Add provider</Trans>
					</Button>
				}
			/>
			<ReviewModelCard />
			<DataTable
				label={t`Model providers`}
				columns={columns}
				data={providers.data?.providers ?? []}
				getRowId={(provider) => provider.id}
				loading={providers.isLoading}
				error={providers.isError ? providers.error : undefined}
				onRetry={() => void providers.refetch()}
				empty={
					<EmptyState
						title={<Trans>No model providers yet</Trans>}
						description={<Trans>Add a built-in provider or an OpenAI-compatible endpoint.</Trans>}
					/>
				}
			/>
			{editing !== undefined && providers.data && (
				<ProviderDialog
					existing={editing === "new" ? undefined : editing}
					builtin={providers.data.builtin}
					onClose={() => setEditing(undefined)}
					onSaved={() => void providers.refetch()}
				/>
			)}
			<ConfirmDialog
				open={deleting !== undefined}
				onOpenChange={(open) => {
					if (!open) setDeleting(undefined);
				}}
				title={deleting ? t`Delete provider ${deleting.providerId}?` : ""}
				description={
					<Trans>
						Its models disappear from the model lists, and its stored key is deleted. Existing sessions that use them
						stop working until you change their model.
					</Trans>
				}
				confirmLabel={<Trans>Delete provider</Trans>}
				busy={remove.isPending}
				onConfirm={() => {
					if (!deleting) return;
					remove.mutate(deleting.providerId, {
						onSuccess: () => {
							toast.success(t`Provider deleted.`);
							setDeleting(undefined);
						},
					});
				}}
			/>
		</Page>
	);
}
