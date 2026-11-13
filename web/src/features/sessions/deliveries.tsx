import { Trans, useLingui } from "@lingui/react/macro";
import { EyeIcon, FileIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { ErrorState } from "@/components/error-state";
import { Spinner } from "@/components/spinner";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useLibraries } from "@/features/library/api";
import { enc, queryString } from "@/lib/api/client";
import { formatBytes } from "@/lib/format";
import type { DeliveryDetails } from "./tool-details";

/** The media types a delivered file can preview, judged by its name; the server sniffs the bytes again. */
function previewable(name: string): boolean {
	return /\.(png|jpe?g|gif|webp)$/i.test(name);
}

/** Where a delivered file downloads from, resolving a library by its id so a renamed group keeps the link. */
function deliveryUrls(delivery: DeliveryDetails, libraryRef: string | undefined) {
	if ("library" in delivery.source) {
		const ref = libraryRef ?? delivery.source.library;
		const base = `/api/libraries/${enc(ref)}/file${queryString({ path: delivery.source.path })}`;
		return {
			download: base,
			preview: `/api/libraries/${enc(ref)}/file${queryString({ path: delivery.source.path, preview: "1" })}`,
			source: ref,
		};
	}
	return {
		download: `/api/nodes/${enc(delivery.source.nodeId)}/file${queryString({ path: delivery.source.path })}`,
		preview: `/api/nodes/${enc(delivery.source.nodeId)}/file${queryString({ path: delivery.source.path, preview: "1" })}`,
		source: delivery.source.node,
	};
}

/** The image of a delivered file, loaded from the ordinary preview endpoint when the dialog opens. */
function DeliveryPreview({ delivery, url, onClose }: { delivery: DeliveryDetails; url: string; onClose: () => void }) {
	const { t } = useLingui();
	const [image, setImage] = useState<string>();
	const [error, setError] = useState<unknown>();

	useEffect(() => {
		let active = true;
		let objectUrl: string | undefined;
		void (async () => {
			try {
				const response = await fetch(url, { credentials: "same-origin" });
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
					<DialogTitle>{delivery.name}</DialogTitle>
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
						alt={delivery.name}
						className="mx-auto max-h-[70vh] max-w-full object-contain"
						data-testid="delivery-preview-image"
					/>
				)}
			</DialogContent>
		</Dialog>
	);
}

/** One delivered file: its name, where it came from and its size; clicking it downloads the file. */
function DeliveryBox({ delivery }: { delivery: DeliveryDetails }) {
	const { i18n, t } = useLingui();
	const [preview, setPreview] = useState(false);
	const librarySource = "library" in delivery.source ? delivery.source : undefined;
	const libraries = useLibraries(librarySource !== undefined);
	const libraryRef =
		librarySource !== undefined && libraries.data !== undefined
			? (libraries.data.find((library) => library.id === librarySource.libraryId)?.ref ?? librarySource.library)
			: undefined;
	const urls = deliveryUrls(delivery, libraryRef);

	return (
		<div
			data-testid="delivery-box"
			className="flex w-full max-w-[92%] items-center gap-1 rounded-md border bg-background px-2 py-1.5 text-xs"
		>
			<a
				href={urls.download}
				className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-foreground hover:text-foreground/80 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
				title={delivery.source.path}
				data-testid="delivery-download"
				aria-label={t`Download ${delivery.name}`}
			>
				<FileIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
				<span className="min-w-0 truncate font-medium">{delivery.name}</span>
				<span className="min-w-0 truncate text-muted-foreground">{urls.source}</span>
				{delivery.bytes !== undefined && (
					<span className="shrink-0 text-muted-foreground">{formatBytes(delivery.bytes, i18n.locale)}</span>
				)}
			</a>
			{previewable(delivery.name) && (
				<button
					type="button"
					onClick={() => setPreview(true)}
					className="inline-flex shrink-0 cursor-pointer items-center justify-center rounded-md p-1 text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
					aria-label={t`Preview ${delivery.name}`}
					title={t`Preview ${delivery.name}`}
					data-testid="delivery-preview"
				>
					<EyeIcon className="size-3.5" aria-hidden="true" />
				</button>
			)}
			{preview && <DeliveryPreview delivery={delivery} url={urls.preview} onClose={() => setPreview(false)} />}
		</div>
	);
}

/** The files one turn delivered, after its final answer (doc/design/library.md "Deliveries"). */
export function TurnDeliveries({ deliveries }: { deliveries: readonly DeliveryDetails[] }) {
	return (
		<div className="flex flex-col items-end gap-1 px-3 pb-2" data-testid="turn-deliveries">
			{deliveries.map((delivery) => (
				<DeliveryBox
					key={
						"library" in delivery.source
							? `library:${delivery.source.libraryId}:${delivery.source.path}`
							: `node:${delivery.source.nodeId}:${delivery.source.path}`
					}
					delivery={delivery}
				/>
			))}
		</div>
	);
}
