import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import type { Db } from "../storage/db.ts";

export const MASTER_KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const FORMAT = "v1";

export class KeyError extends Error {}

/**
 * The master key encrypts the `secrets` table. It lives in a file named by `master_key_file`, never in the
 * database; see doc/execution-plane.md#密钥.
 */
export class MasterKey {
	readonly #key: Buffer;

	constructor(key: Uint8Array) {
		if (key.length !== MASTER_KEY_BYTES) throw new KeyError(`master key must be ${MASTER_KEY_BYTES} bytes`);
		this.#key = Buffer.from(key);
	}

	static generate(): MasterKey {
		return new MasterKey(randomBytes(MASTER_KEY_BYTES));
	}

	/** A stable, non-secret identifier, stored in the database to detect a mismatched key file. */
	get id(): string {
		return createHmac("sha256", this.#key).update("crh-master-key-id").digest("hex").slice(0, 32);
	}

	toBase64(): string {
		return this.#key.toString("base64");
	}

	/** AES-256-GCM; `aad` binds the ciphertext to its context (for secrets: id and kind). */
	encrypt(plaintext: Uint8Array, aad: string): string {
		const nonce = randomBytes(NONCE_BYTES);
		const cipher = createCipheriv("aes-256-gcm", this.#key, nonce).setAAD(Buffer.from(aad));
		const body = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
		return `${FORMAT}.${nonce.toString("base64url")}.${body.toString("base64url")}`;
	}

	decrypt(ciphertext: string, aad: string): Buffer {
		const [format, nonceText, bodyText] = ciphertext.split(".");
		if (format !== FORMAT || !nonceText || !bodyText) throw new KeyError("unsupported ciphertext format");
		const nonce = Buffer.from(nonceText, "base64url");
		const body = Buffer.from(bodyText, "base64url");
		if (nonce.length !== NONCE_BYTES || body.length < TAG_BYTES) throw new KeyError("malformed ciphertext");
		const decipher = createDecipheriv("aes-256-gcm", this.#key, nonce)
			.setAAD(Buffer.from(aad))
			.setAuthTag(body.subarray(body.length - TAG_BYTES));
		try {
			return Buffer.concat([decipher.update(body.subarray(0, body.length - TAG_BYTES)), decipher.final()]);
		} catch {
			throw new KeyError("decryption failed: wrong master key or corrupted data");
		}
	}
}

export async function writeMasterKeyFile(path: string, key: MasterKey): Promise<void> {
	try {
		await writeFile(path, `${key.toBase64()}\n`, { mode: 0o600, flag: "wx" });
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "EEXIST") throw new KeyError(`${path} already exists`);
		if (code === "ENOENT") throw new KeyError(`cannot create ${path}: the directory does not exist`);
		if (code === "EACCES") throw new KeyError(`cannot create ${path}: permission denied`);
		throw err;
	}
}

export async function readMasterKeyFile(path: string): Promise<MasterKey> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			throw new KeyError(`master key file ${path} not found; create one with "crhs keys init"`);
		}
		throw err;
	}
	const info = await stat(path);
	if ((info.mode & 0o077) !== 0) {
		throw new KeyError(`master key file ${path} must not be accessible by group or others (chmod 600)`);
	}
	const key = Buffer.from(text.trim(), "base64");
	if (key.length !== MASTER_KEY_BYTES || key.toString("base64") !== text.trim()) {
		throw new KeyError(`master key file ${path} is not ${MASTER_KEY_BYTES} bytes of base64`);
	}
	return new MasterKey(key);
}

const MASTER_KEY_ID = "master_key_id";

/** Records the key id on first use; afterwards refuses a key file that does not match the database. */
export async function bindMasterKey(db: Db, key: MasterKey): Promise<void> {
	const row = await db.selectFrom("server_meta").select("value").where("key", "=", MASTER_KEY_ID).executeTakeFirst();
	if (!row) {
		await db.insertInto("server_meta").values({ key: MASTER_KEY_ID, value: key.id }).execute();
	} else if (row.value !== key.id) {
		throw new KeyError("the master key file does not belong to this database (master key id mismatch)");
	}
}

export async function boundMasterKeyId(db: Db): Promise<string | undefined> {
	const row = await db.selectFrom("server_meta").select("value").where("key", "=", MASTER_KEY_ID).executeTakeFirst();
	return row?.value;
}
