import type { TrustEntry } from "@crh/protocol";
import { afterEach, beforeEach, expect, it } from "vitest";
import { buildKeyExport, secretAad, verifyKeyExportAgainstDb } from "../src/keys/export.ts";
import { bindMasterKey, MasterKey } from "../src/keys/master-key.ts";
import {
	AUTHORIZATION_SIGNING_KEY_KIND,
	loadAuthorizationSigningKey,
	loadAuthorizationSigningKeys,
	trustedSigningKey,
} from "../src/privilege/key.ts";
import { parseAuthorizedKey, verifySshsig } from "../src/privilege/sshsig.ts";
import type { Db } from "../src/storage/db.ts";
import { defaultOrgId } from "../src/storage/org.ts";
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

	it("loads every key newest first and updates the set when keys are added and deleted", async () => {
		const store = await loadAuthorizationSigningKeys(db, key);
		expect(store.keys).toHaveLength(1);
		const first = store.newest;
		if (!first) throw new Error("missing key");

		const added = await store.add();
		expect(added.fingerprint).toMatch(/^SHA256:/);
		expect(store.keys.map((candidate) => candidate.id)).toEqual([added.id, first.id]);
		expect(store.fingerprints).toEqual([added.fingerprint, first.fingerprint]);

		// A second load sees the same set in the same order.
		const reloaded = await loadAuthorizationSigningKeys(db, key);
		expect(reloaded.fingerprints).toEqual(store.fingerprints);
		expect(reloaded.newest?.fingerprint).toBe(added.fingerprint);

		await store.delete(added.id);
		expect(store.fingerprints).toEqual([first.fingerprint]);
		await expect(store.delete(added.id)).rejects.toThrow(/no such signing key/);
	});

	it("keeps zero keys after the last one was deleted", async () => {
		const store = await loadAuthorizationSigningKeys(db, key);
		const only = store.newest;
		if (!only) throw new Error("missing key");
		await store.delete(only.id);
		expect(store.keys).toEqual([]);

		// The next start must not mistake the explicit deletion for a first start.
		const reloaded = await loadAuthorizationSigningKeys(db, key);
		expect(reloaded.keys).toEqual([]);
		expect(reloaded.describe()).toBe("no signing key");
	});

	it("picks the newest key a node trusts with the needed kind", async () => {
		const store = await loadAuthorizationSigningKeys(db, key);
		const older = store.newest;
		if (!older) throw new Error("missing key");
		const newer = await store.add();
		const entry = (fingerprint: string, kinds: TrustEntry["kinds"]): TrustEntry => ({
			name: fingerprint,
			source: "local",
			role: "crhs",
			key: { kind: "sshsig", publicKey: "ssh-ed25519 AAAA", fingerprint },
			kinds,
			requireExact: false,
			requireTask: false,
			requireUv: false,
			maxTtlMs: null,
			allow: [],
			deny: [],
			envAllow: [],
		});
		// Both keys: the newer wins.
		expect(
			trustedSigningKey(
				store.keys,
				[entry(older.fingerprint, ["execute"]), entry(newer.fingerprint, ["execute"])],
				"execute",
			)?.id,
		).toBe(newer.id);
		// The older key alone is still usable on a node that has not caught up.
		expect(trustedSigningKey(store.keys, [entry(older.fingerprint, ["execute"])], "execute")?.id).toBe(older.id);
		// The newer key only executes: cosigning stays on the older cosign key.
		expect(
			trustedSigningKey(
				store.keys,
				[entry(older.fingerprint, ["cosign"]), entry(newer.fingerprint, ["execute"])],
				"cosign",
			)?.id,
		).toBe(older.id);
		expect(trustedSigningKey(store.keys, [], "execute")).toBeUndefined();
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

	it("exports every signing key and restores all of them", async () => {
		const store = await loadAuthorizationSigningKeys(db, key);
		const older = store.newest;
		if (!older) throw new Error("missing key");
		const newer = await store.add();

		const data = await buildKeyExport(db, key);
		const exported = data.keys.filter((entry) => entry.kind === AUTHORIZATION_SIGNING_KEY_KIND);
		expect(exported).toHaveLength(2);
		expect(exported.every((entry) => !("name" in entry))).toBe(true);

		const restored = await openTestDb(backend);
		try {
			await bindMasterKey(restored, key);
			const orgId = await defaultOrgId(restored);
			for (const entry of exported) {
				await restored
					.insertInto("secrets")
					.values({
						id: entry.id,
						org_id: orgId,
						kind: AUTHORIZATION_SIGNING_KEY_KIND,
						ciphertext: key.encrypt(Buffer.from(entry.value, "base64"), secretAad(entry.id, entry.kind)),
						created_at: new Date().toISOString(),
					})
					.execute();
			}
			const loaded = await loadAuthorizationSigningKeys(restored, key);
			expect([...loaded.fingerprints].sort()).toEqual([older.fingerprint, newer.fingerprint].sort());
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
