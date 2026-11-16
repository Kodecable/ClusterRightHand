import {
	DirectoryResponseSchema,
	EntityListQuerySchema,
	ErrorResponseSchema,
	IdParamSchema,
	OkResponseSchema,
	UserCreateBodySchema,
	UserDetailSchema,
	UserGroupDetailResponseSchema,
	UserGroupListResponseSchema,
	UserGroupMemberParamSchema,
	UserGroupNameBodySchema,
	UserGroupResponseSchema,
	UserListResponseSchema,
	UserPasswordBodySchema,
	UserPatchBodySchema,
	UserResponseSchema,
} from "@crh/api/schemas";
import type { SessionListHub } from "../agent/session-list.ts";
import { userActor } from "../audit/audit.ts";
import { revokeAllApiTokens } from "../auth/api-tokens.ts";
import { revokeUserWebSessions } from "../auth/sessions.ts";
import type { ChannelManager } from "../channels/manager.ts";
import type { Cluster } from "../cluster/cluster.ts";
import { deleteGrantsForUserGroup } from "../cluster/node-access.ts";
import type { TaskGroups } from "../cluster/task-groups.ts";
import { Scheduler } from "../scheduler/scheduler.ts";
import type { SettingsStore } from "../settings/settings.ts";
import type { Db } from "../storage/db.ts";
import {
	createUser,
	getUserDetail,
	queryDirectory,
	queryUsers,
	setPassword,
	toPublicUser,
	updateUser,
} from "../users/service.ts";
import {
	addUserGroupMember,
	createUserGroup,
	deleteUserGroup,
	getUserGroupDetail,
	queryUserGroups,
	removeUserGroupMember,
	renameUserGroup,
} from "../users/user-groups.ts";
import { NotFoundError, UserError } from "../util/errors.ts";
import { cancelRevokedTokenWaits } from "./api-token-waits.ts";
import { requireAdmin, requireAdminOrSelf } from "./middleware.ts";
import { apiRouter, defineRoute, json } from "./openapi.ts";

const TAGS = ["Users"];

const meRoute = defineRoute({
	method: "get",
	path: "/me",
	tags: TAGS,
	summary: "The signed-in user",
	agent: "allow",
	responses: { 200: { description: "The caller", ...json(UserResponseSchema) } },
});

const directoryRoute = defineRoute({
	method: "get",
	path: "/directory",
	tags: TAGS,
	summary: "Search the users and user groups a share or rule may name; names only",
	agent: "allow",
	request: { query: EntityListQuerySchema },
	responses: { 200: { description: "The matching users and user groups", ...json(DirectoryResponseSchema) } },
});

const detailRoute = defineRoute({
	method: "get",
	path: "/users/{id}",
	tags: TAGS,
	summary: "One user with the user groups it belongs to; administrators, or the user themselves",
	agent: "allow",
	middleware: [requireAdminOrSelf],
	request: { params: IdParamSchema },
	responses: { 200: { description: "The user and its user groups", ...json(UserDetailSchema) } },
});

const listRoute = defineRoute({
	method: "get",
	path: "/users",
	tags: TAGS,
	summary: "List the organization's users (administrators)",
	agent: "allow",
	middleware: [requireAdmin],
	request: { query: EntityListQuerySchema },
	responses: {
		200: { description: "The users", ...json(UserListResponseSchema) },
		403: { description: "Administrators only", ...json(ErrorResponseSchema) },
	},
});

const createRoute = defineRoute({
	method: "post",
	path: "/users",
	tags: TAGS,
	summary: "Create a user, optionally with a password (administrators)",
	agent: "deny", // user management
	middleware: [requireAdmin],
	request: { body: { required: true, ...json(UserCreateBodySchema) } },
	responses: {
		201: { description: "The new user", ...json(UserResponseSchema) },
		403: { description: "Administrators only", ...json(ErrorResponseSchema) },
	},
});

const patchRoute = defineRoute({
	method: "patch",
	path: "/users/{id}",
	tags: TAGS,
	summary: "Change a user's display name, email, role or status (administrators)",
	agent: "deny", // roles and status are access control
	middleware: [requireAdmin],
	request: { params: IdParamSchema, body: { required: true, ...json(UserPatchBodySchema) } },
	responses: {
		200: { description: "The updated user", ...json(UserResponseSchema) },
		403: { description: "Administrators only", ...json(ErrorResponseSchema) },
	},
});

const passwordRoute = defineRoute({
	method: "post",
	path: "/users/{id}/password",
	tags: TAGS,
	summary: "Reset a user's password and revoke their WebUI sessions (administrators)",
	agent: "deny", // passwords
	middleware: [requireAdmin],
	request: { params: IdParamSchema, body: { required: true, ...json(UserPasswordBodySchema) } },
	responses: {
		200: { description: "The password was reset", ...json(OkResponseSchema) },
		403: { description: "Administrators only", ...json(ErrorResponseSchema) },
	},
});

const groupsRoute = defineRoute({
	method: "get",
	path: "/user-groups",
	tags: TAGS,
	summary: "List the organization's user groups (administrators)",
	agent: "allow",
	middleware: [requireAdmin],
	request: { query: EntityListQuerySchema },
	responses: {
		200: { description: "The user groups", ...json(UserGroupListResponseSchema) },
		403: { description: "Administrators only", ...json(ErrorResponseSchema) },
	},
});

const groupRoute = defineRoute({
	method: "get",
	path: "/user-groups/{id}",
	tags: TAGS,
	summary: "One user group and its members (administrators)",
	agent: "allow",
	middleware: [requireAdmin],
	request: { params: IdParamSchema },
	responses: {
		200: { description: "The user group", ...json(UserGroupDetailResponseSchema) },
		403: { description: "Administrators only", ...json(ErrorResponseSchema) },
	},
});

const createGroupRoute = defineRoute({
	method: "post",
	path: "/user-groups",
	tags: TAGS,
	summary: "Create an empty user group (administrators)",
	agent: "deny", // group membership reaches shared resources
	middleware: [requireAdmin],
	request: { body: { required: true, ...json(UserGroupNameBodySchema) } },
	responses: {
		201: { description: "The new user group", ...json(UserGroupResponseSchema) },
		403: { description: "Administrators only", ...json(ErrorResponseSchema) },
	},
});

const renameGroupRoute = defineRoute({
	method: "patch",
	path: "/user-groups/{id}",
	tags: TAGS,
	summary: "Rename a user group (administrators)",
	agent: "deny", // group management
	middleware: [requireAdmin],
	request: { params: IdParamSchema, body: { required: true, ...json(UserGroupNameBodySchema) } },
	responses: {
		200: { description: "The renamed user group", ...json(UserGroupResponseSchema) },
		403: { description: "Administrators only", ...json(ErrorResponseSchema) },
	},
});

const deleteGroupRoute = defineRoute({
	method: "delete",
	path: "/user-groups/{id}",
	tags: TAGS,
	summary: "Delete a user group, its memberships, its grants and its shares (administrators)",
	agent: "deny", // group management
	middleware: [requireAdmin],
	request: { params: IdParamSchema },
	responses: {
		200: { description: "Deleted", ...json(OkResponseSchema) },
		403: { description: "Administrators only", ...json(ErrorResponseSchema) },
	},
});

const addMemberRoute = defineRoute({
	method: "put",
	path: "/user-groups/{id}/members/{userId}",
	tags: TAGS,
	summary: "Add a user to a user group; idempotent (administrators)",
	agent: "deny", // membership grants access
	middleware: [requireAdmin],
	request: { params: UserGroupMemberParamSchema },
	responses: {
		200: { description: "The member is in the group", ...json(OkResponseSchema) },
		403: { description: "Administrators only", ...json(ErrorResponseSchema) },
	},
});

const removeMemberRoute = defineRoute({
	method: "delete",
	path: "/user-groups/{id}/members/{userId}",
	tags: TAGS,
	summary: "Remove a user from a user group; idempotent (administrators)",
	agent: "deny", // membership grants access
	middleware: [requireAdmin],
	request: { params: UserGroupMemberParamSchema },
	responses: {
		200: { description: "The member is not in the group", ...json(OkResponseSchema) },
		403: { description: "Administrators only", ...json(ErrorResponseSchema) },
	},
});

export interface UserRoutesOptions {
	/** The session list stream: membership and account changes alter what a user may see. */
	sessions?: SessionListHub;
	/** With taskGroups, rejects the waiting work of tokens an administrator's password reset revokes. */
	cluster?: Cluster;
	taskGroups?: TaskGroups;
	/** Ends the user's per-session SSE streams after a password reset revokes their WebUI sessions. */
	revalidateWebSessions?: (userId: string) => Promise<void> | void;
	/** System settings: a new user or user group copies the default library limits. */
	settings?: SettingsStore;
	/** Chat channels: a disabled user's linked accounts stop. */
	channels?: ChannelManager;
}

/** Expects requireUser to have run. */
export function userRoutes(db: Db, options: UserRoutesOptions = {}) {
	const app = apiRouter();

	app.openapi(meRoute, async (c) => {
		const row = await db.selectFrom("users").selectAll().where("id", "=", c.get("user").userId).executeTakeFirst();
		if (!row) throw new NotFoundError("no such user");
		const { password_hash: _, ...rest } = row;
		return c.json({ user: toPublicUser(rest) }, 200);
	});

	// Everyone in the organization can look up whom to share with; only names, nothing else.
	app.openapi(directoryRoute, async (c) => {
		const params = c.req.valid("query");
		const page = await queryDirectory(db, params);
		return c.json(
			{
				users: page.users,
				userGroups: page.userGroups,
				...(params.limit === undefined ? {} : { more: page.more }),
			},
			200,
		);
	});

	/**
	 * One user's view. Administrators read anyone; everyone else only themselves, and any other id answers
	 * the same 404 a missing user gets (an unprivileged caller never learns whether an account exists).
	 * The other /users routes are administrator-only.
	 */
	app.openapi(detailRoute, async (c) => {
		const { id } = c.req.valid("param");
		const detail = await getUserDetail(db, id);
		if (!detail) throw new NotFoundError("no such user");
		return c.json(detail, 200);
	});

	app.openapi(listRoute, async (c) => {
		const params = c.req.valid("query");
		const page = await queryUsers(db, params);
		return c.json({ users: page.items, ...(params.limit === undefined ? {} : { more: page.more }) }, 200);
	});

	app.openapi(createRoute, async (c) => {
		const body = c.req.valid("json");
		const username = body.username;
		if (!username) throw new UserError("username is required");
		await options.settings?.ensureLoaded(db);
		const user = await createUser(
			db,
			{
				username,
				kind: body.kind ?? "member",
				displayName: body.displayName,
				email: body.email,
				password: body.password,
			},
			options.settings ? { library: options.settings.current().library.user } : {},
		);
		void c.get("audit").record({
			actor: userActor(c.get("user")),
			action: "user.created",
			target: { type: "user", id: user.id },
			detail: { username: user.username, kind: user.kind, display_name: user.displayName },
		});
		return c.json({ user }, 201);
	});

	app.openapi(patchRoute, async (c) => {
		const body = c.req.valid("json");
		const { id } = c.req.valid("param");
		const user = await updateUser(
			db,
			id,
			{
				displayName: body.displayName,
				email: body.email === null ? null : body.email,
				kind: body.kind,
				status: body.status,
			},
			{ by: c.get("user").userId },
		);
		if (body.status === "disabled") {
			await revokeUserWebSessions(db, id);
			// A disabled user's streams end; their next request is a 401 and the client goes to login.
			options.sessions?.endUserStreams(id);
			// Including the per-session event streams, which outlive this request.
			await options.sessions?.publishVisibilityChanged();
			// A disabled owner's schedules stop firing (doc/design/scheduling.md "Lifecycle").
			await Scheduler.disableForOwner(db, id, c.get("audit"), userActor(c.get("user")));
			// Their chat accounts are unlinked (doc/design/channels.md "Accounts").
			await options.channels?.detachUser(id);
		}
		// Administrator and member see different sessions; a reconnect refetches under the new role.
		if (body.kind !== undefined) {
			options.sessions?.endUserStreams(id);
			await options.sessions?.publishVisibilityChanged();
		}
		void c.get("audit").record({
			actor: userActor(c.get("user")),
			action: "user.updated",
			target: { type: "user", id },
			detail: {
				kind: body.kind,
				status: body.status,
				display_name: body.displayName === undefined ? undefined : user.displayName,
				email_changed: body.email === undefined ? undefined : true,
			},
		});
		return c.json({ user }, 200);
	});

	app.openapi(passwordRoute, async (c) => {
		const body = c.req.valid("json");
		if (!body.password) throw new UserError("password is required");
		const { id } = c.req.valid("param");
		const actor = c.get("user");
		await setPassword(db, id, body.password);
		await revokeUserWebSessions(db, id);
		// Every open stream of that user now holds a revoked WebUI session; end them with the reset.
		await options.revalidateWebSessions?.(id);
		// Tokens are opt-in: an administrator may reset a password without ending the user's MCP access.
		const revokeApiTokens = body.revokeApiTokens === true;
		const revokedApiTokens = revokeApiTokens ? await revokeAllApiTokens(db, id) : [];
		await cancelRevokedTokenWaits(db, options.cluster, options.taskGroups, revokedApiTokens, actor.userId);
		void c.get("audit").record({
			actor: userActor(actor),
			action: "user.password_reset",
			target: { type: "user", id },
			detail: { revoke_api_tokens: revokeApiTokens, revoked_api_tokens: revokedApiTokens.length },
		});
		return c.json({ ok: true as const }, 200);
	});

	app.openapi(groupsRoute, async (c) => {
		const params = c.req.valid("query");
		const page = await queryUserGroups(db, params);
		return c.json({ groups: page.items, ...(params.limit === undefined ? {} : { more: page.more }) }, 200);
	});

	app.openapi(groupRoute, async (c) => {
		const { id } = c.req.valid("param");
		const group = await getUserGroupDetail(db, id);
		if (!group) throw new NotFoundError("no such user group");
		return c.json({ group }, 200);
	});

	app.openapi(createGroupRoute, async (c) => {
		const { name } = c.req.valid("json");
		if (!name) throw new UserError("name is required");
		await options.settings?.ensureLoaded(db);
		const group = await createUserGroup(
			db,
			name,
			options.settings ? { library: options.settings.current().library.userGroup } : {},
		);
		void c.get("audit").record({
			actor: userActor(c.get("user")),
			action: "user_group.created",
			target: { type: "user_group", id: group.id },
			detail: { name: group.name },
		});
		return c.json({ group }, 201);
	});

	app.openapi(renameGroupRoute, async (c) => {
		const { name } = c.req.valid("json");
		if (!name) throw new UserError("name is required");
		const { id } = c.req.valid("param");
		const group = await renameUserGroup(db, id, name);
		if (!group) throw new NotFoundError("no such user group");
		void c.get("audit").record({
			actor: userActor(c.get("user")),
			action: "user_group.renamed",
			target: { type: "user_group", id: group.id },
			detail: { name: group.name },
		});
		return c.json({ group }, 200);
	});

	app.openapi(deleteGroupRoute, async (c) => {
		const { id: userGroupId } = c.req.valid("param");
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
		await deleteUserGroup(db, userGroupId, (trx) => deleteGrantsForUserGroup(trx, userGroupId));
		const audience = members.map((member) => member.user_id);
		for (const sessionId of new Set(shares.map((share) => share.resource_id))) {
			await options.sessions?.publishShareRemoved(sessionId, audience);
		}
		// The deleted shares also close per-session event streams the members had open.
		await options.sessions?.publishVisibilityChanged();
		void c.get("audit").record({
			actor: userActor(c.get("user")),
			action: "user_group.deleted",
			target: { type: "user_group", id: userGroupId },
		});
		return c.json({ ok: true as const }, 200);
	});

	app.openapi(addMemberRoute, async (c) => {
		const { id, userId } = c.req.valid("param");
		await addUserGroupMember(db, id, userId);
		await options.sessions?.publishUserGroupMemberChanged(id, userId, true);
		await options.sessions?.publishVisibilityChanged();
		void c.get("audit").record({
			actor: userActor(c.get("user")),
			action: "user_group.member_added",
			target: { type: "user_group", id },
			detail: { user_id: userId },
		});
		return c.json({ ok: true as const }, 200);
	});

	app.openapi(removeMemberRoute, async (c) => {
		const { id, userId } = c.req.valid("param");
		await removeUserGroupMember(db, id, userId);
		await options.sessions?.publishUserGroupMemberChanged(id, userId, false);
		await options.sessions?.publishVisibilityChanged();
		void c.get("audit").record({
			actor: userActor(c.get("user")),
			action: "user_group.member_removed",
			target: { type: "user_group", id },
			detail: { user_id: userId },
		});
		return c.json({ ok: true as const }, 200);
	});

	return app;
}
