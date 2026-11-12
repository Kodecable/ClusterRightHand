import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
	buildKeyExport,
	decryptKeyExport,
	encryptKeyExport,
	secretAad,
	verifyKeyExportAgainstDb,
} from "../src/keys/export.ts";
import { bindMasterKey, boundMasterKeyId, KeyError, MasterKey, readMasterKeyFile } from "../src/keys/master-key.ts";
import { initMasterKey, restoreMasterKey } from "../src/keys/setup.ts";
import type { Db } from "../src/storage/db.ts";
import { defaultOrgId } from "../src/storage/org.ts";
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

describeBackends("master key setup", (backend) => {
	let db: Db;
	let dir: string;
	let path: string;

	beforeEach(async () => {
		db = await openTestDb(backend);
		dir = await mkdtemp(join(tmpdir(), "crh-keys-"));
		path = join(dir, "master.key");
	});
	afterEach(async () => {
		await db.destroy();
		await rm(dir, { recursive: true, force: true });
	});

	it("init writes the file first and binds the database only after that", async () => {
		const key = await initMasterKey(path, db);
		expect((await stat(path)).mode & 0o777).toBe(0o600);
		expect((await readMasterKeyFile(path)).id).toBe(key.id);
		expect(await boundMasterKeyId(db)).toBe(key.id);
	});

	it("init leaves the database unbound and an existing file untouched", async () => {
		const existing = "an existing key file that must not be replaced\n";
		await writeFile(path, existing, { mode: 0o600 });

		await expect(initMasterKey(path, db)).rejects.toThrow(/already exists/);
		expect(await boundMasterKeyId(db)).toBeUndefined();
		expect(await readFile(path, "utf8")).toBe(existing);
	});

	it("init removes the new file when the database belongs to another key", async () => {
		const bound = MasterKey.generate();
		await bindMasterKey(db, bound);

		await expect(initMasterKey(path, db)).rejects.toThrow(KeyError);
		expect(await boundMasterKeyId(db)).toBe(bound.id);
		await expect(readFile(path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("import writes the file first and binds the database only after that", async () => {
		const key = MasterKey.generate();
		const restored = await restoreMasterKey(path, db, await buildKeyExport(db, key));
		expect(restored.id).toBe(key.id);
		expect((await readMasterKeyFile(path)).id).toBe(key.id);
		expect(await boundMasterKeyId(db)).toBe(key.id);
	});

	it("import leaves the database unbound and an existing file untouched", async () => {
		const key = MasterKey.generate();
		const data = await buildKeyExport(db, key);
		const existing = "an existing key file that must not be replaced\n";
		await writeFile(path, existing, { mode: 0o600 });

		await expect(restoreMasterKey(path, db, data)).rejects.toThrow(/already exists/);
		expect(await boundMasterKeyId(db)).toBeUndefined();
		expect(await readFile(path, "utf8")).toBe(existing);
	});

	it("import refuses an export from another key without writing a file", async () => {
		const bound = MasterKey.generate();
		await bindMasterKey(db, bound);
		const data = await buildKeyExport(db, MasterKey.generate());

		await expect(restoreMasterKey(path, db, data)).rejects.toThrow(/does not belong/);
		expect(await boundMasterKeyId(db)).toBe(bound.id);
		await expect(readFile(path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
	});
});
