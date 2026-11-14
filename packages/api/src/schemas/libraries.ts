/** Schemas for the library limits that the system settings copy (doc/design/library.md "Limits"). */
import { z } from "zod";
import { BinaryBodySchema } from "./common.ts";

/** The three limits of a library; 0 allows nothing. */
export const LibraryLimitsSchema = z
	.object({
		files: z.number().describe("How many files the library may hold."),
		fileBytes: z.number().describe("The largest single file, in bytes."),
		totalBytes: z.number().describe("The largest total of all files, in bytes."),
	})
	.meta({ id: "LibraryLimits" });

/** The limits new user and user group libraries copy when they are created. */
export const SystemSettingsLibrarySchema = z
	.object({
		user: LibraryLimitsSchema,
		userGroup: LibraryLimitsSchema,
	})
	.meta({ id: "SystemSettingsLibrary" });

/** Current usage, maintained with the file rows. */
export const LibraryUsageSchema = z
	.object({
		files: z.number(),
		bytes: z.number(),
	})
	.meta({ id: "LibraryUsage" });

/** What the caller may do with a library. */
export const LibraryCapabilitiesSchema = z
	.object({
		write: z.boolean().describe("Upload, overwrite, move and delete files."),
		manage: z.boolean().describe("Change the limits (administrators only)."),
	})
	.meta({ id: "LibraryCapabilities" });

/** `GET /api/libraries` and `GET /api/libraries/{ref}`. */
export const LibraryViewSchema = z
	.object({
		id: z.string(),
		ref: z.string().describe("`user:<username>` or `user_group:<user group name>`."),
		ownerKind: z.enum(["user", "user_group"]),
		ownerId: z.string(),
		ownerName: z.string(),
		ownerDisplayName: z.string().describe("A user's display name; the user group name for a user group library."),
		usage: LibraryUsageSchema,
		limits: LibraryLimitsSchema,
		capabilities: LibraryCapabilitiesSchema,
	})
	.meta({ id: "LibraryView" });

export const LibraryListResponseSchema = z.object({ libraries: z.array(LibraryViewSchema) });
export const LibraryResponseSchema = z.object({ library: LibraryViewSchema });

/** One file of a library; `path` is the library-relative key (doc/design/library.md "Paths"). */
export const LibraryFileSchema = z
	.object({
		path: z.string(),
		size: z.number(),
		sha256: z.string(),
		mediaType: z.string(),
		createdAt: z.string(),
		updatedAt: z.string(),
	})
	.meta({ id: "LibraryFile" });

/** `GET /api/libraries/{ref}/files`: the files directly under the prefix and the next-level directories. */
export const LibraryFilesResponseSchema = z
	.object({
		prefix: z.string(),
		files: z.array(LibraryFileSchema),
		directories: z.array(z.string()),
	})
	.meta({ id: "LibraryFilesResponse" });

export const LibraryFileResponseSchema = z.object({ file: LibraryFileSchema });

/** `PATCH /api/libraries/{ref}/limits`; omitted fields keep their value. */
export const LibraryLimitsPatchSchema = LibraryLimitsSchema.partial().meta({ id: "LibraryLimitsPatch" });

/** `POST /api/libraries/{ref}/move`: the source and destination paths. */
export const LibraryMoveBodySchema = z.object({
	from: z.string(),
	to: z.string(),
	overwrite: z.boolean().optional().describe("Replace an existing destination file."),
});

/** Query parameters of the library file routes. */
export const LibraryPathQuerySchema = z.object({
	path: z.string().optional().describe("The library-relative path; a leading `//` is normalized."),
});

/** Query parameters of `GET /api/libraries/{ref}/files`. */
export const LibraryPrefixQuerySchema = z.object({
	prefix: z.string().optional().describe("A directory prefix; empty lists the root."),
});

/** Query parameters of `GET /api/libraries/{ref}/file`. */
export const LibraryFileQuerySchema = LibraryPathQuerySchema.extend({
	preview: z.string().optional().describe("`1` serves a supported image inline instead of as an attachment."),
});

/** Query parameters of `PUT /api/libraries/{ref}/file`; the body is the raw file. */
export const LibraryUploadQuerySchema = LibraryPathQuerySchema.extend({
	overwrite: z.string().optional().describe("`1` replaces an existing file."),
	rename: z.string().optional().describe("`1` picks the next free name instead of replacing or refusing."),
});

/** The raw uploaded file. */
export const LibraryUploadBodySchema = BinaryBodySchema;

/** Path parameter of the library routes: `user:<username>` or `user_group:<user group name>`. */
export const LibraryRefParamSchema = z.object({ ref: z.string() });
