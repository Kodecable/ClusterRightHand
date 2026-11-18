import { REGISTER_NAMESPACE, signSshsig } from "../../src/privilege/sshsig.ts";
import type { App } from "./api.ts";
import { call } from "./api.ts";
import type { TestSshKey } from "./authenticator.ts";

/** The armored SSHSIG file `ssh-keygen -Y sign` writes; the registration route accepts this form. */
export function armorSshsig(blob: Uint8Array): string {
	const body = Buffer.from(blob)
		.toString("base64")
		.replace(/.{1,70}/g, "$&\n");
	return `-----BEGIN SSH SIGNATURE-----\n${body}-----END SSH SIGNATURE-----\n`;
}

/**
 * Registers an SSH signing credential the way the WebUI does: request a challenge, sign its exact
 * bytes with the key, submit the signature. `armored` exercises the paste form ssh-keygen writes.
 */
export async function registerSshCredential(
	app: App,
	cookie: string,
	key: TestSshKey,
	name?: string,
	options: { armored?: boolean } = {},
) {
	const challenge = await call(app, "/api/me/signing-credentials/ssh/challenge", {
		method: "POST",
		cookie,
		body: {},
	});
	if (challenge.status !== 200) throw new Error(`challenge: ${challenge.status} ${await challenge.text()}`);
	const { challenge: encoded } = (await challenge.json()) as { challenge: string };
	const challengeBytes = Uint8Array.from(Buffer.from(encoded, "base64url"));
	const blob = signSshsig(key.privateKey, key.blob, challengeBytes, { namespace: REGISTER_NAMESPACE });
	const signature = options.armored ? armorSshsig(blob) : Buffer.from(blob).toString("base64");
	return call(app, "/api/me/signing-credentials/ssh", { cookie, body: { signature, name } });
}
