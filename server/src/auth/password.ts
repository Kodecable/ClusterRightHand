import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const ALGORITHM = "scrypt";
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const MAX_PASSWORD_LENGTH = 1024;
const MAX_MEMORY = 256 * 1024 * 1024;

export const DEFAULT_HASH_PARAMETERS = { N: 2 ** 17, r: 8, p: 1 };
const DEFAULTS = DEFAULT_HASH_PARAMETERS;
let current: ScryptParams = DEFAULTS;

/** Lowers the cost for test suites (see vitest.setup.ts); production never calls this. */
export function setHashParametersForTesting(params: ScryptParams): void {
	current = params;
}
const MAX_N = 2 ** 20;
const MAX_R = 32;
const MAX_P = 16;

interface ScryptParams {
	N: number;
	r: number;
	p: number;
}

interface ParsedHash extends ScryptParams {
	salt: Buffer;
	hash: Buffer;
}

function derive(password: string, salt: Buffer, params: ScryptParams, keyLength: number): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		scrypt(
			password.normalize("NFKC"),
			salt,
			keyLength,
			{ N: params.N, r: params.r, p: params.p, maxmem: MAX_MEMORY },
			(err, key) => (err ? reject(err) : resolve(key)),
		);
	});
}

const B64URL = /^[A-Za-z0-9_-]+$/;

function parseInteger(text: string): number | null {
	return /^[1-9][0-9]{0,9}$/.test(text) ? Number(text) : null;
}

function parse(encoded: string): ParsedHash | null {
	if (typeof encoded !== "string") return null;
	const parts = encoded.split("$");
	if (parts.length !== 6 || parts[0] !== ALGORITHM) return null;
	const N = parseInteger(parts[1] ?? "");
	const r = parseInteger(parts[2] ?? "");
	const p = parseInteger(parts[3] ?? "");
	if (N === null || r === null || p === null) return null;
	if (N < 2 || N > MAX_N || (N & (N - 1)) !== 0 || r > MAX_R || p > MAX_P) return null;
	const saltText = parts[4] ?? "";
	const hashText = parts[5] ?? "";
	if (!B64URL.test(saltText) || !B64URL.test(hashText)) return null;
	const salt = Buffer.from(saltText, "base64url");
	const hash = Buffer.from(hashText, "base64url");
	if (salt.length === 0 || hash.length !== KEY_LENGTH) return null;
	return { N, r, p, salt, hash };
}

export async function hashPassword(password: string): Promise<string> {
	if (password.length > MAX_PASSWORD_LENGTH) {
		throw new RangeError(`password must be at most ${MAX_PASSWORD_LENGTH} characters`);
	}
	const salt = randomBytes(SALT_LENGTH);
	const key = await derive(password, salt, current, KEY_LENGTH);
	const { N, r, p } = current;
	return `${ALGORITHM}$${N}$${r}$${p}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
	if (typeof password !== "string" || password.length > MAX_PASSWORD_LENGTH) return false;
	const parsed = parse(encoded);
	if (!parsed) return false;
	try {
		const key = await derive(password, parsed.salt, parsed, parsed.hash.length);
		return timingSafeEqual(key, parsed.hash);
	} catch {
		return false;
	}
}

export function needsRehash(encoded: string): boolean {
	const parsed = parse(encoded);
	if (!parsed) return true;
	return (
		parsed.N !== current.N ||
		parsed.r !== current.r ||
		parsed.p !== current.p ||
		parsed.salt.length !== SALT_LENGTH ||
		parsed.hash.length !== KEY_LENGTH
	);
}
