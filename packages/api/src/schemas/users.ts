/**
 * Runtime schemas for users, user groups and the directory (`../users.ts`,
 * doc/design/access-control.md "User model").
 */
import { z } from "zod";

export const UserKindSchema = z.enum(["admin", "member"]);
export const UserStatusSchema = z.enum(["active", "disabled"]);

/** A user as the API shows it; the password hash is never part of it. */
export const UserSchema = z
	.object({
		id: z.string(),
		username: z.string(),
		displayName: z.string(),
		email: z.string().nullable(),
		kind: UserKindSchema,
		status: UserStatusSchema,
		createdAt: z.string(),
	})
	.meta({ id: "User" });

export const UserGroupRefSchema = z
	.object({
		id: z.string(),
		name: z.string(),
	})
	.meta({ id: "UserGroupRef" });

export const UserGroupSchema = z
	.object({
		id: z.string(),
		name: z.string(),
		source: z.literal("local"),
		createdAt: z.string(),
		memberIds: z.array(z.string()),
	})
	.meta({ id: "UserGroup" });

/** `GET /api/users/{id}`: the user's view plus the user groups it belongs to. */
export const UserDetailSchema = z
	.object({
		user: UserSchema,
		userGroups: z.array(UserGroupRefSchema),
	})
	.meta({ id: "UserDetail" });

/** One member of a user group, as `GET /api/user-groups/{id}` lists it. */
export const UserGroupMemberSchema = z
	.object({
		id: z.string(),
		username: z.string(),
		displayName: z.string(),
	})
	.meta({ id: "UserGroupMember" });

/** `GET /api/user-groups/{id}`: the group, its creation time and its members. */
export const UserGroupDetailSchema = z
	.object({
		id: z.string(),
		name: z.string(),
		createdAt: z.string(),
		members: z.array(UserGroupMemberSchema),
	})
	.meta({ id: "UserGroupDetail" });

export const DirectoryUserSchema = z.object({
	id: z.string(),
	username: z.string(),
	displayName: z.string(),
});

export const DirectoryUserGroupSchema = z.object({ id: z.string(), name: z.string() });

/** `GET /api/directory`: who a session, a token rule or a share may name. */
export const DirectorySchema = z
	.object({
		users: z.array(DirectoryUserSchema),
		userGroups: z.array(DirectoryUserGroupSchema),
	})
	.meta({ id: "Directory" });

/** `GET /api/users`; `more` is present only with `limit`. */
export const UserListResponseSchema = z.object({
	users: z.array(UserSchema),
	more: z.boolean().optional().describe("Present only with `limit`: whether more users match."),
});

/** `GET /api/user-groups`; `more` is present only with `limit`. */
export const UserGroupListResponseSchema = z.object({
	groups: z.array(UserGroupSchema),
	more: z.boolean().optional().describe("Present only with `limit`: whether more groups match."),
});

/** `GET /api/directory`; `more` is present only with `limit` and covers either list. */
export const DirectoryResponseSchema = DirectorySchema.extend({
	more: z.boolean().optional().describe("Present only with `limit`: whether either list was cut."),
}).meta({ id: "DirectoryResponse" });

export const UserResponseSchema = z.object({ user: UserSchema });
export const UserGroupResponseSchema = z.object({ group: UserGroupSchema });
export const UserGroupDetailResponseSchema = z.object({ group: UserGroupDetailSchema });

/** `POST /api/users`. */
export const UserCreateBodySchema = z.object({
	username: z.string().describe("1-64 characters of a-z, 0-9, '.', '_' or '-', starting with a letter."),
	kind: UserKindSchema.optional().describe('"member" by default.'),
	displayName: z.string().optional().describe("Defaults to the username."),
	email: z.string().optional(),
	password: z.string().optional().describe("At least 8 characters; a user without one cannot log in."),
});

/** `PATCH /api/users/{id}`; omitted fields keep their value, `email: null` clears it. */
export const UserPatchBodySchema = z.object({
	displayName: z.string().optional(),
	email: z.string().nullable().optional(),
	kind: UserKindSchema.optional(),
	status: UserStatusSchema.optional(),
});

/** `POST /api/users/{id}/password`: an administrator's reset. */
export const UserPasswordBodySchema = z.object({
	password: z.string(),
	revokeApiTokens: z.boolean().optional().describe("Also revoke the user's API tokens; false by default."),
});

/** `POST /api/user-groups` and `PATCH /api/user-groups/{id}`. */
export const UserGroupNameBodySchema = z.object({
	name: z.string().describe("Case-insensitive, unique; a user group name starts with a letter."),
});

/** Path parameter of `PUT`/`DELETE /api/user-groups/{id}/members/{userId}`. */
export const UserGroupMemberParamSchema = z.object({ id: z.string(), userId: z.string() });
