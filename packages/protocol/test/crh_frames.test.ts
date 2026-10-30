import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decode as decodeCbor, encode as encodeCbor } from "../src/cbor.ts";
import { decodeFrame, encodeFrame, ProtocolError } from "../src/frame.ts";
import { handshakeInitCodec, handshakeResponseCodec } from "../src/messages.ts";
import { buildFixture, type CrhFramesFixture, type FixtureCase } from "./crh_frames.ts";

const fixtureText = readFileSync(new URL("../../../test/interop/crh_frames.json", import.meta.url), "utf8");
const fixture = JSON.parse(fixtureText) as CrhFramesFixture;

const bytesOf = (hex: string): Uint8Array => Uint8Array.from(Buffer.from(hex, "hex"));
const hexOf = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

function checkPositive(vector: FixtureCase): void {
	const bytes = bytesOf(vector.hex);
	if (vector.id.startsWith("handshake.init")) {
		const value = handshakeInitCodec.decode(decodeCbor(bytes));
		expect(hexOf(encodeCbor(handshakeInitCodec.encode(value)))).toBe(vector.hex);
	} else if (vector.id.startsWith("handshake.response")) {
		const value = handshakeResponseCodec.decode(decodeCbor(bytes));
		expect(hexOf(encodeCbor(handshakeResponseCodec.encode(value)))).toBe(vector.hex);
	} else {
		const frame = decodeFrame(bytes);
		if (frame.kind === "event" && frame.name === "facts") {
			// Facts is the protocol's one map: the schema decode ignores unknown fact keys, so the
			// byte-for-byte comparison is the profile's re-encode of the generic value, which keeps
			// them (doc/protocol.md Facts).
			expect(hexOf(encodeCbor(decodeCbor(bytes)))).toBe(vector.hex);
			return;
		}
		expect(hexOf(encodeFrame(frame))).toBe(vector.hex);
	}
}

describe("test/interop/crh_frames.json", () => {
	it("matches the generator", () => {
		const generated = buildFixture();
		expect(`${JSON.stringify(generated, null, "\t")}\n`).toBe(fixtureText);
		expect(fixture).toEqual(generated);
	});

	it("has unique ids and non-empty descriptions", () => {
		const ids = [...fixture.positive, ...fixture.negative].map((vector) => vector.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const vector of [...fixture.positive, ...fixture.negative]) {
			expect(vector.description.length).toBeGreaterThan(0);
			expect(vector.hex).toMatch(/^[0-9a-f]+$/);
		}
	});

	it.each(fixture.positive)("decodes and re-encodes $id", (vector) => {
		checkPositive(vector);
	});

	it.each(fixture.negative)("rejects $id", (vector) => {
		expect(() => decodeFrame(bytesOf(vector.hex))).toThrow(ProtocolError);
	});
});
