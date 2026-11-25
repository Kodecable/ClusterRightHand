import { Readable } from "node:stream";
import { firstFilesystem, type NodeMetrics } from "@crh/api";
import {
	BinaryBodySchema,
	EmojiBodySchema,
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
	NodeMetricsQuerySchema,
	NodeMetricsResponseSchema,
	NodeRenameBodySchema,
	NodeResponseSchema,
	NodeStatQuerySchema,
	NodeTrafficNextResetBodySchema,
	NodeTrafficResponseSchema,
	NodeTrustResponseSchema,
	NodeUpgradeBodySchema,
	NodeUpgradeResponseSchema,
	NodeUserRemarkBodySchema,
	OkResponseSchema,
} from "@crh/api/schemas";
import type { Context, MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { userActor } from "../audit/audit.ts";
import { isAdmin } from "../auth/sessions.ts";
import { type TaskView, TERMINAL } from "../cluster/cluster.ts";
import { type CrhaBinary, isReleaseVersion, ReleaseError } from "../cluster/crha-release.ts";
import { createEnrollmentToken } from "../cluster/enrollment.ts";
import { nodeGroupsForNodes, resolveNodeGroupIds, setNodeGroupsForNode } from "../cluster/node-groups.ts";
import { crhaUpdateAvailable, planUpgrade, upgradeSpec } from "../cluster/node-upgrade.ts";
import {
	approveNode,
	deleteNode,
	getNode,
	nodeAccess,
	nodeClockWarning,
	type PublicNode,
	queryNodesForUser,
	renameNode,
	setNodeEmoji,
	setNodeUserRemark,
	toPublicNode,
} from "../cluster/nodes.ts";
import { sshNodeDetails } from "../cluster/ssh/nodes.ts";
import { resolveTargets } from "../cluster/task-groups.ts";
import { trustView } from "../cluster/trust.ts";
import { trustWarningsForRows } from "../cluster/trust-warnings.ts";
import { findUserLibrary } from "../library/library.ts";
import { INLINE_MEDIA_TYPES, INLINE_PREVIEW_MAX_BYTES, sniffMagic } from "../library/media-type.ts";
import { openTransferLocation, type TransferContext, type TransferLocationJson } from "../library/transfer-location.ts";
import type { LatestMetrics } from "../metrics/collector.ts";
import { METRIC_LEVEL_BUCKET_MS, type MetricLevel } from "../metrics/levels.ts";
import {
	expandMetricsSeriesNames,
	invalidMetricsSeriesEntry,
	MAX_EXPANDED_METRICS_SERIES,
	MAX_METRICS_RANGE_MS,
	MAX_METRICS_READ_POINTS,
	MAX_METRICS_SERIES,
	metricsReadPoints,
	parseMetricsInstant,
	parseMetricsSeriesList,
} from "../metrics/read.ts";
import type { NodeTraffic } from "../metrics/store.ts";
import { isValidTrafficNextReset, type TrafficPeriod } from "../metrics/traffic.ts";
import type { Db } from "../storage/db.ts";
import { errorText, NotFoundError, UserError } from "../util/errors.ts";
import { CRH_VERSION } from "../version.ts";
import type { AppOptions } from "./app.ts";
import { contentDisposition } from "./content-disposition.ts";
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

const metricsRoute = defineRoute({
	method: "get",
	path: "/nodes/{id}/metrics",
	tags: TAGS,
	summary: "A node's stored host metrics: bucket averages for gauges, totals and counts for deltas",
	description: `Reads one storage level (doc/design/metrics.md "Reading"). \`series\` names series or \`prefix.*\` patterns; \`from\` and \`to\` are ISO 8601 or epoch milliseconds and the range is at most 400 days. Without \`level\`, the coarsest level that covers the range and gives at least 200 points is used, moved coarser when the expanded series would return more than ${MAX_METRICS_READ_POINTS} points; an explicit \`level\` that exceeds that cap is refused. The response also carries the node traffic period (always 30 days) and, when known, the filesystem report order.`,
	agent: "allow",
	request: { params: IdParamSchema, query: NodeMetricsQuerySchema },
	responses: { 200: { description: "The series and their buckets", ...json(NodeMetricsResponseSchema) } },
});

const trafficResetRoute = defineRoute({
	method: "post",
	path: "/nodes/{id}/traffic/reset",
	tags: TAGS,
	summary: "Reset a node's traffic totals now and start a new 30-day period (administrators)",
	description:
		'The totals go to zero and the current period starts now; the next reset is 30 days later (doc/design/metrics.md "Traffic totals").',
	agent: "deny", // it changes stored totals, not a host fact
	request: { params: IdParamSchema },
	responses: {
		200: { description: "The new period", ...json(NodeTrafficResponseSchema) },
		403: { description: "Administrators only", ...json(ErrorResponseSchema) },
		404: { description: "No such node", ...json(ErrorResponseSchema) },
	},
});

const nextResetRoute = defineRoute({
	method: "put",
	path: "/nodes/{id}/traffic/next-reset",
	tags: TAGS,
	summary: "Set when a node's current traffic period ends (administrators)",
	description:
		'The totals and the period start are kept, and the 30-day cycle continues from the new end (doc/design/metrics.md "Traffic totals").',
	agent: "deny", // it changes stored totals, not a host fact
	request: { params: IdParamSchema, body: { required: true, ...json(NodeTrafficNextResetBodySchema) } },
	responses: {
		200: { description: "The changed period", ...json(NodeTrafficResponseSchema) },
		400: { description: "The instant is not in the next 30 days", ...json(ErrorResponseSchema) },
		403: { description: "Administrators only", ...json(ErrorResponseSchema) },
		404: { description: "No such node", ...json(ErrorResponseSchema) },
	},
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
	agent: "deny", // it runs as the user, bypassing the session's file rules; the model has file tools
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
	agent: "deny", // it runs as the user, bypassing the session's file rules; the model has file tools
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

const upgradeRoute = defineRoute({
	method: "post",
	path: "/nodes/upgrade",
	tags: TAGS,
	summary: "Upgrade crha on nodes to crhs's own version, or plan it (administrators)",
	agent: "ask", // the upgrade itself is privileged and is authorized like any privileged task
	description:
		'Each architecture becomes one privileged node.upgrade task group, authorized like any privileged task. A node is skipped with a reason when it cannot be upgraded (doc/design/distribution.md "crha self-upgrade").',
	request: { body: { content: { "application/json": { schema: NodeUpgradeBodySchema } }, required: true } },
	responses: {
		200: { description: "The plan of a dry run", ...json(NodeUpgradeResponseSchema) },
		201: { description: "The plan and the task groups started", ...json(NodeUpgradeResponseSchema) },
		403: { description: "Administrators only", ...json(ErrorResponseSchema) },
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
	/** The current sample interval, for marking a latest sample older than three intervals as stale. */
	const metricsIntervalMs = () => options.settings?.current().metrics.intervalMs ?? 60_000;
	/** Whether collection is on; a node with collection off gets no metrics warning. */
	const metricsEnabled = () => options.settings?.current().metrics.enabled ?? true;
	const crhsFingerprints =
		options.signingKeys?.fingerprints ?? (options.authorizationKey ? [options.authorizationKey.fingerprint] : []);

	/** The wire shape of a traffic period: instants are ISO 8601 UTC, bytes are numbers. */
	const trafficView = (traffic: TrafficPeriod) => ({
		periodStart: new Date(traffic.periodStartMs).toISOString(),
		nextResetAt: new Date(traffic.nextResetAtMs).toISOString(),
		rxBytes: traffic.rxBytes,
		txBytes: traffic.txBytes,
	});

	/**
	 * Fills in what only the live server knows: the connection state, the clock warning, the latest
	 * metrics sample and the current traffic period the node list shows without reading buckets
	 * (doc/design/metrics.md "Reading").
	 */
	const live = (n: PublicNode, traffic: NodeTraffic | undefined, admin: boolean): PublicNode => {
		const latest = options.metricsCollector?.latest(n.id);
		const connected = n.connected === null ? null : (options.cluster?.isConnected(n.id) ?? false);
		// A sample failure is shown only while the node is online: an offline node already says so in its
		// status, and collection being off is a setting, not the node's failure (doc/design/metrics.md
		// "Collection"). An SSH node has no connection, so being active is its online state.
		const online = n.status === "active" && (n.transport === "ssh" || connected === true);
		const failure = online && metricsEnabled() ? options.metricsCollector?.metricsFailure?.(n.id) : undefined;
		return {
			...n,
			connected,
			clockWarning: nodeClockWarning(n.facts, clockWarnMs()),
			updateAvailable: crhaUpdateAvailable(n.transport, n.clientVersion, CRH_VERSION),
			// A failure's reason can name the SSH route (user@host:port of a jump), which a non-admin may not
			// see; they get a generic text and the since instant, administrators the full reason.
			metricsWarning:
				failure === undefined
					? null
					: { reason: admin ? failure.reason : "metrics collection failed", since: failure.since },
			...(latest
				? { metrics: latestMetricsView(latest, metricsIntervalMs(), options.metricsCollector?.diskOrder?.(n.id)) }
				: {}),
			traffic: traffic === undefined ? null : trafficView(traffic),
		};
	};

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

	const userRemarkRoute = defineRoute({
		method: "put",
		path: "/nodes/{id}/user-remark",
		tags: TAGS,
		summary: "Set or clear a node's user remark (administrators)",
		description:
			'The user remark is one line of at most 50 Unicode code points; it is trimmed, and an empty remark clears it (doc/design/webui.md "Node pages").',
		agent: "deny", // a stored administrator annotation on infrastructure, not a host fact
		request: { params: IdParamSchema, body: { required: true, ...json(NodeUserRemarkBodySchema) } },
		responses: {
			200: { description: "The node with its new user remark", ...json(NodeResponseSchema) },
			400: { description: "The user remark is not one line of at most 50 code points", ...json(ErrorResponseSchema) },
			403: { description: "Administrators only", ...json(ErrorResponseSchema) },
			404: { description: "No such node", ...json(ErrorResponseSchema) },
		},
	});

	const emojiRoute = defineRoute({
		method: "put",
		path: "/nodes/{id}/emoji",
		tags: TAGS,
		summary: "Set or clear a node's emoji (administrators)",
		description:
			'Exactly one emoji is accepted: a flag, a skin tone, a ZWJ sequence or a keycap; null or an empty string clears it (doc/design/webui.md "Node pages").',
		agent: "deny", // a stored administrator annotation on infrastructure, not a host fact
		request: { params: IdParamSchema, body: { required: true, ...json(EmojiBodySchema) } },
		responses: {
			200: { description: "The node with its new emoji", ...json(NodeResponseSchema) },
			400: { description: "The value is not exactly one emoji", ...json(ErrorResponseSchema) },
			403: { description: "Administrators only", ...json(ErrorResponseSchema) },
			404: { description: "No such node", ...json(ErrorResponseSchema) },
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
		// One read of every listed node's traffic row, whatever the page size: the list must not issue a
		// statement per node (doc/design/metrics.md "Traffic totals").
		const store = options.metricsStore ?? options.metrics;
		const traffic = store ? await store.trafficForNodes(page.items.map((node) => node.id)) : undefined;
		return c.json(
			{
				nodes: page.items.map((node) => live(node, traffic?.get(node.id), isAdmin(c.get("user")))),
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
		const store = options.metricsStore ?? options.metrics;
		const traffic = store ? (await store.trafficForNodes([id])).get(id) : undefined;
		const admin = isAdmin(c.get("user"));
		const node = live(toPublicNode(row, level, nodeGroups, trustWarnings), traffic, admin);
		if (!admin) return c.json({ node }, 200);
		return c.json({ node, ssh: (await sshNodeDetails(db, row)) ?? null }, 200);
	});

	/**
	 * A node's stored host metrics (doc/design/metrics.md "Reading"). Node access is the only check: reading
	 * metrics is not a task, so no rule or approval applies. A hidden node answers 404 like every node route.
	 */
	app.openapi(metricsRoute, async (c) => {
		const { id } = c.req.valid("param");
		if (!(await access(c, id))) throw new NotFoundError("no such node");
		const store = options.metricsStore ?? options.metrics;
		if (!store) throw new UserError("host metrics are not available on this server");
		const params = c.req.valid("query");
		const requested = parseMetricsSeriesList(params.series);
		if (requested.length === 0) throw new UserError("series: at least one series is required");
		if (requested.length > MAX_METRICS_SERIES) {
			throw new UserError(`series: at most ${MAX_METRICS_SERIES} entries are allowed`);
		}
		for (const entry of requested) {
			const problem = invalidMetricsSeriesEntry(entry);
			if (problem !== undefined) throw new UserError(problem);
		}
		const fromMs = parseMetricsInstant(params.from);
		if (fromMs === undefined) throw new UserError("from: must be an ISO 8601 time or Unix epoch milliseconds");
		const toMs = parseMetricsInstant(params.to);
		if (toMs === undefined) throw new UserError("to: must be an ISO 8601 time or Unix epoch milliseconds");
		if (fromMs >= toMs) throw new UserError("from: must be before to");
		if (toMs - fromMs > MAX_METRICS_RANGE_MS) {
			throw new UserError(`to: the range must be at most ${MAX_METRICS_RANGE_MS / 86_400_000} days`);
		}
		const available = await store.seriesNames(id);
		const names = expandMetricsSeriesNames(available, requested);
		if (names.length > MAX_EXPANDED_METRICS_SERIES) {
			throw new UserError(
				`series: the patterns name ${names.length} series, at most ${MAX_EXPANDED_METRICS_SERIES} are allowed`,
			);
		}
		const level =
			params.level === undefined
				? store.chooseLevel(fromMs, toMs, names.length)
				: (Number(params.level) as MetricLevel);
		const points = metricsReadPoints(names.length, fromMs, toMs, level);
		if (points > MAX_METRICS_READ_POINTS) {
			throw new UserError(
				params.level === undefined
					? `series: the request needs ${points} points at level ${level}, at most ${MAX_METRICS_READ_POINTS} are allowed; choose a shorter range or fewer series`
					: `level: ${names.length} series over this range need ${points} points at level ${level}, at most ${MAX_METRICS_READ_POINTS} are allowed; choose a coarser level or fewer series`,
			);
		}
		const readings = await store.read(id, names, fromMs, toMs, level);
		// The report order is only in the collector's memory; the bucket rows keep no order
		// (doc/design/metrics.md "Storage"). A period that already ended is rolled before it is served.
		const diskOrder = options.metricsCollector?.diskOrder?.(id);
		const traffic = await store.traffic(id);
		return c.json(
			{
				level,
				bucketMs: METRIC_LEVEL_BUCKET_MS[level],
				series: readings.map((reading) => ({
					name: reading.name,
					kind: reading.kind,
					lastSeenAt: reading.lastSeenAt,
					buckets: reading.buckets.map((bucket) => ({
						t: bucket.bucketStart,
						count: bucket.count,
						avg: bucket.count > 0 ? bucket.sum / bucket.count : 0,
						sum: bucket.sum,
						min: bucket.min,
						max: bucket.max,
						last: bucket.last,
					})),
				})),
				...(diskOrder === undefined || diskOrder.length === 0 ? {} : { diskOrder }),
				traffic: traffic === undefined ? null : trafficView(traffic),
			},
			200,
		);
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
		const name = path.slice(path.lastIndexOf("/") + 1);
		/** The headers of a streamed file: untrusted bytes never get a page context. */
		const fileHeaders = (mime: string, disposition: "attachment" | "inline"): void => {
			c.header("Content-Length", String(result.size));
			c.header("X-Content-Type-Options", "nosniff");
			c.header("Content-Security-Policy", "sandbox");
			c.header("Content-Type", mime);
			c.header("Content-Disposition", contentDisposition(disposition, name));
		};
		// Hono serves HEAD through this GET handler and drops the body, so opening the read stream would
		// leak its descriptor and the staging file (the body's discard would never run): answer with the
		// headers only and clean up here. Without the body there is nothing to sniff, so preview is an
		// attachment on HEAD.
		if (c.req.method === "HEAD") {
			await opened.discard();
			fileHeaders("application/octet-stream", "attachment");
			return c.body(null, 200);
		}
		const stream = opened.openRead();
		// The file opens (and can fail) before the body pulls from it; an unhandled 'error' event would
		// end the process, so the stream always has a listener.
		stream.on("error", () => {});
		if (!preview) {
			fileHeaders("application/octet-stream", "attachment");
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
		fileHeaders(mime, "inline");
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
	 * "Reset now" for a node's traffic totals (doc/design/metrics.md "Traffic totals"): administrators
	 * only, audited, and hidden nodes answer 404 like every other node route. The new period starts now.
	 */
	app.openapi(trafficResetRoute, async (c) => {
		const { id } = c.req.valid("param");
		await manageable(c, id);
		const store = options.metricsStore ?? options.metrics;
		if (!store) throw new UserError("host metrics are not available on this server");
		const before = await store.traffic(id);
		const traffic = trafficView(await store.resetTraffic(id));
		void c.get("audit").record({
			actor: userActor(c.get("user")),
			action: "node.traffic_reset",
			target: { type: "node", id },
			detail: {
				previous_period_start: before === undefined ? null : new Date(before.periodStartMs).toISOString(),
				previous_rx_bytes: before?.rxBytes ?? 0,
				previous_tx_bytes: before?.txBytes ?? 0,
				period_start: traffic.periodStart,
				next_reset_at: traffic.nextResetAt,
			},
		});
		return c.json({ traffic }, 200);
	});

	/**
	 * Changes when the current traffic period ends (doc/design/metrics.md "Traffic totals"): the totals and
	 * the start stay, and the fixed 30-day cycle continues from the new end. Only a future instant within
	 * one period is accepted; the server does no calendar or timezone math on it.
	 */
	app.openapi(nextResetRoute, async (c) => {
		const { id } = c.req.valid("param");
		await manageable(c, id);
		const store = options.metricsStore ?? options.metrics;
		if (!store) throw new UserError("host metrics are not available on this server");
		const { nextResetAt } = c.req.valid("json");
		// The instant must name its zone: a zoneless local time would make the server's own timezone
		// decide the period, which this design keeps out of crhs (doc/design/metrics.md "Traffic totals").
		const nextResetAtMs = /(?:Z|[+-]\d{2}:\d{2})$/.test(nextResetAt) ? Date.parse(nextResetAt) : Number.NaN;
		const nowMs = Date.now();
		if (!Number.isFinite(nextResetAtMs) || !isValidTrafficNextReset(nextResetAtMs, nowMs)) {
			throw new UserError("nextResetAt: must be in the future and at most 30 days from now, as ISO 8601 UTC");
		}
		const before = await store.traffic(id);
		const traffic = trafficView(await store.setTrafficNextReset(id, nextResetAtMs, nowMs));
		void c.get("audit").record({
			actor: userActor(c.get("user")),
			action: "node.traffic_next_reset_set",
			target: { type: "node", id },
			detail: {
				previous_next_reset_at: before === undefined ? null : new Date(before.nextResetAtMs).toISOString(),
				next_reset_at: traffic.nextResetAt,
			},
		});
		return c.json({ traffic }, 200);
	});

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
		return c.json(
			{
				node: live(
					toPublicNode(node, level, (await nodeGroupsForNodes(db, [id])).get(id) ?? []),
					undefined,
					isAdmin(c.get("user")),
				),
			},
			200,
		);
	});

	/** One line of context an administrator writes on a node's card; hidden nodes answer 404 first. */
	app.openapi(userRemarkRoute, async (c) => {
		const { id } = c.req.valid("param");
		const level = await manageable(c, id);
		const { userRemark } = c.req.valid("json");
		const before = await getNode(db, id);
		const node = await setNodeUserRemark(db, id, userRemark);
		void c.get("audit").record({
			actor: userActor(c.get("user")),
			action: "node.user_remark_set",
			target: { type: "node", id },
			detail: { previous: before?.user_remark ?? null, userRemark: node.user_remark },
		});
		return c.json(
			{
				node: live(
					toPublicNode(node, level, (await nodeGroupsForNodes(db, [id])).get(id) ?? []),
					undefined,
					isAdmin(c.get("user")),
				),
			},
			200,
		);
	});

	/** The emoji shown left of the node's name; hidden nodes answer 404 and members 403 first. */
	app.openapi(emojiRoute, async (c) => {
		const { id } = c.req.valid("param");
		const level = await manageable(c, id);
		const { emoji } = c.req.valid("json");
		const before = await getNode(db, id);
		const node = await setNodeEmoji(db, id, emoji);
		void c.get("audit").record({
			actor: userActor(c.get("user")),
			action: "node.emoji_set",
			target: { type: "node", id },
			detail: { previous: before?.emoji ?? null, emoji: node.emoji },
		});
		return c.json(
			{
				node: live(
					toPublicNode(node, level, (await nodeGroupsForNodes(db, [id])).get(id) ?? []),
					undefined,
					isAdmin(c.get("user")),
				),
			},
			200,
		);
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
		// The route is gone: a pooled SSH connection to it must not stay open.
		options.cluster?.closeSshNode(id);
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

	/**
	 * crha self-upgrade (doc/design/distribution.md "The upgrade task"): plan the requested nodes, then
	 * fetch and verify the release once per architecture and start one privileged task group for each.
	 */
	app.openapi(upgradeRoute, async (c) => {
		const user = c.get("user");
		if (!isAdmin(user)) throw new HTTPException(403, { message: "administrators only" });
		const { cluster, taskGroups, crhaReleases } = options;
		if (!cluster || !taskGroups || !crhaReleases) throw clusterUnavailable();
		const body = c.req.valid("json");
		// The installer upgrades only from a release to a newer release, and a crhs that is no release
		// has no crha release to send.
		if (!isReleaseVersion(crhaReleases.version)) {
			throw new UserError(
				`crhs ${crhaReleases.version} is not a release: crha self-upgrade needs a released crhs, whose version names the crha release`,
				"not_a_release",
			);
		}
		const resolved = await resolveTargets(db, user, body.targets);
		const rows = (await Promise.all(resolved.nodeIds.map((id) => getNode(db, id)))).filter((row) => row !== undefined);
		const plan = await planUpgrade(db, rows, crhaReleases.version, (id) => cluster.isConnected(id));
		const planned = [...plan.byArch.values()].flat();
		if (body.dryRun === true || planned.length === 0) {
			return c.json({ version: plan.version, upgrades: planned, skipped: plan.skipped, taskGroups: [] }, 200);
		}
		const audit = c.get("audit");
		// Every architecture's release is fetched and verified before any group starts, so a release that
		// fails, possibly a tampered one, starts nothing; the failure is audited. A release that has no
		// archive for an architecture skips only its nodes.
		const binaries = new Map<string, CrhaBinary>();
		const skipped = [...plan.skipped];
		for (const [arch, candidates] of plan.byArch) {
			try {
				binaries.set(arch, await crhaReleases.binary(arch));
			} catch (err) {
				if (err instanceof ReleaseError && err.code === "release_no_arch") {
					for (const node of candidates) {
						skipped.push({
							nodeId: node.nodeId,
							name: node.name,
							reason: "release_unavailable",
							nodeReasons: [],
							version: node.version,
						});
					}
					continue;
				}
				void audit.record({
					actor: userActor(user),
					action: "node.upgrade_failed",
					target: { type: "node_upgrade", id: plan.version },
					detail: {
						version: plan.version,
						arch,
						code: err instanceof UserError ? (err.code ?? null) : null,
						reason: errorText(err),
					},
				});
				throw err;
			}
		}
		const upgrades = planned.filter((node) => binaries.has(node.arch));
		const answer = { version: plan.version, upgrades, skipped };
		if (upgrades.length === 0) return c.json({ ...answer, taskGroups: [] }, 200);
		const startUpgradeGroup = async (arch: string, candidates: readonly { nodeId: string }[]): Promise<string> => {
			const binary = binaries.get(arch) as CrhaBinary;
			const location = await cluster.stageBytesForPush(binary.bytes);
			try {
				return await taskGroups.create({
					spec: upgradeSpec(binary),
					targets: candidates.map((candidate) => candidate.nodeId),
					nodeIds: candidates.map((candidate) => candidate.nodeId),
					transferLocation: location,
					privileged: true,
					actor: { type: "user", id: user.userId, onBehalfOfUserId: user.userId },
				});
			} catch (err) {
				// The group takes over the staged binary once it exists; a failed create leaves it to discard.
				await openTransferLocation(cluster.transferContext(), location)
					.discard()
					.catch(() => {});
				throw err;
			}
		};
		const started: { arch: string; taskGroupId: string }[] = [];
		let failure: unknown;
		try {
			for (const [arch, candidates] of plan.byArch) {
				if (!binaries.has(arch)) continue;
				started.push({ arch, taskGroupId: await startUpgradeGroup(arch, candidates) });
			}
		} catch (err) {
			failure = err;
		}
		// Recorded with the groups that did start, also when a later one failed.
		void audit.record({
			actor: userActor(user),
			action: "node.upgrade_requested",
			target: { type: "node_upgrade", id: plan.version },
			detail: {
				version: plan.version,
				nodes: upgrades.map((upgrade) => ({ id: upgrade.nodeId, from: upgrade.version, arch: upgrade.arch })),
				task_groups: started.map((group) => group.taskGroupId),
				skipped: skipped.map((skip) => ({ id: skip.nodeId, reason: skip.reason })),
				...(failure === undefined ? {} : { error: errorText(failure) }),
			},
		});
		if (failure !== undefined) throw failure;
		return c.json({ ...answer, taskGroups: started }, 201);
	});

	return app;
}

async function discardLocation(context: TransferContext, location: TransferLocationJson): Promise<void> {
	await openTransferLocation(context, location).discard();
}

/** A filesystem's two values in the latest sample, when both are present. */
function sampleDisk(disks: ReadonlyMap<string, { used?: number; total?: number }>, name: string): NodeMetrics["disk"] {
	const filesystem = disks.get(name);
	if (filesystem?.used === undefined || filesystem.total === undefined || !(filesystem.total > 0)) return undefined;
	const used = Math.max(0, filesystem.used);
	return { name, usedRatio: used / filesystem.total, usedBytes: used, totalBytes: filesystem.total };
}

/**
 * The node list's figures from a collector sample (doc/design/metrics.md "Reading"): the time, whether the
 * sample succeeded, CPU, memory, the first filesystem, uptime and the live network rates. A field the
 * sample lacks is absent, because a missing value is not zero (doc/design/metrics.md "Metrics").
 */
function latestMetricsView(latest: LatestMetrics, intervalMs: number, diskOrder?: readonly string[]): NodeMetrics {
	const values = new Map<string, number>();
	const disks = new Map<string, { used?: number; total?: number }>();
	for (const entry of latest.values) {
		values.set(entry.name, entry.value);
		const match = /^disk\.(.+)\.(used_bytes|total_bytes)$/.exec(entry.name);
		if (match === null) continue;
		const filesystem = disks.get(match[1] as string) ?? {};
		filesystem[match[2] === "used_bytes" ? "used" : "total"] = entry.value;
		disks.set(match[1] as string, filesystem);
	}
	const value = (name: string): number | undefined => values.get(name);
	const cpu = value("cpu.total");
	const total = value("mem.total_bytes");
	const available = value("mem.available_bytes");
	const memUsed =
		total !== undefined && available !== undefined && total > 0 ? Math.max(0, 1 - available / total) : undefined;
	const memUsedBytes =
		total !== undefined && available !== undefined && total > 0 ? Math.max(0, total - available) : undefined;
	const uptimeSec = value("uptime");
	// Only a filesystem with both values can say how full it is; the shared helper keeps this choice and the
	// WebUI's summary card identical (doc/design/metrics.md "Reading").
	const complete = new Set(
		[...disks]
			.filter(
				([, filesystem]) => filesystem.used !== undefined && filesystem.total !== undefined && filesystem.total > 0,
			)
			.map(([name]) => name),
	);
	const first = firstFilesystem(complete, diskOrder);
	const disk = first === undefined ? undefined : sampleDisk(disks, first);
	const rxBytesPerSec = value("net.rx_bytes_per_sec");
	const txBytesPerSec = value("net.tx_bytes_per_sec");
	return {
		at: new Date(latest.slotStartMs).toISOString(),
		up: value("up") ?? 1,
		...(cpu === undefined ? {} : { cpu }),
		...(memUsed === undefined ? {} : { memUsed }),
		...(memUsedBytes === undefined ? {} : { memUsedBytes }),
		...(total === undefined ? {} : { memTotalBytes: total }),
		...(uptimeSec === undefined ? {} : { uptimeSec }),
		...(disk === undefined ? {} : { disk }),
		...(rxBytesPerSec === undefined ? {} : { rxBytesPerSec }),
		...(txBytesPerSec === undefined ? {} : { txBytesPerSec }),
		stale: Date.now() - latest.slotStartMs > 3 * intervalMs,
	};
}
