/**
 * Users, user groups and the directory (doc/design/access-control.md "User model").
 * The server's `PublicUser` is this `User`; the types are derived from their schemas.
 */

import type { z } from "zod";
import type { SigningCredentialViewSchema } from "./schemas/signing-credentials.ts";
import type {
	DirectoryResponseSchema,
	DirectorySchema,
	UserCreateBodySchema,
	UserDetailSchema,
	UserGroupDetailSchema,
	UserGroupListResponseSchema,
	UserGroupRefSchema,
	UserGroupSchema,
	UserKindSchema,
	UserListResponseSchema,
	UserPatchBodySchema,
	UserSchema,
	UserStatusSchema,
} from "./schemas/users.ts";

export type UserKind = z.infer<typeof UserKindSchema>;
export type UserStatus = z.infer<typeof UserStatusSchema>;

export type User = z.infer<typeof UserSchema>;

export type UserGroup = z.infer<typeof UserGroupSchema>;

/** A user group as it appears on another record (a user's memberships). */
export type UserGroupRef = z.infer<typeof UserGroupRefSchema>;

/** `GET /api/users/:id`: the user's view plus the user groups it belongs to. */
export type UserDetail = z.infer<typeof UserDetailSchema>;

/** One member of a user group, as `GET /api/user-groups/:id` lists it. */
export type UserGroupMember = z.infer<typeof UserGroupDetailSchema>["members"][number];

/** `GET /api/user-groups/:id`: the group, its creation time and its members. */
export type UserGroupDetail = z.infer<typeof UserGroupDetailSchema>;

/** `GET /api/directory`: who a session, a token rule or a share may name. */
export type Directory = z.infer<typeof DirectorySchema>;

/** `GET /api/users`; `more` is present only with `limit` (doc/design/webui.md "Entity search"). */
export type UserListResponse = z.infer<typeof UserListResponseSchema>;

/** `GET /api/user-groups`; `more` is present only with `limit`. */
export type UserGroupListResponse = z.infer<typeof UserGroupListResponseSchema>;

/** `GET /api/directory`; `more` is present only with `limit` and covers either list. */
export type DirectoryResponse = z.infer<typeof DirectoryResponseSchema>;

/** Body of `POST /api/users`. */
export type UserCreateBody = z.infer<typeof UserCreateBodySchema>;

/** Body of `PATCH /api/users/{id}`. */
export type UserPatchBody = z.infer<typeof UserPatchBodySchema>;

/** One of the user's signing credentials (doc/design/privilege.md "Signing methods"). */
export type SigningCredentialView = z.infer<typeof SigningCredentialViewSchema>;
