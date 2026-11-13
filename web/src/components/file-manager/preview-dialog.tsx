import { useLingui } from "@lingui/react/macro";
import { useEffect, useState } from "react";
import { ErrorState } from "@/components/error-state";
import { Spinner } from "@/components/spinner";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { type FileEntry, type FileSource, isPreviewable } from "./types";

/**
 * A FileManager preview: the image is loaded when the dialog opens (never a thumbnail in the list),
 * after `stat` checks the file is still the same previewable type. Only PNG, JPEG, GIF and WebP up
 * to 20 MiB are previewed; the server also enforces the type and size.
 */
export function FilePreviewDialog({
	source,
	entry,
	onClose,
}: {
	source: FileSource;
	entry: FileEntry;
	onClose: () => void;
}) {
	const { t } = useLingui();
	const [url, setUrl] = useState<string>();
	const [error, setError] = useState<unknown>();

	useEffect(() => {
		let active = true;
		let objectUrl: string | undefined;
		setUrl(undefined);
		setError(undefined);
		void (async () => {
			try {
				const fresh = await source.stat(entry.path);
				if (!isPreviewable(fresh) || !source.preview) throw new Error("this file cannot be previewed");
				const blob = await source.preview(fresh.path);
				if (!active) return;
				objectUrl = URL.createObjectURL(blob);
				setUrl(objectUrl);
			} catch (err) {
				if (active) setError(err);
			}
		})();
		return () => {
			active = false;
			if (objectUrl) URL.revokeObjectURL(objectUrl);
		};
	}, [source, entry.path]);

	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			<DialogContent className="sm:max-w-5xl">
				<DialogHeader>
					<DialogTitle>{entry.name}</DialogTitle>
					<DialogDescription>{t`Preview`}</DialogDescription>
				</DialogHeader>
				{error !== undefined && error !== null ? (
					<ErrorState error={error} compact />
				) : url === undefined ? (
					<div className="grid place-items-center py-12">
						<Spinner label={t`Loading preview`} />
					</div>
				) : (
					<img
						src={url}
						alt={entry.name}
						className="mx-auto max-h-[70vh] max-w-full object-contain"
						data-testid="file-preview-image"
					/>
				)}
			</DialogContent>
		</Dialog>
	);
}
