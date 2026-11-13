import { zodResolver } from "@hookform/resolvers/zod";
import { Trans, useLingui } from "@lingui/react/macro";
import { DownloadIcon, EyeIcon, FileIcon, FolderIcon, PencilLineIcon, Trash2Icon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { actionsHeader, DataTable, type DataTableColumn } from "@/components/data-table";
import { ConfirmDialog, FormDialog } from "@/components/dialogs";
import { TableEmpty } from "@/components/empty-state";
import { ErrorText } from "@/components/error-state";
import { FieldShell } from "@/components/form";
import { RelativeTime } from "@/components/relative-time";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { useIsMobile } from "@/hooks/use-mobile";
import { errorMessage } from "@/lib/api/client";
import { formatBytes } from "@/lib/format";
import { FilePreviewDialog } from "./preview-dialog";
import {
	type FileEntry,
	type FileSelection,
	type FileSource,
	isPreviewable,
	isValidFilePath,
	joinPath,
	normalizeFilePath,
} from "./types";

export interface FileListProps {
	source: FileSource;
	/** The directory prefix on display; the root is "". */
	path: string;
	onPathChange: (path: string) => void;
	/** The accessible name of the root, also the table's name at the root. */
	rootLabel: string;
	/** Selection mode for FilePickerDialog; its actions are hidden. */
	selection?: FileSelection;
	/** Bump to reload the listing after an upload or a mutation elsewhere. */
	version: number;
	/** Ask the owner to bump `version` after this list moves, deletes or previews a file. */
	onReload: () => void;
}

/**
 * The shared file list (doc/design/webui.md "Shared components"): directories before files in a DataTable, the
 * actions its source provides, and the preview, move and delete dialogs. The library and node file
 * pages reuse it with their own FileSource; the toolbar and uploads sit outside it.
 */
export function FileList({ source, path, onPathChange, rootLabel, selection, version, onReload }: FileListProps) {
	const { t, i18n } = useLingui();
	const narrow = useIsMobile();
	const [listing, setListing] = useState<{ files: FileEntry[]; directories: string[] }>({ files: [], directories: [] });
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<unknown>();
	const [renaming, setRenaming] = useState<FileEntry>();
	const [deleting, setDeleting] = useState<FileEntry>();
	const [previewing, setPreviewing] = useState<FileEntry>();
	const canUpload = source.upload !== undefined && selection === undefined;

	// biome-ignore lint/correctness/useExhaustiveDependencies: version is the explicit reload trigger.
	useEffect(() => {
		const controller = new AbortController();
		setLoading(true);
		setError(undefined);
		source
			.list(path, controller.signal)
			.then((result) => {
				if (controller.signal.aborted) return;
				setListing(result);
				setLoading(false);
			})
			.catch((err: unknown) => {
				if (controller.signal.aborted) return;
				setError(err);
				setLoading(false);
			});
		return () => controller.abort();
	}, [source, path, version]);

	const rows = useMemo(() => {
		const directories: FileEntry[] = listing.directories
			.map((name) => ({ path: joinPath(path, name), name, kind: "directory" as const }))
			.sort((a, b) => a.name.localeCompare(b.name));
		const files = [...listing.files].sort((a, b) => a.name.localeCompare(b.name));
		return [...directories, ...files];
	}, [listing, path]);

	const openEntry = useCallback(
		(entry: FileEntry) => {
			if (entry.kind === "directory") {
				onPathChange(entry.path);
				return;
			}
			if (selection) {
				selection.onToggle(entry);
				return;
			}
			if (source.preview && isPreviewable(entry)) setPreviewing(entry);
		},
		[onPathChange, selection, source],
	);

	const columns = useMemo<DataTableColumn<FileEntry>[]>(() => {
		const base: DataTableColumn<FileEntry>[] = [];
		if (selection) {
			base.push({
				id: "select",
				header: () => (
					<span className="sr-only">
						<Trans>Select</Trans>
					</span>
				),
				size: 36,
				cell: ({ row }) =>
					row.original.kind === "directory" ? (
						<span aria-hidden="true" />
					) : (
						<Checkbox
							checked={selection.selected.has(row.original.path)}
							onCheckedChange={() => selection.onToggle(row.original)}
							aria-label={t`Select ${row.original.path}`}
						/>
					),
			});
		}
		base.push({
			id: "name",
			header: t`Name`,
			minSize: 220,
			cell: ({ row }) => {
				const entry = row.original;
				return (
					<span className="flex min-w-0 items-center gap-2">
						{entry.kind === "directory" ? (
							<FolderIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
						) : (
							<FileIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
						)}
						<span className="truncate font-medium">{entry.name}</span>
					</span>
				);
			},
			meta: { title: (entry: FileEntry) => entry.path },
		});
		// A narrow screen keeps only the name and the actions: the path already tells where a file is.
		if (!narrow) {
			base.push(
				{
					id: "size",
					header: t`Size`,
					size: 100,
					cell: ({ row }) =>
						row.original.kind === "directory" || row.original.size === undefined ? (
							<span className="text-muted-foreground">–</span>
						) : (
							<span className="tabular-nums">{formatBytes(row.original.size, i18n.locale)}</span>
						),
				},
				{
					id: "updated",
					header: t`Updated`,
					size: 120,
					cell: ({ row }) =>
						row.original.updatedAt === undefined ? (
							<span className="text-muted-foreground">–</span>
						) : (
							<RelativeTime value={row.original.updatedAt} />
						),
				},
			);
		}
		if (!selection && (source.download || source.rename || source.delete || source.preview)) {
			base.push({
				id: "actions",
				header: actionsHeader,
				size: 136,
				cell: ({ row }) => {
					const entry = row.original;
					if (entry.kind === "directory") return null;
					const download = source.download?.(entry.path);
					return (
						<span className="flex items-center justify-end gap-0.5">
							{source.preview && isPreviewable(entry) && (
								<Button
									type="button"
									variant="ghost"
									size="icon-xs"
									title={t`Preview`}
									aria-label={t`Preview ${entry.path}`}
									onClick={() => setPreviewing(entry)}
								>
									<EyeIcon />
								</Button>
							)}
							{download !== undefined && (
								<Button
									variant="ghost"
									size="icon-xs"
									title={t`Download`}
									aria-label={t`Download ${entry.path}`}
									nativeButton={false}
									render={<a href={download} />}
								>
									<DownloadIcon />
								</Button>
							)}
							{source.rename && (
								<Button
									type="button"
									variant="ghost"
									size="icon-xs"
									title={t`Move or rename`}
									aria-label={t`Move or rename ${entry.path}`}
									onClick={() => setRenaming(entry)}
								>
									<PencilLineIcon />
								</Button>
							)}
							{source.delete && (
								<Button
									type="button"
									variant="ghost"
									size="icon-xs"
									title={t`Delete`}
									aria-label={t`Delete ${entry.path}`}
									onClick={() => setDeleting(entry)}
								>
									<Trash2Icon />
								</Button>
							)}
						</span>
					);
				},
			});
		}
		return base;
	}, [selection, source, t, i18n.locale, narrow]);

	const loadingLabel = path === "" ? rootLabel : path;

	return (
		<>
			<DataTable
				label={t`Files in ${loadingLabel}`}
				columns={columns}
				data={rows}
				getRowId={(entry) => entry.path}
				loading={loading}
				error={error}
				onRetry={onReload}
				onRowActivate={openEntry}
				rowActivateColumn="name"
				rowLabel={(entry) => entry.path}
				empty={
					<TableEmpty>
						{canUpload ? (
							<Trans>This folder is empty. Drop files here to upload them.</Trans>
						) : (
							<Trans>This folder is empty.</Trans>
						)}
					</TableEmpty>
				}
			/>

			{renaming && (
				<MoveFileDialog
					source={source}
					entry={renaming}
					onClose={() => setRenaming(undefined)}
					onRenamed={() => {
						setRenaming(undefined);
						onReload();
					}}
				/>
			)}
			{deleting && (
				<DeleteFileDialog
					source={source}
					entry={deleting}
					onClose={() => setDeleting(undefined)}
					onDeleted={() => {
						setDeleting(undefined);
						onReload();
					}}
				/>
			)}
			{previewing && <FilePreviewDialog source={source} entry={previewing} onClose={() => setPreviewing(undefined)} />}
		</>
	);
}

/** Moves or renames one file through a full destination path; a "/" in it is a directory. */
function MoveFileDialog({
	source,
	entry,
	onClose,
	onRenamed,
}: {
	source: FileSource;
	entry: FileEntry;
	onClose: () => void;
	onRenamed: () => void;
}) {
	const { t } = useLingui();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	const schema = useMemo(
		() =>
			z.object({
				path: z.string().refine((value) => isValidFilePath(value), t`Enter a valid path without a trailing /.`),
			}),
		[t],
	);
	type Values = z.infer<typeof schema>;
	const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { path: entry.path } });

	const submit = form.handleSubmit(async (values) => {
		if (!source.rename) return;
		setError(undefined);
		setBusy(true);
		try {
			await source.rename(entry.path, normalizeFilePath(values.path.trim()));
			onRenamed();
		} catch (err) {
			setError(errorMessage(err));
		} finally {
			setBusy(false);
		}
	});

	return (
		<FormDialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
			title={t`Move or rename ${entry.name}`}
			submitLabel={<Trans>Move</Trans>}
			busy={busy}
			error={error}
			onSubmit={() => void submit()}
			testId="file-move-dialog"
		>
			<FieldShell id="file-move-path" label={t`New path`} error={form.formState.errors.path?.message}>
				<Input id="file-move-path" autoFocus {...form.register("path")} />
			</FieldShell>
		</FormDialog>
	);
}

/** Deletes one file after a confirmation that names it. */
function DeleteFileDialog({
	source,
	entry,
	onClose,
	onDeleted,
}: {
	source: FileSource;
	entry: FileEntry;
	onClose: () => void;
	onDeleted: () => void;
}) {
	const { t } = useLingui();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<unknown>();

	const remove = async () => {
		if (!source.delete) return;
		setError(undefined);
		setBusy(true);
		try {
			await source.delete(entry.path);
			onDeleted();
		} catch (err) {
			setError(err);
		} finally {
			setBusy(false);
		}
	};

	return (
		<ConfirmDialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
			title={t`Delete ${entry.path}?`}
			description={t`This cannot be undone.`}
			confirmLabel={<Trans>Delete</Trans>}
			busy={busy}
			onConfirm={() => void remove()}
		>
			{error !== undefined && error !== null && <ErrorText error={error} />}
		</ConfirmDialog>
	);
}
