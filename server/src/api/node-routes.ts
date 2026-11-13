import { Readable } from "node:stream";
import type { NodeFileInfo, NodeFilesResponse } from "@crh/api";
import { type Context, Hono } from "hono";
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
import { INLINE_MEDIA_TYPES, INLINE_PREVIEW_MAX_BYTES, sniffMagic } from "../library/media-type.ts";
import { openTransferLocation, type TransferContext, type TransferLocationJson } from "../library/transfer-location.ts";
import type { Db } from "../storage/db.ts";
import { UserError } from "../util/errors.ts";
import type { AppOptions } from "./app.ts";
import { type AppEnv, jsonError, optionalString, readJsonObject } from "./context.ts";
import { requireAdmin } from "./middleware.ts";

/** Expects requireUser to have run. */
export function nodeRoutes(db: Db, options: AppOptions = {}) {
	const app = new Hono<AppEnv>();

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

	app.get("/nodes", async (c) => {
		const params = {
			q: c.req.query("q"),
			limit: c.req.query("limit"),
			ids: c.req.query("ids"),
		};
		const page = await queryNodesForUser(db, c.get("user"), params, { crhsFingerprints });
		return c.json({
			nodes: page.items.map(live),
			...(params.limit === undefined ? {} : { more: page.more }),
		});
	});

	app.get("/nodes/:id", async (c) => {
		const id = c.req.param("id");
		const level = await access(c, id);
		const row = level ? await getNode(db, id) : undefined;
		if (!level || !row) return jsonError(c, 404, "no such node");
		const nodeGroups = (await nodeGroupsForNodes(db, [id])).get(id) ?? [];
		const trustWarnings =
			(await trustWarningsForRows(db, [row], new Map([[id, nodeGroups]]), { crhsFingerprints })).get(id) ?? [];
		const node = live(toPublicNode(row, level, nodeGroups, trustWarnings));
		if (!isAdmin(c.get("user"))) return c.json({ node });
		return c.json({ node, ssh: (await sshNodeDetails(db, row)) ?? null });
	});

	/** The node's trust panel (doc/design/privilege.md "Trust cache"): the last TrustReport, its digest and its entries. */
	app.get("/nodes/:id/trust", async (c) => {
		const id = c.req.param("id");
		const level = await access(c, id);
		const row = level ? await getNode(db, id) : undefined;
		if (!level || !row) return jsonError(c, 404, "no such node");
		return c.json({ trust: trustView(row, options.cluster?.trustFresh(id) ?? false) });
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

	const waitForBrowse = async (c: Context<AppEnv>, taskId: string): Promise<TaskView | undefined> => {
		const signal = c.req.raw.signal;
		let task = await options.cluster?.getTask(taskId);
		while (task && !TERMINAL.has(task.state) && !options.cluster?.waitsEnded) {
			if (signal.aborted) {
				await options.cluster?.cancelTask(taskId, "the file browser request ended", browseActor(c));
				return options.cluster?.getTask(taskId);
			}
			task = (await options.cluster?.waitTask(taskId, 5 * 60 * 1000, signal)) ?? task;
		}
		return task;
	};

	/** The browse task's failure as an HTTP response; undefined when it succeeded. */
	const browseFailure = (c: Parameters<typeof jsonError>[0], task: TaskView | undefined) => {
		if (!task) return jsonError(c, 404, "no such node");
		if (task.errorCode === "not_found") return jsonError(c, 404, task.errorMessage ?? "no such file");
		if (task.errorCode === "permission_denied") return jsonError(c, 403, task.errorMessage ?? "permission denied");
		if (task.state !== "exited" || task.result === null) {
			return jsonError(c, 400, task.errorMessage ?? `the listing failed (${task.state})`);
		}
		return undefined;
	};

	const browsePath = (value: string | undefined, fallback = "/"): string => {
		if (value === undefined || value === "") return fallback;
		if (!value.startsWith("/")) throw new UserError("path must be absolute");
		return value;
	};

	app.get("/nodes/:id/files", async (c) => {
		const nodeId = c.req.param("id");
		if (!(await access(c, nodeId))) return jsonError(c, 404, "no such node");
		if (!options.cluster) return jsonError(c, 503, "the cluster is not running");
		const path = browsePath(c.req.query("path"));
		const task = await options.cluster.createTask({
			nodeId,
			spec: { kind: "file.list", path, limit: 0 },
			actor: browseActor(c),
			purpose: "browse",
		});
		const done = await waitForBrowse(c, task.id);
		const failure = browseFailure(c, done);
		if (failure) return failure;
		const result = done?.result;
		if (result?.kind !== "file.list") return jsonError(c, 400, "the node reported no listing");
		const entries = result.entries.map((entry) => ({
			path: path === "/" ? `/${entry.name}` : `${path}/${entry.name}`,
			name: entry.name,
			type: entry.type,
			size: entry.size,
			mtime: entry.mtime,
			linkTarget: null,
		}));
		const body: NodeFilesResponse = { path, entries, truncated: result.truncated };
		return c.json(body);
	});

	app.get("/nodes/:id/stat", async (c) => {
		const nodeId = c.req.param("id");
		if (!(await access(c, nodeId))) return jsonError(c, 404, "no such node");
		if (!options.cluster) return jsonError(c, 503, "the cluster is not running");
		const path = browsePath(c.req.query("path"), "");
		if (path === "") throw new UserError("path is required");
		const task = await options.cluster.createTask({
			nodeId,
			spec: { kind: "file.stat", path },
			actor: browseActor(c),
			purpose: "browse",
		});
		const done = await waitForBrowse(c, task.id);
		const failure = browseFailure(c, done);
		if (failure) return failure;
		const result = done?.result;
		if (result?.kind !== "file.stat") return jsonError(c, 400, "the node reported no file");
		const file: NodeFileInfo = {
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
		return c.json({ file });
	});

	/**
	 * A node file's image preview: one `file.pull` with purpose `browse` into staging, then a check of the
	 * sniffed type and size before the bytes stream with the same safe headers as a library preview.
	 */
	app.get("/nodes/:id/file", async (c) => {
		const nodeId = c.req.param("id");
		if (!(await access(c, nodeId))) return jsonError(c, 404, "no such node");
		if (!options.cluster) return jsonError(c, 503, "the cluster is not running");
		if (c.req.query("preview") !== "1") throw new UserError("preview=1 is required");
		const path = browsePath(c.req.query("path"), "");
		if (path === "") throw new UserError("path is required");
		const location = options.cluster.stagingLocation();
		const task = await options.cluster.pullFile({
			nodeId,
			path,
			maxBytes: INLINE_PREVIEW_MAX_BYTES,
			location,
			actor: browseActor(c),
			purpose: "browse",
		});
		const done = await waitForBrowse(c, task.id);
		const failure = browseFailure(c, done);
		if (failure) {
			await discardLocation(options.cluster.transferContext(), location);
			return failure;
		}
		const result = done?.result;
		if (result?.kind !== "file.pull") {
			await discardLocation(options.cluster.transferContext(), location);
			return jsonError(c, 400, "the node reported no file");
		}
		const opened = openTransferLocation(options.cluster.transferContext(), location);
		const stream = opened.openRead();
		const iterator = stream[Symbol.asyncIterator]();
		let head: Buffer;
		const first = await iterator.next();
		head = first.done ? Buffer.alloc(0) : Buffer.from(first.value as Uint8Array);
		const mime = sniffMagic(head.subarray(0, 16));
		if (mime === undefined || !INLINE_MEDIA_TYPES.has(mime) || result.size > INLINE_PREVIEW_MAX_BYTES) {
			stream.destroy();
			await opened.discard();
			throw new UserError("only PNG, JPEG, GIF and WebP images up to 20 MiB can be previewed");
		}
		const name = path.slice(path.lastIndexOf("/") + 1);
		c.header("Content-Type", mime);
		c.header("Content-Length", String(result.size));
		c.header("X-Content-Type-Options", "nosniff");
		c.header("Content-Security-Policy", "sandbox");
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

	app.post("/enrollment-tokens", requireAdmin, async (c) => {
		if (!options.serverFingerprint) return c.json({ error: "server fingerprint is not configured" }, 500);
		const body = await readJsonObject(c);
		if (!body) return jsonError(c, 400, "expected a JSON object");
		const created = await createEnrollmentToken(db, {
			userId: c.get("user").userId,
			nameHint: optionalString(body, "nameHint"),
			serverFingerprint: options.serverFingerprint,
		});
		void c.get("audit").record({
			actor: userActor(c.get("user")),
			action: "enrollment_token.created",
			target: { type: "enrollment_token", id: created.id },
			detail: { name_hint: optionalString(body, "nameHint"), expires_at: created.expiresAt },
		});
		return c.json({ token: created.token, expiresAt: created.expiresAt }, 201);
	});

	/** Resolves the node for a manage-only route: 404 when hidden, 403 for a non-administrator. */
	const manageable = async (c: Parameters<typeof access>[0], id: string) => {
		const level = await access(c, id);
		if (!level) return { error: { status: 404 as const, message: "no such node" } };
		if (!isAdmin(c.get("user"))) return { error: { status: 403 as const, message: "administrators only" } };
		return { level };
	};

	/**
	 * A one-time token that replaces this crha node's key instead of creating a node
	 * (doc/design/protocol.md "Rotation and revocation"). The node keeps its id, name, node groups,
	 * access grants and task history; it becomes pending again until the new key is approved.
	 */
	app.post("/nodes/:id/reenroll", async (c) => {
		const id = c.req.param("id");
		const m = await manageable(c, id);
		if (m.error) return jsonError(c, m.error.status, m.error.message);
		const row = await getNode(db, id);
		if (!row) return jsonError(c, 404, "no such node");
		if (row.transport === "ssh") return jsonError(c, 400, "SSH nodes cannot be re-enrolled");
		if (!options.serverFingerprint) return c.json({ error: "server fingerprint is not configured" }, 500);
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

	app.post("/nodes/:id/approve", async (c) => {
		const id = c.req.param("id");
		const m = await manageable(c, id);
		if (m.error) return jsonError(c, m.error.status, m.error.message);
		const row = await getNode(db, id);
		if (row?.status !== "pending") return jsonError(c, 409, "node is not pending");
		const node = await approveNode(db, id, c.get("user").userId);
		// The pending connection only carried facts; tell crha, then let it reconnect as an active node.
		options.cluster?.notifyNodeStatus(id, "active", "approved");
		void c.get("audit").record({
			actor: userActor(c.get("user")),
			action: "node.approved",
			target: { type: "node", id },
			detail: { name: node.name },
		});
		return c.json({ node: toPublicNode(node, m.level, (await nodeGroupsForNodes(db, [id])).get(id) ?? []) });
	});

	app.patch("/nodes/:id", async (c) => {
		const id = c.req.param("id");
		const m = await manageable(c, id);
		if (m.error) return jsonError(c, m.error.status, m.error.message);
		const body = await readJsonObject(c);
		const name = body ? optionalString(body, "name") : undefined;
		if (!name) return jsonError(c, 400, "name is required");
		const before = await getNode(db, id);
		const node = await renameNode(db, id, name);
		void c.get("audit").record({
			actor: userActor(c.get("user")),
			action: "node.renamed",
			target: { type: "node", id },
			detail: { old_name: before?.name, new_name: node.name },
		});
		return c.json({ node: live(toPublicNode(node, m.level, (await nodeGroupsForNodes(db, [id])).get(id) ?? [])) });
	});

	/** Replaces a node's node groups; administrators only, for crha and SSH nodes alike. */
	app.put("/nodes/:id/node-groups", async (c) => {
		const id = c.req.param("id");
		const m = await manageable(c, id);
		if (m.error) return jsonError(c, m.error.status, m.error.message);
		const row = await getNode(db, id);
		if (!row) return jsonError(c, 404, "no such node");
		const body = await readJsonObject(c);
		const nodeGroups = body?.nodeGroups;
		if (!Array.isArray(nodeGroups) || !nodeGroups.every((group) => typeof group === "string")) {
			return jsonError(c, 400, "nodeGroups must be a list of node-group names or ids");
		}
		const nodeGroupIds = await resolveNodeGroupIds(db, row.org_id, nodeGroups);
		const current = await setNodeGroupsForNode(db, id, nodeGroupIds);
		void c.get("audit").record({
			actor: userActor(c.get("user")),
			action: "node.node_groups_changed",
			target: { type: "node", id },
			detail: { node_group_ids: nodeGroupIds, node_groups: current.map((nodeGroup) => nodeGroup.name) },
		});
		return c.json({ nodeGroups: current });
	});

	app.delete("/nodes/:id", async (c) => {
		const id = c.req.param("id");
		const m = await manageable(c, id);
		if (m.error) return jsonError(c, m.error.status, m.error.message);
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
		return c.json({ ok: true });
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
