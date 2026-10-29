/**
 * Tiny codec combinator library. A codec maps a TS value to the plain value
 * graph that `cbor.ts` encodes (and back), checking protocol-level types and
 * ranges at the same time. Every message type is declared exactly once.
 */

export class SchemaError extends Error {
	override name = "SchemaError";
}

export interface Codec<T> {
	readonly name: string;
	encode(value: T): unknown;
	decode(value: unknown): T;
}

/** Object codecs are flattened by unions (their fields sit beside the tag). */
export interface ObjectCodec<T> extends Codec<T> {
	readonly fields: readonly string[];
}

export interface TupleCodec<T> extends ObjectCodec<T> {}
export interface FieldCodec<T> extends ObjectCodec<T> {}

export type Infer<C> = C extends Codec<infer T> ? T : never;

function fail(name: string, reason: string): never {
	throw new SchemaError(`${name}: ${reason}`);
}

function make<T>(name: string, encode: (value: T) => unknown, decode: (value: unknown) => T): Codec<T> {
	return { name, encode, decode };
}

function isUint(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isInt(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value);
}

/** 0 ≤ n ≤ 2^53−1. Bigints are rejected even when they fit. */
export const uint: Codec<number> = make(
	"uint",
	(value) => (isUint(value) ? value : fail("uint", `not a safe unsigned integer: ${String(value)}`)),
	(value) => (isUint(value) ? value : fail("uint", `not a safe unsigned integer: ${String(value)}`)),
);

/** |n| ≤ 2^53−1. Bigints are rejected even when they fit. */
export const int: Codec<number> = make(
	"int",
	(value) => (isInt(value) ? value : fail("int", `not a safe integer: ${String(value)}`)),
	(value) => (isInt(value) ? value : fail("int", `not a safe integer: ${String(value)}`)),
);

export const bool: Codec<boolean> = make(
	"bool",
	(value) => (typeof value === "boolean" ? value : fail("bool", "not a boolean")),
	(value) => (typeof value === "boolean" ? value : fail("bool", "not a boolean")),
);

function checkText(value: unknown, name: string): string {
	if (typeof value !== "string") fail(name, "not text");
	if (!value.isWellFormed()) fail(name, "text is not well-formed Unicode");
	return value;
}

export const text: Codec<string> = make(
	"text",
	(value) => checkText(value, "text"),
	(value) => checkText(value, "text"),
);

export const bytes: Codec<Uint8Array> = make(
	"bytes",
	(value) => (value instanceof Uint8Array ? value : fail("bytes", "not a byte string")),
	(value) => (value instanceof Uint8Array ? value : fail("bytes", "not a byte string")),
);

/** Byte string with an exact length, e.g. the 32-byte SHA-256 digest. */
export function fixedBytes(length: number): Codec<Uint8Array> {
	const name = `bytes[${length}]`;
	const check = (value: unknown): Uint8Array => {
		if (!(value instanceof Uint8Array)) fail(name, "not a byte string");
		if (value.length !== length) fail(name, `expected ${length} bytes, got ${value.length}`);
		return value;
	};
	return make(name, check, check);
}

/** SHA-256 digest: exactly 32 bytes. */
export const sha256: Codec<Uint8Array> = fixedBytes(32);

export function nullable<T>(inner: Codec<T>): Codec<T | null> {
	const name = `${inner.name}?`;
	return make(
		name,
		(value) => (value === null ? null : inner.encode(value)),
		(value) => (value === null ? null : inner.decode(value)),
	);
}

export function list<T>(inner: Codec<T>): Codec<T[]> {
	const name = `[${inner.name}]`;
	return make(
		name,
		(value) => {
			if (!Array.isArray(value)) fail(name, "not an array");
			return value.map((item) => inner.encode(item));
		},
		(value) => {
			if (!Array.isArray(value)) fail(name, "not an array");
			return value.map((item) => inner.decode(item));
		},
	);
}

/** Map restricted to text keys and text values, used for `env`. */
export const textMap: Codec<Record<string, string>> = make(
	"{text: text}",
	(value) => {
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			fail("{text: text}", "not an object");
		}
		// A Map or class instance would stringify as an empty object here; only
		// plain records are accepted.
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) {
			fail("{text: text}", "not a plain object");
		}
		const entries: [string, string][] = [];
		for (const [key, item] of Object.entries(value)) {
			if (!key.isWellFormed()) fail("{text: text}", `key ${JSON.stringify(key)} is not well-formed Unicode`);
			if (typeof item !== "string") fail("{text: text}", `value for key ${JSON.stringify(key)} is not text`);
			entries.push([key, item]);
		}
		return new Map(entries);
	},
	(value) => {
		if (!(value instanceof Map)) fail("{text: text}", "not a map");
		const entries: [string, string][] = [];
		for (const [key, item] of value) {
			if (typeof key !== "string") fail("{text: text}", "map key is not text");
			if (typeof item !== "string") fail("{text: text}", "map value is not text");
			entries.push([key, item]);
		}
		return Object.fromEntries(entries);
	},
);

type Field = readonly [string, Codec<unknown>];
type FieldValue<F extends readonly Field[]> = {
	[K in F[number] as K[0]]: Infer<K[1]>;
};

/**
 * Fixed-length tuple with named fields. The encoded form is an array in
 * declaration order; decoding requires exactly that length.
 */
export function tuple<const F extends readonly Field[]>(fields: F): TupleCodec<FieldValue<F>> {
	const names = fields.map(([name]) => name);
	const name = `[${names.join(", ")}]`;
	const encode = (value: FieldValue<F>): unknown => {
		const object = value as Record<string, unknown>;
		return fields.map(([fieldName, codec]) => codec.encode(object[fieldName]));
	};
	const decode = (value: unknown): FieldValue<F> => {
		if (!Array.isArray(value)) fail(name, "not an array");
		if (value.length !== fields.length) fail(name, `expected ${fields.length} elements, got ${value.length}`);
		const entries: [string, unknown][] = [];
		for (let i = 0; i < fields.length; i++) {
			const field = fields[i];
			if (field === undefined) fail(name, "missing field definition");
			entries.push([field[0], field[1].decode(value[i])]);
		}
		return Object.fromEntries(entries) as FieldValue<F>;
	};
	return { name, fields: names, encode: encode as Codec<FieldValue<F>>["encode"], decode };
}

/**
 * One named field whose encoded body is the inner codec's value directly,
 * without the array wrapper of `tuple`. Used for `Command = ["argv", [text]]`.
 */
export function field<const N extends string, T>(name: N, inner: Codec<T>): FieldCodec<{ [K in N]: T }> {
	type Value = { [K in N]: T };
	const encode = (value: Value): unknown => inner.encode(value[name]);
	const decode = (value: unknown): Value => Object.fromEntries([[name, inner.decode(value)]]) as Value;
	return { name: `${name}: ${inner.name}`, fields: [name], encode, decode };
}

export function enumOf<const V extends readonly string[]>(...values: V): Codec<V[number]> {
	const allowed: readonly string[] = values;
	const name = values.map((value) => JSON.stringify(value)).join(" | ");
	const check = (value: unknown): V[number] => {
		if (typeof value !== "string" || !allowed.includes(value)) {
			fail(name, `unknown enum value: ${String(value)}`);
		}
		return value as V[number];
	};
	return make(name, check, check);
}

type UnionBranch = Codec<unknown>;
type UnionMap = Record<string, UnionBranch>;

type BranchValue<K extends string, C extends UnionBranch> =
	C extends ObjectCodec<infer T> ? { kind: K } & T : { kind: K; value: Infer<C> };

export type UnionValue<M extends UnionMap> = {
	[K in keyof M & string]: BranchValue<K, M[K]>;
}[keyof M & string];

type UntaggedBranchValue<C extends UnionBranch> = C extends ObjectCodec<infer T> ? T : { value: Infer<C> };

export type UntaggedUnionValue<M extends UnionMap> = {
	[K in keyof M & string]: UntaggedBranchValue<M[K]>;
}[keyof M & string];

function isObject(codec: UnionBranch): codec is ObjectCodec<object> {
	return "fields" in codec;
}

/**
 * Tagged union encoded as `[tag, body]`. When the branch body is a tuple, its
 * fields are flattened beside the tag (`{kind: tag, ...body}`); otherwise the
 * body is exposed as `{kind: tag, value}`. With `{untagged: true}` the tag is
 * omitted and the branch is chosen by the tuple field names present.
 */
export function union<const M extends UnionMap>(branches: M): Codec<UnionValue<M>>;
export function union<const M extends UnionMap>(branches: M, options: { untagged: true }): Codec<UntaggedUnionValue<M>>;
export function union(branches: UnionMap, options: { untagged?: boolean } = {}): Codec<unknown> {
	const entries = Object.entries(branches);
	const untagged = options.untagged === true;
	const name = `union(${entries.map(([tag]) => tag).join(", ")})`;
	const encode = (value: unknown): unknown => {
		if (typeof value !== "object" || value === null) fail(name, "not an object");
		if (untagged) {
			let match: [string, ObjectCodec<object>] | undefined;
			for (const [tag, codec] of entries) {
				if (!isObject(codec)) continue;
				const object = value as Record<string, unknown>;
				if (!codec.fields.every((field) => Object.hasOwn(object, field))) continue;
				if (match !== undefined) fail(name, "ambiguous union value");
				match = [tag, codec];
			}
			if (match === undefined) fail(name, "no union branch matches the value");
			return [match[0], match[1].encode(value as object)];
		}
		const tag = (value as { kind?: unknown }).kind;
		if (typeof tag !== "string") fail(name, "missing kind tag");
		const codec = Object.hasOwn(branches, tag) ? branches[tag] : undefined;
		if (codec === undefined) fail(name, `unknown tag: ${tag}`);
		if (isObject(codec)) return [tag, codec.encode(value as object)];
		return [tag, codec.encode((value as { value: unknown }).value)];
	};
	const decode = (value: unknown): unknown => {
		if (!Array.isArray(value)) fail(name, "not an array");
		if (value.length !== 2) fail(name, `expected 2 elements, got ${value.length}`);
		const [tag, body] = value;
		if (typeof tag !== "string") fail(name, "tag is not text");
		const codec = Object.hasOwn(branches, tag) ? branches[tag] : undefined;
		if (codec === undefined) fail(name, `unknown tag: ${tag}`);
		if (!isObject(codec)) {
			return untagged ? { value: codec.decode(body) } : { kind: tag, value: codec.decode(body) };
		}
		const decoded = codec.decode(body);
		return untagged ? decoded : { kind: tag, ...(decoded as object) };
	};
	return { name, encode, decode };
}
