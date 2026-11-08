/**
 * User authorizations (doc/m4.md M4.4, doc/privilege.md#授权路径): submitting a signed authorization
 * (pasted `crha grant` output or a Passkey assertion), the administrators' list, and the pending
 * payload the waiting page shows its owner.
 */
import { type AuthorizationPayload, decodeAuthorizationPayload } from "@crh/protocol";
import { Hono } from "hono";
import type { Cluster } from "../cluster/cluster.ts";
import { decodedPayloadOf, pendingForTask, pendingForTaskGroup } from "../cluster/pending.ts";
import { taskRelation } from "../cluster/task-visibility.ts";
import {
	parseSubmittedAuthorization,
	parseWebauthnSubmission,
	type SubmittedAuthorization,
} from "../privilege/submission.ts";
import type { Db } from "../storage/db.ts";
import { type AppEnv, jsonError, readJsonObject } from "./context.ts";
import { type CursorSpec, cursorRows, decodeCursor, descendingKeyset, encodeCursor, parseLimit } from "./cursor.ts";

/** `GET /authorizations` pages over `created_at desc, id desc` (doc/webui.md#api-约定). */
const AUTHORIZATIONS_CURSOR: CursorSpec = { columns: [{ name: "created_at", type: "string" }], idType: "string" };

export interface AuthorizationRoutesOptions {
	cluster?: Cluster;
}

/** Expects requireUser to have run. */
export function authorizationRoutes(db: Db, options: AuthorizationRoutesOptions = {}) {
	const app = new Hono<AppEnv>();

	/**
	 * Accepts `{ authorization: base64 }` (CBOR Authorization, e.g. `crha grant` output) or
	 * `{ payloadId, webauthn: AuthenticationResponseJSON }` from the waiting page's Passkey button.
	 */
	app.post("/authorizations", async (c) => {
		const user = c.get("user");
		const body = await readJsonObject(c);
		if (!body) return jsonError(c, 400, "expected a JSON object");
		if (!options.cluster) return c.json({ error: "the cluster is not running" }, 503);
		const authorization = body.authorization;
		const payloadId = body.payloadId;
		let submitted: SubmittedAuthorization;
		if (typeof authorization === "string") {
			submitted = parseSubmittedAuthorization(authorization);
		} else if (typeof payloadId === "string" && typeof body.webauthn === "object" && body.webauthn !== null) {
			submitted = await parseWebauthnSubmission(db, user.userId, payloadId, body.webauthn);
		} else {
			return jsonError(c, 400, "give authorization (base64) or payloadId and webauthn");
		}
		const result = await options.cluster.submitAuthorization(user, submitted);
		return c.json({ authorization: { id: result.id, dispatched: result.dispatched } });
	});

	/**
	 * The organization's authorizations; administrators only (doc/access-control.md#审计).
	 * Keyset paginated: the old hard cap of 200 rows is gone (doc/webui.md#api-约定).
	 */
	app.get("/authorizations", async (c) => {
		const user = c.get("user");
		const orgId = await orgOf(db, user.userId);
		if (user.kind !== "admin" || orgId === undefined) {
			return jsonError(c, 403, "only administrators can list authorizations");
		}
		const limit = parseLimit(c.req.query("limit"));
		const rawCursor = c.req.query("cursor");
		const cursor = rawCursor === undefined ? undefined : decodeCursor(rawCursor, AUTHORIZATIONS_CURSOR);
		let query = db.selectFrom("authorizations").selectAll().where("org_id", "=", orgId);
		if (cursor) query = query.where(descendingKeyset(["created_at"], cursor));
		const page = await cursorRows(
			limit,
			(limitPlusOne) => query.orderBy("created_at", "desc").orderBy("id", "desc").limit(limitPlusOne).execute(),
			(row) => encodeCursor([row.created_at], row.id),
		);
		// Name only the issuers of this page, not every user in the organization.
		const issuerIds = [
			...new Set(page.rows.flatMap((row) => (row.issuer_user_id === null ? [] : [row.issuer_user_id]))),
		];
		const users = new Map(
			(issuerIds.length === 0
				? []
				: await db.selectFrom("users").select(["id", "username"]).where("id", "in", issuerIds).execute()
			).map((row) => [row.id, row.username]),
		);
		return c.json({
			items: page.rows.map((row) => {
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
			}),
			nextCursor: page.nextCursor,
		});
	});

	/** The pending payload of a task, for its owner (doc/m4.md M4.4); other users get a 403. */
	app.get("/tasks/:id/authorization", async (c) => {
		const user = c.get("user");
		const row = await db
			.selectFrom("tasks")
			.select(["id", "node_id", "on_behalf_of_user_id", "actor_type", "actor_id", "authorization"])
			.where("id", "=", c.req.param("id"))
			.executeTakeFirst();
		if (
			!row ||
			!(
				await taskRelation(db, user, {
					onBehalfOfUserId: row.on_behalf_of_user_id,
					actorType: row.actor_type,
					actorId: row.actor_id,
				})
			).visible
		) {
			return jsonError(c, 404, "no such task");
		}
		if (row.on_behalf_of_user_id !== user.userId) {
			return jsonError(c, 403, "only the task's owner can authorize it");
		}
		return c.json({ authorization: await pendingForTask(db, row) });
	});

	/** The shared payload of a task group's waiting tasks; only the task group's owner may read it. */
	app.get("/task-groups/:id/authorization", async (c) => {
		const user = c.get("user");
		const taskGroup = await db
			.selectFrom("task_groups")
			.select(["id", "on_behalf_of_user_id", "actor_type", "actor_id"])
			.where("id", "=", c.req.param("id"))
			.executeTakeFirst();
		if (
			!taskGroup ||
			!(
				await taskRelation(db, user, {
					onBehalfOfUserId: taskGroup.on_behalf_of_user_id,
					actorType: taskGroup.actor_type,
					actorId: taskGroup.actor_id,
				})
			).visible
		) {
			return jsonError(c, 404, "no such task group");
		}
		if (taskGroup.on_behalf_of_user_id !== user.userId) {
			return jsonError(c, 403, "only the task group's owner can authorize it");
		}
		return c.json({ taskGroup: await pendingForTaskGroup(db, taskGroup.id, user.userId) });
	});

	return app;
}

/** The stored payload of a row; throws on a damaged row (the caller then shows no detail). */
function parseStoredPayload(base64: string): AuthorizationPayload {
	return decodeAuthorizationPayload(Uint8Array.from(Buffer.from(base64, "base64")));
}

async function orgOf(db: Db, userId: string): Promise<string | undefined> {
	const row = await db.selectFrom("users").select("org_id").where("id", "=", userId).executeTakeFirst();
	return row?.org_id;
}
