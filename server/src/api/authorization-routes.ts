/**
 * User authorizations (doc/design/privilege.md "Authorization path"): submitting a signed authorization
 * (pasted `crhu sign` output or a Passkey assertion), the administrators' list, the options
 * the waiting page shows its owner, and the owner rejecting the wait instead of signing it.
 */
import {
	AuthorizationListResponseSchema,
	AuthorizationSubmittedResponseSchema,
	CursorQuerySchema,
	ErrorResponseSchema,
	IdParamSchema,
	OkResponseSchema,
	RejectAuthorizationBodySchema,
	SubmitAuthorizationBodySchema,
	TaskAuthorizationResponseSchema,
	TaskGroupAuthorizationResponseSchema,
} from "@crh/api/schemas";
import { type AuthorizationPayload, decodeAuthorizationPayload } from "@crh/protocol";
import { HTTPException } from "hono/http-exception";
import type { Actor, Cluster } from "../cluster/cluster.ts";
import { decodedPayloadOf, pendingForTask, pendingForTaskGroup } from "../cluster/pending.ts";
import type { TaskGroups } from "../cluster/task-groups.ts";
import { taskRelation } from "../cluster/task-visibility.ts";
import {
	parseSubmittedAuthorization,
	parseWebauthnSubmission,
	type SubmittedAuthorization,
} from "../privilege/submission.ts";
import type { Db } from "../storage/db.ts";
import { usernamesById } from "../users/service.ts";
import {
	type CursorSpec,
	cursorRows,
	decodeCursor,
	descendingKeyset,
	encodeCursor,
	parseLimit,
} from "../util/cursor.ts";
import { NotFoundError, UserError } from "../util/errors.ts";
import type { AppEnv } from "./context.ts";
import { requireAdmin } from "./middleware.ts";
import { apiRouter, defineRoute, json } from "./openapi.ts";

const TAGS = ["Authorizations"];

/** `GET /authorizations` pages over `created_at desc, id desc` (doc/design/webui.md "API conventions"). */
const AUTHORIZATIONS_CURSOR: CursorSpec = { columns: [{ name: "created_at", type: "string" }], idType: "string" };

/** A rejection reason is stored as the task's error message; longer text is cut, not refused. */
const MAX_REJECTION_REASON = 1000;

const submitRoute = defineRoute({
	method: "post",
	path: "/authorizations",
	tags: TAGS,
	summary: "Submit a signed authorization (pasted `crhu sign` output or a Passkey assertion)",
	agent: "deny", // signature submission
	request: { body: { required: true, ...json(SubmitAuthorizationBodySchema) } },
	responses: {
		200: { description: "The stored authorization's id", ...json(AuthorizationSubmittedResponseSchema) },
		503: { description: "The cluster is not running", ...json(ErrorResponseSchema) },
	},
});

const listRoute = defineRoute({
	method: "get",
	path: "/authorizations",
	tags: TAGS,
	summary: "Page through the organization's stored authorizations, newest first (administrators)",
	agent: "deny", // the signing record is the user's security surface, not an agent's
	middleware: [requireAdmin],
	request: { query: CursorQuerySchema },
	responses: {
		200: { description: "One page of authorizations", ...json(AuthorizationListResponseSchema) },
		403: { description: "Administrators only", ...json(ErrorResponseSchema) },
	},
});

const taskAuthorizationRoute = defineRoute({
	method: "get",
	path: "/tasks/{id}/authorization",
	tags: TAGS,
	summary: "The authorization options a task's owner can take",
	agent: "deny", // signing material and the challenge
	request: { params: IdParamSchema },
	responses: {
		200: {
			description: "The options, or null when no plan is written yet",
			...json(TaskAuthorizationResponseSchema),
		},
		403: { description: "Only the task's owner can authorize it", ...json(ErrorResponseSchema) },
	},
});

const rejectTaskRoute = defineRoute({
	method: "post",
	path: "/tasks/{id}/authorization/reject",
	tags: TAGS,
	summary: "Reject a task's signature wait instead of signing it; the task ends `rejected`",
	agent: "deny", // an authorization decision
	request: { params: IdParamSchema, body: { required: true, ...json(RejectAuthorizationBodySchema) } },
	responses: {
		200: { description: "The wait was rejected", ...json(OkResponseSchema) },
		409: { description: "The task is not waiting for authorization", ...json(ErrorResponseSchema) },
		503: { description: "The cluster is not running", ...json(ErrorResponseSchema) },
	},
});

const groupAuthorizationRoute = defineRoute({
	method: "get",
	path: "/task-groups/{id}/authorization",
	tags: TAGS,
	summary: "The shared payload of a task group's waiting tasks",
	agent: "deny", // signing material and the challenge
	request: { params: IdParamSchema },
	responses: {
		200: {
			description: "The options, or null when no plan is written yet",
			...json(TaskGroupAuthorizationResponseSchema),
		},
		403: { description: "Only the task group's owner can authorize it", ...json(ErrorResponseSchema) },
	},
});

const rejectGroupRoute = defineRoute({
	method: "post",
	path: "/task-groups/{id}/authorization/reject",
	tags: TAGS,
	summary: "Reject a task group's signature wait; every member still waiting ends `rejected`",
	agent: "deny", // an authorization decision
	request: { params: IdParamSchema, body: { required: true, ...json(RejectAuthorizationBodySchema) } },
	responses: {
		200: { description: "The wait was rejected", ...json(OkResponseSchema) },
		409: { description: "The task group is not waiting for authorization", ...json(ErrorResponseSchema) },
		503: { description: "The cluster is not running", ...json(ErrorResponseSchema) },
	},
});

export interface AuthorizationRoutesOptions {
	cluster?: Cluster;
	taskGroups?: TaskGroups;
}

/** Expects requireUser to have run. */
export function authorizationRoutes(db: Db, options: AuthorizationRoutesOptions = {}) {
	const app = apiRouter();

	/**
	 * Accepts `{ authorization: base64 }` (CBOR Authorization, e.g. `crhu sign` output) or
	 * `{ payload: base64, webauthn: AuthenticationResponseJSON }` from the waiting page's Passkey button: the
	 * bytes the browser signed, so a payload refreshed while the owner was signing still verifies.
	 */
	app.openapi(submitRoute, async (c) => {
		const user = c.get("user");
		const body = c.req.valid("json");
		if (!options.cluster) throw new HTTPException(503, { message: "the cluster is not running" });
		const authorization = body.authorization;
		const payload = body.payload;
		let submitted: SubmittedAuthorization;
		if (typeof authorization === "string") {
			submitted = parseSubmittedAuthorization(authorization);
		} else if (typeof payload === "string" && typeof body.webauthn === "object" && body.webauthn !== null) {
			submitted = await parseWebauthnSubmission(db, user.userId, payload, body.webauthn);
		} else {
			throw new UserError("give authorization (base64) or payload and webauthn");
		}
		const result = await options.cluster.submitAuthorization(user, submitted);
		// The submission's dispatch continues in the background; its outcome shows up in the task states.
		return c.json({ authorization: { id: result.id } }, 200);
	});

	/**
	 * The organization's authorizations; administrators only (doc/design/access-control.md "Audit").
	 * Keyset paginated: the old hard cap of 200 rows is gone (doc/design/webui.md "API conventions").
	 */
	app.openapi(listRoute, async (c) => {
		const user = c.get("user");
		const orgId = await orgOf(db, user.userId);
		if (orgId === undefined) throw new HTTPException(403, { message: "only administrators can list authorizations" });
		const query = c.req.valid("query");
		const limit = parseLimit(query.limit);
		const rawCursor = query.cursor;
		const cursor = rawCursor === undefined ? undefined : decodeCursor(rawCursor, AUTHORIZATIONS_CURSOR);
		let select = db.selectFrom("authorizations").selectAll().where("org_id", "=", orgId);
		if (cursor) select = select.where(descendingKeyset(["created_at"], cursor));
		const page = await cursorRows(
			limit,
			(limitPlusOne) => select.orderBy("created_at", "desc").orderBy("id", "desc").limit(limitPlusOne).execute(),
			(row) => encodeCursor([row.created_at], row.id),
		);
		// Name only the issuers of this page, not every user in the organization.
		const issuerIds = [
			...new Set(page.rows.flatMap((row) => (row.issuer_user_id === null ? [] : [row.issuer_user_id]))),
		];
		const users = await usernamesById(db, issuerIds);
		const items = page.rows.map((row) => {
			let decoded: ReturnType<typeof decodedPayloadOf> | null = null;
			try {
				decoded = decodedPayloadOf(parseStoredPayload(row.payload));
			} catch {}
			return {
				id: row.id,
				issuerUserId: row.issuer_user_id,
				issuerUsername: row.issuer_user_id ? (users.get(row.issuer_user_id) ?? null) : null,
				nodes: decoded?.nodes ?? [],
				command: decoded?.command ?? null,
				taskIds: row.task_ids === null ? null : (JSON.parse(row.task_ids) as string[]),
				attempt: decoded?.attempt ?? null,
				note: decoded?.note ?? "",
				issuedAt: decoded?.issuedAt ?? null,
				deadline: row.deadline,
				createdAt: row.created_at,
			};
		});
		return c.json({ items, nextCursor: page.nextCursor }, 200);
	});

	/** The options of a task, for its owner (doc/design/privilege.md "Authorizations"); other users get a 403. */
	app.openapi(taskAuthorizationRoute, async (c) => {
		const { id } = c.req.valid("param");
		const found = await authorizationTask(db, c.get("user"), id);
		if (!found.owner) throw new HTTPException(403, { message: "only the task's owner can authorize it" });
		return c.json({ authorization: await pendingForTask(db, found.row) }, 200);
	});

	/**
	 * Rejects the task's signature wait instead of signing it (doc/design/privilege.md "Waiting for signatures"):
	 * the task ends `rejected` with `authorization_declined` and the reason, or the default text. Only its
	 * owner may answer; anyone else gets the same 404 as a task they cannot see.
	 */
	app.openapi(rejectTaskRoute, async (c) => {
		if (!options.cluster) throw new HTTPException(503, { message: "the cluster is not running" });
		const { id } = c.req.valid("param");
		const found = await authorizationTask(db, c.get("user"), id);
		if (!found.owner) throw new NotFoundError("no such task");
		if (found.row.state !== "awaiting_authorization") {
			throw new HTTPException(409, { message: "the task is not waiting for authorization" });
		}
		const rejected = await options.cluster.rejectAuthorization(
			found.row.id,
			rejectionReason(c.req.valid("json")),
			rejectingActor(c.get("user")),
		);
		if (!rejected) throw new HTTPException(409, { message: "the task is not waiting for authorization" });
		return c.json({ ok: true as const }, 200);
	});

	/** The shared options of a task group's waiting tasks; only the task group's owner may read them. */
	app.openapi(groupAuthorizationRoute, async (c) => {
		const user = c.get("user");
		const { id } = c.req.valid("param");
		const found = await authorizationTaskGroup(db, user, id);
		if (!found.owner) throw new HTTPException(403, { message: "only the task group's owner can authorize it" });
		return c.json({ taskGroup: await pendingForTaskGroup(db, found.row.id, user.userId) }, 200);
	});

	/**
	 * Rejects the signature wait of a task group's owner (doc/design/privilege.md "Waiting for signatures"):
	 * every member still waiting ends `rejected` with `authorization_declined` and the reason, and the
	 * group ends `rejected`. Members already finished are untouched, and only the owner may answer.
	 */
	app.openapi(rejectGroupRoute, async (c) => {
		if (!options.taskGroups) throw new HTTPException(503, { message: "the cluster is not running" });
		const { id } = c.req.valid("param");
		const found = await authorizationTaskGroup(db, c.get("user"), id);
		if (!found.owner) throw new NotFoundError("no such task group");
		// A partly dispatched group is `running`; it still waits while another member needs a signature.
		if (found.row.state !== "awaiting_authorization" && !(await options.taskGroups.hasAuthorizationWait(id))) {
			throw new HTTPException(409, { message: "the task group is not waiting for authorization" });
		}
		const rejected = await options.taskGroups.rejectAuthorization(
			found.row.id,
			rejectionReason(c.req.valid("json")),
			rejectingActor(c.get("user")),
		);
		if (!rejected) throw new HTTPException(409, { message: "the task group is not waiting for authorization" });
		return c.json({ ok: true as const }, 200);
	});

	return app;
}

/** The fields the authorization endpoints read; the owner check is shared by them all. */
type AuthorizationTaskRow = {
	id: string;
	state: string;
	node_id: string;
	on_behalf_of_user_id: string;
	actor_type: string;
	actor_id: string;
	authorization: string | null;
};

type AuthorizationTaskGroupRow = {
	id: string;
	state: string;
	on_behalf_of_user_id: string;
	actor_type: string;
	actor_id: string;
};

/**
 * A task the user can see, with whether they own it: an invisible task is 404, like every lookup, and
 * the endpoints decide their own answer for a visible task of another user (doc/design/privilege.md "Authorizations").
 */
async function authorizationTask(
	db: Db,
	user: AppEnv["Variables"]["user"],
	id: string,
): Promise<{ row: AuthorizationTaskRow; owner: boolean }> {
	const row = await db
		.selectFrom("tasks")
		.select(["id", "state", "node_id", "on_behalf_of_user_id", "actor_type", "actor_id", "authorization"])
		.where("id", "=", id)
		.executeTakeFirst();
	if (!row) throw new NotFoundError("no such task");
	const relation = await taskRelation(db, user, {
		onBehalfOfUserId: row.on_behalf_of_user_id,
		actorType: row.actor_type,
		actorId: row.actor_id,
	});
	if (!relation.visible) throw new NotFoundError("no such task");
	return { row, owner: row.on_behalf_of_user_id === user.userId };
}

/** A task group the user can see, with whether they own it; the same lookup as a task's. */
async function authorizationTaskGroup(
	db: Db,
	user: AppEnv["Variables"]["user"],
	id: string,
): Promise<{ row: AuthorizationTaskGroupRow; owner: boolean }> {
	const row = await db
		.selectFrom("task_groups")
		.select(["id", "state", "on_behalf_of_user_id", "actor_type", "actor_id"])
		.where("id", "=", id)
		.executeTakeFirst();
	if (!row) throw new NotFoundError("no such task group");
	const relation = await taskRelation(db, user, {
		onBehalfOfUserId: row.on_behalf_of_user_id,
		actorType: row.actor_type,
		actorId: row.actor_id,
	});
	if (!relation.visible) throw new NotFoundError("no such task group");
	return { row, owner: row.on_behalf_of_user_id === user.userId };
}

/** The body's reason, trimmed and bounded; an absent or empty one is no reason. */
function rejectionReason(body: { reason?: string }): string {
	return typeof body.reason === "string" ? body.reason.trim().slice(0, MAX_REJECTION_REASON) : "";
}

/** The user answering for themselves: the actor the rejection audit names. */
function rejectingActor(user: AppEnv["Variables"]["user"]): Actor {
	return { type: "user", id: user.userId, onBehalfOfUserId: user.userId };
}

/** The stored payload of a row; throws on a damaged row (the caller then shows no detail). */
function parseStoredPayload(base64: string): AuthorizationPayload {
	return decodeAuthorizationPayload(Uint8Array.from(Buffer.from(base64, "base64")));
}

async function orgOf(db: Db, userId: string): Promise<string | undefined> {
	const row = await db.selectFrom("users").select("org_id").where("id", "=", userId).executeTakeFirst();
	return row?.org_id;
}
