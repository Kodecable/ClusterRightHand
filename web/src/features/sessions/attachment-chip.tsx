import type { ChatAttachment, LibraryResponse } from "@crh/api";
import { Trans, useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { FileBox } from "@/components/file-box";
import { useLibraries } from "@/features/library/api";
import { enc, http, isNotFound } from "@/lib/api/client";

/**
 * One attachment of a user message (doc/design/library.md "Chat attachments"): a file box linking to
 * the library file. The library is resolved by its id when the entry has one, so a renamed group keeps
 * the link; an older entry without one falls back to the stored reference. It is inactive, with the
 * reason, when the viewer cannot reach the library or the file is gone; the transcript never parses
 * attachment data out of the text.
 */
export function AttachmentChip({ attachment }: { attachment: ChatAttachment }) {
	const { t } = useLingui();
	const byId = attachment.libraryId !== undefined;
	const libraries = useLibraries(byId);
	const listed = byId ? libraries.data?.find((library) => library.id === attachment.libraryId) : undefined;
	const ref = listed?.ref ?? attachment.library;
	const library = useQuery({
		queryKey: ["libraries", "detail", ref],
		enabled: !byId,
		queryFn: ({ signal }) => http.get<LibraryResponse>(`/libraries/${enc(ref)}`, { signal }).then((r) => r.library),
		retry: false,
	});
	const reachable = byId ? listed !== undefined : library.isSuccess;
	const file = useQuery({
		queryKey: ["libraries", "stat", ref, attachment.path],
		enabled: reachable,
		retry: false,
		queryFn: ({ signal }) =>
			http
				.get<{ file: { size: number } }>(`/libraries/${enc(ref)}/stat?path=${encodeURIComponent(attachment.path)}`, {
					signal,
				})
				.then((r) => r.file),
	});

	const href = `/api/libraries/${enc(ref)}/file?path=${encodeURIComponent(attachment.path)}`;
	const previewHref = `${href}&preview=1`;
	let reason: string | undefined;
	if (byId) {
		if (libraries.isPending) reason = t`Checking the file…`;
		else if (libraries.isError) reason = t`This file could not be checked.`;
		else if (listed === undefined) reason = t`You don't have access to this library.`;
	} else if (library.isError) {
		reason = isNotFound(library.error) ? t`You don't have access to this library.` : t`This file could not be checked.`;
	} else if (library.isPending) {
		reason = t`Checking the file…`;
	}
	if (reason === undefined) {
		if (file.isError) {
			reason = isNotFound(file.error) ? t`This file is no longer available.` : t`This file could not be checked.`;
		} else if (file.isPending) {
			reason = t`Checking the file…`;
		}
	}

	return (
		<FileBox
			name={attachment.name}
			bytes={attachment.bytes}
			mime={attachment.mime}
			path={attachment.path}
			download={reason === undefined ? href : undefined}
			preview={reason === undefined ? previewHref : undefined}
			reason={reason}
			testId="attachment-chip"
			downloadTestId="attachment-chip-link"
			srLabel={<Trans>Attachment</Trans>}
		/>
	);
}
