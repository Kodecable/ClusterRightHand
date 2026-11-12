/**
 * Users, user groups and the directory (doc/design/access-control.md "User model").
 * The server's `PublicUser` is this `User`.
 */

export type UserKind = "admin" | "member";
export type UserStatus = "active" | "disabled";

export interface User {
	id: string;
	username: string;
	displayName: string;
	email: string | null;
	kind: UserKind;
	status: UserStatus;
	createdAt: string;
}

export interface UserGroup {
	id: string;
	name: string;
	source: "local";
	createdAt: string;
	memberIds: string[];
}

/** A user group as it appears on another record (a user's memberships). */
export interface UserGroupRef {
	id: string;
	name: string;
}

/** `GET /api/users/:id`: the user's view plus the user groups it belongs to. */
export interface UserDetail {
	user: User;
	userGroups: UserGroupRef[];
}

/** One member of a user group, as `GET /api/user-groups/:id` lists it. */
export interface UserGroupMember {
	id: string;
	username: string;
	displayName: string;
}

/** `GET /api/user-groups/:id`: the group, its creation time and its members. */
export interface UserGroupDetail {
	id: string;
	name: string;
	createdAt: string;
	members: UserGroupMember[];
}

/** `GET /api/directory`: who a session, a token rule or a share may name. */
export interface Directory {
	users: { id: string; username: string; displayName: string }[];
	userGroups: { id: string; name: string }[];
}

/** `GET /api/users`; `more` is present only with `limit` (doc/design/webui.md "Entity search"). */
export interface UserListResponse {
	users: User[];
	more?: boolean;
}

/** `GET /api/user-groups`; `more` is present only with `limit`. */
export interface UserGroupListResponse {
	groups: UserGroup[];
	more?: boolean;
}

/** `GET /api/directory`; `more` is present only with `limit` and covers either list. */
export interface DirectoryResponse extends Directory {
	more?: boolean;
}

/** One of the user's signing credentials (doc/design/privilege.md "Signing methods"). */
export interface SigningCredentialView {
	id: string;
	kind: "ssh" | "webauthn";
	name: string;
	createdAt: string;
	/** ssh: the authorized_keys line; webauthn: the COSE public key, base64. */
	publicKey: string;
	/** ssh only: the fingerprint a trust entry's key carries. */
	fingerprint: string | null;
	/** webauthn only. */
	credentialId: string | null;
	rpId: string | null;
	origins: string[];
}
