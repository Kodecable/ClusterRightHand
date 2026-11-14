/**
 * Libraries and their files (doc/design/library.md "Libraries" and "WebUI and API").
 *
 * A library is named by its owner: `user:<username>` or `user_group:<user group name>`. The API
 * accepts that reference wherever a route names a library.
 */

import type { z } from "zod";
import type {
	LibraryCapabilitiesSchema,
	LibraryFileSchema,
	LibraryFilesResponseSchema,
	LibraryLimitsPatchSchema,
	LibraryLimitsSchema,
	LibraryListResponseSchema,
	LibraryResponseSchema,
	LibraryUsageSchema,
	LibraryViewSchema,
	SystemSettingsLibrarySchema,
} from "./schemas/libraries.ts";

/** The three limits of a library; 0 allows nothing (doc/design/library.md "Limits"). */
export type LibraryLimits = z.infer<typeof LibraryLimitsSchema>;

/** Current usage, maintained with the file rows. */
export type LibraryUsage = z.infer<typeof LibraryUsageSchema>;

/** What the caller may do with a library. */
export type LibraryCapabilities = z.infer<typeof LibraryCapabilitiesSchema>;

/** `GET /api/libraries` and `GET /api/libraries/:ref`. */
export type LibraryView = z.infer<typeof LibraryViewSchema>;

export type LibraryListResponse = z.infer<typeof LibraryListResponseSchema>;

export type LibraryResponse = z.infer<typeof LibraryResponseSchema>;

/** One file of a library; `path` is the library-relative key (doc/design/library.md "Paths"). */
export type LibraryFile = z.infer<typeof LibraryFileSchema>;

/** `GET /api/libraries/:ref/files`: the files directly under the prefix and the next-level directories. */
export type LibraryFilesResponse = z.infer<typeof LibraryFilesResponseSchema>;

export type LibraryFileResponse = { file: LibraryFile };

/** `PATCH /api/libraries/:ref/limits`; omitted fields keep their value. */
export type LibraryLimitsPatch = z.infer<typeof LibraryLimitsPatchSchema>;

/** The default limits new libraries copy (doc/design/library.md "Limits"). */
export type SystemSettingsLibrary = z.infer<typeof SystemSettingsLibrarySchema>;
