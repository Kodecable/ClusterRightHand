import type { ExtensionView } from "@crh/api";
import { formatList } from "@crh/api";
import { Trans, useLingui } from "@lingui/react/macro";
import { useQueryClient } from "@tanstack/react-query";
import { PencilIcon, PlusIcon, RefreshCwIcon, Trash2Icon, WrenchIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { actionsHeader, DataTable, type DataTableColumn } from "@/components/data-table";
import { ConfirmDialog } from "@/components/dialogs";
import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";
import { RelativeTime } from "@/components/relative-time";
import { StatusText } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useDirectory } from "@/features/users/api";
import { cn, MONO_CELL } from "@/lib/utils";
import { extensionKeys, useDeleteExtension, useExtensions, useExtensionTools, useReconnectExtension } from "./api";
import { ExtensionDialog } from "./extension-dialog";

const STATE_LABEL = {
	unknown: <Trans>Not listed yet</Trans>,
	connecting: <Trans>Connecting</Trans>,
	ready: <Trans>Ready</Trans>,
	unavailable: <Trans>Unavailable</Trans>,
};

function KindCell({ extension }: { extension: ExtensionView }) {
	return extension.kind === "builtin" ? <Trans>Built-in</Trans> : <Trans>MCP</Trans>;
}

function StateCell({ extension }: { extension: ExtensionView }) {
	const { status } = extension;
	return (
		<span className="grid gap-0.5 text-xs" title={status.lastError ?? undefined}>
			<StatusText tone={status.state === "ready" ? "ok" : status.state === "unavailable" ? "danger" : "muted"}>
				{STATE_LABEL[status.state]}
			</StatusText>
			{extension.kind === "mcp" && (
				<span className="text-muted-foreground">
					{status.connected ? <Trans>Connected</Trans> : <Trans>Idle, connects on use</Trans>}
				</span>
			)}
			{status.refreshedAt !== null && (
				<span className="text-muted-foreground">
					<Trans>
						Listed <RelativeTime value={status.refreshedAt} />
					</Trans>
				</span>
			)}
			{status.nextAttemptAt !== null && (
				<span className="text-muted-foreground">
					<Trans>
						Next refresh: <RelativeTime value={status.nextAttemptAt} />
					</Trans>
				</span>
			)}
			{status.lastError !== null && status.state === "unavailable" && (
				<span className="max-w-64 truncate text-muted-foreground">{status.lastError}</span>
			)}
		</span>
	);
}

/** The tool list of one extension, with its annotations as rules see them. */
function ToolsDialog({ extension, onClose }: { extension: ExtensionView; onClose: () => void }) {
	const { t } = useLingui();
	const queryClient = useQueryClient();
	const tools = useExtensionTools(extension.name);
	// Listing an MCP extension's tools connects to it, so its state and tool count in the list are stale now.
	useEffect(() => {
		if (tools.data === undefined) return;
		void queryClient.invalidateQueries({ queryKey: extensionKeys.all, exact: true });
	}, [tools.data, queryClient]);
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			<DialogContent className="sm:max-w-2xl" data-testid="extension-tools-dialog">
				<DialogHeader>
					<DialogTitle>{t`Tools of ${extension.name}`}</DialogTitle>
				</DialogHeader>
				{tools.isPending ? (
					<p className="text-sm text-muted-foreground">
						<Trans>Loading the tool list…</Trans>
					</p>
				) : tools.isError ? (
					<ErrorState error={tools.error} retry={() => void tools.refetch()} />
				) : (tools.data?.tools ?? []).length === 0 ? (
					<p className="text-sm text-muted-foreground">
						<Trans>The extension lists no tools.</Trans>
					</p>
				) : (
					<ul className="grid max-h-[60vh] gap-2 overflow-y-auto" data-testid="extension-tool-list">
						{(tools.data?.tools ?? []).map((tool) => (
							<li key={tool.name} className="grid gap-0.5 rounded-md border p-2">
								<div className="flex flex-wrap items-baseline gap-2">
									<code className={cn("text-xs font-medium", MONO_CELL)}>{tool.name}</code>
									{tool.title !== null && <span className="text-xs text-muted-foreground">{tool.title}</span>}
									{tool.annotations?.readOnlyHint === true && (
										<span className="rounded-full bg-ok-bg px-1.5 text-[11px] text-ok">
											<Trans>Read-only</Trans>
										</span>
									)}
									{tool.annotations !== null && (
										<code className="text-[11px] break-all text-muted-foreground">
											{JSON.stringify(tool.annotations)}
										</code>
									)}
								</div>
								{tool.description !== null && <p className="text-xs text-muted-foreground">{tool.description}</p>}
								<code className="max-h-48 overflow-auto rounded bg-muted p-1 font-mono text-[11px] whitespace-pre-wrap">
									{JSON.stringify(tool.inputSchema, null, 2)}
								</code>
							</li>
						))}
					</ul>
				)}
			</DialogContent>
		</Dialog>
	);
}

/**
 * System settings → Extensions (doc/design/extensions.md "Extensions"): the administrator's MCP extensions and
 * crhs's built-in extensions in one table, with their state, tool count and availability. A built-in can be
 * edited and disabled but not reconnected or deleted.
 */
export function ExtensionsPage() {
	const { t, i18n } = useLingui();
	const extensions = useExtensions();
	const directory = useDirectory();
	const remove = useDeleteExtension();
	const reconnect = useReconnectExtension();
	const [editing, setEditing] = useState<ExtensionView | "new">();
	const [deleting, setDeleting] = useState<ExtensionView>();
	const [viewing, setViewing] = useState<ExtensionView>();

	// Grantee names come from the directory, like the editor's grant chips; an id stands in when it is gone.
	const grantNames = useMemo(
		() =>
			new Map<string, string>([
				...(directory.data?.users ?? []).map((user) => [`user:${user.id}`, user.displayName || user.username] as const),
				...(directory.data?.userGroups ?? []).map((group) => [`user_group:${group.id}`, group.name] as const),
			]),
		[directory.data],
	);

	const columns = useMemo<DataTableColumn<ExtensionView>[]>(
		() => [
			{
				id: "name",
				header: t`Name`,
				size: 120,
				cell: ({ row }) => <code className={MONO_CELL}>{row.original.name}</code>,
			},
			{
				id: "kind",
				header: t`Kind`,
				size: 72,
				cell: ({ row }) => <KindCell extension={row.original} />,
			},
			{
				id: "state",
				header: t`Connection`,
				minSize: 140,
				cell: ({ row }) => <StateCell extension={row.original} />,
			},
			{
				id: "tools",
				header: t`Tools`,
				size: 64,
				cell: ({ row }) => row.original.status.toolCount,
			},
			{
				id: "availability",
				header: t`Availability`,
				minSize: 180,
				cell: ({ row }) => {
					const names = row.original.grants.map(
						(grant) => grantNames.get(`${grant.granteeType}:${grant.granteeId}`) ?? grant.granteeId,
					);
					const flags = [
						...(row.original.listDirectly ? [t`Listed directly`] : []),
						...(row.original.kind === "mcp" && !row.original.trustAnnotations ? [t`Annotations untrusted`] : []),
					];
					const granted = formatList(i18n.locale, names);
					return (
						<span className="grid gap-0.5 text-xs">
							<span className="truncate" title={granted || undefined}>
								{row.original.availability === "granted" ? (
									names.length === 0 ? (
										<span className="text-muted-foreground">
											<Trans>No one yet</Trans>
										</span>
									) : (
										granted
									)
								) : (
									<Trans>Everyone</Trans>
								)}
							</span>
							{flags.length > 0 && <span className="text-muted-foreground">{flags.join(" · ")}</span>}
						</span>
					);
				},
			},
			{
				id: "enabled",
				header: t`Enabled`,
				size: 80,
				cell: ({ row }) => (
					<StatusText tone={row.original.enabled ? "ok" : "muted"}>
						{row.original.enabled ? <Trans>Enabled</Trans> : <Trans>Disabled</Trans>}
					</StatusText>
				),
			},
			{
				id: "actions",
				header: actionsHeader,
				// Built-ins have two actions, MCP extensions four; the column keeps room for the widest.
				size: 140,
				cell: ({ row }) => (
					<span className="flex flex-nowrap items-center gap-1">
						<Button
							type="button"
							size="icon-xs"
							variant="outline"
							title={t`Edit`}
							aria-label={t`Edit ${row.original.name}`}
							onClick={() => setEditing(row.original)}
						>
							<PencilIcon />
						</Button>
						<Button
							type="button"
							size="icon-xs"
							variant="outline"
							title={t`Tools`}
							aria-label={t`View tools of ${row.original.name}`}
							onClick={() => setViewing(row.original)}
						>
							<WrenchIcon />
						</Button>
						{row.original.kind === "mcp" && (
							<>
								<Button
									type="button"
									size="icon-xs"
									variant="outline"
									title={t`Reconnect`}
									disabled={reconnect.isPending}
									aria-label={t`Reconnect ${row.original.name}`}
									onClick={() => reconnect.mutate(row.original.name)}
								>
									<RefreshCwIcon />
								</Button>
								<Button
									type="button"
									size="icon-xs"
									variant="destructive"
									title={t`Delete`}
									aria-label={t`Delete ${row.original.name}`}
									onClick={() => setDeleting(row.original)}
								>
									<Trash2Icon />
								</Button>
							</>
						)}
					</span>
				),
			},
		],
		[t, i18n.locale, reconnect, grantNames],
	);

	return (
		<Page data-testid="extensions-page">
			<PageHeader title={<Trans>Extensions</Trans>} />
			<section className="grid gap-3" aria-label={t`Extensions`}>
				<div className="flex flex-wrap items-start justify-between gap-2">
					<div>
						<p className="text-sm text-muted-foreground">
							<Trans>
								Agent sessions reach extension tools through search_tools and call_tool, under the session's rules and
								approvals. MCP extensions connect over Streamable HTTP; built-in extensions ship with crhs.
							</Trans>
						</p>
					</div>
					<Button type="button" onClick={() => setEditing("new")} data-testid="add-extension">
						<PlusIcon />
						<Trans>New extension</Trans>
					</Button>
				</div>
				<DataTable
					label={t`Extensions`}
					columns={columns}
					data={extensions.data?.extensions ?? []}
					getRowId={(extension) => extension.id}
					loading={extensions.isLoading}
					error={extensions.isError ? extensions.error : undefined}
					onRetry={() => void extensions.refetch()}
					empty={
						<EmptyState
							bare
							title={<Trans>No extensions yet</Trans>}
							description={<Trans>Connect a Streamable HTTP MCP server to give sessions external tools.</Trans>}
						/>
					}
				/>
				{reconnect.error !== null && reconnect.error !== undefined && <ErrorState error={reconnect.error} />}
			</section>
			{editing !== undefined && (
				<ExtensionDialog
					existing={editing === "new" ? undefined : editing}
					onClose={() => setEditing(undefined)}
					onSaved={() => void extensions.refetch()}
				/>
			)}
			{viewing !== undefined && <ToolsDialog extension={viewing} onClose={() => setViewing(undefined)} />}
			<ConfirmDialog
				open={deleting !== undefined}
				onOpenChange={(open) => {
					if (!open) setDeleting(undefined);
				}}
				title={deleting ? t`Delete MCP extension ${deleting.name}?` : ""}
				description={
					<Trans>
						Its tools disappear from sessions and its stored headers are deleted. Waiting calls of this extension are
						not retried.
					</Trans>
				}
				confirmLabel={<Trans>Delete extension</Trans>}
				busy={remove.isPending}
				onConfirm={() => {
					if (!deleting) return;
					remove.mutate(deleting.name, {
						onSuccess: () => setDeleting(undefined),
					});
				}}
			/>
		</Page>
	);
}
