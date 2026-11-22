/**
 * The job API (doc/design/jobs.md "API"): a session's jobs, one job, and cancelling one. Visibility follows
 * ownership as the session routes check it: the session's owner, its share viewers and administrators may read,
 * and only the owner may cancel.
 */
import {
	ErrorResponseSchema,
	JobCancelResponseSchema,
	JobIdParamSchema,
	JobListQuerySchema,
	JobPageResponseSchema,
	JobResponseSchema,
} from "@crh/api/schemas";
import { HTTPException } from "hono/http-exception";
import type { SessionUser } from "../auth/sessions.ts";
import type { Jobs } from "../jobs/jobs.ts";
import type { JobRow } from "../jobs/types.ts";
import { sessionCapabilities } from "../sessions/sharing.ts";
import type { Db } from "../storage/db.ts";
import {
	type CursorSpec,
	cursorRows,
	decodeCursor,
	descendingKeyset,
	encodeCursor,
	parseLimit,
} from "../util/cursor.ts";
import { NotFoundError } from "../util/errors.ts";
import { jobViewOf } from "./job-view.ts";
import { apiRouter, defineRoute, json } from "./openapi.ts";

const TAGS = ["Jobs"];

/** GET /jobs orders by `created_at desc, id desc`, like the task list. */
const JOBS_CURSOR: CursorSpec = { columns: [{ name: "created_at", type: "string" }], idType: "string" };

const listRoute = defineRoute({
	method: "get",
	path: "/jobs",
	tags: TAGS,
	summary: "Page through one session's jobs, newest first",
	agent: "allow",
	request: { query: JobListQuerySchema },
	responses: { 200: { description: "One page of jobs", ...json(JobPageResponseSchema) } },
});

const getRoute = defineRoute({
	method: "get",
	path: "/jobs/{id}",
	tags: TAGS,
	summary: "One job and the record it projects",
	agent: "allow",
	request: { params: JobIdParamSchema },
	responses: { 200: { description: "The job", ...json(JobResponseSchema) } },
});

const cancelRoute = defineRoute({
	method: "post",
	path: "/jobs/{id}/cancel",
	tags: TAGS,
	summary: "Cancel a job through its record's cancel path; only the session's owner may",
	agent: "ask",
	request: { params: JobIdParamSchema },
	responses: {
		200: { description: "Whether it was cancelled, and the job after it", ...json(JobCancelResponseSchema) },
		403: { description: "Only the session's owner cancels", ...json(ErrorResponseSchema) },
	},
});

/** A job the caller may see, with whether they may cancel it. */
interface JobAccess {
	job: JobRow;
	/** The session's owner, the only one who may cancel. */
	owner: boolean;
}

export interface JobRoutesOptions {
	jobs: Jobs;
}

/** The job routes. Expects requireUser to have run. */
export function jobRoutes(db: Db, options: JobRoutesOptions) {
	const { jobs } = options;
	const app = apiRouter();

	/**
	 * The job and the caller's access to it. A job belongs to the session whose tool call started it: its owner,
	 * a share viewer and an administrator may read it; a job an MCP client started (no session) has no WebUI page.
	 */
	const accessTo = async (user: SessionUser, id: string): Promise<JobAccess | undefined> => {
		const job = await jobs.get(id);
		if (!job || job.session_id === null) return undefined;
		const info = await sessionCapabilities(db, user, job.session_id);
		if (!info) return undefined;
		const session = await db
			.selectFrom("sessions")
			.select("owner_user_id")
			.where("id", "=", job.session_id)
			.executeTakeFirst();
		if (!session) return undefined;
		return { job, owner: session.owner_user_id === user.userId };
	};

	app.openapi(listRoute, async (c) => {
		const user = c.get("user");
		const query = c.req.valid("query");
		const info = await sessionCapabilities(db, user, query.session);
		if (!info) throw new NotFoundError("no such session");
		const active = query.active === "true" || query.active === "1";
		const limit = parseLimit(query.limit);
		const cursor = query.cursor === undefined ? undefined : decodeCursor(query.cursor, JOBS_CURSOR);
		let select = db.selectFrom("jobs").selectAll().where("session_id", "=", query.session);
		// The background bar loads only active jobs; the full list keeps settled ones for history.
		if (active) select = select.where("state", "!=", "settled");
		if (cursor) select = select.where(descendingKeyset(["created_at"], cursor));
		const page = await cursorRows(
			limit,
			(limitPlusOne) => select.orderBy("created_at", "desc").orderBy("id", "desc").limit(limitPlusOne).execute(),
			(row) => encodeCursor([row.created_at], row.id),
		);
		return c.json({ items: page.rows.map(jobViewOf), nextCursor: page.nextCursor }, 200);
	});

	app.openapi(getRoute, async (c) => {
		const { id } = c.req.valid("param");
		const found = await accessTo(c.get("user"), id);
		if (!found) throw new NotFoundError("no such job");
		return c.json({ job: jobViewOf(found.job) }, 200);
	});

	app.openapi(cancelRoute, async (c) => {
		const user = c.get("user");
		const { id } = c.req.valid("param");
		const found = await accessTo(user, id);
		if (!found) throw new NotFoundError("no such job");
		if (!found.owner) throw new HTTPException(403, { message: "only the session's owner can do this" });
		const result = await jobs.cancelJob(found.job, {
			type: "user",
			id: user.userId,
			onBehalfOfUserId: user.userId,
		});
		return c.json({ cancelled: result.cancelled, job: jobViewOf(result.job ?? found.job) }, 200);
	});

	return app;
}
