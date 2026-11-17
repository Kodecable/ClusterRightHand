import { Trans, useLingui } from "@lingui/react/macro";
import { EyeIcon, FileIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { ErrorState } from "@/components/error-state";
import { PREVIEW_MAX_BYTES, PREVIEW_MEDIA_TYPES } from "@/components/file-manager";
import { Spinner } from "@/components/spinner";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatBytes } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Whether a file can be shown by the image preview (doc/design/library.md "Chat attachments"): PNG,
 * JPEG, GIF or WebP up to 20 MiB, from its media type when known and otherwise from its name. The
 * server sniffs the bytes again.
 */
export function isPreviewableFile(file: { name: string; mime?: string; bytes?: number }): boolean {
	if (file.bytes !== undefined && file.bytes > PREVIEW_MAX_BYTES) return false;
	if (file.mime !== undefined) return PREVIEW_MEDIA_TYPES.has(file.mime.toLowerCase());
	return /\.(png|jpe?g|gif|webp)$/i.test(file.name);
}

/** The image of a file, loaded from its preview URL when the dialog opens. */
function FilePreviewDialog({ name, url, onClose }: { name: string; url: string; onClose: () => void }) {
	const { t } = useLingui();
	const [image, setImage] = useState<string>();
	const [error, setError] = useState<unknown>();

	useEffect(() => {
		let active = true;
		let objectUrl: string | undefined;
		const controller = new AbortController();
		void (async () => {
			try {
				const response = await fetch(url, { credentials: "same-origin", signal: controller.signal });
				if (!response.ok) {
					let message = `HTTP ${response.status}`;
					try {
						const body = (await response.json()) as { error?: string };
						message = body.error ?? message;
					} catch {
						// Not JSON; keep the status line.
					}
					throw new Error(message);
				}
				const blob = await response.blob();
				if (!active) return;
				objectUrl = URL.createObjectURL(blob);
				setImage(objectUrl);
			} catch (err) {
				if (active) setError(err);
			}
		})();
		return () => {
			active = false;
			controller.abort();
			if (objectUrl) URL.revokeObjectURL(objectUrl);
		};
	}, [url]);

	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			<DialogContent className="sm:max-w-4xl">
				<DialogHeader>
					<DialogTitle>{name}</DialogTitle>
					<DialogDescription>
						<Trans>Preview</Trans>
					</DialogDescription>
				</DialogHeader>
				{error !== undefined ? (
					<ErrorState error={error} compact />
				) : image === undefined ? (
					<div className="grid place-items-center py-12">
						<Spinner label={t`Loading preview`} />
					</div>
				) : (
					<img
						src={image}
						alt={name}
						className="mx-auto max-h-[70vh] max-w-full object-contain"
						data-testid="file-preview-image"
					/>
				)}
			</DialogContent>
		</Dialog>
	);
}

/**
 * One file of the transcript (doc/design/webui.md "Message rendering"): a user's attachment or a
 * file a turn delivered. It shows the name, an optional source (a library reference or node name)
 * and the size in a compact box; clicking it downloads the file, and an image also offers a preview
 * button. Without a download it is inactive and shows why.
 */
export function FileBox({
	name,
	bytes,
	mime,
	source,
	path,
	download,
	preview,
	reason,
	testId,
	downloadTestId,
	previewTestId,
	inactiveTestId,
	reasonTestId,
	srLabel,
}: {
	name: string;
	/** The size in bytes, when known. */
	bytes?: number;
	/** The media type, when known: with the name it decides whether the image preview is offered. */
	mime?: string;
	/** The source shown under the name: a library reference or node name, omitted for an attachment. */
	source?: string;
	/** The full path, shown as the box's tooltip. */
	path: string;
	/** The download URL; without it the box is inactive and shows `reason`. */
	download?: string;
	/** The URL that serves the image bytes for the preview. */
	preview?: string;
	/** Why the file is inactive. */
	reason?: string;
	/** The `data-testid` of the box; the preview, inactive and reason ids default to suffixes of it. */
	testId: string;
	/** The `data-testid` of the download link; defaults to `<testId>-download`. */
	downloadTestId?: string;
	/** The `data-testid` of the preview button; defaults to `<testId>-preview`. */
	previewTestId?: string;
	/** The `data-testid` of the inactive box; defaults to `<testId>-inactive`. */
	inactiveTestId?: string;
	/** The `data-testid` of the reason; defaults to `<testId>-reason`. */
	reasonTestId?: string;
	/** A screen-reader-only label, e.g. that the box is an attachment. */
	srLabel?: React.ReactNode;
}) {
	const { t, i18n } = useLingui();
	const [previewing, setPreviewing] = useState(false);
	const showsPreview = download !== undefined && preview !== undefined && isPreviewableFile({ name, mime, bytes });
	const body = (
		<span className="flex min-w-0 flex-1 items-center gap-2">
			<FileIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
			<span className="flex min-w-0 flex-1 flex-col">
				<span className="min-w-0 truncate font-medium">{name}</span>
				{(source !== undefined || bytes !== undefined) && (
					<span className="flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground">
						{source !== undefined && <span className="min-w-0 truncate">{source}</span>}
						{source !== undefined && bytes !== undefined && <span aria-hidden="true">·</span>}
						{bytes !== undefined && <span className="shrink-0">{formatBytes(bytes, i18n.locale)}</span>}
					</span>
				)}
			</span>
		</span>
	);

	return (
		<div data-testid={testId} className="flex w-full max-w-xs min-w-0 flex-col gap-0.5">
			<div
				className={cn(
					"flex min-w-0 items-center gap-1 rounded-md border px-2 py-1.5 text-xs",
					download === undefined ? "bg-muted text-muted-foreground" : "bg-background text-foreground",
				)}
			>
				{download === undefined ? (
					<span
						className="flex min-w-0 flex-1 items-center opacity-70"
						title={path}
						data-testid={inactiveTestId ?? `${testId}-inactive`}
					>
						{body}
					</span>
				) : (
					<a
						href={download}
						className="flex min-w-0 flex-1 cursor-pointer items-center rounded-sm transition-colors hover:text-foreground/80 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
						title={path}
						aria-label={t`Download ${name}`}
						data-testid={downloadTestId ?? `${testId}-download`}
					>
						{body}
					</a>
				)}
				{showsPreview && (
					<button
						type="button"
						onClick={() => setPreviewing(true)}
						className="inline-flex shrink-0 cursor-pointer items-center justify-center rounded-md p-1 text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
						aria-label={t`Preview ${name}`}
						title={t`Preview ${name}`}
						data-testid={previewTestId ?? `${testId}-preview`}
					>
						<EyeIcon className="size-3.5" aria-hidden="true" />
					</button>
				)}
			</div>
			{reason !== undefined && (
				<span className="text-[11px] text-muted-foreground" data-testid={reasonTestId ?? `${testId}-reason`}>
					{reason}
				</span>
			)}
			{srLabel !== undefined && <span className="sr-only">{srLabel}</span>}
			{previewing && preview !== undefined && (
				<FilePreviewDialog name={name} url={preview} onClose={() => setPreviewing(false)} />
			)}
		</div>
	);
}
