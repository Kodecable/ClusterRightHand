import { createPrivateKey } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { keyPairFromPrivate } from "@crh/noise";
import type { AuditInput } from "../audit/audit.ts";
import { appendCliAudit, cliInput } from "../audit/cli.ts";
import { keyFingerprint } from "../cluster/identity.ts";
import type { Config } from "../config.ts";
import { buildKeyExport, decryptKeyExport, encryptKeyExport, type KeyExport } from "../keys/export.ts";
import { bindMasterKey, KeyError, type MasterKey, readMasterKeyFile } from "../keys/master-key.ts";
import { initMasterKey, restoreMasterKey } from "../keys/setup.ts";
import { signingKeyFingerprint } from "../privilege/key.ts";
import type { Db } from "../storage/db.ts";
import { createUser, findUserByUsername, setPassword } from "../users/service.ts";
import { UserError } from "../util/errors.ts";

/** Writes one audit event; injectable so a test can make the write fail. */
export type AuditWriter = (db: Db, input: AuditInput) => Promise<void>;

export interface CliCommandOptions {
	audit?: AuditWriter;
}

export interface ExportOptions extends CliCommandOptions {
	/** age's scrypt work factor; the CLI uses age's default (18), tests a cheaper one. */
	workFactor?: number;
}

export interface AddUserOptions extends CliCommandOptions {
	password: string;
	kind: "admin" | "member";
	displayName?: string;
}

/**
 * `crhs user add`: the user and its `user.created` event are written in one transaction, so a user is
 * never created without a record of who did it.
 */
export async function addUser(
	db: Db,
	username: string,
	options: AddUserOptions,
): Promise<{ id: string; username: string; kind: string }> {
	const audit = options.audit ?? appendCliAudit;
	return db.transaction().execute(async (trx) => {
		const user = await createUser(trx, {
			username,
			password: options.password,
			kind: options.kind,
			displayName: options.displayName,
		});
		await audit(
			trx,
			cliInput(
				"user.created",
				{ username: user.username, kind: user.kind, display_name: user.displayName },
				{ type: "user", id: user.id },
			),
		);
		return user;
	});
}

/** `crhs user passwd`: `user.password_reset` has the WebUI event's shape, plus the CLI detail. */
export async function changePassword(
	db: Db,
	username: string,
	password: string,
	options: CliCommandOptions = {},
): Promise<{ id: string; username: string }> {
	const audit = options.audit ?? appendCliAudit;
	const user = await findUserByUsername(db, username);
	if (!user) throw new UserError(`no such user: ${username}`);
	await db.transaction().execute(async (trx) => {
		await setPassword(trx, user.id, password);
		await audit(
			trx,
			cliInput(
				"user.password_reset",
				// The CLI does not revoke API tokens, so the fields the WebUI event carries say "none".
				{ revoke_api_tokens: false, revoked_api_tokens: 0 },
				{ type: "user", id: user.id },
			),
		);
	});
	return { id: user.id, username: user.username };
}

/** `crhs keys init`: create the master key file, then record `keys.initialized` with its non-secret id. */
export async function initKeys(config: Config, db: Db, options: CliCommandOptions = {}): Promise<MasterKey> {
	const key = await initMasterKey(config.masterKeyFile, db);
	try {
		await (options.audit ?? appendCliAudit)(
			db,
			cliInput("keys.initialized", { master_key_file: config.masterKeyFile, master_key_id: key.id }),
		);
	} catch (err) {
		throw new KeyError(
			`the master key was created but its audit record could not be written: ${(err as Error).message}`,
		);
	}
	return key;
}

/**
 * `crhs keys export`: write the encrypted file first, then its audit row. An export that cannot be
 * audited is removed again: the caller may not keep a copy the log does not know about.
 */
export async function exportKeys(
	config: Config,
	db: Db,
	out: string,
	passphrase: string,
	options: ExportOptions = {},
): Promise<KeyExport> {
	const key = await readMasterKeyFile(config.masterKeyFile);
	await bindMasterKey(db, key);
	const data = await buildKeyExport(db, key);
	try {
		await writeFile(out, await encryptKeyExport(data, passphrase, options.workFactor), {
			mode: 0o600,
			flag: "wx",
		});
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "EEXIST") throw new KeyError(`${out} already exists`);
		throw err;
	}
	try {
		await (options.audit ?? appendCliAudit)(
			db,
			cliInput("keys.exported", {
				out,
				master_key_included: true,
				keys: keySummaries(data),
			}),
		);
	} catch {
		await rm(out, { force: true }).catch((cleanupError: unknown) => {
			console.error(`crhs: could not remove ${out} after the audit record failed:`, cleanupError);
		});
		throw new KeyError("the export was removed because it could not be audited");
	}
	return data;
}

/** `crhs keys import`: restore the master key file, then record `keys.imported` with the export's path. */
export async function importKeys(
	config: Config,
	db: Db,
	file: string,
	passphrase: string,
	options: CliCommandOptions = {},
): Promise<MasterKey> {
	const data = await decryptKeyExport(await readFile(file, "utf8"), passphrase);
	const key = await restoreMasterKey(config.masterKeyFile, db, data);
	try {
		await (options.audit ?? appendCliAudit)(db, cliInput("keys.imported", { file, master_key_id: key.id }));
	} catch (err) {
		throw new KeyError(
			`the master key was restored but its audit record could not be written: ${(err as Error).message}`,
		);
	}
	return key;
}

/** Non-secret identities of the keys in an export, so an audit row can name what left the server. */
function keySummaries(data: KeyExport): { id: string; kind: string; fingerprint: string }[] {
	return data.keys.map((key) => {
		const raw = Buffer.from(key.value, "base64");
		const fingerprint =
			key.kind === "server_identity_key"
				? keyFingerprint(keyPairFromPrivate(raw).publicKey)
				: signingKeyFingerprint(createPrivateKey({ key: raw, format: "der", type: "pkcs8" }));
		return { id: key.id, kind: key.kind, fingerprint };
	});
}
