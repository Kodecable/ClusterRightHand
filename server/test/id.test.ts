import { describe, expect, it } from "vitest";
import { idTimestamp, newId } from "../src/util/id.ts";

const FORMAT = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("newId", () => {
	it("produces canonical UUIDv7 strings", () => {
		for (let i = 0; i < 100; i++) expect(newId()).toMatch(FORMAT);
	});

	it("is unique and strictly increasing", () => {
		const ids = Array.from({ length: 10_000 }, () => newId());
		expect(new Set(ids).size).toBe(ids.length);
		for (let i = 1; i < ids.length; i++) {
			expect((ids[i] as string) > (ids[i - 1] as string)).toBe(true);
		}
	});

	it("stays monotonic across millisecond boundaries", async () => {
		const a = newId();
		await new Promise((resolve) => setTimeout(resolve, 3));
		const b = newId();
		expect(b > a).toBe(true);
	});
});

describe("idTimestamp", () => {
	it("extracts the creation time", () => {
		const before = Date.now();
		const id = newId();
		const ts = idTimestamp(id);
		expect(ts).toBeGreaterThanOrEqual(before - 5);
		expect(ts).toBeLessThanOrEqual(Date.now() + 15);
	});

	it("parses a known id", () => {
		expect(idTimestamp("017f22e2-79b0-7cc3-98c4-dc0c0c07398f")).toBe(0x017f22e279b0);
	});
});
