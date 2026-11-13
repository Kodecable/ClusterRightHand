/**
 * The contract between the shared FileManager and whoever supplies files
 * (doc/design/webui.md "Shared components"). The component knows nothing of libraries or nodes: a
 * source lists and stats, and may additionally download, upload, delete, rename and preview. A
 * missing operation hides its action.
 */

/** One row of a listing. A directory exists only while a file is under it. */
export interface FileEntry {
	/** The full path from the source's root, without a leading slash. */
	path: string;
	/** The last path segment, shown in the row. */
	name: string;
	kind: "file" | "directory";
	/** Files only. */
	size?: number;
	/** Files only; the sniffed/server-declared type. */
	mediaType?: string;
	/** Files only. */
	updatedAt?: string;
}

export interface FileListing {
	files: FileEntry[];
	/** Next-level directory names under the listed prefix. */
	directories: string[];
}

/** The controlled selection of a FileManager in FilePicker mode. */
export interface FileSelection {
	multiple: boolean;
	selected: ReadonlySet<string>;
	onToggle: (entry: FileEntry) => void;
}

export interface FileUploadOptions {
	/** Replace an existing file at the path (the source decides whether it may). */
	overwrite?: boolean;
	onProgress?: (loaded: number, total: number) => void;
	signal?: AbortSignal;
}

export interface FileRenameOptions {
	overwrite?: boolean;
}

export interface FileSource {
	/** Lists the files directly under `prefix` and the next-level directory names. */
	list(prefix: string, signal: AbortSignal): Promise<FileListing>;
	stat(path: string): Promise<FileEntry>;
	/** A URL the browser can open; the server serves it as an attachment. */
	download?(path: string): string;
	upload?(path: string, file: File, options: FileUploadOptions): Promise<FileEntry>;
	delete?(path: string): Promise<void>;
	rename?(path: string, target: string, options?: FileRenameOptions): Promise<FileEntry>;
	/** The image bytes, loaded when a preview is opened. */
	preview?(path: string): Promise<Blob>;
}

/** The media types a FileManager previews and the largest it loads. */
export const PREVIEW_MEDIA_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
export const PREVIEW_MAX_BYTES = 20 * 1024 * 1024;

export function isPreviewable(entry: FileEntry): boolean {
	return (
		entry.kind === "file" &&
		entry.mediaType !== undefined &&
		PREVIEW_MEDIA_TYPES.has(entry.mediaType) &&
		(entry.size ?? 0) <= PREVIEW_MAX_BYTES
	);
}

/** Joins a directory prefix and a name; the root prefix is empty. */
export function joinPath(prefix: string, name: string): string {
	return prefix === "" ? name : `${prefix}/${name}`;
}

/** The path segments of a prefix, for a breadcrumb. */
export function pathSegments(prefix: string): string[] {
	return prefix === "" ? [] : prefix.split("/");
}

/** The canonical form of a library-style key: without leading "/" characters. */
export function normalizeFilePath(path: string): string {
	return path.replace(/^\/+/, "");
}

/**
 * Whether `path` is a library-style key: valid UTF-8, at most 1024 bytes, no trailing slash, no
 * empty, "." or ".." segment and no control characters. A leading "/" is accepted and normalized
 * away; the canonical form has none (doc/design/library.md "Paths"). The server validates again.
 */
export function isValidFilePath(path: string): boolean {
	const canonical = normalizeFilePath(path);
	if (canonical === "" || canonical.endsWith("/")) return false;
	if (/[\p{Cc}]/u.test(canonical)) return false;
	if (canonical.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) return false;
	return new TextEncoder().encode(canonical).length <= 1024;
}
