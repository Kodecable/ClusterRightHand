/**
 * M4 wire types (doc/protocol.md#m4提权): the authorization object, TrustSummary,
 * local approval and the crh-priv handshake. Only the shapes and the structural
 * invariants of protocol.md live here; signature checks and hashing are left to
 * the callers, which run under Node.
 */
import { decode as decodeCbor, encode as encodeCbor } from "./cbor.ts";
import { taskSpecCodec } from "./messages.ts";
import {
	bool,
	bytes,
	enumOf,
	field,
	type Infer,
	int,
	list,
	nullable,
	SchemaError,
	sha256,
	text,
	tuple,
	uint,
	union,
} from "./schema.ts";

/** SSHSIG namespace and WebAuthn challenge prefix. */
export const AUTH_NAMESPACE = "crh-auth-v1";
export const AUTH_PAYLOAD_VERSION = 1;

export const PRIV_MAJOR = 3;
/**
 * Incompatible changes bump the major version, so a peer with another major is refused; the minor
 * stays additive and never refuses a handshake. PrivMajor 3 renames `TrustSummary.groups` to
 * `aliases` (D110); 2 carried the `task.exit.result` element and the line-range `file.read` spec.
 */
export const PRIV_MINOR = 0;

const method = enumOf("exec", "file.read", "file.write");

// ---------------------------------------------------------------------------
// TrustSummary
// ---------------------------------------------------------------------------

export const guardRuleCodec = tuple([
	["method", method],
	["match", enumOf("any", "prefix", "regex")],
	["pattern", text],
]);
export type GuardRule = Infer<typeof guardRuleCodec>;

export const identityCodec = tuple([
	["uid", uint],
	["gid", uint],
	["user", text],
]);
export type Identity = Infer<typeof identityCodec>;

export const trustKeyCodec = union({
	sshsig: tuple([
		["publicKey", text],
		["fingerprint", text],
	]),
	webauthn: tuple([
		["credentialId", bytes],
		["coseKey", bytes],
		["rpId", text],
		["origins", list(text)],
	]),
	local: tuple([["uids", list(uint)]]),
});
export type TrustKey = Infer<typeof trustKeyCodec>;

export const trustEntryCodec = tuple([
	["name", text],
	["source", enumOf("local")],
	["role", enumOf("crhs", "user", "local")],
	["key", trustKeyCodec],
	["kinds", list(enumOf("execute", "cosign", "require-cosign"))],
	["requireExact", bool],
	["requireTask", bool],
	["requireUv", bool],
	["maxTtlMs", nullable(uint)],
	["allow", list(guardRuleCodec)],
	["deny", list(guardRuleCodec)],
	["envAllow", list(text)],
]);
export type TrustEntry = Infer<typeof trustEntryCodec>;

export const trustSummaryCodec = tuple([
	["nodeId", text],
	["aliases", list(text)],
	["clockSkewMs", uint],
	[
		"identities",
		tuple([
			["unprivileged", identityCodec],
			["privileged", identityCodec],
		]),
	],
	["trust", list(trustEntryCodec)],
]);
export type TrustSummary = Infer<typeof trustSummaryCodec>;

export const trustReportCodec = union({
	ok: field("summary", trustSummaryCodec),
	unavailable: tuple([["message", text]]),
	not_forward: tuple([]),
});
export type TrustReport = Infer<typeof trustReportCodec>;

// ---------------------------------------------------------------------------
// Local approval
// ---------------------------------------------------------------------------

export const localRequestCodec = tuple([
	["taskId", text],
	["attempt", uint],
	["spec", taskSpecCodec],
	["note", text],
]);
export type LocalRequest = Infer<typeof localRequestCodec>;

export const localStateCodec = union({
	pending: tuple([]),
	approved: tuple([]),
	denied: tuple([["message", text]]),
});
export type LocalState = Infer<typeof localStateCodec>;

export const localWithdrawCodec = tuple([
	["taskId", text],
	["attempt", uint],
]);
export type LocalWithdraw = Infer<typeof localWithdrawCodec>;

export const localDecisionCodec = tuple([
	["taskId", text],
	["attempt", uint],
	["state", localStateCodec],
]);
export type LocalDecision = Infer<typeof localDecisionCodec>;

// ---------------------------------------------------------------------------
// Authorization object
// ---------------------------------------------------------------------------

export const authMatchCodec = union({
	exact: tuple([
		["target", text],
		["specSha256", sha256],
	]),
	prefix: tuple([["target", text]]),
});
export type AuthMatch = Infer<typeof authMatchCodec>;

export const authCommandCodec = tuple([
	["method", method],
	["match", authMatchCodec],
]);
export type AuthCommand = Infer<typeof authCommandCodec>;

export const authorizationPayloadCodec = tuple([
	["v", uint],
	["nodes", list(text)],
	["command", nullable(authCommandCodec)],
	["issuedAtMs", int],
	["deadlineMs", nullable(int)],
	["taskIds", nullable(list(text))],
	["attempt", nullable(uint)],
	["note", text],
]);
export type AuthorizationPayload = Infer<typeof authorizationPayloadCodec>;

export const signatureCodec = union({
	sshsig: tuple([["blob", bytes]]),
	webauthn: tuple([
		["credentialId", bytes],
		["authenticatorData", bytes],
		["clientDataJson", bytes],
		["signature", bytes],
	]),
});
export type Signature = Infer<typeof signatureCodec>;

/** `payload` is the original CBOR bytes of an AuthorizationPayload. */
export const authorizationCodec = tuple([
	["payload", bytes],
	["signatures", list(signatureCodec)],
]);
export type Authorization = Infer<typeof authorizationCodec>;

/** The structural rules of protocol.md beyond the shape; throws SchemaError. */
export function checkAuthorizationPayload(payload: AuthorizationPayload): AuthorizationPayload {
	const fail = (reason: string): never => {
		throw new SchemaError(`authorization payload: ${reason}`);
	};
	if (payload.v !== AUTH_PAYLOAD_VERSION) fail(`unsupported version ${payload.v}`);
	if (payload.nodes.length === 0) fail("nodes is empty");
	if (payload.nodes.includes("*") && payload.nodes.length !== 1) fail('"*" must be the only node');
	if (new Set(payload.nodes).size !== payload.nodes.length) fail("duplicate nodes");
	if ((payload.taskIds === null) !== (payload.attempt === null))
		fail("taskIds and attempt must both be null or both be set");
	if (payload.taskIds !== null) {
		if (payload.taskIds.length === 0) fail("taskIds is empty");
		if (new Set(payload.taskIds).size !== payload.taskIds.length) fail("duplicate taskIds");
	}
	if (payload.attempt !== null && payload.attempt < 1) fail("attempt must be at least 1");
	return payload;
}

/** Strictly decode payload bytes: profile, schema and the structural rules. */
export function decodeAuthorizationPayload(payloadBytes: Uint8Array): AuthorizationPayload {
	return checkAuthorizationPayload(authorizationPayloadCodec.decode(decodeCbor(payloadBytes)));
}

export function encodeAuthorizationPayload(payload: AuthorizationPayload): Uint8Array {
	return encodeCbor(authorizationPayloadCodec.encode(checkAuthorizationPayload(payload)));
}

// ---------------------------------------------------------------------------
// crh-priv
// ---------------------------------------------------------------------------

export const privHelloCodec = tuple([
	["privMajor", uint],
	["privMinor", uint],
	["commands", list(text)],
	["crhaVersion", text],
	["role", enumOf("forward", "native", "local")],
]);
export type PrivHello = Infer<typeof privHelloCodec>;

export const privWelcomeCodec = tuple([
	["privMajor", uint],
	["privMinor", uint],
	["commands", list(text)],
	["crhaVersion", text],
]);
export type PrivWelcome = Infer<typeof privWelcomeCodec>;

export const pendingEntryCodec = tuple([
	["taskId", text],
	["attempt", uint],
	["spec", taskSpecCodec],
	["note", text],
	["receivedAtMs", int],
]);
export type PendingEntry = Infer<typeof pendingEntryCodec>;

export const localVerdictCodec = tuple([
	["taskId", text],
	["attempt", uint],
	/** The spec the approver saw; the privileged mode refuses a verdict with another hash. */
	["specSha256", sha256],
	["message", text],
]);
export type LocalVerdict = Infer<typeof localVerdictCodec>;

/** crh-priv frames on a stream: a 4-byte big-endian length, then the frame. */
export function lengthPrefixed(frame: Uint8Array): Uint8Array {
	const out = new Uint8Array(4 + frame.length);
	new DataView(out.buffer).setUint32(0, frame.length);
	out.set(frame, 4);
	return out;
}
