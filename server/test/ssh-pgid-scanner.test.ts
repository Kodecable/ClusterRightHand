import { describe, expect, it } from "vitest";
import { PgidScanner } from "../src/cluster/ssh/exec.ts";

/** The wrapper's pgid line: the search, and the limit that ends it (doc/design/execution.md "SSH execution"). */
const NONCE = "0011223344556677";
const MARKER = (nonce: string, pid: number) => `crh-pgid:${nonce}:${pid}\n`;

describe("the pgid marker scanner", () => {
	it("gives up on a marker beyond its limit and forwards everything", () => {
		const chunks: string[] = [];
		const scanner = new PgidScanner(NONCE, (data) => chunks.push(Buffer.from(data).toString()), 32);
		scanner.push(Buffer.from("x".repeat(40)));
		scanner.push(Buffer.from(MARKER(NONCE, 99)));
		expect(scanner.pgid).toBeUndefined();
		scanner.flush();
		expect(chunks.join("")).toBe(`x${"x".repeat(39)}${MARKER(NONCE, 99)}`);
	});

	it("finds a marker split across chunks", () => {
		const chunks: string[] = [];
		const scanner = new PgidScanner(NONCE, (data) => chunks.push(Buffer.from(data).toString()));
		scanner.push(Buffer.from("noise\ncrh-pgid:0011"));
		scanner.push(Buffer.from("223344556677:1234\ntail\n"));
		expect(scanner.pgid).toBe(1234);
		expect(chunks.join("")).toBe("noise\ntail\n");
	});

	it("ignores the marker when it does not start its line", () => {
		const chunks: string[] = [];
		const scanner = new PgidScanner(NONCE, (data) => chunks.push(Buffer.from(data).toString()));
		scanner.push(Buffer.from(`echo ${MARKER(NONCE, 5)}`));
		scanner.flush();
		expect(scanner.pgid).toBeUndefined();
		expect(chunks.join("")).toBe(`echo ${MARKER(NONCE, 5)}`);
	});
});
