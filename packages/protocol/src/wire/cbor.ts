/**
 * CBOR-CORE-INT-v1 profile: RFC 8949 §4.2.1 core deterministic encoding, no
 * floats, tags, indefinite lengths, undefined or custom simple values.
 * Decoding is strict and additionally checks the re-encoded bytes.
 */
import {
	decode as cborgDecode,
	encode as cborgEncode,
	type DecodeOptions,
	type EncodeOptions,
	rfc8949EncodeOptions,
	Token,
	Tokenizer,
	Type,
} from "cborg";

export class CborError extends Error {
	override name = "CborError";
}

function reject(reason: string): never {
	throw new CborError(reason);
}

// Encoding. `rfc8949EncodeOptions` selects §4.2.1 map key ordering (bytewise,
// not length-first); the type encoders below remove the value types the
// profile forbids.
const ENCODE_OPTIONS: EncodeOptions = {
	...rfc8949EncodeOptions,
	typeEncoders: {
		number(value: unknown): Token {
			if (typeof value !== "number" || !Number.isSafeInteger(value)) {
				reject(`floats are not allowed: ${String(value)}`);
			}
			return new Token(value >= 0 ? Type.uint : Type.negint, value);
		},
		string(value: unknown): Token {
			if (typeof value !== "string") reject("string encoder got a non-string");
			if (!value.isWellFormed()) reject("text is not well-formed Unicode");
			return new Token(Type.string, value);
		},
		undefined(): never {
			return reject("undefined is not allowed");
		},
		Tagged(): never {
			return reject("tags are not allowed");
		},
	},
};

/** Encode one value in CBOR-CORE-INT-v1. */
export function encode(value: unknown): Uint8Array {
	return Uint8Array.from(cborgEncode(value, ENCODE_OPTIONS));
}

// Decoding. cborg's `strict` rejects non-shortest integers and lengths, and
// the tokenizer below rejects floats, which cborg has no option for. cborg
// 6.1.3 has no `strictUtf8`; invalid UTF-8 is still rejected by the
// re-encode comparison in `decode()` (it decodes to U+FFFD and re-encodes to
// different bytes).
const DECODE_OPTIONS: DecodeOptions = {
	strict: true,
	allowIndefinite: false,
	allowUndefined: false,
	allowBigInt: true,
	rejectDuplicateMapKeys: true,
	useMaps: true,
	allowNaN: false,
	allowInfinity: false,
};

class ProfileTokenizer extends Tokenizer {
	override next(): Token {
		const token = super.next();
		if (Type.equals(token.type, Type.float)) reject("floats are not allowed");
		return token;
	}
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

/**
 * Decode exactly one CBOR-CORE-INT-v1 value. Maps decode as `Map` (keys may be
 * any deterministic key type); integers beyond the safe range decode as
 * `bigint`. Non-canonical encodings are rejected by re-encoding the result.
 */
export function decode(bytes: Uint8Array): unknown {
	if (!(bytes instanceof Uint8Array)) reject("input must be a Uint8Array");
	if (bytes.length === 0) reject("empty input");
	const options: DecodeOptions = { ...DECODE_OPTIONS };
	options.tokenizer = new ProfileTokenizer(bytes, options);
	let value: unknown;
	try {
		value = cborgDecode(bytes, options);
	} catch (err) {
		if (err instanceof CborError) throw err;
		throw new CborError(err instanceof Error ? err.message : String(err));
	}
	let reencoded: Uint8Array;
	try {
		reencoded = encode(value);
	} catch (err) {
		throw new CborError(`decoded value cannot be re-encoded: ${err instanceof Error ? err.message : String(err)}`);
	}
	if (!sameBytes(reencoded, bytes)) reject("non-canonical encoding (re-encoded bytes differ)");
	return value;
}
