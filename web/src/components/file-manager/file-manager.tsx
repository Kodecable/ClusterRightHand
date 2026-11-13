import { Trans } from "@lingui/react/macro";
import { UploadIcon } from "lucide-react";
import { type DragEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { UploadProgressDialog } from "@/components/upload";
import { useUploadQueue } from "@/hooks/use-upload-queue";
import { cn } from "@/lib/utils";
import { FileList } from "./file-list";
import { FileToolbar } from "./file-toolbar";
import { type FileSelection, type FileSource, joinPath } from "./types";

export interface FileManagerProps {
	source: FileSource;
	/** The directory prefix on display; the root is "". */
	path: string;
	onPathChange: (path: string) => void;
	/** The accessible name of the root breadcrumb, e.g. the library's label. */
	rootLabel: string;
	/** Extra toolbar controls, shown immediately before the Upload button (e.g. a usage indicator). */
	toolbarActions?: ReactNode;
	/** Selection mode for FilePickerDialog; actions and uploads are hidden. */
	selection?: FileSelection;
	testId?: string;
}

/**
 * The one file browser (doc/design/webui.md "Shared components"): the toolbar, directories before files in a
 * DataTable, the actions its source provides, and the upload queue behind a progress dialog. The
 * toolbar and the list are shared components, so node file management reuses them with a node
 * FileSource; the library page adds only its usage indicator.
 */
export function FileManager({
	source,
	path,
	onPathChange,
	rootLabel,
	toolbarActions,
	selection,
	testId,
}: FileManagerProps) {
	const [version, setVersion] = useState(0);
	const [uploading, setUploading] = useState(false);
	const [dragging, setDragging] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);
	const canUpload = source.upload !== undefined && selection === undefined;

	const upload = useCallback(
		(file: File, onProgress: (loaded: number) => void, signal: AbortSignal) => {
			if (!source.upload) return Promise.resolve();
			return source.upload(joinPath(path, file.name), file, { onProgress, signal }).then(() => undefined);
		},
		[path, source],
	);
	const queue = useUploadQueue(upload);

	const reload = useCallback(() => setVersion((value) => value + 1), []);

	const startUpload = useCallback(
		(files: File[]) => {
			if (!canUpload || files.length === 0) return;
			queue.start(files);
			setUploading(true);
		},
		[canUpload, queue],
	);

	// One listing reload after a batch that uploaded anything, instead of one per finished file.
	const wasRunning = useRef(false);
	useEffect(() => {
		if (wasRunning.current && !queue.running && queue.done > 0) reload();
		wasRunning.current = queue.running;
	}, [queue.done, queue.running, reload]);

	const onDrop = (event: DragEvent<HTMLDivElement>) => {
		if (!canUpload) return;
		event.preventDefault();
		setDragging(false);
		startUpload([...event.dataTransfer.files]);
	};

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: the drop target wraps the browser; its own controls are interactive.
		<div
			className={cn("grid gap-3", dragging && "rounded-lg ring-2 ring-ring ring-offset-2")}
			data-testid={testId ?? "file-manager"}
			onDragOver={(event) => {
				if (!canUpload) return;
				event.preventDefault();
				setDragging(true);
			}}
			onDragLeave={() => setDragging(false)}
			onDrop={onDrop}
		>
			<FileToolbar
				path={path}
				onPathChange={onPathChange}
				rootLabel={rootLabel}
				actions={
					<>
						{toolbarActions}
						{canUpload && (
							<>
								<input
									ref={inputRef}
									type="file"
									multiple
									className="sr-only"
									aria-hidden="true"
									tabIndex={-1}
									data-testid="file-upload-input"
									onChange={(event) => {
										startUpload([...(event.target.files ?? [])]);
										event.target.value = "";
									}}
								/>
								<Button type="button" size="sm" onClick={() => inputRef.current?.click()} data-testid="file-upload">
									<UploadIcon />
									<Trans>Upload</Trans>
								</Button>
							</>
						)}
					</>
				}
			/>

			<FileList
				source={source}
				path={path}
				onPathChange={onPathChange}
				rootLabel={rootLabel}
				selection={selection}
				version={version}
				onReload={reload}
			/>

			{canUpload && <UploadProgressDialog open={uploading} onOpenChange={setUploading} queue={queue} />}
		</div>
	);
}
