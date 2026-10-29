import { afterEach, beforeEach, expect, it } from "vitest";
import { buildKeyExport, secretAad, verifyKeyExportAgainstDb } from "../src/keys/export.ts";
import { bindMasterKey, MasterKey } from "../src/keys/master-key.ts";
import { AUTHORIZATION_SIGNING_KEY_KIND, loadAuthorizationSigningKey } from "../src/privilege/key.ts";
import { parseAuthorizedKey, verifySshsig } from "../src/privilege/sshsig.ts";
import type { Db } from "../src/storage/db.ts";
import { defaultOrgId } from "../src/users/service.ts";
import { describeBackends, openTestDb } from "./helpers/db.ts";

describeBackends("authorization signing key", (backend) => {
	let db: Db;
	let key: MasterKey;
	beforeEach(async () => {
		db = await openTestDb(backend);
		key = MasterKey.generate();
		await bindMasterKey(db, key);
	});
	afterEach(async () => {
		await db.destroy();
	});

	it("creates one ed25519 key on first load and reuses it", async () => {
		const first = await loadAuthorizationSigningKey(db, key);
		const second = await loadAuthorizationSigningKey(db, key);
		expect(second.fingerprint).toBe(first.fingerprint);
		expect(second.authorizedKey).toBe(first.authorizedKey);
		expect(first.authorizedKey).toMatch(/^ssh-ed25519 [A-Za-z0-9+/]+=* crhs-signing$/);
		expect(first.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]+$/);
		expect(parseAuthorizedKey(first.authorizedKey).keyType).toBe("ssh-ed25519");
		const rows = await db
			.selectFrom("secrets")
			.select(["kind", "ciphertext"])
			.where("kind", "=", AUTHORIZATION_SIGNING_KEY_KIND)
			.execute();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.ciphertext).not.toContain("PRIVATE");
	});

	it("signs payload bytes with an SSHSIG the verifier accepts", async () => {
		const signing = await loadAuthorizationSigningKey(db, key);
		const payload = Buffer.from("authorization payload bytes");
		const blob = signing.sign(payload);
		expect(verifySshsig(signing.authorizedKey, payload, blob)).toMatchObject({
			valid: true,
			keyType: "ssh-ed25519",
			userVerified: false,
		});
		expect(verifySshsig(signing.authorizedKey, Buffer.from("other"), blob).valid).toBe(false);
	});

	it("is part of crhs keys export and restores from it", async () => {
		const signing = await loadAuthorizationSigningKey(db, key);
		const data = await buildKeyExport(db, key);
		const exported = data.keys.find((k) => k.kind === AUTHORIZATION_SIGNING_KEY_KIND);
		if (!exported) throw new Error("authorization signing key is missing from the export");
		expect((await verifyKeyExportAgainstDb(db, data)).id).toBe(key.id);

		// The export carries the private key, so a fresh database with the same master key recreates the
		// same public key (the import path stores the row, then loadAuthorizationSigningKey reads it).
		const restored = await openTestDb(backend);
		try {
			await bindMasterKey(restored, key);
			await restored
				.insertInto("secrets")
				.values({
					id: exported.id,
					org_id: await defaultOrgId(restored),
					kind: AUTHORIZATION_SIGNING_KEY_KIND,
					ciphertext: key.encrypt(
						Buffer.from(exported.value, "base64"),
						secretAad(exported.id, AUTHORIZATION_SIGNING_KEY_KIND),
					),
					created_at: new Date().toISOString(),
				})
				.execute();
			const loaded = await loadAuthorizationSigningKey(restored, key);
			expect(loaded.fingerprint).toBe(signing.fingerprint);
			expect(loaded.authorizedKey).toBe(signing.authorizedKey);
		} finally {
			await restored.destroy();
		}
	});

	it("fails closed when the stored ciphertext is damaged", async () => {
		await loadAuthorizationSigningKey(db, key);
		await db
			.updateTable("secrets")
			.set({ ciphertext: key.encrypt(Buffer.from("not a key"), "wrong-aad") })
			.where("kind", "=", AUTHORIZATION_SIGNING_KEY_KIND)
			.execute();
		await expect(loadAuthorizationSigningKey(db, key)).rejects.toThrow();
	});
});
