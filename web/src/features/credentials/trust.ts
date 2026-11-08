import type { CredentialView } from "@crh/api";

/** A TOML basic string; the only characters that need escaping are the quote and the backslash. */
export function tomlString(value: string): string {
	return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/** Standard base64 to the unpadded base64url the node's trust config uses for COSE keys. */
export function toBase64url(base64: string): string {
	return base64.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/**
 * The `[[trust]]` block for a node's privileged.toml that trusts crhs's signing
 * key (doc/privilege.md#信任配置). The allow/deny lists are examples: the
 * operator narrows them to what crhs may do on that node, and denying
 * `/etc/crha/` keeps crhs out of the trust configuration.
 */
export function trustSnippet(authorizedKey: string): string {
	return [
		"[[trust]]",
		'name          = "crhs"',
		'role          = "crhs"',
		'format        = "sshsig"',
		`key           = ${tomlString(authorizedKey)}`,
		'kinds         = ["execute", "cosign"]',
		"require_exact = true",
		'max_ttl       = "5m"',
		"",
		"# Allow the commands crhs may authorize on this node.",
		"allow = [",
		'\t{ method = "exec", prefix = "systemctl restart " },',
		'\t{ method = "file.read", prefix = "/var/log/" },',
		"]",
		"",
		"# crhs must not be able to change this node's privileged configuration.",
		"deny = [",
		'\t{ method = "file.write", prefix = "/etc/crha/" },',
		"]",
		"",
	].join("\n");
}

/**
 * The `[[trust]]` block for an SSH key or Passkey the user registered
 * (doc/privilege.md#信任配置, doc/m4.md M4.4). The allow and deny lists are
 * examples to narrow: the owner edits them on the node before the credential
 * can authorize anything. `require_uv` and `max_ttl` are commented out because
 * they are policy choices, not defaults.
 */
export function credentialTrustSnippet(credential: CredentialView): string {
	const lines = ["[[trust]]", `name          = ${tomlString(credential.name)}`, 'role          = "user"'];
	if (credential.kind === "ssh") {
		lines.push('format        = "sshsig"', `key           = ${tomlString(credential.publicKey)}`);
	} else {
		lines.push(
			'format        = "webauthn"',
			`rp_id         = ${tomlString(credential.rpId ?? "")}`,
			`origins       = [${credential.origins.map(tomlString).join(", ")}]`,
			`credential_id = ${tomlString(credential.credentialId ?? "")}`,
			`key           = ${tomlString(`cose:${toBase64url(credential.publicKey)}`)}`,
		);
	}
	lines.push(
		'kinds         = ["execute"]',
		"",
		credential.kind === "ssh"
			? "# Require user verification (a FIDO touch with PIN); only sk-* SSH keys can assert it."
			: "# Require user verification (a PIN or biometrics) for this credential.",
		"# require_uv = true",
		"# Longest lifetime a signature of this credential may have; omit for no limit.",
		'# max_ttl   = "24h"',
		"",
		"# What this credential may authorize on this node: narrow it before trusting the key.",
		"allow = [",
		'\t{ method = "exec", prefix = "systemctl restart " },',
		"]",
		"deny = [",
		'\t{ method = "file.write", prefix = "/etc/crha/" },',
		"]",
		"",
	);
	return lines.join("\n");
}
