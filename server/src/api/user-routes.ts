import { Hono } from "hono";
import type { SessionListHub } from "../agent/session-list.ts";
import { userActor } from "../audit/audit.ts";
import { revokeAllApiTokens } from "../auth/api-tokens.ts";
import { revokeUserWebSessions } from "../auth/sessions.ts";
import type { Cluster } from "../cluster/cluster.ts";
import type { TaskGroups } from "../cluster/task-groups.ts";
import { Scheduler } from "../scheduler/scheduler.ts";
import type { Db } from "../storage/db.ts";
import { createUser, getUserDetail, listUsers, setPassword, toPublicUser, updateUser } from "../users/service.ts";
import {
	addUserGroupMember,
	createUserGroup,
	deleteUserGroup,
	getUserGroupDetail,
	listUserGroups,
	removeUserGroupMember,
	renameUserGroup,
} from "../users/user-groups.ts";
import { rejectRevokedTokenWaits } from "./api-token-waits.ts";
import { type AppEnv, jsonError, optionalString, readJsonObject } from "./context.ts";
import { requireAdmin, requireAdminOrSelf } from "./middleware.ts";

const KINDS = new Set(["admin", "member"]);
const STATUSES = new Set(["active", "disabled"]);

export interface UserRoutesOptions {
	/** The session list stream: membership and account changes alter what a user may see. */
	sessions?: SessionListHub;
	/** With taskGroups, rejects the waiting work of tokens an administrator's password reset revokes. */
	cluster?: Cluster;
	taskGroups?: TaskGroups;
	/** Ends the user's per-session SSE streams after a password reset revokes their WebUI sessions. */
	revalidateWebSessions?: (userId: string) => Promise<void> | void;
}

/** Expects requireUser to have run. */
export function userRoutes(db: Db, options: UserRoutesOptions = {}) {
	const app = new Hono<AppEnv>();

	app.get("/me", async (c) => {
		const row = await db.selectFrom("users").selectAll().where("id", "=", c.get("user").userId).executeTakeFirst();
		if (!row) return jsonError(c, 404, "no such user");
		const { password_hash: _, ...rest } = row;
		return c.json({ user: toPublicUser(rest) });
	});

	// Everyone in the organization can look up whom to share with; only names, nothing else.
	app.get("/directory", async (c) => {
		const users = await db
			.selectFrom("users")
			.select(["id", "username", "display_name"])
			.where("status", "=", "active")
			.orderBy("username")
			.execute();
		const groups = await db.selectFrom("user_groups").select(["id", "name"]).orderBy("name").execute();
		return c.json({
			users: users.map((u) => ({ id: u.id, username: u.username, displayName: u.display_name })),
			userGroups: groups,
		});
	});

	/**
	 * One user's view. Administrators read anyone; everyone else only themselves, and any other id answers
	 * the same 404 a missing user gets (an unprivileged caller never learns whether an account exists).
	 * Registered before the admin middleware for `/users/*`; every other /users route stays admin-only.
	 */
	app.get("/users/:id", requireAdminOrSelf, async (c) => {
		const detail = await getUserDetail(db, c.req.param("id"));
		if (!detail) return jsonError(c, 404, "no such user");
		return c.json(detail);
	});

	app.use("/users/*", requireAdmin);
	app.use("/users", requireAdmin);
	app.use("/user-groups/*", requireAdmin);
	app.use("/user-groups", requireAdmin);

	app.get("/users", async (c) => c.json({ users: await listUsers(db) }));

	app.post("/users", async (c) => {
		const body = await readJsonObject(c);
		if (!body) return jsonError(c, 400, "expected a JSON object");
		const username = optionalString(body, "username");
		const kind = optionalString(body, "kind") ?? "member";
		if (!username) return jsonError(c, 400, "username is required");
		if (!KINDS.has(kind)) return jsonError(c, 400, "kind must be admin or member");
		const user = await createUser(db, {
			username,
			kind: kind as "admin" | "member",
			displayName: optionalString(body, "displayName"),
			email: optionalString(body, "email"),
			password: optionalString(body, "password"),
		});
		void c.get("audit").record({
			actor: userActor(c.get("user")),
			action: "user.created",
			target: { type: "user", id: user.id },
			detail: { username: user.username, kind: user.kind, display_name: user.displayName },
		});
		return c.json({ user }, 201);
	});

	app.patch("/users/:id", async (c) => {
		const body = await readJsonObject(c);
		if (!body) return jsonError(c, 400, "expected a JSON object");
		const kind = optionalString(body, "kind");
		const status = optionalString(body, "status");
		if (kind !== undefined && !KINDS.has(kind)) return jsonError(c, 400, "kind must be admin or member");
		if (status !== undefined && !STATUSES.has(status)) return jsonError(c, 400, "status must be active or disabled");
		const id = c.req.param("id");
		const user = await updateUser(
			db,
			id,
			{
				displayName: optionalString(body, "displayName"),
				email: body.email === null ? null : optionalString(body, "email"),
				kind: kind as "admin" | "member" | undefined,
				status: status as "active" | "disabled" | undefined,
			},
			{ by: c.get("user").userId },
		);
		if (status === "disabled") {
			await revokeUserWebSessions(db, id);
			// A disabled user's streams end; their next request is a 401 and the client goes to login.
			options.sessions?.endUserStreams(id);
			// Including the per-session event streams, which outlive this request.
			await options.sessions?.publishVisibilityChanged();
			// A disabled owner's schedules stop firing (doc/scheduling.md#生命周期).
			await Scheduler.disableForOwner(db, id, c.get("audit"), userActor(c.get("user")));
		}
		// Administrator and member see different sessions; a reconnect refetches under the new role.
		if (kind !== undefined) {
			options.sessions?.endUserStreams(id);
			await options.sessions?.publishVisibilityChanged();
		}
		void c.get("audit").record({
			actor: userActor(c.get("user")),
			action: "user.updated",
			target: { type: "user", id },
			detail: {
				kind,
				status,
				display_name: body.displayName === undefined ? undefined : user.displayName,
				email_changed: body.email === undefined ? undefined : true,
			},
		});
		return c.json({ user });
	});

	app.post("/users/:id/password", async (c) => {
		const body = await readJsonObject(c);
		const password = body ? optionalString(body, "password") : undefined;
		if (!password) return jsonError(c, 400, "password is required");
		if (body?.revokeApiTokens !== undefined && typeof body.revokeApiTokens !== "boolean") {
			return jsonError(c, 400, "revokeApiTokens must be a boolean");
		}
		const id = c.req.param("id");
		const actor = c.get("user");
		await setPassword(db, id, password);
		await revokeUserWebSessions(db, id);
		// Every open stream of that user now holds a revoked WebUI session; end them with the reset.
		await options.revalidateWebSessions?.(id);
		// Tokens are opt-in: an administrator may reset a password without ending the user's MCP access.
		const revokeApiTokens = body?.revokeApiTokens === true;
		const revokedApiTokens = revokeApiTokens ? await revokeAllApiTokens(db, id) : [];
		await rejectRevokedTokenWaits(db, options.cluster, options.taskGroups, revokedApiTokens, actor.userId);
		void c.get("audit").record({
			actor: userActor(actor),
			action: "user.password_reset",
			target: { type: "user", id },
			detail: { revoke_api_tokens: revokeApiTokens, revoked_api_tokens: revokedApiTokens.length },
		});
		return c.json({ ok: true });
	});

	app.get("/user-groups", async (c) => c.json({ groups: await listUserGroups(db) }));

	app.get("/user-groups/:id", async (c) => {
		const group = await getUserGroupDetail(db, c.req.param("id"));
		if (!group) return jsonError(c, 404, "no such user group");
		return c.json({ group });
	});

	app.post("/user-groups", async (c) => {
		const body = await readJsonObject(c);
		const name = body ? optionalString(body, "name") : undefined;
		if (!name) return jsonError(c, 400, "name is required");
		const group = await createUserGroup(db, name);
		void c.get("audit").record({
			actor: userActor(c.get("user")),
			action: "user_group.created",
			target: { type: "user_group", id: group.id },
			detail: { name: group.name },
		});
		return c.json({ group }, 201);
	});

	app.patch("/user-groups/:id", async (c) => {
		const body = await readJsonObject(c);
		const name = body ? optionalString(body, "name") : undefined;
		if (!name) return jsonError(c, 400, "name is required");
		const group = await renameUserGroup(db, c.req.param("id"), name);
		if (!group) return jsonError(c, 404, "no such user group");
		void c.get("audit").record({
			actor: userActor(c.get("user")),
			action: "user_group.renamed",
			target: { type: "user_group", id: group.id },
			detail: { name: group.name },
		});
		return c.json({ group });
	});

	app.delete("/user-groups/:id", async (c) => {
		const userGroupId = c.req.param("id");
		// Capture who the user group's shares reached before deleting it: the share rows and memberships go with it.
		const members = await db
			.selectFrom("user_group_members")
			.select("user_id")
			.where("user_group_id", "=", userGroupId)
			.execute();
		const shares = await db
			.selectFrom("shares")
			.select("resource_id")
			.where("resource_type", "=", "session")
			.where("grantee_type", "=", "user_group")
			.where("grantee_id", "=", userGroupId)
			.execute();
		await deleteUserGroup(db, userGroupId);
		const audience = members.map((member) => member.user_id);
		for (const sessionId of new Set(shares.map((share) => share.resource_id))) {
			await options.sessions?.publishShareRemoved(sessionId, audience);
		}
		// The deleted shares also close per-session event streams the members had open.
		await options.sessions?.publishVisibilityChanged();
		void c.get("audit").record({
			actor: userActor(c.get("user")),
			action: "user_group.deleted",
			target: { type: "user_group", id: c.req.param("id") },
		});
		return c.json({ ok: true });
	});

	app.put("/user-groups/:id/members/:userId", async (c) => {
		await addUserGroupMember(db, c.req.param("id"), c.req.param("userId"));
		await options.sessions?.publishUserGroupMemberChanged(c.req.param("id"), c.req.param("userId"), true);
		await options.sessions?.publishVisibilityChanged();
		void c.get("audit").record({
			actor: userActor(c.get("user")),
			action: "user_group.member_added",
			target: { type: "user_group", id: c.req.param("id") },
			detail: { user_id: c.req.param("userId") },
		});
		return c.json({ ok: true });
	});

	app.delete("/user-groups/:id/members/:userId", async (c) => {
		await removeUserGroupMember(db, c.req.param("id"), c.req.param("userId"));
		await options.sessions?.publishUserGroupMemberChanged(c.req.param("id"), c.req.param("userId"), false);
		await options.sessions?.publishVisibilityChanged();
		void c.get("audit").record({
			actor: userActor(c.get("user")),
			action: "user_group.member_removed",
			target: { type: "user_group", id: c.req.param("id") },
			detail: { user_id: c.req.param("userId") },
		});
		return c.json({ ok: true });
	});

	return app;
}
