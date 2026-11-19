/**
 * Signing recipes of a waiting authorization and of an SSH signing-credential registration
 * (doc/design/privilege.md "Signing methods"): the `crhu` commands and the equivalent manual
 * `ssh-keygen -Y sign` steps. Kept out of the React components so they can be tested directly, and
 * in the shared `lib/` layer so the shared decision components may use them.
 */

/**
 * The largest base64 spec that still fits on one command line. A larger one exceeds the argument
 * size limit, so the command reads it from standard input instead.
 */
export const SPEC_ARGUMENT_LIMIT = 100 * 1024;

/**
 * The `crhu sign` command that signs the payload. A payload whose command limit is a spec carries only the
 * hash, so the complete spec (`--spec`) accompanies it; a large one is read from standard input with a
 * heredoc. The fingerprints are the owner's SSH credentials that match the plan's user entries; they only
 * help `crhu` choose the key. A prefix or unrestricted payload has nothing to check the spec against, so
 * `--spec` is left out for it.
 */
export function grantCommand(payload: string, spec?: string, fingerprints: readonly string[] = []): string {
	const hints = fingerprints.map((fingerprint) => ` --hint ${fingerprint}`).join("");
	const head = `crhu sign --payload ${payload}${hints}`;
	if (spec === undefined) return head;
	if (spec.length > SPEC_ARGUMENT_LIMIT) return `${head} --spec - <<'EOF'\n${spec}\nEOF`;
	return `${head} --spec ${spec}`;
}

/**
 * The equivalent manual `ssh-keygen -Y sign` recipe: write the exact bytes and sign them. The
 * resulting armored SSHSIG is not submitted by itself: the authorizations endpoint takes the
 * base64 Authorization that `crhu sign` prints.
 */
export function sshKeygenRecipe(payload: string): string {
	return [
		`printf %s '${payload}' | base64 -d > crh-payload.bin`,
		"ssh-keygen -Y sign -n crh-auth-v1 -f ~/.ssh/id_ed25519 crh-payload.bin",
		"# crh-payload.bin.sig is the armored SSHSIG; `crhu sign` prints the base64 Authorization the API takes",
	].join("\n");
}

/** The `crhu register` command for an SSH signing-credential challenge. */
export function sshRegistrationCommand(challenge: string): string {
	return `crhu register ${challenge}`;
}

/**
 * The manual equivalent: decode the standard-base64 challenge bytes and sign them in the
 * registration namespace. The armored `.sig` can be pasted into the WebUI as-is.
 */
export function sshRegistrationRecipe(challenge: string): string {
	return [
		`printf %s '${base64urlToBase64(challenge)}' | base64 -d > crh-register.bin`,
		"ssh-keygen -Y sign -n crh-register-v1 -f ~/.ssh/id_ed25519 crh-register.bin",
		"# paste crh-register.bin.sig into the signature box",
	].join("\n");
}

/** Converts the API's unpadded base64url challenge to the padded standard base64 `base64 -d` takes. */
export function base64urlToBase64(value: string): string {
	const standard = value.replaceAll("-", "+").replaceAll("_", "/");
	const padding = standard.length % 4;
	return padding === 2 ? `${standard}==` : padding === 3 ? `${standard}=` : standard;
}
