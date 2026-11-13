import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import type { LibraryFile, LibraryLimits, LibraryLimitsPatch } from "@crh/api";
import { Hono } from "hono";
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
import { libraryPathName, validateLibraryPath } from "../library/paths.ts";
import type { Db } from "../storage/db.ts";
import { NotFoundError, UserError } from "../util/errors.ts";
import { type AppEnv, jsonError, optionalString, readJsonObject } from "./context.ts";

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
	const app = new Hono<AppEnv>();
	const backend = (): LibraryBackend => {
		if (!options.backend) throw new UserError("this crhs has no library backend");
		return options.backend;
	};

	app.get("/libraries", async (c) => {
		const records = await listAccessibleLibraries(db, c.get("user"));
		return c.json({ libraries: records.map((record) => libraryView(record, c.get("user"))) });
	});

	app.get("/libraries/:ref", async (c) => {
		const record = await requireLibrary(db, c.get("user"), c.req.param("ref"));
		return c.json({ library: libraryView(record, c.get("user")) });
	});

	app.get("/libraries/:ref/files", async (c) => {
		const record = await requireLibrary(db, c.get("user"), c.req.param("ref"));
		const listing = await listLibraryFiles(db, record.row.id, c.req.query("prefix") ?? "");
		return c.json(listing);
	});

	app.get("/libraries/:ref/stat", async (c) => {
		const record = await requireLibrary(db, c.get("user"), c.req.param("ref"));
		const path = requiredPath(c.req.query("path"));
		const row = await findLibraryFile(db, record.row.id, path);
		if (!row) throw new NotFoundError("no such library file");
		return c.json({ file: toLibraryFile(row) });
	});

	app.get("/libraries/:ref/file", async (c) => {
		const record = await requireLibrary(db, c.get("user"), c.req.param("ref"));
		const path = requiredPath(c.req.query("path"));
		const row = await findLibraryFile(db, record.row.id, path);
		if (!row) throw new NotFoundError("no such library file");
		const inline =
			c.req.query("preview") === "1" && INLINE_MEDIA_TYPES.has(row.media_type) && row.size <= INLINE_PREVIEW_MAX_BYTES;
		const filename = libraryPathName(row.path);
		c.header("Content-Type", row.media_type === "text/plain" ? "text/plain; charset=utf-8" : row.media_type);
		c.header("Content-Length", String(row.size));
		c.header("X-Content-Type-Options", "nosniff");
		c.header("Content-Security-Policy", "sandbox");
		c.header("Content-Disposition", contentDisposition(inline ? "inline" : "attachment", filename));
		return c.body(Readable.toWeb(backend().get(row.object_key)) as unknown as ReadableStream);
	});

	app.put("/libraries/:ref/file", async (c) => {
		const record = await requireLibrary(db, c.get("user"), c.req.param("ref"));
		const path = requiredPath(c.req.query("path"));
		const overwrite = c.req.query("overwrite") === "1";
		// `rename` picks the next free `name (n)` inside the commit instead of replacing or refusing.
		const rename = c.req.query("rename") === "1";
		const existing = rename ? undefined : await findLibraryFile(db, record.row.id, path);
		const lengthHeader = c.req.header("content-length");
		if (lengthHeader !== undefined) {
			const length = Number(lengthHeader);
			if (!Number.isSafeInteger(length) || length < 0) {
				return jsonError(c, 400, "content-length must be a non-negative integer");
			}
			if (length > record.row.max_file_bytes) {
				return jsonError(c, 400, "the file is larger than the library's one-file size limit");
			}
		}
		const webBody = c.req.raw.body;
		if (!webBody) return jsonError(c, 400, "expected a request body");
		const upload = beginLibraryUpload(db, backend(), {
			library: record.row,
			path,
			overwrite,
			rename,
			createdBy: c.get("user").userId,
		});
		let file: LibraryFile;
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

	app.post("/libraries/:ref/move", async (c) => {
		const record = await requireLibrary(db, c.get("user"), c.req.param("ref"));
		const body = await readJsonObject(c);
		if (!body) return jsonError(c, 400, "expected a JSON object");
		const from = optionalString(body, "from");
		const to = optionalString(body, "to");
		if (from === undefined || to === undefined) return jsonError(c, 400, "from and to are required");
		if (body.overwrite !== undefined && typeof body.overwrite !== "boolean") {
			return jsonError(c, 400, "overwrite must be a boolean");
		}
		const file = await moveLibraryFile(db, backend(), record.row.id, from, to, body.overwrite === true);
		void c.get("audit").record({
			actor: userActor(c.get("user")),
			action: "library.file.moved",
			target: { type: "library", id: libraryRef(record.row, record.ownerName) },
			detail: {
				library: libraryRef(record.row, record.ownerName),
				from,
				to: file.path,
				size: file.size,
				sha256: file.sha256,
			},
		});
		return c.json({ file });
	});

	app.delete("/libraries/:ref/file", async (c) => {
		const record = await requireLibrary(db, c.get("user"), c.req.param("ref"));
		const path = requiredPath(c.req.query("path"));
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
		return c.json({ ok: true });
	});

	app.patch("/libraries/:ref/limits", async (c) => {
		const record = await requireLibrary(db, c.get("user"), c.req.param("ref"));
		if (!isAdmin(c.get("user"))) return jsonError(c, 403, "administrators only");
		const body = await readJsonObject(c);
		if (!body) return jsonError(c, 400, "expected a JSON object");
		const patch: LibraryLimitsPatch = {};
		for (const key of ["files", "fileBytes", "totalBytes"] as const) {
			const value = body[key];
			if (value === undefined) continue;
			if (typeof value !== "number") return jsonError(c, 400, `${key} must be a number`);
			patch[key] = value;
		}
		const oldLimits: LibraryLimits = libraryLimits(record.row);
		await updateLibraryLimits(db, record.row.id, patch);
		const updated = await findLibraryByRef(db, libraryRef(record.row, record.ownerName));
		if (!updated) return jsonError(c, 404, "no such library");
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
		return c.json({ library: libraryView(updated, c.get("user")) });
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
