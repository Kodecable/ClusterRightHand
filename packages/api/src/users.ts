/**
 * Users, user groups and the directory (doc/access-control.md "用户模型").
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

/** `GET /api/directory`: who a session, a token rule or a share may name. */
export interface Directory {
	users: { id: string; username: string; displayName: string }[];
	userGroups: { id: string; name: string }[];
}

/** One of the user's signing credentials (doc/m4.md M4.4). */
export interface CredentialView {
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
