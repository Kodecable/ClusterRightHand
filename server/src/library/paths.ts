/**
 * Library paths (doc/design/library.md "Paths"): flat keys with "/" separating segments, no directory
 * objects. A leading "/" is accepted and normalized away; the canonical form has none. A listing prefix
 * may be empty (the root), which "/" also names.
 */
import { UserError } from "../util/errors.ts";

/** The longest path, in UTF-8 bytes. */
export const MAX_LIBRARY_PATH_BYTES = 1024;

/** The canonical form of a library path: without leading "/" characters. */
export function normalizeLibraryPath(path: string): string {
	return path.replace(/^\/+/, "");
}

/** Validates a file path and returns its canonical form, without a leading "/". */
export function validateLibraryPath(path: unknown): string {
	if (typeof path !== "string" || path === "") throw new UserError("a library path must not be empty");
	const canonical = normalizeLibraryPath(path);
	if (canonical === "") throw new UserError("a library path must not be empty");
	if (canonical.endsWith("/")) throw new UserError("a library path must not end with /");
	if (/[\p{Cc}]/u.test(canonical)) throw new UserError("a library path must not contain control characters");
	for (const segment of canonical.split("/")) {
		if (segment === "" || segment === "." || segment === "..") {
			throw new UserError("a library path must not contain empty, . or .. segments");
		}
	}
	if (Buffer.byteLength(canonical, "utf8") > MAX_LIBRARY_PATH_BYTES) {
		throw new UserError(`a library path must be at most ${MAX_LIBRARY_PATH_BYTES} bytes`);
	}
	if (Buffer.from(canonical, "utf8").toString("utf8") !== canonical) {
		throw new UserError("a library path must be valid UTF-8");
	}
	return canonical;
}

/** Validates a listing prefix; the empty string and "/" both mean the library's root. */
export function validateLibraryPrefix(prefix: unknown): string {
	if (prefix === undefined || prefix === null) return "";
	if (typeof prefix !== "string") throw new UserError("a library prefix must be a string");
	const canonical = normalizeLibraryPath(prefix);
	return canonical === "" ? "" : validateLibraryPath(canonical);
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
