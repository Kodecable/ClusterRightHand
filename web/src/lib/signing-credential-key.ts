import type { SigningCredentialView } from "@crh/api";

/** The key id a signing credential row shows: the SSH fingerprint or the WebAuthn credential id. */
export function signingCredentialKeyId(credential: SigningCredentialView): string {
	return credential.kind === "ssh" ? (credential.fingerprint ?? "") : (credential.credentialId ?? "");
}
