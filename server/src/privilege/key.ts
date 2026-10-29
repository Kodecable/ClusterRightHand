/**
 * crhs's authorization signing key (doc/privilege.md#授权签名密钥): an ed25519 key generated on the
 * first start, encrypted in `secrets` with the master key exactly like the Noise identity, and the
 * SSHSIG signer built on node:crypto.
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from "node:crypto";
import { secretAad } from "../keys/export.ts";
import type { MasterKey } from "../keys/master-key.ts";
import type { Db } from "../storage/db.ts";
import { defaultOrgId } from "../users/service.ts";
import { newId } from "../util/id.ts";
import { authorizedKeyLine, ed25519PublicBlob, signSshsig, sshFingerprint } from "./sshsig.ts";

/** The `secrets.kind` of the key (crhs keys export lists it). */
export const AUTHORIZATION_SIGNING_KEY_KIND = "authorization_signing_key";
/** The authorized_keys comment of the public key. */
export const AUTHORIZATION_SIGNING_KEY_COMMENT = "crhs-signing";

export interface AuthorizationSigningKey {
	readonly publicKey: KeyObject;
	/** SSH wire-format ed25519 public key blob (what the fingerprint hashes). */
	readonly publicKeyBlob: Uint8Array;
	/** `ssh-ed25519 <base64> crhs-signing`, to paste into a node's privileged.toml trust entry. */
	readonly authorizedKey: string;
	/** OpenSSH `SHA256:…` fingerprint, matching TrustSummary's TrustKey fingerprint. */
	readonly fingerprint: string;
	/** SSHSIG (binary, unarmored) over the payload bytes, namespace crh-auth-v1, sha512. */
	sign(payload: Uint8Array): Uint8Array;
}

/** The key material of one loaded or created key; the private key is never exported beyond this module. */
function publicParts(publicKey: KeyObject): { publicKeyBlob: Uint8Array; authorizedKey: string; fingerprint: string } {
	const publicKeyBlob = ed25519PublicBlob(publicKey);
	return {
		publicKeyBlob,
		authorizedKey: authorizedKeyLine("ssh-ed25519", publicKeyBlob, AUTHORIZATION_SIGNING_KEY_COMMENT),
		fingerprint: sshFingerprint(publicKeyBlob),
	};
}

/** Loads crhs's authorization signing key from `secrets`, creating it on first start. */
export async function loadAuthorizationSigningKey(db: Db, masterKey: MasterKey): Promise<AuthorizationSigningKey> {
	const row = await db
		.selectFrom("secrets")
		.selectAll()
		.where("kind", "=", AUTHORIZATION_SIGNING_KEY_KIND)
		.orderBy("created_at", "desc")
		.executeTakeFirst();
	let privateKey: KeyObject;
	if (row) {
		privateKey = createPrivateKey({
			key: masterKey.decrypt(row.ciphertext, secretAad(row.id, row.kind)),
			format: "der",
			type: "pkcs8",
		});
	} else {
		const generated = generateKeyPairSync("ed25519");
		privateKey = generated.privateKey;
		const id = newId();
		await db
			.insertInto("secrets")
			.values({
				id,
				org_id: await defaultOrgId(db),
				kind: AUTHORIZATION_SIGNING_KEY_KIND,
				ciphertext: masterKey.encrypt(
					generated.privateKey.export({ format: "der", type: "pkcs8" }),
					secretAad(id, AUTHORIZATION_SIGNING_KEY_KIND),
				),
				created_at: new Date().toISOString(),
			})
			.execute();
	}
	const publicKey = createPublicKey(privateKey);
	const parts = publicParts(publicKey);
	return {
		publicKey,
		...parts,
		sign: (payload) => signSshsig(privateKey, parts.publicKeyBlob, payload),
	};
}
