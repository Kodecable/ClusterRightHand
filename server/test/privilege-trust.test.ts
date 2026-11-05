import type { TrustEntry, TrustReport, TrustSummary } from "@crh/protocol";
import { describe, expect, it, vi } from "vitest";
import {
	parseTaskAuthorization,
	serializeTaskAuthorization,
	signatureToJson,
	type TaskAuthorizationRecord,
} from "../src/cluster/authorization.ts";
import type { NodeRow } from "../src/cluster/nodes.ts";
import {
	parseTrustReport,
	trustDigest,
	trustReportFromJson,
	trustReportToJson,
	trustSummaryFromJson,
	trustSummaryToJson,
	trustView,
} from "../src/cluster/trust.ts";

const SSHSIG: TrustEntry = {
	name: "crhs",
	source: "local",
	role: "crhs",
	key: { kind: "sshsig", publicKey: "ssh-ed25519 AAAA crhs-signing", fingerprint: "SHA256:crhs" },
	kinds: ["execute", "cosign"],
	requireExact: true,
	requireTask: false,
	requireUv: false,
	maxTtlMs: 300_000,
	allow: [{ method: "exec", match: "prefix", pattern: "systemctl restart " }],
	deny: [{ method: "file.write", match: "prefix", pattern: "/etc/crha/" }],
	envAllow: ["LANG"],
};

const WEBAUTHN: TrustEntry = {
	name: "passkey",
	source: "local",
	role: "user",
	key: {
		kind: "webauthn",
		credentialId: Uint8Array.from([1, 2, 3]),
		coseKey: Uint8Array.from([4, 5, 6]),
		rpId: "crh.example.com",
		origins: ["https://crh.example.com"],
	},
	kinds: ["execute", "require-cosign"],
	requireExact: false,
	requireTask: true,
	requireUv: true,
	maxTtlMs: null,
	allow: [],
	deny: [],
	envAllow: [],
};

const LOCAL: TrustEntry = {
	name: "local-admins",
	source: "local",
	role: "local",
	key: { kind: "local", uids: [0, 1000] },
	kinds: ["execute"],
	requireExact: false,
	requireTask: false,
	requireUv: false,
	maxTtlMs: null,
	allow: [{ method: "exec", match: "any", pattern: "" }],
	deny: [],
	envAllow: [],
};

const SUMMARY: TrustSummary = {
	nodeId: "01JB0000000000000000000001",
	aliases: ["web", "prod"],
	clockSkewMs: 42,
	identities: {
		unprivileged: { uid: 998, gid: 998, user: "crha" },
		privileged: { uid: 0, gid: 0, user: "root" },
	},
	trust: [SSHSIG, WEBAUTHN, LOCAL],
};

describe("trust report storage", () => {
	it("round-trips an ok summary through the JSON form", () => {
		expect(trustSummaryFromJson(trustSummaryToJson(SUMMARY))).toEqual(SUMMARY);
		const report: TrustReport = { kind: "ok", summary: SUMMARY };
		expect(trustReportFromJson(trustReportToJson(report))).toEqual(report);
		expect(parseTrustReport(JSON.stringify(trustReportToJson(report)))).toEqual(report);
	});

	it("round-trips the other report kinds", () => {
		for (const report of [
			{ kind: "unavailable", message: "the privileged mode is not running" },
			{ kind: "not_forward" },
		] satisfies TrustReport[]) {
			expect(parseTrustReport(JSON.stringify(trustReportToJson(report)))).toEqual(report);
		}
	});

	it("fails closed on a damaged stored report", () => {
		// A damaged row is ignored with a log line; it must never be treated as a usable report.
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			expect(parseTrustReport(null)).toBeNull();
			expect(parseTrustReport("not json")).toBeNull();
			expect(parseTrustReport('{"kind":"ok","summary":{}}')).toBeNull();
			expect(parseTrustReport('{"kind":"ok","summary":[]}')).toBeNull();
			expect(parseTrustReport('{"kind":"something-else"}')).toBeNull();
			expect(trustReportFromJson({ kind: "ok", summary: trustSummaryToJson(SUMMARY) })).toEqual({
				kind: "ok",
				summary: SUMMARY,
			});
		} finally {
			warn.mockRestore();
		}
	});

	it("computes a stable digest that changes with the summary", () => {
		const digest = trustDigest(SUMMARY);
		expect(digest).toMatch(/^[0-9a-f]{64}$/);
		expect(trustDigest(trustSummaryFromJson(trustSummaryToJson(SUMMARY)))).toBe(digest);
		expect(trustDigest({ ...SUMMARY, aliases: ["web"] })).not.toBe(digest);
		expect(trustDigest({ ...SUMMARY, clockSkewMs: 43 })).not.toBe(digest);
	});

	it("describes a kept report as stale until the connection reports again", () => {
		const row = {
			trust_report: JSON.stringify(trustReportToJson({ kind: "ok", summary: SUMMARY })),
			trust_digest: trustDigest(SUMMARY),
			trust_updated_at: "2026-01-01T00:00:00.000Z",
		} as NodeRow;
		expect(trustView(row, true)).toMatchObject({ status: "ok", stale: false, digest: trustDigest(SUMMARY) });
		expect(trustView(row, false)).toMatchObject({ status: "ok", stale: true });
		expect(trustView({ ...row, trust_report: null }, false)).toMatchObject({ status: null, stale: false });
	});
});

describe("task authorization record", () => {
	const record: TaskAuthorizationRecord = {
		plan: {
			paths: [
				{ path: "user", entries: [{ name: "alice", role: "user", credential: "sshsig" }] },
				{ path: "local", entries: [{ name: "local-admins", role: "local" }] },
			],
		},
		tried: ["crhs"],
		dispatchedPath: null,
		pending: null,
		local: null,
		payloadId: "6d4a",
		attempt: 2,
		trustDigest: trustDigest(SUMMARY),
		lastRejection: { code: "authorization_rejected", message: "denied", attempt: 1, at: "2026-01-01T00:00:00.000Z" },
		updatedAt: "2026-01-01T00:00:00.000Z",
	};

	it("round-trips the stored record", () => {
		expect(parseTaskAuthorization(serializeTaskAuthorization(record))).toEqual(record);
	});

	it("treats a damaged record as absent and restores missing optional fields", () => {
		expect(parseTaskAuthorization(null)).toBeNull();
		expect(parseTaskAuthorization("not json")).toBeNull();
		expect(parseTaskAuthorization('{"plan":[]}')).toBeNull();
		expect(parseTaskAuthorization("[1,2,3]")).toBeNull();
		expect(parseTaskAuthorization('{"plan":{"paths":[]},"tried":[]}')).toMatchObject({
			dispatchedPath: null,
			payloadId: null,
			attempt: 1,
			trustDigest: null,
			lastRejection: null,
		});
	});

	it("stores signatures as JSON with base64 bytes", () => {
		expect(signatureToJson({ kind: "sshsig", blob: Uint8Array.from([1, 2, 3]) })).toEqual({
			kind: "sshsig",
			blob: "AQID",
		});
		expect(
			signatureToJson({
				kind: "webauthn",
				credentialId: Uint8Array.from([1]),
				authenticatorData: Uint8Array.from([2]),
				clientDataJson: Uint8Array.from([3]),
				signature: Uint8Array.from([4]),
			}),
		).toEqual({
			kind: "webauthn",
			credentialId: "AQ==",
			authenticatorData: "Ag==",
			clientDataJson: "Aw==",
			signature: "BA==",
		});
	});
});
