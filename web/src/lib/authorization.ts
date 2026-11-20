/**
 * Signing recipes of a waiting authorization, of a reusable authorization and of an SSH signing-credential
 * registration (doc/design/privilege.md "Signing methods"): the `crhu` commands, the equivalent manual
 * `ssh-keygen -Y sign` steps, and signing a drafted payload with a Passkey. Kept out of the React components
 * so they can be tested directly, and in the shared `lib/` layer so the shared decision components may use
 * them.
 */
import type { AuthorizationDraft, AuthorizationDraftBody, AuthorizationMethod } from "@crh/api";
import { startAuthentication } from "@simplewebauthn/browser";
import { http } from "@/lib/api/client";

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

/** Quotes one argument for a POSIX shell: single quotes, with each embedded quote closed and escaped. */
export function shellArgument(value: string): string {
	if (/^[A-Za-z0-9_./:=,@%+-]+$/.test(value)) return value;
	return `'${value.replaceAll("'", "'\\''")}'`;
}

/** A reusable authorization's limit: a method and a target prefix (empty for every target), or any command. */
export type ReusableCommand = { method: AuthorizationMethod; prefix: string } | null;

/**
 * The `crhu grant` command for a reusable authorization (doc/design/webui.md "Authorizations"): crhu builds and
 * signs the payload itself, so the command carries everything the payload says. An empty prefix is passed as
 * `--prefix ''`, which crhu takes as every target of the method.
 */
export function reusableGrantCommand(input: {
	nodes: readonly string[];
	command: ReusableCommand;
	/** A crhu `--deadline` duration such as `5m` or `720h`. */
	deadline: string;
	note?: string;
	fingerprints?: readonly string[];
}): string {
	const parts = ["crhu grant", `--nodes ${shellArgument(input.nodes.join(","))}`];
	if (input.command === null) parts.push("--any-command");
	else parts.push(`--method ${input.command.method}`, `--prefix ${shellArgument(input.command.prefix)}`);
	parts.push(`--deadline ${input.deadline}`);
	if (input.note !== undefined && input.note !== "") parts.push(`--note ${shellArgument(input.note)}`);
	for (const fingerprint of input.fingerprints ?? []) parts.push(`--hint ${fingerprint}`);
	return parts.join(" ");
}

/** Asks crhs to build a reusable payload to sign; nothing is stored until it comes back signed. */
export function draftAuthorization(body: AuthorizationDraftBody): Promise<AuthorizationDraft> {
	return http.post<{ draft: AuthorizationDraft }>("/authorizations/draft", body).then((r) => r.draft);
}

/** A Passkey that can sign: the credential, its relying party and whether user verification is required. */
export interface SigningPasskey {
	credentialId: string;
	rpId: string;
	requireUv?: boolean;
}

/**
 * Drafts a reusable payload and signs it with one Passkey: the body `POST /authorizations` takes. The payload
 * is the one the assertion signed, so a submission always matches its signature.
 */
export async function signDraftWithPasskey(
	body: AuthorizationDraftBody,
	passkey: SigningPasskey,
): Promise<{ payload: string; webauthn: unknown }> {
	const draft = await draftAuthorization(body);
	const webauthn = await startAuthentication({
		optionsJSON: {
			rpId: passkey.rpId,
			challenge: draft.challenge,
			allowCredentials: [{ id: passkey.credentialId, type: "public-key" }],
			userVerification: passkey.requireUv ? "required" : "preferred",
			timeout: 60_000,
		},
	});
	return { payload: draft.payload, webauthn };
}

/** The duration a waiting page's short reusable authorization lasts: five minutes. */
export const SHORT_GRANT_SECONDS = 5 * 60;
