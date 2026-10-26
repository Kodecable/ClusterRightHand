import { afterEach, beforeEach, expect, it } from "vitest";
import {
	buildKeyExport,
	decryptKeyExport,
	encryptKeyExport,
	secretAad,
	verifyKeyExportAgainstDb,
} from "../src/keys/export.ts";
import { bindMasterKey, KeyError, MasterKey } from "../src/keys/master-key.ts";
import type { Db } from "../src/storage/db.ts";
import { defaultOrgId } from "../src/users/service.ts";
import { describeBackends, openTestDb } from "./helpers/db.ts";

const WORK_FACTOR = 10; // age's scrypt work factor; the default (18) takes about a second

it("encrypts with associated data", () => {
	const key = MasterKey.generate();
	const ct = key.encrypt(Buffer.from("secret"), "a");
	expect(key.decrypt(ct, "a").toString()).toBe("secret");
	expect(() => key.decrypt(ct, "b")).toThrow(KeyError);
	expect(() => MasterKey.generate().decrypt(ct, "a")).toThrow(KeyError);
	expect(key.encrypt(Buffer.from("secret"), "a")).not.toBe(ct);
});

describeBackends("key export", (backend) => {
	let db: Db;
	let key: MasterKey;
	beforeEach(async () => {
		db = await openTestDb(backend);
		key = MasterKey.generate();
		await bindMasterKey(db, key);
		const orgId = await defaultOrgId(db);
		const id = "0190a000-0000-7000-8000-000000000001";
		await db
			.insertInto("secrets")
			.values({
				id,
				org_id: orgId,
				kind: "server_identity_key",
				ciphertext: key.encrypt(Buffer.from("identity"), secretAad(id, "server_identity_key")),
				created_at: new Date().toISOString(),
			})
			.execute();
	});
	afterEach(async () => {
		await db.destroy();
	});

	it("round-trips through a passphrase-encrypted file and verifies against the database", async () => {
		const file = await encryptKeyExport(await buildKeyExport(db, key), "pass phrase", WORK_FACTOR);
		expect(file).toMatch(/^-----BEGIN AGE ENCRYPTED FILE-----/);
		await expect(decryptKeyExport(file, "wrong")).rejects.toThrow(KeyError);

		const data = await decryptKeyExport(file, "pass phrase");
		expect(data.keys).toEqual([expect.objectContaining({ kind: "server_identity_key", value: btoa("identity") })]);
		expect((await verifyKeyExportAgainstDb(db, data)).id).toBe(key.id);
	});

	it("refuses a mismatched master key", async () => {
		await expect(bindMasterKey(db, MasterKey.generate())).rejects.toThrow(/mismatch/);
		const other = await openTestDb(backend);
		try {
			await bindMasterKey(other, MasterKey.generate());
			const data = await buildKeyExport(db, key);
			await expect(verifyKeyExportAgainstDb(other, data)).rejects.toThrow(/does not belong/);
		} finally {
			await other.destroy();
		}
	});
});
