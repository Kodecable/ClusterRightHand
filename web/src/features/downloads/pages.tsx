import { Trans, useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { ErrorState } from "@/components/error-state";
import { FileBox } from "@/components/file-box";
import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";
import { PageSkeleton } from "@/components/skeletons";
import { useLibraries } from "@/features/library/api";
import { useNodeNames } from "@/features/nodes/api";
import { enc, http, isNotFound, queryString } from "@/lib/api/client";
import { libraryFileUrls, nodeFileUrls, startDownload } from "@/lib/file-urls";

/**
 * What a `/download` link names: a library file (`libraryId`, with the `library` reference as a fallback) or
 * a node file (`nodeId`), and its path. Read from the raw query string, so a path is never reparsed as JSON.
 */
export type DownloadTarget =
	| { kind: "library"; libraryId: string | undefined; library: string | undefined; path: string }
	| { kind: "node"; nodeId: string; path: string };

export function parseDownloadTarget(searchStr: string): DownloadTarget | undefined {
	const search = new URLSearchParams(searchStr);
	const path = search.get("path") ?? "";
	if (path === "") return undefined;
	const libraryId = search.get("libraryId") || undefined;
	const library = search.get("library") || undefined;
	if (libraryId !== undefined || library !== undefined) return { kind: "library", libraryId, library, path };
	const nodeId = search.get("nodeId") || undefined;
	if (nodeId !== undefined) return { kind: "node", nodeId, path };
	return undefined;
}

const fileName = (path: string) => path.slice(path.lastIndexOf("/") + 1) || path;

/**
 * The page a download link outside the WebUI opens (doc/design/webui.md "Download page"), such as a file a
 * chat channel delivered. Signing in happens on the way like any page; the file is then checked as the
 * signed-in user, shown as a file box and its download starts once. A missing file and one the user may not
 * reach get the same message.
 */
export function DownloadPage() {
	const { t } = useLingui();
	const searchStr = useRouterState({ select: (state) => state.location.searchStr });
	const target = parseDownloadTarget(searchStr);

	return (
		<Page width="detail" data-testid="download-page">
			<PageHeader title={<Trans>Download</Trans>} />
			{target === undefined ? (
				<ErrorState error={t`This download link is incomplete.`} />
			) : target.kind === "library" ? (
				// Keyed by the link, so another link reached from here checks and starts its own download.
				<LibraryDownload key={searchStr} target={target} />
			) : (
				<NodeDownload key={searchStr} target={target} />
			)}
		</Page>
	);
}

function LibraryDownload({ target }: { target: Extract<DownloadTarget, { kind: "library" }> }) {
	// The id survives a renamed group; the reference covers a library the list does not show (an administrator
	// opening another user's library).
	const libraries = useLibraries(target.libraryId !== undefined);
	const ref =
		target.libraryId === undefined
			? target.library
			: libraries.isPending
				? undefined
				: (libraries.data?.find((library) => library.id === target.libraryId)?.ref ?? target.library);
	const file = useQuery({
		queryKey: ["download", "library", ref ?? "", target.path],
		enabled: ref !== undefined,
		retry: false,
		queryFn: ({ signal }) =>
			http
				.get<{ file: { size: number; mediaType: string } }>(
					`/libraries/${enc(ref ?? "")}/stat${queryString({ path: target.path })}`,
					{ signal },
				)
				.then((r) => r.file),
	});
	if (ref === undefined && !libraries.isPending) return <NoAccess />;
	return (
		<Ready
			state={file}
			name={fileName(target.path)}
			source={ref ?? ""}
			path={target.path}
			urls={ref === undefined ? undefined : libraryFileUrls(ref, target.path)}
		/>
	);
}

function NodeDownload({ target }: { target: Extract<DownloadTarget, { kind: "node" }> }) {
	const names = useNodeNames();
	const file = useQuery({
		queryKey: ["download", "node", target.nodeId, target.path],
		retry: false,
		queryFn: ({ signal }) =>
			http
				.get<{ file: { size: number } }>(`/nodes/${enc(target.nodeId)}/stat${queryString({ path: target.path })}`, {
					signal,
				})
				.then((r) => r.file),
	});
	return (
		<Ready
			state={file}
			name={fileName(target.path)}
			source={names.get(target.nodeId) ?? target.nodeId}
			path={target.path}
			urls={nodeFileUrls(target.nodeId, target.path)}
		/>
	);
}

function NoAccess() {
	const { t } = useLingui();
	return <ErrorState error={t`This file doesn't exist or you don't have access.`} />;
}

function Ready({
	state,
	name,
	source,
	path,
	urls,
}: {
	state: {
		data?: { size: number; mediaType?: string };
		error: unknown;
		isError: boolean;
		refetch: () => unknown;
	};
	name: string;
	source: string;
	path: string;
	urls: { download: string; preview: string } | undefined;
}) {
	const started = useRef<string | undefined>(undefined);
	const ready = state.data !== undefined && urls !== undefined;
	const download = urls?.download;
	// The link's purpose is the download: start it once the file is known to be there, and once per file.
	useEffect(() => {
		if (!ready || download === undefined || started.current === download) return;
		started.current = download;
		startDownload(download, name);
	}, [ready, download, name]);

	if (state.isError) {
		return isNotFound(state.error) ? (
			<NoAccess />
		) : (
			<ErrorState error={state.error} retry={() => void state.refetch()} />
		);
	}
	if (!ready) return <PageSkeleton />;
	return (
		<div className="grid gap-2">
			<FileBox
				name={name}
				bytes={state.data?.size}
				mime={state.data?.mediaType}
				source={source}
				path={path}
				download={urls.download}
				preview={urls.preview}
				testId="download-file"
			/>
			<p className="text-xs text-muted-foreground">
				<Trans>The download starts on its own. If it does not, click the file.</Trans>
			</p>
		</div>
	);
}
