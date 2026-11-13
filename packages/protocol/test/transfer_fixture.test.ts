import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decode as decodeCbor, encode as encodeCbor } from "../src/cbor.ts";
import { decodeFrame, encodeFrame } from "../src/frame.ts";
import {
	dataConnectionInitCodec,
	dataConnectionResponseCodec,
	dataFrameCodec,
	taskResultCodec,
	taskSpecCodec,
} from "../src/messages.ts";
import { buildTransferFixture, type TransferFixture } from "./transfer_fixture.ts";

const fixture = JSON.parse(
	readFileSync(new URL("../../../test/interop/transfer_fixture.json", import.meta.url), "utf8"),
) as TransferFixture;
const bytesOf = (value: string): Uint8Array => Uint8Array.from(Buffer.from(value, "hex"));

function reencode(codec: string, raw: Uint8Array): Uint8Array {
	switch (codec) {
		case "frame":
			return encodeFrame(decodeFrame(raw));
		case "task-spec":
			return encodeCbor(taskSpecCodec.encode(taskSpecCodec.decode(decodeCborValue(raw))));
		case "task-result":
			return encodeCbor(taskResultCodec.encode(taskResultCodec.decode(decodeCborValue(raw))));
		case "data-init":
			return encodeCbor(dataConnectionInitCodec.encode(dataConnectionInitCodec.decode(decodeCborValue(raw))));
		case "data-response":
			return encodeCbor(dataConnectionResponseCodec.encode(dataConnectionResponseCodec.decode(decodeCborValue(raw))));
		case "data-frame":
			return encodeCbor(dataFrameCodec.encode(dataFrameCodec.decode(decodeCborValue(raw))));
		default:
			throw new Error(`unknown fixture codec ${codec}`);
	}
}

function decodeCborValue(raw: Uint8Array): unknown {
	// The frame codec carries the encoded body; import the profile decoder here to keep the switch short.
	return decodeCbor(raw);
}

describe("transfer interop fixture", () => {
	it("is byte-for-byte what the generator writes", () => {
		expect(`${JSON.stringify(buildTransferFixture(), null, "\t")}\n`).toBe(
			readFileSync(new URL("../../../test/interop/transfer_fixture.json", import.meta.url), "utf8"),
		);
	});

	it("decodes and re-encodes every positive case", () => {
		for (const entry of fixture.positive) {
			const raw = bytesOf(entry.hex);
			expect(Buffer.from(reencode(entry.codec, raw)).toString("hex"), entry.id).toBe(entry.hex);
		}
	});

	it("rejects every negative case", () => {
		for (const entry of fixture.negative) {
			expect(() => reencode(entry.codec, bytesOf(entry.hex)), entry.id).toThrow();
		}
	});
});
