import type { ChatAttachment, LibraryResponse } from "@crh/api";
import { Trans, useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { FileIcon } from "lucide-react";
import { enc, http, isNotFound } from "@/lib/api/client";
import { formatBytes } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * One attachment of a user message (doc/design/library.md "Chat attachments"): a chip linking to the
 * library file. It is inactive, with the reason, when the viewer cannot reach the library or the file is
 * gone; the transcript never parses attachment data out of the text.
 */
export function AttachmentChip({ attachment }: { attachment: ChatAttachment }) {
	const { t, i18n } = useLingui();
	const library = useQuery({
		queryKey: ["libraries", "detail", attachment.library],
		queryFn: ({ signal }) =>
			http.get<LibraryResponse>(`/libraries/${enc(attachment.library)}`, { signal }).then((r) => r.library),
		retry: false,
	});
	const file = useQuery({
		queryKey: ["libraries", "stat", attachment.library, attachment.path],
		enabled: library.isSuccess,
		retry: false,
		queryFn: ({ signal }) =>
			http
				.get<{ file: { size: number } }>(
					`/libraries/${enc(attachment.library)}/stat?path=${encodeURIComponent(attachment.path)}`,
					{ signal },
				)
				.then((r) => r.file),
	});

	const href = `/api/libraries/${enc(attachment.library)}/file?path=${encodeURIComponent(attachment.path)}`;
	let reason: string | undefined;
	if (library.isError) {
		reason = isNotFound(library.error) ? t`You don't have access to this library.` : t`This file could not be checked.`;
	} else if (file.isError) {
		reason = isNotFound(file.error) ? t`This file is no longer available.` : t`This file could not be checked.`;
	} else if (library.isPending || file.isPending) {
		reason = t`Checking the file…`;
	}

	const label = `${attachment.name} (${formatBytes(attachment.bytes, i18n.locale)})`;
	const body = (
		<span className="flex items-center gap-1.5">
			<FileIcon className="size-3.5 shrink-0" aria-hidden="true" />
			<span className="min-w-0 truncate">{label}</span>
		</span>
	);
	return (
		<span className="flex max-w-full flex-col items-end gap-0.5" data-testid="attachment-chip">
			{reason === undefined ? (
				<a
					href={href}
					className="flex max-w-full items-center rounded-md border bg-background px-2 py-1 text-xs text-foreground hover:bg-accent"
					title={attachment.path}
					data-testid="attachment-chip-link"
				>
					{body}
				</a>
			) : (
				<span
					className={cn(
						"flex max-w-full items-center rounded-md border bg-muted px-2 py-1 text-xs text-muted-foreground",
						file.isError && "opacity-70",
					)}
					title={attachment.path}
					data-testid="attachment-chip-inactive"
				>
					{body}
				</span>
			)}
			{reason !== undefined && (
				<span className="text-[11px] text-muted-foreground" data-testid="attachment-chip-reason">
					{reason}
				</span>
			)}
			<span className="sr-only">
				<Trans>Attachment</Trans>
			</span>
		</span>
	);
}
