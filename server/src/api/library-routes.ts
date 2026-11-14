import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import {
	BinaryBodySchema,
	ErrorResponseSchema,
	LibraryFileQuerySchema,
	LibraryFileResponseSchema,
	LibraryFilesResponseSchema,
	LibraryLimitsPatchSchema,
	LibraryListResponseSchema,
	LibraryMoveBodySchema,
	LibraryPathQuerySchema,
	LibraryPrefixQuerySchema,
	LibraryRefParamSchema,
	LibraryResponseSchema,
	LibraryUploadBodySchema,
	LibraryUploadQuerySchema,
	OkResponseSchema,
} from "@crh/api/schemas";
import { HTTPException } from "hono/http-exception";
import { userActor } from "../audit/audit.ts";
import { isAdmin } from "../auth/sessions.ts";
import type { LibraryBackend } from "../library/backend.ts";
import {
	beginLibraryUpload,
	deleteLibraryFile,
	findLibraryFile,
	listLibraryFiles,
	moveLibraryFile,
	toLibraryFile,
	updateLibraryLimits,
} from "../library/files.ts";
import {
	findLibraryByRef,
	libraryLimits,
	libraryRef,
	libraryView,
	listAccessibleLibraries,
	requireLibrary,
} from "../library/library.ts";
import { INLINE_MEDIA_TYPES, INLINE_PREVIEW_MAX_BYTES } from "../library/media-type.ts";
import { libraryPathName, validateLibraryPath, validateLibraryPrefix } from "../library/paths.ts";
import type { Db } from "../storage/db.ts";
import { NotFoundError, UserError } from "../util/errors.ts";
import { apiRouter, defineRoute, json } from "./openapi.ts";

const TAGS = ["Libraries"];

const listRoute = defineRoute({
	method: "get",
	path: "/libraries",
	tags: TAGS,
	summary: "The libraries the caller can reach, with usage and limits",
	agent: "allow",
	responses: { 200: { description: "The accessible libraries", ...json(LibraryListResponseSchema) } },
});

const getRoute = defineRoute({
	method: "get",
	path: "/libraries/{ref}",
	tags: TAGS,
	summary: "One library by owner reference",
	agent: "allow",
	request: { params: LibraryRefParamSchema },
	responses: { 200: { description: "The library", ...json(LibraryResponseSchema) } },
});

const filesRoute = defineRoute({
	method: "get",
	path: "/libraries/{ref}/files",
	tags: TAGS,
	summary: "List the files directly under a prefix and the next-level directories",
	agent: "allow",
	request: { params: LibraryRefParamSchema, query: LibraryPrefixQuerySchema },
	responses: { 200: { description: "The listing", ...json(LibraryFilesResponseSchema) } },
});

const statRoute = defineRoute({
	method: "get",
	path: "/libraries/{ref}/stat",
	tags: TAGS,
	summary: "One library file's metadata",
	agent: "allow",
	request: { params: LibraryRefParamSchema, query: LibraryPathQuerySchema },
	responses: { 200: { description: "The file", ...json(LibraryFileResponseSchema) } },
});

const fileRoute = defineRoute({
	method: "get",
	path: "/libraries/{ref}/file",
	tags: TAGS,
	summary: "Stream a library file; `preview=1` serves a supported image inline",
	agent: "allow",
	request: { params: LibraryRefParamSchema, query: LibraryFileQuerySchema },
	responses: {
		200: {
			description: "The file's bytes, with nosniff and a sandbox CSP",
			content: {
				"application/octet-stream": { schema: BinaryBodySchema },
				"image/png": { schema: BinaryBodySchema },
				"image/jpeg": { schema: BinaryBodySchema },
				"image/gif": { schema: BinaryBodySchema },
				"image/webp": { schema: BinaryBodySchema },
				"text/plain": { schema: BinaryBodySchema },
			},
		},
	},
});

const uploadRoute = defineRoute({
	method: "put",
	path: "/libraries/{ref}/file",
	tags: TAGS,
	summary: "Upload a raw file; `overwrite` replaces and `rename` picks the next free name",
	agent: "ask",
	request: {
		params: LibraryRefParamSchema,
		query: LibraryUploadQuerySchema,
		body: {
			required: true,
			content: { "application/octet-stream": { schema: LibraryUploadBodySchema } },
		},
	},
	responses: { 201: { description: "The stored file", ...json(LibraryFileResponseSchema) } },
});

const moveRoute = defineRoute({
	method: "post",
	path: "/libraries/{ref}/move",
	tags: TAGS,
	summary: "Move or rename one library file",
	agent: "ask",
	request: { params: LibraryRefParamSchema, body: { required: true, ...json(LibraryMoveBodySchema) } },
	responses: { 200: { description: "The moved file", ...json(LibraryFileResponseSchema) } },
});

const deleteRoute = defineRoute({
	method: "delete",
	path: "/libraries/{ref}/file",
	tags: TAGS,
	summary: "Delete one library file and free its quota",
	agent: "ask",
	request: { params: LibraryRefParamSchema, query: LibraryPathQuerySchema },
	responses: { 200: { description: "Deleted", ...json(OkResponseSchema) } },
});

const limitsRoute = defineRoute({
	method: "patch",
	path: "/libraries/{ref}/limits",
	tags: TAGS,
	summary: "Change a library's file-count and size limits (administrators)",
	agent: "deny", // resource limits are an administrative decision
	request: { params: LibraryRefParamSchema, body: { required: true, ...json(LibraryLimitsPatchSchema) } },
	responses: {
		200: { description: "The library with its new limits", ...json(LibraryResponseSchema) },
		403: { description: "Administrators only", ...json(ErrorResponseSchema) },
	},
});

export interface LibraryRoutesOptions {
	/** The object store; without it the metadata routes still work and file routes answer 503. */
	backend?: LibraryBackend;
}

/**
 * Libraries (doc/design/library.md "WebUI and API"): list the caller's libraries, browse and stream
 * files, upload a raw body, move and delete, and let administrators change limits. File responses
 * carry nosniff and a sandbox CSP; only the four image types are served inline, and only for a
 * preview request.
 */
export function libraryRoutes(db: Db, options: LibraryRoutesOptions = {}) {
	const app = apiRouter();
	const backend = (): LibraryBackend => {
		if (!options.backend) throw new UserError("this crhs has no library backend");
		return options.backend;
	};

	app.openapi(listRoute, async (c) => {
		const records = await listAccessibleLibraries(db, c.get("user"));
		return c.json({ libraries: records.map((record) => libraryView(record, c.get("user"))) }, 200);
	});

	app.openapi(getRoute, async (c) => {
		const { ref } = c.req.valid("param");
		const record = await requireLibrary(db, c.get("user"), ref);
		return c.json({ library: libraryView(record, c.get("user")) }, 200);
	});

	app.openapi(filesRoute, async (c) => {
		const { ref } = c.req.valid("param");
		const { prefix } = c.req.valid("query");
		const record = await requireLibrary(db, c.get("user"), ref);
		const listing = await listLibraryFiles(db, record.row.id, validateLibraryPrefix(prefix ?? ""));
		return c.json(listing, 200);
	});

	app.openapi(statRoute, async (c) => {
		const { ref } = c.req.valid("param");
		const record = await requireLibrary(db, c.get("user"), ref);
		const path = requiredPath(c.req.valid("query").path);
		const row = await findLibraryFile(db, record.row.id, path);
		if (!row) throw new NotFoundError("no such library file");
		return c.json({ file: toLibraryFile(row) }, 200);
	});

	app.openapi(fileRoute, async (c) => {
		const { ref } = c.req.valid("param");
		const query = c.req.valid("query");
		const record = await requireLibrary(db, c.get("user"), ref);
		const path = requiredPath(query.path);
		const row = await findLibraryFile(db, record.row.id, path);
		if (!row) throw new NotFoundError("no such library file");
		const inline =
			query.preview === "1" && INLINE_MEDIA_TYPES.has(row.media_type) && row.size <= INLINE_PREVIEW_MAX_BYTES;
		const filename = libraryPathName(row.path);
		c.header("Content-Type", row.media_type === "text/plain" ? "text/plain; charset=utf-8" : row.media_type);
		c.header("Content-Length", String(row.size));
		c.header("X-Content-Type-Options", "nosniff");
		c.header("Content-Security-Policy", "sandbox");
		c.header("Content-Disposition", contentDisposition(inline ? "inline" : "attachment", filename));
		return c.body(Readable.toWeb(backend().get(row.object_key)) as unknown as ReadableStream);
	});

	app.openapi(uploadRoute, async (c) => {
		const { ref } = c.req.valid("param");
		const query = c.req.valid("query");
		const record = await requireLibrary(db, c.get("user"), ref);
		const path = requiredPath(query.path);
		const overwrite = query.overwrite === "1";
		// `rename` picks the next free `name (n)` inside the commit instead of replacing or refusing.
		const rename = query.rename === "1";
		const existing = rename ? undefined : await findLibraryFile(db, record.row.id, path);
		const lengthHeader = c.req.header("content-length");
		if (lengthHeader !== undefined) {
			const length = Number(lengthHeader);
			if (!Number.isSafeInteger(length) || length < 0) {
				throw new UserError("content-length must be a non-negative integer");
			}
			if (length > record.row.max_file_bytes) {
				throw new UserError("the file is larger than the library's one-file size limit");
			}
		}
		const webBody = c.req.raw.body;
		if (!webBody) throw new UserError("expected a request body");
		const upload = beginLibraryUpload(db, backend(), {
			library: record.row,
			path,
			overwrite,
			rename,
			createdBy: c.get("user").userId,
		});
		let file: ReturnType<typeof toLibraryFile>;
		try {
			for await (const chunk of Readable.fromWeb(webBody as WebReadableStream<Uint8Array>)) {
				await upload.write(chunk as Uint8Array);
			}
			await upload.finish();
			file = (await upload.commit()).file;
		} catch (err) {
			await upload.discard();
			throw err;
		}
		void c.get("audit").record({
			actor: userActor(c.get("user")),
			action: existing ? "library.file.overwritten" : "library.file.uploaded",
			target: { type: "library", id: libraryRef(record.row, record.ownerName) },
			detail: {
				library: libraryRef(record.row, record.ownerName),
				path: file.path,
				size: file.size,
				sha256: file.sha256,
			},
		});
		return c.json({ file }, 201);
	});

	app.openapi(moveRoute, async (c) => {
		const { ref } = c.req.valid("param");
		const body = c.req.valid("json");
		const record = await requireLibrary(db, c.get("user"), ref);
		const fromPath = validateLibraryPath(body.from);
		const toPath = validateLibraryPath(body.to);
		const file = await moveLibraryFile(db, backend(), record.row.id, fromPath, toPath, body.overwrite === true);
		void c.get("audit").record({
			actor: userActor(c.get("user")),
			action: "library.file.moved",
			target: { type: "library", id: libraryRef(record.row, record.ownerName) },
			detail: {
				library: libraryRef(record.row, record.ownerName),
				from: fromPath,
				to: file.path,
				size: file.size,
				sha256: file.sha256,
			},
		});
		return c.json({ file }, 200);
	});

	app.openapi(deleteRoute, async (c) => {
		const { ref } = c.req.valid("param");
		const record = await requireLibrary(db, c.get("user"), ref);
		const path = requiredPath(c.req.valid("query").path);
		const file = await deleteLibraryFile(db, backend(), record.row.id, path);
		void c.get("audit").record({
			actor: userActor(c.get("user")),
			action: "library.file.deleted",
			target: { type: "library", id: libraryRef(record.row, record.ownerName) },
			detail: {
				library: libraryRef(record.row, record.ownerName),
				path: file.path,
				size: file.size,
				sha256: file.sha256,
			},
		});
		return c.json({ ok: true as const }, 200);
	});

	app.openapi(limitsRoute, async (c) => {
		const { ref } = c.req.valid("param");
		const record = await requireLibrary(db, c.get("user"), ref);
		if (!isAdmin(c.get("user"))) throw new HTTPException(403, { message: "administrators only" });
		const body = c.req.valid("json");
		const patch: { files?: number; fileBytes?: number; totalBytes?: number } = {};
		for (const key of ["files", "fileBytes", "totalBytes"] as const) {
			const value = body[key];
			if (value === undefined) continue;
			patch[key] = value;
		}
		const oldLimits = libraryLimits(record.row);
		await updateLibraryLimits(db, record.row.id, patch);
		const updated = await findLibraryByRef(db, libraryRef(record.row, record.ownerName));
		if (!updated) throw new NotFoundError("no such library");
		void c.get("audit").record({
			actor: userActor(c.get("user")),
			action: "library.limits_changed",
			target: { type: "library", id: libraryRef(updated.row, updated.ownerName) },
			detail: {
				library: libraryRef(updated.row, updated.ownerName),
				old: oldLimits,
				new: libraryLimits(updated.row),
			},
		});
		return c.json({ library: libraryView(updated, c.get("user")) }, 200);
	});

	return app;
}

function requiredPath(value: string | undefined): string {
	if (value === undefined) throw new UserError("path is required");
	return validateLibraryPath(value);
}

/** `inline`/`attachment` with an ASCII fallback and the UTF-8 form for other file names. */
function contentDisposition(kind: "inline" | "attachment", filename: string): string {
	const fallback = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
	const encoded = encodeURIComponent(filename).replace(
		/['()*]/g,
		(char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
	);
	return `${kind}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
