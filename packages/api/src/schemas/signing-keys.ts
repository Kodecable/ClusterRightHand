/**
 * Runtime schemas for crhs's authorization signing keys (`../signing-keys.ts`,
 * doc/design/privilege.md "Authorization signing key").
 */
import { z } from "zod";

/** A crhs signing key's usable capabilities in a node's `privileged.toml` trust entry. */
export const SigningKeyKindSchema = z.enum(["execute", "cosign"]);

/** One node whose cached trust report trusts a signing key, and with which kinds. */
export const SigningKeyTrustSchema = z
	.object({
		nodeId: z.string(),
		nodeName: z.string(),
		kinds: z.array(SigningKeyKindSchema),
	})
	.meta({ id: "SigningKeyTrust" });

/** One crhs authorization signing key. */
export const SigningKeySchema = z
	.object({
		id: z.string().describe("The secret row id; the delete route addresses the key by it."),
		publicKey: z.string().describe("The authorized_keys line to paste into a node's trust entry."),
		fingerprint: z.string().describe("OpenSSH SHA256:… fingerprint; it identifies the key everywhere."),
		createdAt: z.string(),
		trustedBy: z.array(SigningKeyTrustSchema),
	})
	.meta({ id: "SigningKey" });

/** `GET /api/privilege/signing-keys`; newest first. */
export const SigningKeyListResponseSchema = z
	.object({ keys: z.array(SigningKeySchema) })
	.meta({ id: "SigningKeyListResponse" });

/** `POST /api/privilege/signing-keys` takes no body: a key is identified by its fingerprint. */
export const SigningKeyCreateInputSchema = z.object({}).strict();

/** The response of adding a key: its public parts, with an empty `trustedBy` until a node reloads. */
export const SigningKeyCreateResponseSchema = z
	.object({ key: SigningKeySchema })
	.meta({ id: "SigningKeyCreateResponse" });

/**
 * `DELETE /api/privilege/signing-keys/{id}` without force while nodes still trust the key: which nodes
 * stand in the way.
 */
export const SigningKeyDeleteConflictSchema = z
	.object({
		error: z.string(),
		nodes: z.array(SigningKeyTrustSchema),
	})
	.meta({ id: "SigningKeyDeleteConflict" });

/** `DELETE /api/privilege/signing-keys/{id}`: `force` overrides a remaining trust entry. */
export const SigningKeyDeleteBodySchema = z.object({ force: z.boolean().optional() });

/** Query parameter of the signing key delete route; `force=true` overrides a remaining trust entry. */
export const SigningKeyDeleteQuerySchema = z.object({ force: z.string().optional() });
