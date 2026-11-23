/**
 * The served protocol majors and the upgrade-only path (doc/design/protocol.md "The major in the clear",
 * "Upgrade-only connections").
 */
import { majorFromSubprotocols, PROTOCOL_MAJOR, type TaskSpec } from "@crh/protocol";
import { describe, expect, it } from "vitest";
import {
	refusalResponse,
	SERVED_MAJORS,
	servedMajor,
	UPGRADE_REQUIRED_CODE,
	upgradeOnlyAllows,
	upgradeRequired,
} from "../src/cluster/majors.ts";

const UPGRADE: TaskSpec = {
	kind: "node.upgrade",
	version: "1.3.0",
	arch: "amd64",
	size: 1,
	sha256: new Uint8Array(32),
	endpoint: { kind: "crhs", transferId: "x" },
};
const LOG = "/var/lib/crha-upgrade/upgrade.jsonl";
const FACTS = JSON.stringify({ hostname: "n", upgradeLogPath: LOG });

describe("served majors", () => {
	it("serves only the current major at the first compatibility release", () => {
		expect(SERVED_MAJORS.map((entry) => [entry.major, entry.current])).toEqual([[PROTOCOL_MAJOR, true]]);
		expect(servedMajor(PROTOCOL_MAJOR)?.current).toBe(true);
		expect(servedMajor(2)).toBeUndefined();
		expect(servedMajor(undefined)).toBeUndefined();
	});

	it("reads the major from the subprotocol header", () => {
		expect(majorFromSubprotocols(undefined)).toBeUndefined();
		expect(majorFromSubprotocols("chat, superchat")).toBeUndefined();
		expect(majorFromSubprotocols(`crh.${PROTOCOL_MAJOR}`)).toBe(PROTOCOL_MAJOR);
		expect(majorFromSubprotocols("other, crh.7")).toBe(7);
		expect(majorFromSubprotocols("crh.x")).toBeUndefined();
		expect(majorFromSubprotocols("crh.03")).toBeUndefined();
		expect(majorFromSubprotocols("crh.")).toBeUndefined();
	});

	it("answers 426 with the served majors in a header and the body", () => {
		const answer = refusalResponse(2);
		const [head, body] = answer.split("\r\n\r\n");
		expect(head?.split("\r\n")[0]).toBe("HTTP/1.1 426 Upgrade Required");
		expect(head).toContain(`\r\nCRH-Served-Majors: ${PROTOCOL_MAJOR}`);
		expect(head).toContain(`\r\nUpgrade: crh.${PROTOCOL_MAJOR}`);
		expect(head).toContain(`\r\nContent-Length: ${Buffer.byteLength(body ?? "")}`);
		expect(body).toContain("this crha speaks major 2");
		expect(refusalResponse(undefined)).toContain("could not read a protocol major");
	});
});

describe("upgrade-only connections", () => {
	it("allow node.upgrade and a read of the reported upgrade log, nothing else", () => {
		expect(upgradeOnlyAllows(UPGRADE, null)).toBe(true);
		expect(upgradeOnlyAllows({ kind: "file.read", path: LOG, startLine: 1, lineCount: 128 }, FACTS)).toBe(true);
		expect(upgradeOnlyAllows({ kind: "file.read", path: "/etc/shadow", startLine: 1, lineCount: 1 }, FACTS)).toBe(
			false,
		);
		// Without a reported log path there is nothing to read.
		expect(upgradeOnlyAllows({ kind: "file.read", path: LOG, startLine: 1, lineCount: 1 }, null)).toBe(false);
		expect(upgradeOnlyAllows({ kind: "file.read", path: LOG, startLine: 1, lineCount: 1 }, "not json")).toBe(false);
		expect(upgradeOnlyAllows({ kind: "file.stat", path: LOG }, FACTS)).toBe(false);
		expect(upgradeOnlyAllows({ kind: "exec", command: { argv: ["true"] }, env: {}, cwd: "", stdin: null }, FACTS)).toBe(
			false,
		);
	});

	it("refuses everything else with upgrade_required", () => {
		const error = upgradeRequired("db-1");
		expect(error.code).toBe(UPGRADE_REQUIRED_CODE);
		expect(error.message).toContain("db-1");
	});
});
