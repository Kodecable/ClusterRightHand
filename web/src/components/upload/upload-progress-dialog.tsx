import { Trans, useLingui } from "@lingui/react/macro";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import type { UploadQueue } from "@/hooks/use-upload-queue";
import { formatBytes, formatDuration } from "@/lib/format";

export interface UploadProgressDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** The queue from `useUploadQueue`. */
	queue: UploadQueue;
	title?: ReactNode;
}

/**
 * An upload queue's progress as a dialog (doc/design/webui.md "Shared components"): the overall byte progress,
 * the files uploaded, the total size, the current speed and the remaining time, and every failed
 * file with its error. Cancel stops the file in flight and the files after it; the dialog cannot be
 * dismissed while the queue runs, so the only way out is that Cancel.
 */
export function UploadProgressDialog({ open, onOpenChange, queue, title }: UploadProgressDialogProps) {
	const { t, i18n } = useLingui();
	const percent =
		queue.totalBytes > 0 ? Math.min(100, (queue.loadedBytes / queue.totalBytes) * 100) : queue.running ? 0 : 100;
	const eta = queue.eta === undefined ? undefined : formatDuration(queue.eta * 1000, i18n.locale);

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!next && queue.running) return;
				onOpenChange(false);
			}}
		>
			<DialogContent showCloseButton={false} data-testid="upload-progress-dialog">
				<DialogHeader>
					<DialogTitle>{title ?? <Trans>Uploading files</Trans>}</DialogTitle>
				</DialogHeader>
				<Progress value={percent} aria-label={t`Overall upload progress`} data-testid="upload-progress" />
				<dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
					<dt className="text-muted-foreground">
						<Trans>Files</Trans>
					</dt>
					<dd className="tabular-nums">
						{queue.done} / {queue.totalFiles}
					</dd>
					<dt className="text-muted-foreground">
						<Trans>Total size</Trans>
					</dt>
					<dd className="tabular-nums">{formatBytes(queue.totalBytes, i18n.locale)}</dd>
					{queue.running && (
						<>
							<dt className="text-muted-foreground">
								<Trans>Speed</Trans>
							</dt>
							<dd className="tabular-nums">{formatBytes(queue.speed, i18n.locale)}/s</dd>
							<dt className="text-muted-foreground">
								<Trans>ETA</Trans>
							</dt>
							<dd className="tabular-nums">{eta ?? "–"}</dd>
						</>
					)}
				</dl>
				{queue.failures.length > 0 && (
					<div className="grid gap-1" data-testid="upload-failures">
						<p className="text-sm font-medium">
							<Trans>Failed files</Trans>
						</p>
						<ul className="grid gap-1">
							{queue.failures.map((failure) => (
								<li
									key={failure.id}
									className="grid gap-0.5 rounded-md border border-danger/30 bg-danger-bg px-2 py-1.5"
								>
									<span className="truncate text-sm">{failure.file.name}</span>
									<span className="text-xs break-words text-danger [overflow-wrap:anywhere]">{failure.error}</span>
								</li>
							))}
						</ul>
					</div>
				)}
				<DialogFooter>
					{queue.running ? (
						<Button type="button" variant="outline" onClick={queue.cancel}>
							<Trans>Cancel</Trans>
						</Button>
					) : (
						<Button type="button" onClick={() => onOpenChange(false)}>
							<Trans>Close</Trans>
						</Button>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
