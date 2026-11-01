/**
 * CBOR-CORE-INT-v1 profile: RFC 8949 §4.2.1 core deterministic encoding, no
 * floats, tags, indefinite lengths, undefined or custom simple values. Map
 * keys must be text or integers. Decoding is strict and additionally checks
 * the re-encoded bytes.
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

// Map keys. The profile allows text (major 3) and integers (major 0/1) only;
// every other key type is an error in both directions. The walk is iterative
// so that deeply nested values cannot exhaust the JS stack, and a WeakSet
// breaks reference cycles (cborg rejects those separately when encoding).
function checkMapKey(key: unknown): void {
	if (typeof key === "string" || typeof key === "bigint") return;
	if (typeof key === "number" && Number.isSafeInteger(key)) return;
	reject(`map keys must be text or integer, got ${typeof key}`);
}

function checkMapKeys(root: unknown): void {
	const seen = new WeakSet<object>();
	const stack: unknown[] = [root];
	while (stack.length > 0) {
		const value = stack.pop();
		if (value === null || typeof value !== "object" || seen.has(value)) continue;
		seen.add(value);
		if (value instanceof Map) {
			for (const [key, item] of value) {
				checkMapKey(key);
				stack.push(item);
			}
		} else if (Array.isArray(value)) {
			for (const item of value) stack.push(item);
		} else if (!ArrayBuffer.isView(value) && !(value instanceof ArrayBuffer)) {
			// Plain objects can only have string keys, but their values may hold maps.
			for (const item of Object.values(value)) stack.push(item);
		}
	}
}

/** Encode one value in CBOR-CORE-INT-v1. */
export function encode(value: unknown): Uint8Array {
	checkMapKeys(value);
	return Uint8Array.from(cborgEncode(value, ENCODE_OPTIONS));
}

// Decoding. cborg's `strict` rejects non-shortest integers and lengths, and
// the tokenizer below rejects floats, which cborg has no option for. cborg
// 6.1.3 has no `strictUtf8`, and its default TextDecoder strips a leading BOM
// and substitutes U+FFFD for invalid UTF-8; the tokenizer re-decodes the
// retained string bytes with a fatal decoder to preserve the BOM and reject
// invalid UTF-8 before the re-encode comparison.
const DECODE_OPTIONS: DecodeOptions = {
	strict: true,
	allowIndefinite: false,
	allowUndefined: false,
	allowBigInt: true,
	rejectDuplicateMapKeys: true,
	useMaps: true,
	allowNaN: false,
	allowInfinity: false,
	retainStringBytes: true,
};

const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * Maximum number of nested arrays and maps, the same limit the Go decoder sets
 * (`MaxNestedLevels: 64` in client/internal/protocol/cbor.go). Both sides must
 * reject the same payloads.
 */
const MAX_NESTING = 64;

class ProfileTokenizer extends Tokenizer {
	/** Remaining child tokens of every open array or map, innermost last. */
	private readonly open: number[] = [];

	override next(): Token {
		const token = super.next();
		if (Type.equals(token.type, Type.float)) reject("floats are not allowed");
		if (Type.equals(token.type, Type.string) && token.byteValue !== undefined) {
			try {
				token.value = UTF8.decode(token.byteValue);
			} catch {
				reject("text is not valid UTF-8");
			}
		}
		this.trackNesting(token);
		return token;
	}

	/**
	 * Enforce MAX_NESTING while the tokens stream in. Tokens arrive depth first, so a
	 * stack of remaining child counts gives the nesting depth of each new container
	 * and unwinds when one ends. A tag is transparent here: the profile rejects tags
	 * after decoding, and a tag with its content is a single value.
	 */
	private trackNesting(token: Token): void {
		if (Type.equals(token.type, Type.tag)) return;
		if (Type.equals(token.type, Type.array) || Type.equals(token.type, Type.map)) {
			if (this.open.length >= MAX_NESTING) {
				reject(`value nests more than ${MAX_NESTING} levels deep`);
			}
			// Maps hold key/value pairs; definite lengths only (indefinite is rejected).
			const children = token.value as number;
			if (children > 0) {
				this.open.push(Type.equals(token.type, Type.map) ? children * 2 : children);
				return;
			}
			// An empty container is complete at once: it never opens a level of its own,
			// it just fills one slot of its parent, like any other complete value.
		}
		// A complete value fills one slot of the innermost container. A container that
		// ends here in turn fills one slot of its parent, and so on.
		while (this.open.length > 0) {
			const innermost = this.open.length - 1;
			const remaining = this.open[innermost];
			if (remaining === undefined) return;
			if (remaining > 1) {
				this.open[innermost] = remaining - 1;
				return;
			}
			// This value completes the container: the container in turn completes one slot
			// of its parent.
			this.open.pop();
		}
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
 * Decode exactly one CBOR-CORE-INT-v1 value. Maps decode as `Map`; their keys
 * must be text or integers. Integers beyond the safe range decode as `bigint`.
 * Non-canonical encodings are rejected by re-encoding the result.
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
	checkMapKeys(value);
	let reencoded: Uint8Array;
	try {
		reencoded = encode(value);
	} catch (err) {
		throw new CborError(`decoded value cannot be re-encoded: ${err instanceof Error ? err.message : String(err)}`);
	}
	if (!sameBytes(reencoded, bytes)) reject("non-canonical encoding (re-encoded bytes differ)");
	return value;
}
