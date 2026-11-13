/**
 * Libraries and their files (doc/design/library.md "Libraries" and "WebUI and API").
 *
 * A library is named by its owner: `user:<username>` or `group:<group name>`. The API accepts that
 * reference wherever a route names a library.
 */

/** The three limits of a library; 0 allows nothing (doc/design/library.md "Limits"). */
export interface LibraryLimits {
	/** How many files the library may hold. */
	files: number;
	/** The largest single file, in bytes. */
	fileBytes: number;
	/** The largest total of all files, in bytes. */
	totalBytes: number;
}

/** Current usage, maintained with the file rows. */
export interface LibraryUsage {
	files: number;
	bytes: number;
}

/** What the caller may do with a library. */
export interface LibraryCapabilities {
	/** Upload, overwrite, move and delete files. */
	write: boolean;
	/** Change the limits (administrators only). */
	manage: boolean;
}

/** `GET /api/libraries` and `GET /api/libraries/:ref`. */
export interface LibraryView {
	id: string;
	/** `user:<username>` or `group:<group name>`. */
	ref: string;
	ownerKind: "user" | "group";
	ownerId: string;
	ownerName: string;
	/** A user's display name; the group name for a group library. */
	ownerDisplayName: string;
	usage: LibraryUsage;
	limits: LibraryLimits;
	capabilities: LibraryCapabilities;
}

export interface LibraryListResponse {
	libraries: LibraryView[];
}

export interface LibraryResponse {
	library: LibraryView;
}

/** One file of a library; `path` is the library-relative key (doc/design/library.md "Paths"). */
export interface LibraryFile {
	path: string;
	size: number;
	sha256: string;
	mediaType: string;
	createdAt: string;
	updatedAt: string;
}

/** `GET /api/libraries/:ref/files`: the files directly under the prefix and the next-level directories. */
export interface LibraryFilesResponse {
	prefix: string;
	files: LibraryFile[];
	directories: string[];
}

export interface LibraryFileResponse {
	file: LibraryFile;
}

/** `PATCH /api/libraries/:ref/limits`; omitted fields keep their value. */
export interface LibraryLimitsPatch {
	files?: number;
	fileBytes?: number;
	totalBytes?: number;
}

/** The default limits new libraries copy (doc/design/library.md "Limits"). */
export interface SystemSettingsLibrary {
	user: LibraryLimits;
	group: LibraryLimits;
}
