import { Hono } from "hono";
import { revokeUserWebSessions } from "../auth/sessions.ts";
import type { Db } from "../storage/db.ts";
import {
	addGroupMember,
	createUserGroup,
	deleteUserGroup,
	listUserGroups,
	removeGroupMember,
} from "../users/groups.ts";
import {
	createUser,
	listUsers,
	NotFoundError,
	setPassword,
	toPublicUser,
	UserError,
	updateUser,
} from "../users/service.ts";
import { type AppEnv, jsonError, optionalString, readJsonObject } from "./context.ts";
import { requireAdmin } from "./middleware.ts";

const KINDS = new Set(["admin", "member"]);
const STATUSES = new Set(["active", "disabled"]);

/** Expects requireUser to have run. */
export function userRoutes(db: Db) {
	const app = new Hono<AppEnv>();

	app.onError((err, c) => {
		if (err instanceof NotFoundError) return jsonError(c, 404, err.message);
		if (err instanceof UserError || err instanceof TypeError) return jsonError(c, 400, err.message);
		throw err;
	});

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
		const user = await updateUser(db, id, {
			displayName: optionalString(body, "displayName"),
			email: body.email === null ? null : optionalString(body, "email"),
			kind: kind as "admin" | "member" | undefined,
			status: status as "active" | "disabled" | undefined,
		});
		if (status === "disabled") await revokeUserWebSessions(db, id);
		return c.json({ user });
	});

	app.post("/users/:id/password", async (c) => {
		const body = await readJsonObject(c);
		const password = body ? optionalString(body, "password") : undefined;
		if (!password) return jsonError(c, 400, "password is required");
		const id = c.req.param("id");
		await setPassword(db, id, password);
		await revokeUserWebSessions(db, id);
		return c.json({ ok: true });
	});

	app.get("/user-groups", async (c) => c.json({ groups: await listUserGroups(db) }));

	app.post("/user-groups", async (c) => {
		const body = await readJsonObject(c);
		const name = body ? optionalString(body, "name") : undefined;
		if (!name) return jsonError(c, 400, "name is required");
		return c.json({ group: await createUserGroup(db, name) }, 201);
	});

	app.delete("/user-groups/:id", async (c) => {
		await deleteUserGroup(db, c.req.param("id"));
		return c.json({ ok: true });
	});

	app.put("/user-groups/:id/members/:userId", async (c) => {
		await addGroupMember(db, c.req.param("id"), c.req.param("userId"));
		return c.json({ ok: true });
	});

	app.delete("/user-groups/:id/members/:userId", async (c) => {
		await removeGroupMember(db, c.req.param("id"), c.req.param("userId"));
		return c.json({ ok: true });
	});

	return app;
}
