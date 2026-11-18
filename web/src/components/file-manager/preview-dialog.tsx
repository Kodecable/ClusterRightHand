import { useLingui } from "@lingui/react/macro";
import { useCallback } from "react";
import { FilePreviewDialog } from "@/components/file-preview-dialog";
import { type FileEntry, type FileSource, isPreviewable } from "./types";

/**
 * A FileManager preview: the image is loaded when the dialog opens (never a thumbnail in the list),
 * after `stat` checks the file is still the same previewable type. Only PNG, JPEG, GIF and WebP up
 * to 20 MiB are previewed; the server also enforces the type and size.
 */
export function FileManagerPreview({
	source,
	entry,
	onClose,
}: {
	source: FileSource;
	entry: FileEntry;
	onClose: () => void;
}) {
	const { t } = useLingui();
	const load = useCallback(
		async (signal: AbortSignal) => {
			const fresh = await source.stat(entry.path);
			if (signal.aborted) throw new DOMException("the preview closed", "AbortError");
			if (!isPreviewable(fresh) || !source.preview) throw new Error(t`This file cannot be previewed`);
			return source.preview(fresh.path, signal);
		},
		[source, entry.path, t],
	);
	return <FilePreviewDialog name={entry.name} load={load} onClose={onClose} />;
}
