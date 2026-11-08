import { argon2, randomBytes, timingSafeEqual } from "node:crypto";
import { HashBusyError, type HashKind, withHashSlot } from "./hash-gate.ts";

const ALGORITHM = "argon2id";
const VERSION = 19;
const SALT_LENGTH = 16;
const TAG_LENGTH = 32;
const MAX_PASSWORD_LENGTH = 1024;

/** Upper bounds for a parsed PHC string; anything larger is rejected before it is computed. */
const MAX_MEMORY_KIB = 1024 * 1024; // 1 GiB
const MAX_PASSES = 20;
const MAX_PARALLELISM = 16;
const MAX_SALT_LENGTH = 64;

export interface Argon2Parameters {
	/** Memory in KiB, as the PHC `m=` parameter and crypto.argon2's `memory`. */
	memory: number;
	passes: number;
	parallelism: number;
}

/** m = 64 MiB, t = 3, p = 1, 16-byte salt, 32-byte tag (doc/configuration.md). */
export const DEFAULT_ARGON2_PARAMETERS: Argon2Parameters = { memory: 65536, passes: 3, parallelism: 1 };

let current: Argon2Parameters = DEFAULT_ARGON2_PARAMETERS;

/**
 * Lowers the cost for test suites (see vitest.setup.ts); production never calls this. Tests that
 * check the production parameters restore DEFAULT_ARGON2_PARAMETERS themselves.
 */
export function setArgon2ParametersForTesting(params: Argon2Parameters): void {
	current = params;
}

interface ParsedHash extends Argon2Parameters {
	salt: Buffer;
	hash: Buffer;
}

function derive(message: Buffer, salt: Buffer, params: Argon2Parameters, tagLength: number): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		argon2(
			ALGORITHM,
			{
				message,
				nonce: salt,
				parallelism: params.parallelism,
				tagLength,
				memory: params.memory,
				passes: params.passes,
			},
			(err, derivedKey) => (err ? reject(err) : resolve(derivedKey)),
		);
	});
}

/** PHC strings use standard base64 without padding; URL-safe characters are invalid. */
function encodeBase64(buffer: Buffer): string {
	return buffer.toString("base64").replace(/=+$/, "");
}

function decodeBase64(text: string): Buffer | null {
	if (!/^[A-Za-z0-9+/]+$/.test(text) || text.length % 4 === 1) return null;
	const decoded = Buffer.from(text, "base64");
	// Reject non-canonical encodings (and anything Buffer's lenient decoder changed).
	if (encodeBase64(decoded) !== text) return null;
	return decoded;
}

function parseInteger(text: string): number | null {
	if (!/^[1-9][0-9]{0,9}$/.test(text)) return null;
	return Number(text);
}

function parse(encoded: string): ParsedHash | null {
	if (typeof encoded !== "string") return null;
	const parts = encoded.split("$");
	// "", "argon2id", "v=19", "m=…,t=…,p=…", salt, hash
	if (parts.length !== 6 || parts[0] !== "" || parts[1] !== ALGORITHM) return null;
	if (parts[2] !== `v=${VERSION}`) return null;
	const params = /^m=([1-9][0-9]{0,9}),t=([1-9][0-9]{0,9}),p=([1-9][0-9]{0,9})$/.exec(parts[3] ?? "");
	if (!params) return null;
	const memory = parseInteger(params[1] as string);
	const passes = parseInteger(params[2] as string);
	const parallelism = parseInteger(params[3] as string);
	if (memory === null || passes === null || parallelism === null) return null;
	if (memory > MAX_MEMORY_KIB || passes > MAX_PASSES || parallelism > MAX_PARALLELISM) return null;
	// Argon2 requires m >= 8 * p (RFC 9106), and the tag is fixed at 32 bytes.
	if (memory < 8 * parallelism) return null;
	const salt = decodeBase64(parts[4] ?? "");
	const hash = decodeBase64(parts[5] ?? "");
	if (!salt || salt.length < SALT_LENGTH || salt.length > MAX_SALT_LENGTH) return null;
	if (!hash || hash.length !== TAG_LENGTH) return null;
	return { memory, passes, parallelism, salt, hash };
}

function format(params: Argon2Parameters, salt: Buffer, hash: Buffer): string {
	return `$${ALGORITHM}$v=${VERSION}$m=${params.memory},t=${params.passes},p=${params.parallelism}$${encodeBase64(salt)}$${encodeBase64(hash)}`;
}

export async function hashPassword(password: string, kind: HashKind = "other"): Promise<string> {
	if (typeof password !== "string" || password.length > MAX_PASSWORD_LENGTH) {
		throw new RangeError(`password must be at most ${MAX_PASSWORD_LENGTH} characters`);
	}
	const salt = randomBytes(SALT_LENGTH);
	const params = current;
	const key = await withHashSlot(
		() => derive(Buffer.from(password.normalize("NFKC"), "utf8"), salt, params, TAG_LENGTH),
		kind,
	);
	return format(params, salt, key);
}

export async function verifyPassword(password: string, encoded: string, kind: HashKind = "other"): Promise<boolean> {
	if (typeof password !== "string" || password.length > MAX_PASSWORD_LENGTH) return false;
	const parsed = parse(encoded);
	if (!parsed) return false;
	try {
		const key = await withHashSlot(
			() => derive(Buffer.from(password.normalize("NFKC"), "utf8"), parsed.salt, parsed, parsed.hash.length),
			kind,
		);
		return timingSafeEqual(key, parsed.hash);
	} catch (err) {
		// A full gate is the server's condition, not a wrong password: let the route answer 503.
		if (err instanceof HashBusyError) throw err;
		return false;
	}
}

export function needsRehash(encoded: string): boolean {
	const parsed = parse(encoded);
	if (!parsed) return true;
	return (
		parsed.memory !== current.memory ||
		parsed.passes !== current.passes ||
		parsed.parallelism !== current.parallelism ||
		parsed.salt.length !== SALT_LENGTH ||
		parsed.hash.length !== TAG_LENGTH
	);
}
