/**
 * crhs's authorization signing keys (doc/design/privilege.md "Authorization signing key"): the list an
 * administrator manages and the nodes whose cached trust report trusts each key.
 */

/** A crhs signing key's usable capabilities in a node's `privileged.toml` trust entry. */
export type SigningKeyKind = "execute" | "cosign";

/** One node whose cached trust report trusts a signing key, and with which kinds. */
export interface SigningKeyTrust {
	nodeId: string;
	nodeName: string;
	kinds: SigningKeyKind[];
}

/** One crhs authorization signing key. */
export interface SigningKey {
	/** The secret row id; `DELETE /api/privilege/signing-keys/:id` addresses the key by it. */
	id: string;
	/** The authorized_keys line (`ssh-ed25519 … crhs-signing`) to paste into a node's trust entry. */
	publicKey: string;
	/** OpenSSH `SHA256:…` fingerprint. */
	fingerprint: string;
	/** The administrator's optional label; null when unnamed. */
	name: string | null;
	/** The key's creation time; newer keys are preferred when a node trusts several. */
	createdAt: string;
	/** The nodes whose cached trust report trusts this key, with the kinds they trust it for. */
	trustedBy: SigningKeyTrust[];
}

/** `GET /api/privilege/signing-keys`; newest first. */
export interface SigningKeyListResponse {
	keys: SigningKey[];
}

/** `POST /api/privilege/signing-keys` with an optional name. */
export interface SigningKeyCreateInput {
	name?: string;
}

/** The response of adding a key: its public parts, with an empty `trustedBy` until a node reloads. */
export interface SigningKeyCreateResponse {
	key: SigningKey;
}

/**
 * `DELETE /api/privilege/signing-keys/:id` without `?force=true` while nodes still trust the key: which
 * nodes stand in the way.
 */
export interface SigningKeyDeleteConflict {
	error: string;
	nodes: SigningKeyTrust[];
}
