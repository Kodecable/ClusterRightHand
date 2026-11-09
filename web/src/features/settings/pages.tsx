import type { ModelProviderView } from "@crh/api";
import { Trans, useLingui } from "@lingui/react/macro";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { useMemo, useState } from "react";
import { actionsHeader, DataTable, type DataTableColumn } from "@/components/data-table";
import { ConfirmDialog } from "@/components/dialogs";
import { EmptyState } from "@/components/empty-state";
import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";
import { StatusText } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { cn, MONO_CELL } from "@/lib/utils";
import { useDeleteModelProvider, useModelProviders } from "./api";
import { ModelPresetsSection } from "./model-presets";
import { ProviderDialog } from "./provider-dialog";

/**
 * Model settings (administrators only, doc/webui.md "Models"): the three model
 * presets first, then the Pi built-in providers and custom endpoints and their
 * keys (never displayed back).
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
				size: 130,
				cell: ({ row }) => <code className={MONO_CELL}>{row.original.providerId}</code>,
				meta: { title: (provider: ModelProviderView) => provider.providerId },
			},
			{
				id: "kind",
				header: t`Kind`,
				size: 110,
				cell: ({ row }) => <span>{row.original.kind === "builtin" ? t`Pi built-in` : t`Custom`}</span>,
			},
			{
				id: "name",
				header: t`Name`,
				minSize: 140,
				cell: ({ row }) =>
					row.original.name === "" ? (
						<span className="text-muted-foreground">–</span>
					) : (
						<span className="truncate">{row.original.name}</span>
					),
				meta: { title: (provider: ModelProviderView) => provider.name },
			},
			{
				id: "baseUrl",
				header: t`Base URL`,
				cell: ({ row }) =>
					row.original.baseUrl === null ? (
						<span className="text-muted-foreground">–</span>
					) : (
						<span className={cn("truncate", MONO_CELL)}>{row.original.baseUrl}</span>
					),
				meta: { title: (provider: ModelProviderView) => provider.baseUrl ?? undefined },
			},
			{
				id: "key",
				header: t`API key`,
				size: 90,
				cell: ({ row }) => (row.original.hasApiKey ? <Trans>Set</Trans> : <Trans>Not set</Trans>),
			},
			{
				id: "enabled",
				header: t`Status`,
				size: 90,
				cell: ({ row }) => (
					<StatusText tone={row.original.enabled ? "ok" : "muted"}>
						{row.original.enabled ? <Trans>Enabled</Trans> : <Trans>Disabled</Trans>}
					</StatusText>
				),
			},
			{
				id: "models",
				header: t`Models`,
				cell: ({ row }) => (
					<span className="truncate">
						{row.original.models ? row.original.models.map((model) => model.id).join(", ") : t`all built-in models`}
					</span>
				),
				meta: {
					title: (provider: ModelProviderView) =>
						provider.models ? provider.models.map((model) => model.id).join(", ") : undefined,
				},
			},
			{
				id: "actions",
				header: actionsHeader,
				size: 140,
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
			<PageHeader title={<Trans>Models</Trans>} />
			<ModelPresetsSection />
			<section className="grid gap-3" aria-labelledby="model-providers-heading" data-testid="model-providers">
				<div className="flex flex-wrap items-start justify-between gap-2">
					<div>
						<h2 id="model-providers-heading" className="text-sm font-medium">
							<Trans>Model providers</Trans>
						</h2>
						<p className="text-sm text-muted-foreground">
							<Trans>Pi built-in providers and custom endpoints; their keys are never shown back.</Trans>
						</p>
					</div>
					<Button type="button" onClick={() => setEditing("new")} data-testid="add-provider">
						<PlusIcon />
						<Trans>New provider</Trans>
					</Button>
				</div>
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
							bare
							title={<Trans>No model providers yet</Trans>}
							description={<Trans>Add a Pi built-in provider or a custom endpoint.</Trans>}
						/>
					}
				/>
			</section>
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
							setDeleting(undefined);
						},
					});
				}}
			/>
		</Page>
	);
}
