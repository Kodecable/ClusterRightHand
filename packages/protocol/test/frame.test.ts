import { describe, expect, it } from "vitest";
import { encode as encodeCbor } from "../src/cbor.ts";
import {
	decodeFrame,
	encodeFrame,
	type Frame,
	MAX_FRAME_BYTES,
	ProtocolError,
	peekProtocolMajor,
} from "../src/frame.ts";

const bytesOf = (hex: string): Uint8Array => Uint8Array.from(Buffer.from(hex, "hex"));
const hexOf = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

const request: Frame = { kind: "request", id: 7, cmd: "task.cancel", body: { taskId: "t-1" } };
const success: Frame = { kind: "response", id: 7, cmd: "ping", ok: true, body: { seq: 3 } };
const failure: Frame = {
	kind: "response",
	id: 8,
	cmd: "task.start",
	ok: false,
	error: { code: "invalid_spec", message: "empty task id" },
};
const event: Frame = { kind: "event", name: "task.exit.ack", body: { taskId: "t-1" } };

describe("frames", () => {
	it.each([request, success, failure, event])("round-trips $kind", (frame) => {
		const bytes = encodeFrame(frame);
		expect(decodeFrame(bytes)).toEqual(frame);
		expect(hexOf(encodeFrame(decodeFrame(bytes)))).toBe(hexOf(bytes));
	});

	it("matches the documented request layout", () => {
		expect(hexOf(encodeFrame(request))).toBe("8400076b7461736b2e63616e63656c8163742d31");
	});

	it("surfaces an unsupported request and can answer it", () => {
		const decoded = decodeFrame(encodeCbor([0, 9, "trust.query", []]));
		expect(decoded).toEqual({ kind: "request.unsupported", id: 9, cmd: "trust.query" });
		const reply = encodeFrame({
			kind: "response",
			id: 9,
			cmd: "trust.query",
			ok: false,
			error: { code: "unsupported_command", message: "unsupported command: trust.query" },
		});
		expect(decodeFrame(reply)).toEqual({
			kind: "response",
			id: 9,
			cmd: "trust.query",
			ok: false,
			error: { code: "unsupported_command", message: "unsupported command: trust.query" },
		});
	});

	it("rejects unknown events", () => {
		expect(() => decodeFrame(encodeCbor([2, "trust.summary", []]))).toThrow(ProtocolError);
	});

	it("rejects malformed bodies and unknown frame types", () => {
		expect(() => decodeFrame(encodeCbor([0, 1, "task.cancel", []]))).toThrow(ProtocolError);
		expect(() => decodeFrame(encodeCbor([3, 1]))).toThrow(ProtocolError);
		expect(() => decodeFrame(encodeCbor({}))).toThrow(ProtocolError);
	});

	it("rejects non-canonical CBOR", () => {
		expect(() => decodeFrame(bytesOf("840018016470696e678101"))).toThrow(ProtocolError);
	});

	it("enforces MAX_FRAME_BYTES on encode and decode", () => {
		expect(MAX_FRAME_BYTES).toBe(61440);
		const oversized: Frame = {
			kind: "event",
			name: "task.output",
			body: { taskId: "t", stream: "stdout", offset: 0, data: new Uint8Array(MAX_FRAME_BYTES) },
		};
		expect(() => encodeFrame(oversized)).toThrow(ProtocolError);
		expect(() => decodeFrame(new Uint8Array(MAX_FRAME_BYTES + 1))).toThrow(ProtocolError);
	});

	it("cannot encode unsupported or unknown frames", () => {
		expect(() => encodeFrame({ kind: "request.unsupported", id: 1, cmd: "trust.query" })).toThrow(ProtocolError);
		expect(() => encodeFrame({ kind: "request", id: 1, cmd: "trust.query", body: [] })).toThrow(ProtocolError);
		expect(() => encodeFrame({ kind: "event", name: "trust.summary", body: [] })).toThrow(ProtocolError);
	});

	it("rejects bad ids and ok flags", () => {
		expect(() => encodeFrame({ kind: "request", id: -1, cmd: "ping", body: { seq: 1 } })).toThrow(ProtocolError);
		expect(() => decodeFrame(bytesOf("8400f93e006470696e678101"))).toThrow(ProtocolError);
		expect(() => decodeFrame(encodeCbor([1, 1, "ping", 1, [1]]))).toThrow(ProtocolError);
	});
});

describe("peekProtocolMajor", () => {
	const headers: [number, string][] = [
		[6, "86"],
		[24, "9818"],
		[300, "99012c"],
	];

	it.each(headers)("reads the first uint from a %i-element array", (_length, header) => {
		expect(peekProtocolMajor(bytesOf(`${header}01`))).toBe(1);
		expect(peekProtocolMajor(bytesOf(`${header}07`))).toBe(7);
	});

	it("does not decode the elements after protocol_major", () => {
		expect(peekProtocolMajor(bytesOf("8201f93c00"))).toBe(1);
	});

	it("rejects empty, non-array, empty-array and truncated payloads", () => {
		expect(() => peekProtocolMajor(new Uint8Array())).toThrow(ProtocolError);
		expect(() => peekProtocolMajor(bytesOf("01"))).toThrow(ProtocolError);
		expect(() => peekProtocolMajor(bytesOf("80"))).toThrow(ProtocolError);
		expect(() => peekProtocolMajor(bytesOf("98"))).toThrow(ProtocolError);
		expect(() => peekProtocolMajor(bytesOf("81"))).toThrow(ProtocolError);
	});

	it("rejects a non-shortest protocol_major encoding", () => {
		expect(() => peekProtocolMajor(bytesOf("1801"))).toThrow(ProtocolError);
		expect(() => peekProtocolMajor(bytesOf("811801"))).toThrow(ProtocolError);
	});

	it("rejects a protocol_major that is not a uint or exceeds 2^53-1", () => {
		expect(() => peekProtocolMajor(bytesOf("8120"))).toThrow(ProtocolError);
		expect(() => peekProtocolMajor(bytesOf("81f93c00"))).toThrow(ProtocolError);
		expect(() => peekProtocolMajor(bytesOf("811b0020000000000000"))).toThrow(ProtocolError);
	});
});
