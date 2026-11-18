import { Trans, useLingui } from "@lingui/react/macro";
import { useEffect, useRef, useState } from "react";
import { ErrorState } from "@/components/error-state";
import { Spinner } from "@/components/spinner";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

/**
 * The one image preview dialog (doc/design/webui.md "Shared components"): the caller names the file and
 * loads its bytes, the dialog shows a spinner, then the image. Closing aborts the load and an image that
 * arrives after that is dropped and its object URL revoked.
 */
export function FilePreviewDialog({
	name,
	load,
	onClose,
}: {
	name: string;
	/** Loads the image bytes; aborting `signal` cancels the request. */
	load: (signal: AbortSignal) => Promise<Blob>;
	onClose: () => void;
}) {
	const { t } = useLingui();
	const [image, setImage] = useState<string>();
	const [error, setError] = useState<unknown>();
	const controller = useRef<AbortController | null>(null);

	useEffect(() => {
		const current = new AbortController();
		controller.current = current;
		let objectUrl: string | undefined;
		setImage(undefined);
		setError(undefined);
		void (async () => {
			try {
				const blob = await load(current.signal);
				if (current.signal.aborted) return;
				objectUrl = URL.createObjectURL(blob);
				setImage(objectUrl);
			} catch (err) {
				if (!current.signal.aborted) setError(err);
			}
		})();
		return () => {
			current.abort();
			if (controller.current === current) controller.current = null;
			if (objectUrl) URL.revokeObjectURL(objectUrl);
		};
	}, [load]);

	const close = () => {
		controller.current?.abort();
		onClose();
	};

	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) close();
			}}
		>
			<DialogContent className="sm:max-w-5xl">
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
