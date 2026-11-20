/**
 * Runtime schemas for a user's signing credentials (`../users.ts`,
 * doc/design/privilege.md "Signing methods"): SSH public keys and Passkeys.
 */
import { z } from "zod";

/** One of the user's signing credentials; a private key never leaves the browser. */
export const SigningCredentialViewSchema = z
	.object({
		id: z.string(),
		kind: z.enum(["ssh", "webauthn"]),
		name: z.string(),
		createdAt: z.string(),
		publicKey: z.string().describe("ssh: the authorized_keys line; webauthn: the COSE public key, base64."),
		fingerprint: z.string().nullable().describe("ssh only: the fingerprint a trust entry's key carries."),
		credentialId: z.string().nullable().describe("webauthn only: the base64url credential id."),
		rpId: z.string().nullable(),
		origins: z.array(z.string()),
	})
	.meta({ id: "SigningCredentialView" });

export const SigningCredentialsResponseSchema = z.object({
	signingCredentials: z.array(SigningCredentialViewSchema),
});

export const SigningCredentialResponseSchema = z.object({ signingCredential: SigningCredentialViewSchema });

/** `POST /api/me/signing-credentials/ssh/challenge`: the exact bytes to sign and the deadline. */
export const SshSigningChallengeResponseSchema = z
	.object({
		challenge: z.string().describe("Base64url of the bytes to sign; `crhu register` decodes it."),
		expiresAt: z.string().describe("ISO 8601; the registration must be submitted before this time."),
	})
	.meta({ id: "SshSigningChallenge" });

/**
 * `POST /api/me/signing-credentials/ssh`: the SSHSIG over the challenge. The public key is taken from
 * the signature, so a user can only register a key it can sign with.
 */
export const SshSigningCredentialBodySchema = z.object({
	signature: z
		.string()
		.describe("The armored SSHSIG over the challenge, or its base64 blob; namespace `crh-register-v1`."),
	name: z.string().optional().describe("A display name; the key is also its own identity."),
});

/** `PATCH /api/me/signing-credentials/{id}`: a new display name; the key and its identity are unchanged. */
export const SigningCredentialRenameBodySchema = z.object({
	name: z.string().trim().min(1).max(100).describe("The new display name, 1 to 100 characters after trimming."),
});

/** The registration options a browser passes to `navigator.credentials.create`. */
export const WebauthnCreationOptionsSchema = z
	.object({
		challenge: z.string().describe("Base64url; the server keeps the matching challenge and uses it once."),
		rp: z.object({ id: z.string().optional(), name: z.string() }),
		user: z.object({ id: z.string(), name: z.string(), displayName: z.string() }),
		pubKeyCredParams: z.array(z.object({ type: z.string(), alg: z.number() })),
		timeout: z.number().optional(),
		excludeCredentials: z.array(z.object({ id: z.string(), type: z.string() })).optional(),
		authenticatorSelection: z.unknown().optional(),
		hints: z.array(z.string()).optional(),
		attestation: z.string().optional(),
		attestationFormats: z.array(z.string()).optional(),
		extensions: z.unknown().optional(),
	})
	.meta({ id: "WebauthnCreationOptions" });

export const WebauthnOptionsResponseSchema = z.object({ options: WebauthnCreationOptionsSchema });

/** The attestation response the browser sends back (the WebAuthn JSON form). */
export const WebauthnRegistrationResponseSchema = z.object({
	id: z.string(),
	rawId: z.string(),
	response: z
		.object({
			clientDataJSON: z.string(),
			attestationObject: z.string(),
			authenticatorData: z.string().optional(),
			transports: z.array(z.string()).optional(),
			publicKeyAlgorithm: z.number().optional(),
			publicKey: z.string().optional(),
		})
		.loose(),
	type: z.string(),
	clientExtensionResults: z.record(z.string(), z.unknown()).optional(),
	authenticatorAttachment: z.string().optional(),
});

/** `POST /api/me/signing-credentials/webauthn`: the attestation response for a challenge this user started. */
export const WebauthnSigningCredentialBodySchema = z.object({
	name: z.string().optional(),
	response: WebauthnRegistrationResponseSchema.describe("The registration response from the authenticator."),
});
