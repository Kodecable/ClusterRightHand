import type { SigningCredentialView } from "@crh/api";

/** A TOML basic string; the only characters that need escaping are the quote and the backslash. */
export function tomlString(value: string): string {
	return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/** Standard base64 to the unpadded base64url the node's trust config uses for COSE keys. */
export function toBase64url(base64: string): string {
	return base64.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** The key id a signing credential row shows: the SSH fingerprint or the WebAuthn credential id. */
export function signingCredentialKeyId(credential: SigningCredentialView): string {
	return credential.kind === "ssh" ? (credential.fingerprint ?? "") : (credential.credentialId ?? "");
}

/** A TOML array of basic strings, e.g. `["execute", "cosign"]`. */
function tomlStrings(values: readonly string[]): string {
	return `[${values.map(tomlString).join(", ")}]`;
}

/** One `[[trust]]` table with its fields aligned at the column the node's examples use. */
function trustEntry(fields: readonly (readonly [string, string])[]): string {
	return ["[[trust]]", ...fields.map(([name, value]) => `${name.padEnd(13)} = ${value}`)].join("\n");
}

/** A user entry name that is unused and never shadows crhs's own entry. */
function uniqueName(name: string, used: Set<string>): string {
	let candidate = name;
	for (let index = 2; used.has(candidate) || candidate === "crhs"; index++) {
		candidate = `${name}-${index}`;
	}
	used.add(candidate);
	return candidate;
}

/**
 * The `[[trust]]` entries for a node's privileged.toml (doc/design/privilege.md "Trust configuration"):
 * crhs's signing key plus, when the user picks any, their own signing credentials. Without selected
 * credentials crhs may authorize on its own; with them crhs only countersigns. Only the basic fields are
 * emitted; limits and guard rules are edited by hand on the node.
 */
export function buildTrustConfig(crhsKey: string, credentials: SigningCredentialView[]): string {
	const entries = [
		trustEntry([
			["name", tomlString("crhs")],
			["role", tomlString("crhs")],
			["format", tomlString("sshsig")],
			["key", tomlString(crhsKey)],
			["kinds", tomlStrings(credentials.length === 0 ? ["execute"] : ["cosign"])],
		]),
	];
	const used = new Set(["crhs"]);
	for (const credential of credentials) {
		const fields: [string, string][] = [
			["name", tomlString(uniqueName(credential.name, used))],
			["role", tomlString("user")],
		];
		if (credential.kind === "ssh") {
			fields.push(["format", tomlString("sshsig")], ["key", tomlString(credential.publicKey)]);
		} else {
			fields.push(
				["format", tomlString("webauthn")],
				["rp_id", tomlString(credential.rpId ?? "")],
				["origins", tomlStrings(credential.origins)],
				["credential_id", tomlString(credential.credentialId ?? "")],
				["key", tomlString(`cose:${toBase64url(credential.publicKey)}`)],
			);
		}
		fields.push(["kinds", tomlStrings(["execute", "require-cosign"])]);
		entries.push(trustEntry(fields));
	}
	return `${entries.join("\n\n")}\n`;
}
