import { readFileSync } from "node:fs";
import { Tagged } from "cborg";
import { describe, expect, it } from "vitest";
import { CborError, decode, encode } from "../src/cbor.ts";

interface PositiveVector {
	id: string;
	description: string;
	diagnostic: string;
	hex: string;
}

interface NegativeVector {
	id: string;
	hex: string;
	reject_reason: string;
}

interface GoldenVectors {
	profile: string;
	map_keys: string;
	positive: PositiveVector[];
	negative: NegativeVector[];
}

const vectors = JSON.parse(
	readFileSync(new URL("../../../test/interop/cbor_core_golden_vectors.json", import.meta.url), "utf8"),
) as GoldenVectors;

const bytesOf = (hex: string): Uint8Array => Uint8Array.from(Buffer.from(hex, "hex"));
const hexOf = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

function rejectUnknownFields(map: Map<unknown, unknown>, allowed: readonly unknown[]): void {
	for (const key of map.keys()) {
		if (!allowed.includes(key)) throw new Error(`unknown field: ${String(key)}`);
	}
}

describe("CBOR-CORE-INT-v1 profile", () => {
	it("loads the shared golden vectors", () => {
		expect(vectors.profile).toBe("CBOR-CORE-INT-v1");
		expect(vectors.map_keys).toBe("text or integer only");
		expect(vectors.positive.length).toBeGreaterThan(0);
		expect(vectors.negative.length).toBeGreaterThan(0);
	});

	it.each(vectors.positive)("decodes and re-encodes $id", (vector) => {
		const bytes = bytesOf(vector.hex);
		const value = decode(bytes);
		expect(hexOf(encode(value))).toBe(vector.hex);
	});

	it("keeps large integers as bigint and byte strings as Uint8Array", () => {
		expect(decode(bytesOf("1bffffffffffffffff"))).toBe(18446744073709551615n);
		expect(decode(bytesOf("3bffffffffffffffff"))).toBe(-18446744073709551616n);
		expect(decode(bytesOf("1b0020000000000001"))).toBe(9007199254740993n);
		expect(decode(bytesOf("43e4b8ad"))).toEqual(Uint8Array.of(0xe4, 0xb8, 0xad));
		expect(decode(bytesOf("63e4b8ad"))).toBe("中");
	});

	it("preserves a leading BOM in text", () => {
		const text = "\uFEFFab";
		expect(decode(encode(text))).toBe(text);
	});

	it("rejects text containing invalid UTF-8 bytes", () => {
		// text(2 bytes) = 0x61 0xff; a UTF-8 decoder would otherwise produce U+FFFD.
		expect(() => decode(bytesOf("6261ff"))).toThrow(CborError);
	});

	it.each(vectors.negative.filter((vector) => vector.id !== "unknown_field"))("rejects $id", (vector) => {
		expect(() => decode(bytesOf(vector.hex))).toThrow(CborError);
	});

	// The fixture's unknown_field case is a schema-level rejection ("under a
	// schema that allows only fields 1..3"); the generic profile has no schema.
	it("rejects unknown fields when a schema is applied", () => {
		const value = decode(bytesOf("a1186301"));
		expect(value).toBeInstanceOf(Map);
		expect(() => rejectUnknownFields(value as Map<unknown, unknown>, [1, 2, 3])).toThrow("unknown field: 99");
	});

	it("encodes RFC 8949 §4.2.1 key order (bytewise, not length-first)", () => {
		expect(
			hexOf(
				encode(
					new Map<unknown, unknown>([
						[100, 1],
						[-1, 2],
					]),
				),
			),
		).toBe("a21864012002");
		expect(
			hexOf(
				encode(
					new Map<unknown, unknown>([
						[100, 1],
						[-1, 2],
					]),
				),
			),
		).not.toBe("a22002186401");
	});

	it("rejects floats, undefined and tags on encode", () => {
		expect(() => encode(1.5)).toThrow(CborError);
		expect(() => encode([undefined])).toThrow(CborError);
		expect(() => encode(new Tagged(1, 0))).toThrow(CborError);
		expect(() => encode(Number.MAX_SAFE_INTEGER + 1)).toThrow(CborError);
		expect(() => encode("\ud800")).toThrow(CborError);
	});

	it("limits nesting to 64 levels like the Go decoder", () => {
		// One-element arrays around a uint: the Go side builds the same bytes in
		// TestMaxNestedLevels.
		const nested = (levels: number): Uint8Array => {
			const bytes = new Uint8Array(levels + 1);
			bytes.fill(0x81, 0, levels);
			bytes[levels] = 0x01;
			return bytes;
		};
		const deep = (levels: number): unknown => {
			let value: unknown = 1;
			for (let i = 0; i < levels; i++) value = [value];
			return value;
		};
		expect(decode(nested(64))).toEqual(deep(64));
		expect(() => decode(nested(65))).toThrow(CborError);
		// A map counts too: 63 nested arrays plus the map is 64 containers.
		expect(decode(encode(new Map([["a", deep(63)]])))).toBeInstanceOf(Map);
		expect(() => decode(encode(new Map([["a", deep(64)]])))).toThrow(CborError);
	});

	it("counts empty containers once, not as an open level", () => {
		// An empty array or map is complete as soon as it starts. It used to be pushed as a
		// level with zero children and never popped, so each one left a stale level behind and
		// a list of 65 empty containers looked deeper than 64.
		const empties = Array.from({ length: 100 }, () => []);
		expect(decode(encode(empties))).toEqual(empties);
		const pairs = Array.from({ length: 70 }, () => [new Map(), 1]);
		expect(decode(encode(pairs))).toEqual(pairs);
		const nested: unknown = [
			[[]],
			[new Map<unknown, unknown>()],
			new Map<unknown, unknown>([
				["a", []],
				["b", new Map<unknown, unknown>()],
			]),
		];
		expect(decode(encode(nested))).toEqual(nested);
	});

	it("counts an empty container as a level for the nesting limit", () => {
		// The Go decoder (MaxNestedLevels: 64) treats an empty container as one level too:
		// 64 nested containers ending in an empty one decode, 65 do not.
		const nestedEmpty = (levels: number): Uint8Array => {
			const bytes = new Uint8Array(levels);
			bytes.fill(0x81, 0, levels - 1);
			bytes[levels - 1] = 0x80;
			return bytes;
		};
		const deepEmpty = (levels: number): unknown => {
			let value: unknown = [];
			for (let i = 1; i < levels; i++) value = [value];
			return value;
		};
		expect(decode(nestedEmpty(64))).toEqual(deepEmpty(64));
		expect(() => decode(nestedEmpty(65))).toThrow(CborError);
	});

	it("limits map nesting to 64 levels", () => {
		// Each level is map{"a": <next>}: a map counts as one level, its key and value do not.
		const nestedMap = (levels: number): Uint8Array => {
			const bytes = new Uint8Array(levels * 3 + 1);
			for (let level = 0; level < levels; level++) bytes.set([0xa1, 0x61, 0x61], level * 3);
			bytes[levels * 3] = 0x01;
			return bytes;
		};
		const deepMap = (levels: number): unknown => {
			let value: unknown = 1;
			for (let i = 0; i < levels; i++) value = new Map([["a", value]]);
			return value;
		};
		expect(decode(nestedMap(64))).toEqual(deepMap(64));
		expect(() => decode(nestedMap(65))).toThrow(CborError);
	});

	it("permits only text and integer map keys", () => {
		const keys = new Map<unknown, unknown>([
			["a", 1],
			[-1, 2],
			[18446744073709551615n, 3],
		]);
		expect(decode(encode(keys))).toEqual(keys);
		for (const key of [Uint8Array.of(0), [0], new Map(), true, null, 1.5, {}]) {
			expect(() => encode(new Map<unknown, number>([[key, 1]]))).toThrow(CborError);
		}
		expect(() => encode({ nested: [new Map<unknown, number>([[false, 1]])] })).toThrow(CborError);
	});
});
