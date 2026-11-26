/**
 * crhs's authorization signing keys (doc/design/privilege.md "Authorization signing key"): the list an
 * administrator manages and the nodes whose cached trust report trusts each key.
 */

import type { z } from "zod";
import type {
	SigningKeyCreateInputSchema,
	SigningKeyCreateResponseSchema,
	SigningKeyDeleteConflictSchema,
	SigningKeyKindSchema,
	SigningKeyListResponseSchema,
	SigningKeySchema,
	SigningKeyTrustSchema,
	TrustConfigResponseSchema,
} from "./schemas/signing-keys.ts";

/** A crhs signing key's usable capabilities in a node's `privileged.toml` trust entry. */
export type SigningKeyKind = z.infer<typeof SigningKeyKindSchema>;

/** One node whose cached trust report trusts a signing key, and with which kinds. */
export type SigningKeyTrust = z.infer<typeof SigningKeyTrustSchema>;

/** One crhs authorization signing key. */
export type SigningKey = z.infer<typeof SigningKeySchema>;

/** `GET /api/privilege/signing-keys`; newest first. */
export type SigningKeyListResponse = z.infer<typeof SigningKeyListResponseSchema>;

/** `POST /api/privilege/signing-keys` takes no body: a key is identified by its fingerprint. */
export type SigningKeyCreateInput = z.infer<typeof SigningKeyCreateInputSchema>;

/** The response of adding a key: its public parts, with an empty `trustedBy` until a node reloads. */
export type SigningKeyCreateResponse = z.infer<typeof SigningKeyCreateResponseSchema>;

/**
 * `DELETE /api/privilege/signing-keys/:id` without `?force=true` while nodes still trust the key: which
 * nodes stand in the way.
 */
export type SigningKeyDeleteConflict = z.infer<typeof SigningKeyDeleteConflictSchema>;

/**
 * `GET /api/privilege/trust-config`: the entries to paste into a node's `privileged.toml` and the crhs
 * key they carry (doc/design/privilege.md "Trust configuration").
 */
export type TrustConfigResponse = z.infer<typeof TrustConfigResponseSchema>;
