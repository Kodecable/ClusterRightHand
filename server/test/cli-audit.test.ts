import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendCliAudit, cliDetail } from "../src/audit/cli.ts";
import { addUser, changePassword, exportKeys, importKeys, initKeys } from "../src/cli/commands.ts";
import { loadServerIdentity } from "../src/cluster/identity.ts";
import type { Config } from "../src/config.ts";
import { buildKeyExport, decryptKeyExport, encryptKeyExport } from "../src/keys/export.ts";
import { readMasterKeyFile } from "../src/keys/master-key.ts";
import { initMasterKey } from "../src/keys/setup.ts";
import { loadAuthorizationSigningKeys } from "../src/privilege/key.ts";
import type { Db } from "../src/storage/db.ts";
import { findUserByUsername } from "../src/users/service.ts";
import { openTestDb } from "./helpers/db.ts";

const WORK_FACTOR = 10; // age's scrypt work factor; the default (18) takes about a second

/** The detail every CLI event starts with. */
const cli = cliDetail();

function configFor(masterKeyFile: string): Config {
	return {
		listen: { host: "127.0.0.1", port: 18080 },
		database: { driver: "sqlite", path: ":memory:" },
		masterKeyFile,
		webRoot: "",
	};
}

describe("CLI audit", () => {
	let db: Db;
	let dir: string;

	const rows = () => db.selectFrom("audit_events").selectAll().orderBy("seq").execute();
	const detailOf = async (action: string): Promise<Record<string, unknown>> => {
		const row = (await rows()).find((event) => event.action === action);
		if (!row) throw new Error(`no ${action} event`);
		return JSON.parse(row.detail) as Record<string, unknown>;
	};

	beforeEach(async () => {
		db = await openTestDb("sqlite");
		dir = await mkdtemp(join(tmpdir(), "crhs-cli-audit-"));
	});

	afterEach(async () => {
		await db.destroy();
		await rm(dir, { recursive: true, force: true });
	});

	it("falls back to the process uid and USER when userInfo throws", () => {
		const detail = cliDetail({ USER: "fallback-user" }, () => {
			throw new Error("no passwd entry");
		});
		expect(detail).toMatchObject({ via: "cli", os_user: "fallback-user" });
		expect(detail.uid).toBe(process.getuid?.() ?? null);
	});

	it("records user add with the cli actor and the WebUI event shape", async () => {
		const user = await addUser(db, "alice", { password: "alice-password", kind: "member" });
		const [event] = await rows();
		expect(event).toMatchObject({
			actor_type: "system",
			actor_id: "cli",
			on_behalf_of_user_id: null,
			action: "user.created",
			target_type: "user",
			target_id: user.id,
		});
		expect(await detailOf("user.created")).toEqual({
			...cli,
			username: "alice",
			kind: "member",
			display_name: "alice",
		});
		expect(JSON.stringify(event)).not.toContain("alice-password");
	});

	it("does not create a user when the audit row cannot be written", async () => {
		await expect(
			addUser(db, "bob", {
				password: "bob-password",
				kind: "member",
				audit: async () => {
					throw new Error("audit unavailable");
				},
			}),
		).rejects.toThrow("audit unavailable");
		expect(await findUserByUsername(db, "bob")).toBeUndefined();
		expect(await rows()).toEqual([]);
	});

	it("records user passwd as user.password_reset", async () => {
		const user = await addUser(db, "carol", { password: "carol-password", kind: "member" });
		await changePassword(db, "carol", "new-carol-password");
		const event = (await rows()).find((row) => row.action === "user.password_reset");
		expect(event).toMatchObject({
			actor_type: "system",
			actor_id: "cli",
			target_type: "user",
			target_id: user.id,
		});
		expect(JSON.parse(event?.detail ?? "{}")).toEqual({
			...cli,
			revoke_api_tokens: false,
			revoked_api_tokens: 0,
		});
		expect(JSON.stringify(event)).not.toContain("new-carol-password");
	});

	it("records keys init with the non-secret master key id", async () => {
		const path = join(dir, "master.key");
		const key = await initKeys(configFor(path), db);
		expect((await readFile(path, "utf8")).trim()).toBe(key.toBase64());
		const event = (await rows())[0];
		expect(event).toMatchObject({ actor_type: "system", actor_id: "cli", action: "keys.initialized" });
		expect(JSON.parse(event?.detail ?? "{}")).toEqual({
			...cli,
			master_key_file: path,
			master_key_id: key.id,
		});
		expect(JSON.stringify(event)).not.toContain(key.toBase64());
	});

	it("records keys export with the exported key fingerprints, not their values", async () => {
		const path = join(dir, "master.key");
		const out = join(dir, "export.age");
		const config = configFor(path);
		const key = await initMasterKey(path, db);
		const identity = await loadServerIdentity(db, key);
		const signingKeys = await loadAuthorizationSigningKeys(db, key);
		const data = await exportKeys(config, db, out, "export passphrase", { workFactor: WORK_FACTOR });

		const detail = await detailOf("keys.exported");
		expect(detail).toMatchObject({ ...cli, out, master_key_included: true });
		expect(detail.keys).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: "server_identity_key", fingerprint: identity.fingerprint }),
				expect.objectContaining({
					id: signingKeys.newest?.id,
					kind: "authorization_signing_key",
					fingerprint: signingKeys.newest?.fingerprint,
				}),
			]),
		);
		const text = JSON.stringify(detail);
		expect(text).not.toContain(key.toBase64());
		expect(text).not.toContain("export passphrase");
		for (const k of data.keys) expect(text).not.toContain(k.value);
		// The file itself still holds the encrypted export.
		expect((await decryptKeyExport(await readFile(out, "utf8"), "export passphrase")).keys).toHaveLength(2);
	});

	it("removes the export when its audit row cannot be written", async () => {
		const path = join(dir, "master.key");
		const out = join(dir, "export.age");
		await initMasterKey(path, db);
		await expect(
			exportKeys(configFor(path), db, out, "export passphrase", {
				workFactor: WORK_FACTOR,
				audit: async () => {
					throw new Error("audit unavailable");
				},
			}),
		).rejects.toThrow("the export was removed because it could not be audited");
		await expect(stat(out)).rejects.toMatchObject({ code: "ENOENT" });
		expect(await rows()).toEqual([]);
	});

	it("records keys import with the export's path", async () => {
		const path = join(dir, "master.key");
		const file = join(dir, "export.age");
		const key = await initMasterKey(path, db);
		await loadServerIdentity(db, key);
		await loadAuthorizationSigningKeys(db, key);
		const data = await buildKeyExport(db, key);
		const encrypted = await encryptKeyExport(data, "export passphrase", WORK_FACTOR);
		await writeFile(file, encrypted);
		// The restore writes a new key file, so the old one must be gone first.
		await rm(path);

		const restored = await importKeys(configFor(path), db, file, "export passphrase");
		expect(restored.id).toBe(key.id);
		expect((await readMasterKeyFile(path)).id).toBe(key.id);
		const event = (await rows())[0];
		expect(event).toMatchObject({ actor_type: "system", actor_id: "cli", action: "keys.imported" });
		expect(JSON.parse(event?.detail ?? "{}")).toEqual({ ...cli, file, master_key_id: key.id });
		expect(JSON.stringify(event)).not.toContain("export passphrase");
	});

	it("default writer appends through the audit log", async () => {
		await appendCliAudit(db, {
			actor: { type: "system", id: "cli" },
			action: "test.append",
			detail: { ok: true },
		});
		expect((await rows())[0]).toMatchObject({ action: "test.append", actor_id: "cli" });
	});
});
