/**
 * Signing recipes of a waiting authorization (doc/design/privilege.md "Authorizations"): the
 * `crha grant` command and the equivalent manual `ssh-keygen -Y sign` steps.
 * Kept out of the React component so they can be tested directly.
 */

/** The `crha grant` command that signs the payload with the owner's SSH key. */
export function grantCommand(payload: string): string {
	return `crha grant --payload ${payload} --key ~/.ssh/id_ed25519`;
}

/** The equivalent manual `ssh-keygen -Y sign` recipe: write the exact bytes, sign, then wrap them. */
export function sshKeygenRecipe(payload: string): string {
	return [
		`printf %s '${payload}' | base64 -d > crh-payload.bin`,
		"ssh-keygen -Y sign -n crh-auth-v1 -f ~/.ssh/id_ed25519 crh-payload.bin",
		"# crh-payload.bin.sig is the armored SSHSIG; `crha grant --payload` adds it to the authorization",
	].join("\n");
}
