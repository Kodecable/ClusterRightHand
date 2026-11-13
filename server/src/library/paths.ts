/**
 * Library paths (doc/design/library.md "Paths"): flat keys with "/" separating segments, no directory
 * objects. A listing prefix may be empty (the root).
 */
import { UserError } from "../util/errors.ts";

/** The longest path, in UTF-8 bytes. */
export const MAX_LIBRARY_PATH_BYTES = 1024;

/** Validates a file path and returns it unchanged. */
export function validateLibraryPath(path: unknown): string {
	if (typeof path !== "string" || path === "") throw new UserError("a library path must not be empty");
	if (path.startsWith("/") || path.endsWith("/")) {
		throw new UserError("a library path must not start or end with /");
	}
	if (/[\p{Cc}]/u.test(path)) throw new UserError("a library path must not contain control characters");
	for (const segment of path.split("/")) {
		if (segment === "" || segment === "." || segment === "..") {
			throw new UserError("a library path must not contain empty, . or .. segments");
		}
	}
	if (Buffer.byteLength(path, "utf8") > MAX_LIBRARY_PATH_BYTES) {
		throw new UserError(`a library path must be at most ${MAX_LIBRARY_PATH_BYTES} bytes`);
	}
	if (Buffer.from(path, "utf8").toString("utf8") !== path) {
		throw new UserError("a library path must be valid UTF-8");
	}
	return path;
}

/** Validates a listing prefix; the empty string means the library's root. */
export function validateLibraryPrefix(prefix: unknown): string {
	if (prefix === undefined || prefix === null || prefix === "") return "";
	if (typeof prefix !== "string") throw new UserError("a library prefix must be a string");
	return validateLibraryPath(prefix);
}

/** The last segment of a path, for a download's file name. */
export function libraryPathName(path: string): string {
	const index = path.lastIndexOf("/");
	return index === -1 ? path : path.slice(index + 1);
}

/**
 * A path with ` (n)` before the first dot of its base name, for an upload that must not replace an
 * existing file: `x.tar.gz` → `x (1).tar.gz`, `.bashrc` → `.bashrc (1)`. A leading dot is not the
 * extension separator; the directory part is kept as is.
 */
export function numberedLibraryPath(path: string, index: number): string {
	const slash = path.lastIndexOf("/");
	const directory = slash === -1 ? "" : path.slice(0, slash + 1);
	const name = slash === -1 ? path : path.slice(slash + 1);
	const dot = name.indexOf(".", 1);
	const base = dot === -1 ? name : name.slice(0, dot);
	const extension = dot === -1 ? "" : name.slice(dot);
	return `${directory}${base} (${index})${extension}`;
}

/** The directory segments of a path, for a breadcrumb. */
export function libraryPathSegments(path: string): string[] {
	return path === "" ? [] : path.split("/");
}
