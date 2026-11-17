import { FileBox } from "@/components/file-box";
import { useLibraries } from "@/features/library/api";
import { enc, queryString } from "@/lib/api/client";
import type { DeliveryDetails } from "./tool-details";

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

/** One delivered file: its name, where it came from and its size; clicking it downloads the file. */
function DeliveryBox({ delivery }: { delivery: DeliveryDetails }) {
	const librarySource = "library" in delivery.source ? delivery.source : undefined;
	const libraries = useLibraries(librarySource !== undefined);
	const libraryRef =
		librarySource !== undefined && libraries.data !== undefined
			? (libraries.data.find((library) => library.id === librarySource.libraryId)?.ref ?? librarySource.library)
			: undefined;
	const urls = deliveryUrls(delivery, libraryRef);

	return (
		<FileBox
			name={delivery.name}
			bytes={delivery.bytes}
			source={urls.source}
			path={delivery.source.path}
			download={urls.download}
			preview={urls.preview}
			testId="delivery-box"
			downloadTestId="delivery-download"
			previewTestId="delivery-preview"
		/>
	);
}

/** The files one turn delivered, after its final answer, on the assistant's side (doc/design/library.md "Deliveries"). */
export function TurnDeliveries({ deliveries }: { deliveries: readonly DeliveryDetails[] }) {
	return (
		<div className="flex flex-col items-start gap-1 px-3 pb-2" data-testid="turn-deliveries" data-side="agent">
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
