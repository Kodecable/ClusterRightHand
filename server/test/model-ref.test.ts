import { describe, expect, it } from "vitest";
import { parseStoredModelRef } from "../src/util/model-ref.ts";

describe("parseStoredModelRef", () => {
	it("reads a stored reference and its thinking level", () => {
		expect(parseStoredModelRef('{"provider":"p","modelId":"m","thinkingLevel":"high"}')).toEqual({
			provider: "p",
			modelId: "m",
			thinkingLevel: "high",
		});
	});

	it("omits a thinking level that is not a string", () => {
		expect(parseStoredModelRef('{"provider":"p","modelId":"m","thinkingLevel":3}')).toEqual({
			provider: "p",
			modelId: "m",
		});
	});

	it("returns null for a missing, malformed or incomplete row", () => {
		expect(parseStoredModelRef(null)).toBeNull();
		expect(parseStoredModelRef("")).toBeNull();
		expect(parseStoredModelRef("not json")).toBeNull();
		expect(parseStoredModelRef('{"provider":"p"}')).toBeNull();
		expect(parseStoredModelRef('{"modelId":"m"}')).toBeNull();
	});
});
