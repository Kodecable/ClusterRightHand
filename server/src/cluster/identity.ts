import { createHash } from "node:crypto";
import { generateKeyPair, type KeyPair, keyPairFromPrivate } from "@crh/noise";
import { secretAad } from "../keys/export.ts";
import type { MasterKey } from "../keys/master-key.ts";
import type { Db } from "../storage/db.ts";
import { defaultOrgId } from "../users/service.ts";
import { newId } from "../util/id.ts";

const KIND = "server_identity_key";

/** The fingerprint that enrollment tokens carry: base64url(SHA-256(public key)). */
export function keyFingerprint(publicKey: Uint8Array): string {
	return createHash("sha256").update(publicKey).digest("base64url");
}

export interface ServerIdentity {
	keyPair: KeyPair;
	fingerprint: string;
}

/** Loads crhs's Noise static key from `secrets`, creating it on first start. */
export async function loadServerIdentity(db: Db, masterKey: MasterKey): Promise<ServerIdentity> {
	const row = await db
		.selectFrom("secrets")
		.selectAll()
		.where("kind", "=", KIND)
		.orderBy("created_at", "desc")
		.executeTakeFirst();
	let keyPair: KeyPair;
	if (row) {
		keyPair = keyPairFromPrivate(masterKey.decrypt(row.ciphertext, secretAad(row.id, row.kind)));
	} else {
		keyPair = generateKeyPair();
		const id = newId();
		await db
			.insertInto("secrets")
			.values({
				id,
				org_id: await defaultOrgId(db),
				kind: KIND,
				ciphertext: masterKey.encrypt(keyPair.privateKey, secretAad(id, KIND)),
				created_at: new Date().toISOString(),
			})
			.execute();
	}
	return { keyPair, fingerprint: keyFingerprint(keyPair.publicKey) };
}
