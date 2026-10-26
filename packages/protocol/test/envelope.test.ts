import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { decodeEnvelope, encodeEnvelope, HelloSchema } from "../src/index.ts";

describe("envelope", () => {
	it("round-trips a Hello", () => {
		const hello = create(HelloSchema, { crhaVersion: "0.0.0", capabilities: ["output-file"] });
		const decoded = decodeEnvelope(encodeEnvelope({ case: "hello", value: hello }));
		expect(decoded.body.case).toBe("hello");
		expect(decoded.body.value).toMatchObject({ crhaVersion: "0.0.0", capabilities: ["output-file"] });
	});

	// The same bytes are asserted in client/internal/transport/envelope_test.go.
	it("matches the Go encoding", () => {
		const hello = create(HelloSchema, { crhaVersion: "0.0.0", capabilities: ["output-file"] });
		expect(Buffer.from(encodeEnvelope({ case: "hello", value: hello })).toString("hex")).toBe(
			"0a140a05302e302e30120b6f75747075742d66696c65",
		);
	});

	it("rejects oversized input", () => {
		expect(() => decodeEnvelope(new Uint8Array(61 * 1024))).toThrow(RangeError);
	});
});
