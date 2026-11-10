/**
 * The node trust cache (doc/design/privilege.md "Trust cache"): crha pushes a TrustReport once after `hello` and
 * again whenever the report changes. crhs keeps the report, the digest of an `ok` summary and the time,
 * audits an actual change, and treats the kept report as stale until the next report.
 */
import { createHash } from "node:crypto";
import type { NodeTrust, TrustStatus } from "@crh/api";
import {
	encode as encodeCbor,
	type GuardRule,
	type Identity,
	type TrustEntry,
	type TrustKey,
	type TrustReport,
	type TrustSummary,
	trustSummaryCodec,
} from "@crh/protocol";
import type { Audit } from "../audit/audit.ts";
import type { Db } from "../storage/db.ts";
import type { NodeRow } from "./nodes.ts";

export type { TrustStatus };

/** `digest = SHA-256(CBOR(TrustSummary))`, lowercase hex (doc/design/protocol.md "Trust summary"). */
export function trustDigest(summary: TrustSummary): string {
	return createHash("sha256")
		.update(encodeCbor(trustSummaryCodec.encode(summary)))
		.digest("hex");
}

// ---------------------------------------------------------------------------
// JSON form: bytes are base64 text, exactly like the other stored JSON in crhs
// (doc/design/protocol.md "JSON storage forms"). It is validated by re-encoding the summary.
// ---------------------------------------------------------------------------

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");

function asObject(value: unknown, what: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error(`stored trust report: ${what} is not an object`);
	return value as Record<string, unknown>;
}

function asString(value: unknown, what: string): string {
	if (typeof value !== "string") throw new Error(`stored trust report: ${what} is not text`);
	return value;
}

function asNumber(value: unknown, what: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		throw new Error(`stored trust report: ${what} is not a non-negative integer`);
	}
	return value;
}

function asBool(value: unknown, what: string): boolean {
	if (typeof value !== "boolean") throw new Error(`stored trust report: ${what} is not a boolean`);
	return value;
}

function asArray(value: unknown, what: string): unknown[] {
	if (!Array.isArray(value)) throw new Error(`stored trust report: ${what} is not an array`);
	return value;
}

function asBytes(value: unknown, what: string): Uint8Array {
	if (typeof value !== "string") throw new Error(`stored trust report: ${what} is not base64`);
	return Uint8Array.from(Buffer.from(value, "base64"));
}

function identityToJson(identity: Identity): Record<string, unknown> {
	return { uid: identity.uid, gid: identity.gid, user: identity.user };
}

function identityFromJson(value: unknown): Identity {
	const o = asObject(value, "identity");
	return {
		uid: asNumber(o.uid, "identity.uid"),
		gid: asNumber(o.gid, "identity.gid"),
		user: asString(o.user, "identity.user"),
	};
}

function trustKeyToJson(key: TrustKey): Record<string, unknown> {
	switch (key.kind) {
		case "sshsig":
			return { kind: "sshsig", publicKey: key.publicKey, fingerprint: key.fingerprint };
		case "webauthn":
			return {
				kind: "webauthn",
				credentialId: b64(key.credentialId),
				coseKey: b64(key.coseKey),
				rpId: key.rpId,
				origins: key.origins,
			};
		case "local":
			return { kind: "local", uids: key.uids };
	}
}

function trustKeyFromJson(value: unknown): TrustKey {
	const o = asObject(value, "trust key");
	const kind = asString(o.kind, "trust key kind");
	switch (kind) {
		case "sshsig":
			return {
				kind: "sshsig",
				publicKey: asString(o.publicKey, "key.publicKey"),
				fingerprint: asString(o.fingerprint, "key.fingerprint"),
			};
		case "webauthn":
			return {
				kind: "webauthn",
				credentialId: asBytes(o.credentialId, "key.credentialId"),
				coseKey: asBytes(o.coseKey, "key.coseKey"),
				rpId: asString(o.rpId, "key.rpId"),
				origins: asArray(o.origins, "key.origins").map((origin) => asString(origin, "key.origins[]")),
			};
		case "local":
			return { kind: "local", uids: asArray(o.uids, "key.uids").map((uid) => asNumber(uid, "key.uids[]")) };
		default:
			throw new Error(`stored trust report: unknown trust key kind ${kind}`);
	}
}

function ruleFromJson(value: unknown): GuardRule {
	const o = asObject(value, "guard rule");
	// trustSummaryCodec.encode below validates the enums and the pattern text.
	return {
		method: asString(o.method, "guard rule method") as GuardRule["method"],
		match: asString(o.match, "guard rule match") as GuardRule["match"],
		pattern: asString(o.pattern, "guard rule pattern"),
	};
}

function entryToJson(entry: TrustEntry): Record<string, unknown> {
	return {
		name: entry.name,
		source: entry.source,
		role: entry.role,
		key: trustKeyToJson(entry.key),
		kinds: entry.kinds,
		requireExact: entry.requireExact,
		requireTask: entry.requireTask,
		requireUv: entry.requireUv,
		maxTtlMs: entry.maxTtlMs,
		allow: entry.allow,
		deny: entry.deny,
		envAllow: entry.envAllow,
	};
}

function entryFromJson(value: unknown): TrustEntry {
	const o = asObject(value, "trust entry");
	return {
		name: asString(o.name, "entry.name"),
		source: asString(o.source, "entry.source") as TrustEntry["source"],
		role: asString(o.role, "entry.role") as TrustEntry["role"],
		key: trustKeyFromJson(o.key),
		kinds: asArray(o.kinds, "entry.kinds").map((kind) => asString(kind, "entry.kinds[]")) as TrustEntry["kinds"],
		requireExact: asBool(o.requireExact, "entry.requireExact"),
		requireTask: asBool(o.requireTask, "entry.requireTask"),
		requireUv: asBool(o.requireUv, "entry.requireUv"),
		maxTtlMs: o.maxTtlMs === null ? null : asNumber(o.maxTtlMs, "entry.maxTtlMs"),
		allow: asArray(o.allow, "entry.allow").map(ruleFromJson),
		deny: asArray(o.deny, "entry.deny").map(ruleFromJson),
		envAllow: asArray(o.envAllow, "entry.envAllow").map((name) => asString(name, "entry.envAllow[]")),
	};
}

export function trustSummaryToJson(summary: TrustSummary): Record<string, unknown> {
	return {
		nodeId: summary.nodeId,
		aliases: summary.aliases,
		clockSkewMs: summary.clockSkewMs,
		identities: {
			unprivileged: identityToJson(summary.identities.unprivileged),
			privileged: identityToJson(summary.identities.privileged),
		},
		trust: summary.trust.map(entryToJson),
	};
}

export function trustSummaryFromJson(value: unknown): TrustSummary {
	const o = asObject(value, "summary");
	const identities = asObject(o.identities, "summary.identities");
	const summary: TrustSummary = {
		nodeId: asString(o.nodeId, "summary.nodeId"),
		aliases: asArray(o.aliases, "summary.aliases").map((alias) => asString(alias, "summary.aliases[]")),
		clockSkewMs: asNumber(o.clockSkewMs, "summary.clockSkewMs"),
		identities: {
			unprivileged: identityFromJson(identities.unprivileged),
			privileged: identityFromJson(identities.privileged),
		},
		trust: asArray(o.trust, "summary.trust").map(entryFromJson),
	};
	// Validates enums, integer ranges, UTF-8 and byte lengths: a damaged row is not trusted.
	trustSummaryCodec.encode(summary);
	return summary;
}

export function trustReportToJson(report: TrustReport): Record<string, unknown> {
	switch (report.kind) {
		case "ok":
			return { kind: "ok", summary: trustSummaryToJson(report.summary) };
		case "unavailable":
			return { kind: "unavailable", message: report.message };
		case "not_forward":
			return { kind: "not_forward" };
	}
}

export function trustReportFromJson(value: unknown): TrustReport {
	const o = asObject(value, "report");
	const kind = asString(o.kind, "report.kind");
	switch (kind) {
		case "ok":
			return { kind: "ok", summary: trustSummaryFromJson(o.summary) };
		case "unavailable":
			return { kind: "unavailable", message: asString(o.message, "report.message") };
		case "not_forward":
			return { kind: "not_forward" };
		default:
			throw new Error(`stored trust report: unknown status ${kind}`);
	}
}

/** The cached report of a node; null when there is none or the row cannot be read (fail closed). */
export function parseTrustReport(json: string | null): TrustReport | null {
	if (!json) return null;
	try {
		return trustReportFromJson(JSON.parse(json));
	} catch (err) {
		console.warn(`trust report ignored: ${err instanceof Error ? err.message : String(err)}`);
		return null;
	}
}

// ---------------------------------------------------------------------------
// The cache and its audit record
// ---------------------------------------------------------------------------

export interface TrustChange {
	changed: boolean;
	/** Hex digest of an `ok` summary; null for the other reports and when there is none. */
	digest: string | null;
	status: TrustStatus;
	previousDigest: string | null;
	previousStatus: TrustStatus | null;
}

/**
 * Stores a report. `node.trust_changed` is written only when the status or the digest actually
 * changed; the audit carries both digests and the new status (doc/design/access-control.md "Recorded events").
 */
export async function recordTrustReport(
	db: Db,
	nodeId: string,
	report: TrustReport,
	options: { audit?: Audit; now?: Date } = {},
): Promise<TrustChange> {
	const now = (options.now ?? new Date()).toISOString();
	const node = await db
		.selectFrom("nodes")
		.select(["trust_digest", "trust_report"])
		.where("id", "=", nodeId)
		.executeTakeFirst();
	if (!node) throw new Error(`no such node: ${nodeId}`);
	const digest = report.kind === "ok" ? trustDigest(report.summary) : null;
	const previousDigest = node.trust_digest;
	const previousStatus = parseTrustReport(node.trust_report)?.kind ?? null;
	const changed = previousDigest !== digest || previousStatus !== report.kind;
	await db
		.updateTable("nodes")
		.set({ trust_report: JSON.stringify(trustReportToJson(report)), trust_digest: digest, trust_updated_at: now })
		.where("id", "=", nodeId)
		.execute();
	if (changed) {
		await options.audit?.record({
			actor: { type: "system", id: "cluster" },
			action: "node.trust_changed",
			target: { type: "node", id: nodeId },
			detail: { old_digest: previousDigest, new_digest: digest, old_status: previousStatus, status: report.kind },
		});
	}
	return { changed, digest, status: report.kind, previousDigest, previousStatus };
}

/** Why a node cannot take part in `forward`, for a privileged_unavailable failure. */
export function trustUnavailableMessage(report: TrustReport | null): string {
	if (report === null) return "the node has not reported a trust summary; it cannot authorize privileged tasks";
	if (report.kind === "unavailable") return report.message;
	if (report.kind === "not_forward") return "the node's crha does not run its privileged mode in forward mode";
	return "";
}

export type NodeTrustView = NodeTrust;

/** The trust panel of a node (doc/design/privilege.md "Trust cache"). */
export function trustView(row: NodeRow, fresh: boolean): NodeTrustView {
	const report = parseTrustReport(row.trust_report);
	return {
		status: report?.kind ?? null,
		message: report?.kind === "unavailable" ? report.message : null,
		digest: row.trust_digest,
		updatedAt: row.trust_updated_at,
		stale: report !== null && !fresh,
		summary: report?.kind === "ok" ? report.summary : null,
	};
}
