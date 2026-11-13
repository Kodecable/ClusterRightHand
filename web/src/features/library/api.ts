import type {
	LibraryFile,
	LibraryFilesResponse,
	LibraryLimitsPatch,
	LibraryListResponse,
	LibraryResponse,
} from "@crh/api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import type { FileEntry, FileSource, FileUploadOptions } from "@/components/file-manager";
import { ApiError, enc, http, notifyUnauthorized, queryString } from "@/lib/api/client";

export const libraryKeys = {
	all: ["libraries"] as const,
	list: () => ["libraries", "list"] as const,
	detail: (ref: string) => ["libraries", "detail", ref] as const,
};

/** The caller's libraries: their own and their user groups'. */
export function useLibraries(enabled = true) {
	return useQuery({
		queryKey: libraryKeys.list(),
		enabled,
		queryFn: ({ signal }) => http.get<LibraryListResponse>("/libraries", { signal }).then((r) => r.libraries),
	});
}

/** One library by its `user:<username>` / `group:<name>` reference. */
export function useLibrary(ref: string) {
	return useQuery({
		queryKey: libraryKeys.detail(ref),
		enabled: ref !== "",
		queryFn: ({ signal }) => http.get<LibraryResponse>(`/libraries/${enc(ref)}`, { signal }).then((r) => r.library),
	});
}

/** An administrators' limits change. */
export function useUpdateLibraryLimits(ref: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (patch: LibraryLimitsPatch) =>
			http.patch<LibraryResponse>(`/libraries/${enc(ref)}/limits`, patch).then((r) => r.library),
		onSuccess: (library) => {
			queryClient.setQueryData(libraryKeys.detail(ref), library);
			void queryClient.invalidateQueries({ queryKey: libraryKeys.all });
		},
	});
}

function toEntry(file: LibraryFile): FileEntry {
	const name = file.path.slice(file.path.lastIndexOf("/") + 1);
	return {
		path: file.path,
		name,
		kind: "file",
		size: file.size,
		mediaType: file.mediaType,
		updatedAt: file.updatedAt,
	};
}

/** `rename` asks the server to pick the next free name when the path is taken (doc/design/library.md "Chat attachments"). */
export interface UploadOptions extends FileUploadOptions {
	rename?: boolean;
}

/** PUT with an upload progress callback and cancel, because `fetch` does not report upload progress. */
export function uploadWithProgress(
	ref: string,
	path: string,
	file: File,
	options: UploadOptions,
): Promise<LibraryFile> {
	return new Promise((resolve, reject) => {
		const xhr = new XMLHttpRequest();
		xhr.open(
			"PUT",
			`/api/libraries/${enc(ref)}/file${queryString({ path, rename: options.rename === true ? 1 : undefined })}`,
		);
		xhr.responseType = "text";
		xhr.setRequestHeader("content-type", "application/octet-stream");
		xhr.upload.addEventListener("progress", (event) => {
			options.onProgress?.(event.loaded, event.lengthComputable ? event.total : file.size);
		});
		xhr.addEventListener("load", () => {
			let body: { file?: LibraryFile; error?: string; code?: string } | undefined;
			try {
				body = xhr.responseText === "" ? undefined : (JSON.parse(xhr.responseText) as typeof body);
			} catch {
				body = undefined;
			}
			if (xhr.status >= 200 && xhr.status < 300 && body?.file) {
				resolve(body.file);
				return;
			}
			if (xhr.status === 401) notifyUnauthorized();
			reject(new ApiError(xhr.status, body?.error ?? `HTTP ${xhr.status}`, body?.code ?? null));
		});
		xhr.addEventListener("error", () => reject(new Error("the upload failed (network error)")));
		xhr.addEventListener("abort", () => reject(new DOMException("upload canceled", "AbortError")));
		options.signal?.addEventListener("abort", () => xhr.abort(), { once: true });
		xhr.send(file);
	});
}

/**
 * The FileSource of one library. Mutations invalidate the usage on the page; the FileManager
 * reloads its own listing after each one.
 */
export function useLibraryFileSource(ref: string): FileSource {
	const queryClient = useQueryClient();
	return useMemo<FileSource>(() => {
		const invalidate = () => {
			void queryClient.invalidateQueries({ queryKey: libraryKeys.detail(ref) });
		};
		const base = `/libraries/${enc(ref)}`;
		return {
			async list(prefix, signal) {
				const body = await http.get<LibraryFilesResponse>(`${base}/files${queryString({ prefix })}`, { signal });
				return { files: body.files.map(toEntry), directories: body.directories };
			},
			async stat(path) {
				const body = await http.get<{ file: LibraryFile }>(`${base}/stat${queryString({ path })}`);
				return toEntry(body.file);
			},
			download(path) {
				return `/api${base}/file${queryString({ path })}`;
			},
			async upload(path, file, options) {
				const created = await uploadWithProgress(ref, path, file, options);
				invalidate();
				return toEntry(created);
			},
			async delete(path) {
				await http.del<{ ok: true }>(`${base}/file${queryString({ path })}`);
				invalidate();
			},
			async rename(path, target, options) {
				const body = await http
					.post<{ file: LibraryFile }>(`${base}/move`, {
						from: path,
						to: target,
						overwrite: options?.overwrite === true,
					})
					.then((r) => r.file);
				invalidate();
				return toEntry(body);
			},
			async preview(path) {
				const response = await fetch(`/api${base}/file${queryString({ path, preview: "1" })}`, {
					credentials: "same-origin",
				});
				if (!response.ok) {
					if (response.status === 401) notifyUnauthorized();
					let message = `HTTP ${response.status}`;
					try {
						const body = (await response.json()) as { error?: string };
						message = body.error ?? message;
					} catch {
						// Not JSON; keep the status line.
					}
					throw new ApiError(response.status, message);
				}
				return response.blob();
			},
		};
	}, [queryClient, ref]);
}
