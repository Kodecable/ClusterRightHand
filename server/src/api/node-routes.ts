import { Readable } from "node:stream";
import {
	BinaryBodySchema,
	EnrollmentTokenBodySchema,
	EnrollmentTokenResponseSchema,
	ErrorResponseSchema,
	IdParamSchema,
	NodeDetailResponseSchema,
	NodeFileQuerySchema,
	NodeFileResponseSchema,
	NodeFilesQuerySchema,
	NodeFilesResponseSchema,
	NodeGroupsBodySchema,
	NodeGroupsResponseSchema,
	NodeListQuerySchema,
	NodeListResponseSchema,
	NodeRenameBodySchema,
	NodeResponseSchema,
	NodeStatQuerySchema,
	NodeTrustResponseSchema,
	OkResponseSchema,
} from "@crh/api/schemas";
import type { Context, MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { userActor } from "../audit/audit.ts";
import { isAdmin } from "../auth/sessions.ts";
import { type TaskView, TERMINAL } from "../cluster/cluster.ts";
import { createEnrollmentToken } from "../cluster/enrollment.ts";
import { nodeGroupsForNodes, resolveNodeGroupIds, setNodeGroupsForNode } from "../cluster/node-groups.ts";
import {
	approveNode,
	deleteNode,
	getNode,
	nodeAccess,
	nodeClockWarning,
	type PublicNode,
	queryNodesForUser,
	renameNode,
	toPublicNode,
} from "../cluster/nodes.ts";
import { sshNodeDetails } from "../cluster/ssh/nodes.ts";
import { trustView } from "../cluster/trust.ts";
import { trustWarningsForRows } from "../cluster/trust-warnings.ts";
import { findUserLibrary } from "../library/library.ts";
import { INLINE_MEDIA_TYPES, INLINE_PREVIEW_MAX_BYTES, sniffMagic } from "../library/media-type.ts";
import { openTransferLocation, type TransferContext, type TransferLocationJson } from "../library/transfer-location.ts";
import type { Db } from "../storage/db.ts";
import { NotFoundError, UserError } from "../util/errors.ts";
import type { AppOptions } from "./app.ts";
import type { AppEnv } from "./context.ts";
import { requireAdmin } from "./middleware.ts";
import { apiRouter, defineRoute, json } from "./openapi.ts";

const TAGS = ["Nodes"];

const listRoute = defineRoute({
	method: "get",
	path: "/nodes",
	tags: TAGS,
	summary: "List the nodes the caller can see, with their live connection state",
	agent: "allow",
	request: { query: NodeListQuerySchema },
	responses: { 200: { description: "The nodes", ...json(NodeListResponseSchema) } },
});

const detailRoute = defineRoute({
	method: "get",
	path: "/nodes/{id}",
	tags: TAGS,
	summary: "One node, its trust warnings and, for administrators, its SSH route",
	agent: "allow",
	request: { params: IdParamSchema },
	responses: { 200: { description: "The node", ...json(NodeDetailResponseSchema) } },
});

const trustRoute = defineRoute({
	method: "get",
	path: "/nodes/{id}/trust",
	tags: TAGS,
	summary: "The node's last trust report, its digest and its entries",
	agent: "allow",
	request: { params: IdParamSchema },
	responses: { 200: { description: "The trust panel", ...json(NodeTrustResponseSchema) } },
});

const filesRoute = defineRoute({
	method: "get",
	path: "/nodes/{id}/files",
	tags: TAGS,
	summary: "List a directory on a node; the listing is an unprivileged `file.list` browse task",
	agent: "ask",
	request: { params: IdParamSchema, query: NodeFilesQuerySchema },
	responses: {
		200: { description: "The entries under the path", ...json(NodeFilesResponseSchema) },
		403: { description: "The node denied the listing", ...json(ErrorResponseSchema) },
		503: { description: "The cluster is not running", ...json(ErrorResponseSchema) },
	},
});

const statRoute = defineRoute({
	method: "get",
	path: "/nodes/{id}/stat",
	tags: TAGS,
	summary: "Stat one path on a node; an unprivileged `file.stat` browse task",
	agent: "ask",
	request: { params: IdParamSchema, query: NodeStatQuerySchema },
	responses: {
		200: { description: "The file's metadata", ...json(NodeFileResponseSchema) },
		403: { description: "The node denied the stat", ...json(ErrorResponseSchema) },
		503: { description: "The cluster is not running", ...json(ErrorResponseSchema) },
	},
});

const fileRoute = defineRoute({
	method: "get",
	path: "/nodes/{id}/file",
	tags: TAGS,
	summary: "Stream a node file as an attachment, or inline when `preview=1` and it is a supported image",
	agent: "deny", // arbitrary file content: not something an agent may pull without the user
	request: { params: IdParamSchema, query: NodeFileQuerySchema },
	responses: {
		200: {
			description: "The file's bytes",
			content: {
				"application/octet-stream": { schema: BinaryBodySchema },
				"image/png": { schema: BinaryBodySchema },
				"image/jpeg": { schema: BinaryBodySchema },
				"image/gif": { schema: BinaryBodySchema },
				"image/webp": { schema: BinaryBodySchema },
			},
		},
		403: { description: "The node denied the download", ...json(ErrorResponseSchema) },
		409: {
			description: "The file pull needs approval; the message carries the approval link",
			...json(ErrorResponseSchema),
		},
		503: { description: "The cluster is not running", ...json(ErrorResponseSchema) },
	},
});

const enrollmentTokenRoute = defineRoute({
	method: "post",
	path: "/enrollment-tokens",
	tags: TAGS,
	summary: "Issue a one-time enrollment token for a new node (administrators)",
	agent: "deny", // a token enrolls a node: it grants infrastructure access
	middleware: [requireAdmin],
	request: { body: { required: true, ...json(EnrollmentTokenBodySchema) } },
	responses: {
		201: { description: "The token and its expiry", ...json(EnrollmentTokenResponseSchema) },
		403: { description: "Administrators only", ...json(ErrorResponseSchema) },
		500: { description: "No server fingerprint is configured", ...json(ErrorResponseSchema) },
	},
});

const reenrollRoute = defineRoute({
	method: "post",
	path: "/nodes/{id}/reenroll",
	tags: TAGS,
	summary: "Issue a one-time token that replaces this node's key (administrators)",
	agent: "deny", // replaces a node's identity
	request: { params: IdParamSchema },
	responses: {
		201: { description: "The token and its expiry", ...json(EnrollmentTokenResponseSchema) },
		403: { description: "Administrators only", ...json(ErrorResponseSchema) },
		500: { description: "No server fingerprint is configured", ...json(ErrorResponseSchema) },
	},
});

const approveRoute = defineRoute({
	method: "post",
	path: "/nodes/{id}/approve",
	tags: TAGS,
	summary: "Approve a pending node so it becomes active (administrators)",
	agent: "deny", // an approval decision
	request: { params: IdParamSchema },
	responses: {
		200: { description: "The approved node", ...json(NodeResponseSchema) },
		403: { description: "Administrators only", ...json(ErrorResponseSchema) },
		409: { description: "The node is not pending", ...json(ErrorResponseSchema) },
	},
});

const deleteRoute = defineRoute({
	method: "delete",
	path: "/nodes/{id}",
	tags: TAGS,
	summary: "Delete a node, its grants and its enrollment token; its waiting tasks end (administrators)",
	agent: "ask",
	request: { params: IdParamSchema },
	responses: {
		200: { description: "Deleted", ...json(OkResponseSchema) },
		403: { description: "Administrators only", ...json(ErrorResponseSchema) },
	},
});

/** Expects requireUser to have run. */
export function nodeRoutes(db: Db, options: AppOptions = {}) {
	const app = apiRouter();

	/** The caller's access to the node, or undefined when the node is hidden from them. */
	const access = (c: { get(k: "user"): AppEnv["Variables"]["user"] }, id: string) => nodeAccess(db, c.get("user"), id);
	const clockWarnMs = () => options.settings?.current().clockWarnMs ?? options.clockWarnMs ?? 60_000;
	const crhsFingerprints =
		options.signingKeys?.fingerprints ?? (options.authorizationKey ? [options.authorizationKey.fingerprint] : []);

	/** Fills in what only the live server knows: the connection state and the clock warning. */
	const live = (n: PublicNode): PublicNode => ({
		...n,
		connected: n.connected === null ? null : (options.cluster?.isConnected(n.id) ?? false),
		clockWarning: nodeClockWarning(n.facts, clockWarnMs()),
	});

	const clusterUnavailable = () => new HTTPException(503, { message: "the cluster is not running" });

	/** Hidden nodes answer 404 and other members 403 before a body is read, like every node management route. */
	const requireManager: MiddlewareHandler<AppEnv> = async (c, next) => {
		const level = await access(c, c.req.param("id") ?? "");
		if (!level) return c.json({ error: "no such node" }, 404);
		if (!isAdmin(c.get("user"))) return c.json({ error: "administrators only" }, 403);
		await next();
	};

	const renameRoute = defineRoute({
		method: "patch",
		path: "/nodes/{id}",
		tags: TAGS,
		summary: "Rename a node (administrators)",
		agent: "ask",
		middleware: [requireManager],
		request: { params: IdParamSchema, body: { required: true, ...json(NodeRenameBodySchema) } },
		responses: {
			200: { description: "The renamed node", ...json(NodeResponseSchema) },
			403: { description: "Administrators only", ...json(ErrorResponseSchema) },
		},
	});

	const nodeGroupsRoute = defineRoute({
		method: "put",
		path: "/nodes/{id}/node-groups",
		tags: TAGS,
		summary: "Replace a node's node groups; calls resolve names or ids (administrators)",
		agent: "deny", // group membership widens who can reach the node
		middleware: [requireManager],
		request: { params: IdParamSchema, body: { required: true, ...json(NodeGroupsBodySchema) } },
		responses: {
			200: { description: "The node's new node groups", ...json(NodeGroupsResponseSchema) },
			403: { description: "Administrators only", ...json(ErrorResponseSchema) },
		},
	});

	app.openapi(listRoute, async (c) => {
		const params = c.req.valid("query");
		const page = await queryNodesForUser(db, c.get("user"), params, { crhsFingerprints });
		return c.json(
			{
				nodes: page.items.map(live),
				...(params.limit === undefined ? {} : { more: page.more }),
			},
			200,
		);
	});

	app.openapi(detailRoute, async (c) => {
		const { id } = c.req.valid("param");
		const level = await access(c, id);
		const row = level ? await getNode(db, id) : undefined;
		if (!level || !row) throw new NotFoundError("no such node");
		const nodeGroups = (await nodeGroupsForNodes(db, [id])).get(id) ?? [];
		const trustWarnings =
			(await trustWarningsForRows(db, [row], new Map([[id, nodeGroups]]), { crhsFingerprints })).get(id) ?? [];
		const node = live(toPublicNode(row, level, nodeGroups, trustWarnings));
		if (!isAdmin(c.get("user"))) return c.json({ node }, 200);
		return c.json({ node, ssh: (await sshNodeDetails(db, row)) ?? null }, 200);
	});

	/** The node's trust panel (doc/design/privilege.md "Trust cache"): the last TrustReport, its digest and its entries. */
	app.openapi(trustRoute, async (c) => {
		const { id } = c.req.valid("param");
		const level = await access(c, id);
		const row = level ? await getNode(db, id) : undefined;
		if (!level || !row) throw new NotFoundError("no such node");
		return c.json({ trust: trustView(row, options.cluster?.trustFresh(id) ?? false) }, 200);
	});

	/**
	 * A node's file manager (doc/design/webui.md "Node pages"): each listing and stat is a `file.list` or
	 * `file.stat` task with purpose `browse`, created and waited for here, as the signed-in user and
	 * unprivileged. The ordinary task list leaves those tasks out.
	 */
	const browseActor = (c: { get(k: "user"): AppEnv["Variables"]["user"] }) => {
		const user = c.get("user");
		return { type: "user" as const, id: user.userId, onBehalfOfUserId: user.userId };
	};

	const waitForBrowse = async (
		c: Context<AppEnv>,
		taskId: string,
		wait: { stopAtApproval?: boolean } = {},
	): Promise<TaskView | undefined> => {
		const signal = c.req.raw.signal;
		let task = await options.cluster?.getTask(taskId);
		while (task && !TERMINAL.has(task.state) && !options.cluster?.waitsEnded) {
			// A download cannot wait minutes for a decision: hand the approval link back instead.
			if (wait.stopAtApproval === true && task.state === "awaiting_approval") return task;
			if (signal.aborted) {
				await options.cluster?.cancelTask(taskId, "the file browser request ended", browseActor(c));
				return options.cluster?.getTask(taskId);
			}
			task = (await options.cluster?.waitTask(taskId, 5 * 60 * 1000, signal)) ?? task;
		}
		return task;
	};

	/** Throws the browse task's failure as the API's usual error; returns the successful task. */
	const browsed = (task: TaskView | undefined): TaskView => {
		if (!task) throw new NotFoundError("no such node");
		if (task.errorCode === "not_found") throw new NotFoundError(task.errorMessage ?? "no such file");
		if (task.errorCode === "permission_denied") {
			throw new HTTPException(403, { message: task.errorMessage ?? "permission denied" });
		}
		if (task.state !== "exited" || task.result === null) {
			throw new UserError(task.errorMessage ?? `the listing failed (${task.state})`);
		}
		return task;
	};

	const browsePath = (value: string | undefined, fallback = "/"): string => {
		if (value === undefined || value === "") return fallback;
		if (!value.startsWith("/")) throw new UserError("path must be absolute");
		return value;
	};

	app.openapi(filesRoute, async (c) => {
		const { id: nodeId } = c.req.valid("param");
		const params = c.req.valid("query");
		if (!(await access(c, nodeId))) throw new NotFoundError("no such node");
		if (!options.cluster) throw clusterUnavailable();
		const path = browsePath(params.path);
		const task = await options.cluster.createTask({
			nodeId,
			spec: { kind: "file.list", path, limit: 0 },
			actor: browseActor(c),
			purpose: "browse",
		});
		const done = browsed(await waitForBrowse(c, task.id));
		const result = done.result;
		if (result?.kind !== "file.list") throw new UserError("the node reported no listing");
		const entries = result.entries.map((entry) => ({
			path: path === "/" ? `/${entry.name}` : `${path}/${entry.name}`,
			name: entry.name,
			type: entry.type,
			size: entry.size,
			mtime: entry.mtime,
			linkTarget: null,
		}));
		return c.json({ path, entries, truncated: result.truncated }, 200);
	});

	app.openapi(statRoute, async (c) => {
		const { id: nodeId } = c.req.valid("param");
		const params = c.req.valid("query");
		if (!(await access(c, nodeId))) throw new NotFoundError("no such node");
		if (!options.cluster) throw clusterUnavailable();
		const path = browsePath(params.path, "");
		if (path === "") throw new UserError("path is required");
		const task = await options.cluster.createTask({
			nodeId,
			spec: { kind: "file.stat", path },
			actor: browseActor(c),
			purpose: "browse",
		});
		const done = browsed(await waitForBrowse(c, task.id));
		const result = done.result;
		if (result?.kind !== "file.stat") throw new UserError("the node reported no file");
		const file = {
			path: result.path,
			type: result.type,
			size: result.size,
			mode: Number.parseInt(result.mode, 8),
			uid: result.uid,
			gid: result.gid,
			owner: result.owner,
			group: result.group,
			mtime: result.mtime,
			linkTarget: result.linkTarget,
		};
		return c.json({ file }, 200);
	});

	/**
	 * A node file for the browser (doc/design/webui.md "Node pages"): `preview=1` streams an image inline,
	 * after checking the sniffed type and size; without it the file streams as an attachment. Both are one
	 * `file.pull` with purpose `browse` into staging, as the signed-in user and unprivileged, so rules,
	 * approvals and audit apply; a download is capped at the user's own library one-file limit.
	 */
	app.openapi(fileRoute, async (c) => {
		const { id: nodeId } = c.req.valid("param");
		const params = c.req.valid("query");
		if (!(await access(c, nodeId))) throw new NotFoundError("no such node");
		if (!options.cluster) throw clusterUnavailable();
		const preview = params.preview === "1";
		const path = browsePath(params.path, "");
		if (path === "") throw new UserError("path is required");
		const own = await findUserLibrary(db, c.get("user").userId);
		if (!own) throw new UserError("the acting user has no library");
		const location = options.cluster.stagingLocation();
		const task = await options.cluster.pullFile({
			nodeId,
			path,
			maxBytes: preview ? INLINE_PREVIEW_MAX_BYTES : own.row.max_file_bytes,
			location,
			actor: browseActor(c),
			purpose: "browse",
		});
		const done = await waitForBrowse(c, task.id, { stopAtApproval: !preview });
		if (done?.state === "awaiting_approval") {
			await options.cluster.cancelTask(task.id, "the file browser request ended", browseActor(c));
			await discardLocation(options.cluster.transferContext(), location);
			throw new HTTPException(409, {
				message: `the file pull needs approval; approve it at /approvals/tasks/${task.id}`,
			});
		}
		let pulled: TaskView;
		try {
			pulled = browsed(done);
		} catch (err) {
			await discardLocation(options.cluster.transferContext(), location);
			throw err;
		}
		const result = pulled.result;
		if (result?.kind !== "file.pull") {
			await discardLocation(options.cluster.transferContext(), location);
			throw new UserError("the node reported no file");
		}
		const opened = openTransferLocation(options.cluster.transferContext(), location);
		const stream = opened.openRead();
		const name = path.slice(path.lastIndexOf("/") + 1);
		if (!preview) {
			c.header("Content-Length", String(result.size));
			c.header("X-Content-Type-Options", "nosniff");
			c.header("Content-Security-Policy", "sandbox");
			c.header("Content-Type", "application/octet-stream");
			c.header("Content-Disposition", contentDisposition("attachment", name));
			const body = Readable.from(
				(async function* () {
					try {
						for await (const chunk of stream) yield chunk as Uint8Array;
					} finally {
						await opened.discard();
					}
				})(),
			);
			return c.body(Readable.toWeb(body) as unknown as ReadableStream);
		}
		const iterator = stream[Symbol.asyncIterator]();
		let first: IteratorResult<unknown>;
		try {
			first = await iterator.next();
		} catch (err) {
			stream.destroy();
			await opened.discard();
			throw err;
		}
		const head = first.done ? Buffer.alloc(0) : Buffer.from(first.value as Uint8Array);
		const mime = sniffMagic(head.subarray(0, 16));
		if (mime === undefined || !INLINE_MEDIA_TYPES.has(mime) || result.size > INLINE_PREVIEW_MAX_BYTES) {
			stream.destroy();
			await opened.discard();
			throw new UserError("only PNG, JPEG, GIF and WebP images up to 20 MiB can be previewed");
		}
		// Only a preview that passed the sniff is an image: headers set before the check would ride
		// along on the JSON refusal with the file's Content-Length.
		c.header("Content-Length", String(result.size));
		c.header("X-Content-Type-Options", "nosniff");
		c.header("Content-Security-Policy", "sandbox");
		c.header("Content-Type", mime);
		c.header("Content-Disposition", contentDisposition("inline", name));
		const body = Readable.from(
			(async function* () {
				try {
					if (!first.done) yield head;
					for (;;) {
						const next = await iterator.next();
						if (next.done) break;
						yield next.value as Uint8Array;
					}
				} finally {
					await opened.discard();
				}
			})(),
		);
		return c.body(Readable.toWeb(body) as unknown as ReadableStream);
	});

	app.openapi(enrollmentTokenRoute, async (c) => {
		if (!options.serverFingerprint) {
			throw new HTTPException(500, { message: "server fingerprint is not configured" });
		}
		const { nameHint } = c.req.valid("json");
		const created = await createEnrollmentToken(db, {
			userId: c.get("user").userId,
			nameHint,
			serverFingerprint: options.serverFingerprint,
		});
		void c.get("audit").record({
			actor: userActor(c.get("user")),
			action: "enrollment_token.created",
			target: { type: "enrollment_token", id: created.id },
			detail: { name_hint: nameHint, expires_at: created.expiresAt },
		});
		return c.json({ token: created.token, expiresAt: created.expiresAt }, 201);
	});

	/** Resolves the node for a manage-only route: 404 when hidden, 403 for a non-administrator. */
	const manageable = async (c: Parameters<typeof access>[0], id: string) => {
		const level = await access(c, id);
		if (!level) throw new NotFoundError("no such node");
		if (!isAdmin(c.get("user"))) throw new HTTPException(403, { message: "administrators only" });
		return level;
	};

	/**
	 * A one-time token that replaces this crha node's key instead of creating a node
	 * (doc/design/protocol.md "Rotation and revocation"). The node keeps its id, name, node groups,
	 * access grants and task history; it becomes pending again until the new key is approved.
	 */
	app.openapi(reenrollRoute, async (c) => {
		const { id } = c.req.valid("param");
		await manageable(c, id);
		const row = await getNode(db, id);
		if (!row) throw new NotFoundError("no such node");
		if (row.transport === "ssh") throw new UserError("SSH nodes cannot be re-enrolled");
		if (!options.serverFingerprint) {
			throw new HTTPException(500, { message: "server fingerprint is not configured" });
		}
		const created = await createEnrollmentToken(db, {
			userId: c.get("user").userId,
			boundNodeId: id,
			serverFingerprint: options.serverFingerprint,
		});
		void c.get("audit").record({
			actor: userActor(c.get("user")),
			action: "enrollment_token.created",
			target: { type: "enrollment_token", id: created.id },
			detail: { node_id: id, node_name: row.name, expires_at: created.expiresAt },
		});
		return c.json({ token: created.token, expiresAt: created.expiresAt }, 201);
	});

	app.openapi(approveRoute, async (c) => {
		const { id } = c.req.valid("param");
		const level = await manageable(c, id);
		const row = await getNode(db, id);
		if (row?.status !== "pending") throw new HTTPException(409, { message: "node is not pending" });
		const node = await approveNode(db, id, c.get("user").userId);
		// The pending connection only carried facts; tell crha, then let it reconnect as an active node.
		options.cluster?.notifyNodeStatus(id, "active", "approved");
		void c.get("audit").record({
			actor: userActor(c.get("user")),
			action: "node.approved",
			target: { type: "node", id },
			detail: { name: node.name },
		});
		return c.json({ node: toPublicNode(node, level, (await nodeGroupsForNodes(db, [id])).get(id) ?? []) }, 200);
	});

	app.openapi(renameRoute, async (c) => {
		const { id } = c.req.valid("param");
		const level = await manageable(c, id);
		const { name } = c.req.valid("json");
		if (!name) throw new UserError("name is required");
		const before = await getNode(db, id);
		const node = await renameNode(db, id, name);
		void c.get("audit").record({
			actor: userActor(c.get("user")),
			action: "node.renamed",
			target: { type: "node", id },
			detail: { old_name: before?.name, new_name: node.name },
		});
		return c.json({ node: live(toPublicNode(node, level, (await nodeGroupsForNodes(db, [id])).get(id) ?? [])) }, 200);
	});

	/** Replaces a node's node groups; administrators only, for crha and SSH nodes alike. */
	app.openapi(nodeGroupsRoute, async (c) => {
		const { id } = c.req.valid("param");
		await manageable(c, id);
		const row = await getNode(db, id);
		if (!row) throw new NotFoundError("no such node");
		const { nodeGroups } = c.req.valid("json");
		const nodeGroupIds = await resolveNodeGroupIds(db, row.org_id, nodeGroups);
		const current = await setNodeGroupsForNode(db, id, nodeGroupIds);
		void c.get("audit").record({
			actor: userActor(c.get("user")),
			action: "node.node_groups_changed",
			target: { type: "node", id },
			detail: { node_group_ids: nodeGroupIds, node_groups: current.map((nodeGroup) => nodeGroup.name) },
		});
		return c.json({ nodeGroups: current }, 200);
	});

	app.openapi(deleteRoute, async (c) => {
		const { id } = c.req.valid("param");
		await manageable(c, id);
		const before = await getNode(db, id);
		await deleteNode(db, id);
		// tasks.node_id has no foreign key: a waiting task would survive its node and could never dispatch.
		await options.cluster?.endNodeTasks(id);
		void c.get("audit").record({
			actor: userActor(c.get("user")),
			action: "node.deleted",
			target: { type: "node", id },
			detail: { name: before?.name, was_pending: before?.status === "pending", rejected: before?.status === "pending" },
		});
		// Deleting a pending node rejects its enrollment; deleting an active node disconnects it. Both get
		// node.status{rejected} first, which tells crha to stop and not reconnect.
		options.cluster?.notifyNodeStatus(id, "rejected", "node deleted");
		return c.json({ ok: true as const }, 200);
	});

	return app;
}

async function discardLocation(context: TransferContext, location: TransferLocationJson): Promise<void> {
	await openTransferLocation(context, location).discard();
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
