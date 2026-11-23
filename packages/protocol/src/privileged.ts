/**
 * Privilege wire types (doc/design/protocol.md "Privilege messages"): the authorization object, TrustSummary
 * with the local approval window, the window commands and the crh-priv handshake. Only the shapes and the structural
 * invariants of protocol.md live here; signature checks and hashing are left to
 * the callers, which run under Node.
 */
import { decode as decodeCbor, encode as encodeCbor } from "./cbor.ts";
import {
	bool,
	bytes,
	enumOf,
	field,
	type Infer,
	int,
	list,
	nullable,
	openName,
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
/**
 * SSHSIG namespace of a cosign ticket. It differs from AUTH_NAMESPACE, so a ticket signature can never
 * pass as an authorization signature, nor the reverse.
 */
export const COSIGN_NAMESPACE = "crh-cosign-v1";
export const COSIGN_PAYLOAD_VERSION = 1;

export const PRIV_MAJOR = 1;
/**
 * Incompatible changes bump the major version, so a peer with another major is refused; the minor
 * stays additive and never refuses a handshake.
 */
export const PRIV_MINOR = 0;

/**
 * The methods this version knows. On the wire a method is an open name (doc/design/protocol.md
 * "Encoding rules"), so a newer peer's method decodes: crhs plans conservatively around it and a
 * node refuses an authorization that names it (doc/design/privilege.md "Methods and targets").
 */
export const KNOWN_METHODS = ["exec", "file.read", "file.write", "upgrade", "pty.create"] as const;
export type KnownMethod = (typeof KNOWN_METHODS)[number];
/** The guard rule match types this version knows; see KNOWN_METHODS for open names. */
export const KNOWN_MATCHES = ["any", "prefix", "regex"] as const;
export type KnownMatch = (typeof KNOWN_MATCHES)[number];
/** The trust entry roles this version knows. */
export const KNOWN_ROLES = ["crhs", "user", "local"] as const;
export type KnownRole = (typeof KNOWN_ROLES)[number];
/** The trust entry capabilities this version knows. */
export const KNOWN_CAPABILITIES = ["execute", "cosign", "require-cosign"] as const;
export type KnownCapability = (typeof KNOWN_CAPABILITIES)[number];

export function isKnownMethod(value: string): value is KnownMethod {
	return (KNOWN_METHODS as readonly string[]).includes(value);
}
export function isKnownMatch(value: string): value is KnownMatch {
	return (KNOWN_MATCHES as readonly string[]).includes(value);
}
export function isKnownRole(value: string): value is KnownRole {
	return (KNOWN_ROLES as readonly string[]).includes(value);
}
export function isKnownCapability(value: string): value is KnownCapability {
	return (KNOWN_CAPABILITIES as readonly string[]).includes(value);
}

const method = openName("method");

// ---------------------------------------------------------------------------
// TrustSummary
// ---------------------------------------------------------------------------

export const guardRuleCodec = tuple([
	["method", method],
	["match", openName("match")],
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
	["role", openName("role")],
	["key", trustKeyCodec],
	["kinds", list(openName("capability"))],
	["requireSpec", bool],
	["requireTask", bool],
	["requireUv", bool],
	["maxTtlMs", nullable(uint)],
	["allow", list(guardRuleCodec)],
	["deny", list(guardRuleCodec)],
	["envAllow", list(text)],
]);
export type TrustEntry = Infer<typeof trustEntryCodec>;

export const windowStateCodec = union({
	closed: tuple([]),
	open: tuple([
		["openedAtMs", int],
		["openedByUid", uint],
		["untilMs", int],
	]),
});
export type WindowState = Infer<typeof windowStateCodec>;

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
	["localWindow", windowStateCodec],
]);
export type TrustSummary = Infer<typeof trustSummaryCodec>;

export const trustReportCodec = union({
	ok: field("summary", trustSummaryCodec),
	unavailable: tuple([["message", text]]),
	not_forward: tuple([]),
});
export type TrustReport = Infer<typeof trustReportCodec>;

// ---------------------------------------------------------------------------
// Authorization object
// ---------------------------------------------------------------------------

/**
 * The command limit of an authorization: the hash of the complete task spec (the method follows
 * from the spec), or a method and target prefix. `null` on the payload means any command.
 */
export const authCommandCodec = union({
	spec: sha256,
	prefix: tuple([
		["method", method],
		["target", text],
	]),
});
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
// Cosign ticket
// ---------------------------------------------------------------------------

/** One use a cosign ticket confirms: a task at one attempt on one node (a node UUID, never a group or "*"). */
export const cosignUseCodec = tuple([
	["node", text],
	["taskId", text],
	["attempt", uint],
]);
export type CosignUse = Infer<typeof cosignUseCodec>;

/**
 * crhs's confirmation of specific uses of one authorization (doc/design/protocol.md "Cosign ticket"):
 * `authorizationId` is SHA-256 of the confirmed authorization's payload bytes.
 */
export const cosignPayloadCodec = tuple([
	["v", uint],
	["authorizationId", sha256],
	["uses", list(cosignUseCodec)],
	["issuedAtMs", int],
	["deadlineMs", int],
]);
export type CosignPayload = Infer<typeof cosignPayloadCodec>;

/** `payload` is the original CBOR bytes of a CosignPayload; the signatures are crhs's, in COSIGN_NAMESPACE. */
export const cosignTicketCodec = tuple([
	["payload", bytes],
	["signatures", list(signatureCodec)],
]);
export type CosignTicket = Infer<typeof cosignTicketCodec>;

/** The structural rules of a cosign payload beyond the shape; throws SchemaError. */
export function checkCosignPayload(payload: CosignPayload): CosignPayload {
	const fail = (reason: string): never => {
		throw new SchemaError(`cosign payload: ${reason}`);
	};
	if (payload.v !== COSIGN_PAYLOAD_VERSION) fail(`unsupported version ${payload.v}`);
	if (payload.uses.length === 0) fail("uses is empty");
	const taskIds = new Set<string>();
	for (const use of payload.uses) {
		if (use.node === "*") fail('a use names a node id, not "*"');
		if (use.attempt < 1) fail("attempt must be at least 1");
		if (taskIds.has(use.taskId)) fail("duplicate task ids");
		taskIds.add(use.taskId);
	}
	if (payload.deadlineMs < payload.issuedAtMs) fail("deadline is before the issue time");
	return payload;
}

/** Strictly decode cosign payload bytes: profile, schema and the structural rules. */
export function decodeCosignPayload(payloadBytes: Uint8Array): CosignPayload {
	return checkCosignPayload(cosignPayloadCodec.decode(decodeCbor(payloadBytes)));
}

export function encodeCosignPayload(payload: CosignPayload): Uint8Array {
	return encodeCbor(cosignPayloadCodec.encode(checkCosignPayload(payload)));
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

export const windowOpenCodec = tuple([["durationMs", uint]]);
export type WindowOpen = Infer<typeof windowOpenCodec>;

/**
 * The optional crh-priv terminal names (doc/design/pty.md "Protocol additions"): a privileged
 * terminal runs in the privileged mode, which relays its bytes to the unprivileged mode. Like every
 * optional crh-priv name they are negotiated by intersection, and they are not advertised yet
 * because there is no runtime.
 */
export const PRIV_PTY_COMMANDS = ["pty.open", "pty.input", "pty.resize", "pty.close"] as const;
export const PRIV_PTY_EVENTS = ["pty.output", "pty.exited"] as const;

/**
 * The crh-priv `pty.open` body: the terminal id, the argv (empty for the privileged identity's login
 * shell), its size and its authorization, carried exactly as `task.start` does. Size and metadata
 * are not here: the terminal's size follows from `pty.resize` and its metadata stays crhs's.
 */
export const privPtyOpenCodec = tuple([
	["ptyId", text],
	["argv", list(text)],
	["rows", uint],
	["cols", uint],
	["attempt", uint],
	["authorizations", list(bytes)],
	["cosign", nullable(bytes)],
]);
export type PrivPtyOpen = Infer<typeof privPtyOpenCodec>;

/** The crh-priv `pty.input` body: bytes the person or agent typed. */
export const privPtyInputCodec = tuple([
	["ptyId", text],
	["data", bytes],
]);
export type PrivPtyInput = Infer<typeof privPtyInputCodec>;

/** The crh-priv `pty.resize` body: the terminal id and its new size. */
export const privPtyResizeCodec = tuple([
	["ptyId", text],
	["rows", uint],
	["cols", uint],
]);
export type PrivPtyResize = Infer<typeof privPtyResizeCodec>;

/** The crh-priv `pty.close` body: the terminal id to close. */
export const privPtyCloseCodec = tuple([["ptyId", text]]);
export type PrivPtyClose = Infer<typeof privPtyCloseCodec>;

/** The crh-priv `pty.output` event body: the terminal id and the bytes the process wrote. */
export const privPtyOutputCodec = tuple([
	["ptyId", text],
	["data", bytes],
]);
export type PrivPtyOutput = Infer<typeof privPtyOutputCodec>;

/**
 * The crh-priv `pty.exited` event body: the terminal id and the process's exit code. There is no
 * reason here; the unprivileged mode decides whether the terminal ended or lost its privileged mode.
 */
export const privPtyExitedCodec = tuple([
	["ptyId", text],
	["exitCode", int],
]);
export type PrivPtyExited = Infer<typeof privPtyExitedCodec>;

/** crh-priv frames on a stream: a 4-byte big-endian length, then the frame. */
export function lengthPrefixed(frame: Uint8Array): Uint8Array {
	const out = new Uint8Array(4 + frame.length);
	new DataView(out.buffer).setUint32(0, frame.length);
	out.set(frame, 4);
	return out;
}
