import { Trans, useLingui } from "@lingui/react/macro";
import { FileIcon, FolderIcon, PlusIcon, UploadIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { FileEntry } from "@/components/file-manager";
import { FilePickerDialog } from "@/components/file-manager";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { uploadWithProgress, useLibraries, useLibraryFileSource } from "@/features/library/api";
import { useUploadQueue } from "@/hooks/use-upload-queue";
import { formatBytes } from "@/lib/format";

/** One chip of the composer's attachment row. */
export interface ComposerAttachment {
	key: string;
	name: string;
	size: number;
	status: "uploading" | "failed" | "done" | "canceled";
	/** Bytes uploaded so far while uploading. */
	loaded?: number;
	error?: string;
	/** The library reference and path once the upload is done or the file was picked. */
	library?: string;
	path?: string;
}

export interface ComposerAttachments {
	/** Chips in display order; a file is sendable once its chip is `done`. */
	items: ComposerAttachment[];
	/** Whether files are still uploading or waiting to upload: sending waits for them. */
	busy: boolean;
	failures: number;
	addFiles: (files: File[]) => void;
	addLibraryFiles: (files: { library: string; file: FileEntry }[]) => void;
	remove: (key: string) => void;
	cancel: () => void;
	clear: () => void;
	/** The attachments of a message that may be sent now. */
	sendable: { library: string; path: string }[];
}

const CONTROL_RE = /[\p{Cc}]/u;

/** The upload name of a file: its basename without control characters or slashes. */
function safeName(name: string): string {
	const base = name.slice(name.lastIndexOf("/") + 1).replace(/[/\\]/g, "_");
	const cleaned = [...base].filter((char) => !CONTROL_RE.test(char)).join("");
	return cleaned === "" ? "file" : cleaned;
}

/** The attachment path under the owner's library: `attachments/<YYYY-MM>/<name>`, numbered by the server if taken. */
function attachmentPath(name: string): string {
	const month = new Date().toISOString().slice(0, 7);
	return `attachments/${month}/${name}`;
}

/**
 * The composer's attachments (doc/design/library.md "Chat attachments"): uploads go to the owner's personal
 * library under `attachments/<YYYY-MM>/` through the shared upload queue, and library picks are already
 * there. Sending waits for every upload; a failed or canceled file blocks sending until it is removed.
 */
export function useComposerAttachments(ownerUsername: string | undefined): ComposerAttachments {
	const ref = ownerUsername === undefined ? undefined : `user:${ownerUsername.toLowerCase()}`;
	const [uploaded, setUploaded] = useState<ComposerAttachment[]>([]);
	const [pending, setPending] = useState<File[]>([]);
	const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
	const results = useRef(new Map<File, { library: string; path: string }>());

	const upload = useCallback(
		async (file: File, onProgress: (loaded: number) => void, signal: AbortSignal) => {
			if (ref === undefined) throw new Error("the owner's library is not known yet");
			const stored = await uploadWithProgress(ref, attachmentPath(safeName(file.name)), file, {
				onProgress,
				signal,
				rename: true,
			});
			results.current.set(file, { library: ref, path: stored.path });
		},
		[ref],
	);
	const queue = useUploadQueue(upload);
	const wasRunning = useRef(false);
	const { running, entries, clear } = queue;

	useEffect(() => {
		if (running) {
			wasRunning.current = true;
			return;
		}
		if (wasRunning.current) {
			wasRunning.current = false;
			const finished = entries.filter((entry) => entry.status !== "pending" && entry.status !== "running");
			if (finished.length > 0) {
				setUploaded((current) => [
					...current,
					...finished.flatMap<ComposerAttachment>((entry) => {
						const key = `upload:${entry.id}:${entry.file.name}:${entry.file.size}`;
						if (entry.status === "done") {
							const location = results.current.get(entry.file);
							if (!location) return [];
							return [{ key, name: entry.file.name, size: entry.file.size, status: "done", ...location }];
						}
						return [
							{
								key,
								name: entry.file.name,
								size: entry.file.size,
								status: entry.status === "canceled" ? "canceled" : "failed",
								...(entry.error === undefined ? {} : { error: entry.error }),
							},
						];
					}),
				]);
			}
			clear();
		}
		if (pending.length > 0) {
			const [next, ...rest] = pending;
			if (next !== undefined) {
				setPending(rest);
				queue.start([next]);
			}
		}
	}, [running, entries, pending, clear, queue]);

	const addFiles = useCallback((files: File[]) => {
		if (files.length === 0) return;
		setPending((current) => [...current, ...files]);
	}, []);

	const addLibraryFiles = useCallback((files: { library: string; file: FileEntry }[]) => {
		setUploaded((current) => [
			...current,
			...files.map(({ library, file }) => ({
				key: `picked:${library}:${file.path}`,
				name: file.name,
				size: file.size ?? 0,
				status: "done" as const,
				library,
				path: file.path,
			})),
		]);
	}, []);

	const remove = useCallback(
		(key: string) => {
			if (key.startsWith("upload:") || key.startsWith("picked:")) {
				setUploaded((current) => current.filter((item) => item.key !== key));
				return;
			}
			if (running) queue.cancel();
			setDismissed((current) => new Set(current).add(key));
		},
		[queue, running],
	);

	const cancel = useCallback(() => {
		queue.cancel();
	}, [queue]);

	const clearAll = useCallback(() => {
		setUploaded([]);
		setPending([]);
		setDismissed(new Set());
		results.current.clear();
		queue.clear();
	}, [queue]);

	const current: ComposerAttachment[] = entries.map((entry) => ({
		key: `queue:${entry.id}`,
		name: entry.file.name,
		size: entry.file.size,
		status:
			entry.status === "failed"
				? "failed"
				: entry.status === "canceled"
					? "canceled"
					: entry.status === "done"
						? "uploading"
						: "uploading",
		loaded: entry.loaded,
		...(entry.error === undefined ? {} : { error: entry.error }),
	}));
	const items = [...uploaded, ...current].filter((item) => !dismissed.has(item.key));
	const sendable = uploaded.flatMap((item) =>
		item.library !== undefined && item.path !== undefined ? [{ library: item.library, path: item.path }] : [],
	);
	return {
		items,
		busy: running || pending.length > 0 || items.some((item) => item.status === "uploading"),
		failures: items.filter((item) => item.status !== "done" && item.status !== "uploading").length,
		addFiles,
		addLibraryFiles,
		remove,
		cancel,
		clear: clearAll,
		sendable,
	};
}

/** The attachment chips above the composer input: progress, failure and a remove button. */
export function AttachmentChips({ attachments }: { attachments: ComposerAttachments }) {
	const { t, i18n } = useLingui();
	if (attachments.items.length === 0) return null;
	return (
		<div className="flex flex-wrap items-center gap-1.5 px-2 pt-2" data-testid="composer-attachments">
			{attachments.busy && (
				<Button
					type="button"
					variant="ghost"
					size="xs"
					data-testid="composer-attachment-cancel"
					onClick={attachments.cancel}
				>
					<Trans>Cancel upload</Trans>
				</Button>
			)}
			<ul className="contents">
				{attachments.items.map((item) => (
					<li
						key={item.key}
						data-testid="composer-attachment"
						data-status={item.status}
						className="flex max-w-full items-center gap-2 rounded-md border bg-muted/40 px-2 py-1 text-xs"
					>
						<FileIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
						<span className="min-w-0 flex-1 truncate" title={item.name}>
							{item.name}
						</span>
						<span className="shrink-0 text-muted-foreground">{formatBytes(item.size, i18n.locale)}</span>
						{item.status === "uploading" && (
							<span className="w-16 shrink-0" title={t`Uploading`}>
								<Progress value={item.size > 0 ? ((item.loaded ?? 0) / item.size) * 100 : 0} />
							</span>
						)}
						{item.status === "failed" && item.error !== undefined && (
							<span className="max-w-48 shrink-0 truncate text-danger" title={item.error}>
								{item.error}
							</span>
						)}
						{item.status === "canceled" && (
							<span className="shrink-0 text-muted-foreground">
								<Trans>Canceled</Trans>
							</span>
						)}
						<Button
							type="button"
							variant="ghost"
							size="icon-xs"
							aria-label={t`Remove ${item.name}`}
							title={t`Remove ${item.name}`}
							onClick={() => attachments.remove(item.key)}
						>
							<XIcon className="size-3" />
						</Button>
					</li>
				))}
			</ul>
		</div>
	);
}

/** The picker over the owner's libraries; the chosen entries become chips at once. */
export function AttachmentPickerDialog({
	open,
	onOpenChange,
	onSelect,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onSelect: (files: { library: string; file: FileEntry }[]) => void;
}) {
	const libraries = useLibraries();
	const [ref, setRef] = useState("");
	const list = libraries.data ?? [];
	const current = list.find((library) => library.ref === ref) ?? list[0];
	const source = useLibraryFileSource(current?.ref ?? "");
	useEffect(() => {
		if (current !== undefined && ref !== current.ref) setRef(current.ref);
	}, [current, ref]);
	if (current === undefined) return null;
	return (
		<FilePickerDialog
			open={open}
			onOpenChange={onOpenChange}
			source={source}
			multiple
			rootLabel={current.ownerDisplayName || current.ownerName}
			title={<Trans>Choose files from a library</Trans>}
			description={<Trans>Choose one or more files.</Trans>}
			testId="attachment-picker"
			header={
				<Select value={current.ref} onValueChange={(next) => setRef(String(next ?? ""))}>
					<SelectTrigger size="sm" aria-label="Library" data-testid="attachment-picker-library">
						<SelectValue>
							{(value: string | null) => {
								const library = list.find((candidate) => candidate.ref === value);
								return library === undefined
									? ""
									: `${library.ownerKind === "user" ? "User" : "User group"} ${library.ownerDisplayName || library.ownerName}`;
							}}
						</SelectValue>
					</SelectTrigger>
					<SelectContent>
						{list.map((library) => (
							<SelectItem key={library.ref} value={library.ref}>
								{library.ownerKind === "user" ? "User" : "User group"} {library.ownerDisplayName || library.ownerName}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			}
			onSelect={(entries) => onSelect(entries.map((file) => ({ library: current.ref, file })))}
		/>
	);
}

/** The composer's **+** menu: upload files or choose from a library (doc/design/library.md "Chat attachments"). */
export function AttachmentMenu({
	attachments,
	onChooseLibrary,
}: {
	attachments: ComposerAttachments;
	onChooseLibrary: () => void;
}) {
	const { t } = useLingui();
	const inputRef = useRef<HTMLInputElement>(null);
	return (
		<>
			<DropdownMenu>
				<DropdownMenuTrigger
					render={
						<Button
							type="button"
							variant="ghost"
							size="icon-sm"
							aria-label={t`Attach files`}
							title={t`Attach files`}
							data-testid="composer-attach"
						/>
					}
				>
					<PlusIcon />
				</DropdownMenuTrigger>
				<DropdownMenuContent side="top" align="start">
					<DropdownMenuItem data-testid="composer-upload" onClick={() => inputRef.current?.click()}>
						<UploadIcon />
						<Trans>Upload files</Trans>
					</DropdownMenuItem>
					<DropdownMenuItem data-testid="composer-choose-library" onClick={onChooseLibrary}>
						<FolderIcon />
						<Trans>Choose from library</Trans>
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
			<input
				ref={inputRef}
				type="file"
				multiple
				className="sr-only"
				aria-hidden="true"
				tabIndex={-1}
				data-testid="composer-upload-input"
				onChange={(event) => {
					attachments.addFiles([...(event.target.files ?? [])]);
					event.target.value = "";
				}}
			/>
		</>
	);
}
