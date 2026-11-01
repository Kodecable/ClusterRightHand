import { Hono } from "hono";
import type { SessionListHub } from "../agent/session-list.ts";
import { userActor } from "../audit/audit.ts";
import { revokeUserWebSessions } from "../auth/sessions.ts";
import { Scheduler } from "../scheduler/scheduler.ts";
import type { Db } from "../storage/db.ts";
import {
	addGroupMember,
	createUserGroup,
	deleteUserGroup,
	listUserGroups,
	removeGroupMember,
} from "../users/groups.ts";
import { createUser, listUsers, setPassword, toPublicUser, updateUser } from "../users/service.ts";
import { type AppEnv, jsonError, optionalString, readJsonObject } from "./context.ts";
import { requireAdmin } from "./middleware.ts";

const KINDS = new Set(["admin", "member"]);
const STATUSES = new Set(["active", "disabled"]);

export interface UserRoutesOptions {
	/** The session list stream: membership and account changes alter what a user may see. */
	sessions?: SessionListHub;
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
		const id = c.req.param("id");
		await setPassword(db, id, password);
		await revokeUserWebSessions(db, id);
		void c.get("audit").record({
			actor: userActor(c.get("user")),
			action: "user.password_reset",
			target: { type: "user", id },
		});
		return c.json({ ok: true });
	});

	app.get("/user-groups", async (c) => c.json({ groups: await listUserGroups(db) }));

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

	app.delete("/user-groups/:id", async (c) => {
		const groupId = c.req.param("id");
		// Capture who the group's shares reached before deleting it: the share rows and memberships go with it.
		const members = await db
			.selectFrom("user_group_members")
			.select("user_id")
			.where("group_id", "=", groupId)
			.execute();
		const shares = await db
			.selectFrom("shares")
			.select("resource_id")
			.where("resource_type", "=", "session")
			.where("grantee_type", "=", "user_group")
			.where("grantee_id", "=", groupId)
			.execute();
		await deleteUserGroup(db, groupId);
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
		await addGroupMember(db, c.req.param("id"), c.req.param("userId"));
		await options.sessions?.publishGroupMemberChanged(c.req.param("id"), c.req.param("userId"), true);
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
		await removeGroupMember(db, c.req.param("id"), c.req.param("userId"));
		await options.sessions?.publishGroupMemberChanged(c.req.param("id"), c.req.param("userId"), false);
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
