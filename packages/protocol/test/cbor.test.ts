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
});
