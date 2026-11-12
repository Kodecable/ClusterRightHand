/**
 * Turning an `Authorization` a user submits (pasted `crha grant` output, or a Passkey assertion built
 * by the waiting page) into something crhs can check and hand to crha (doc/design/privilege.md "Signing methods",
 * doc/design/protocol.md "Authorization object").
 *
 * Two separate questions are answered here:
 *
 * - Does the authorization carry at least one signature from one of the *submitting user's own*
 *   credentials? Without that, anyone could submit someone else's authorization and trigger tasks.
 * - For a given node's TrustSummary, which of the signatures belong to which trust entry, and would the
 *   node accept the authorization? That is the same decision port crha runs (`authz.ts`), fed with the
 *   signatures verified here.
 */

import { createHash } from "node:crypto";
import {
	type AuthorizationPayload,
	authorizationCodec,
	decodeAuthorizationPayload,
	decode as decodeCbor,
	encode as encodeCbor,
	type Signature,
	type TrustEntry,
} from "@crh/protocol";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { parseTaskAuthorization } from "../cluster/authorization.ts";
import type { Db } from "../storage/db.ts";
import { errorText, UserError } from "../util/errors.ts";
import { type AuthzEntry, type AuthzSignature, authzEntryFromTrust } from "./authz.ts";
import { webauthnSigningCredentials } from "./signing-credentials.ts";
import { parseAuthorizedKey, sshsigKeyBlob, verifySshsig } from "./sshsig.ts";
import { verifyAssertion } from "./webauthn.ts";

/** A client error of POST /api/authorizations; the route answers 400 with the message. */
export class SubmissionError extends UserError {}

export interface SubmittedAuthorization {
	payload: AuthorizationPayload;
	/** The exact bytes the signatures cover. */
	payloadBytes: Uint8Array;
	signatures: Signature[];
	/** Hex SHA-256 of the payload bytes: the authorization id. */
	id: string;
}

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]+={0,2}$/;

/** Decodes the base64 text `crha grant` prints: CBOR(Authorization) as one base64 string. */
export function parseSubmittedAuthorization(text: string): SubmittedAuthorization {
	const compact = text.replace(/\s+/g, "");
	if (!BASE64_RE.test(compact)) throw new SubmissionError("authorization must be base64 text");
	const bytes = Uint8Array.from(Buffer.from(compact, "base64"));
	if (Buffer.from(bytes).toString("base64") !== compact) {
		throw new SubmissionError("authorization is not valid base64");
	}
	let authorization: ReturnType<typeof authorizationCodec.decode>;
	try {
		authorization = authorizationCodec.decode(decodeCbor(bytes));
	} catch (err) {
		throw new SubmissionError(`authorization: ${errorText(err)}`);
	}
	let payload: AuthorizationPayload;
	try {
		payload = decodeAuthorizationPayload(authorization.payload);
	} catch (err) {
		throw new SubmissionError(`authorization payload: ${errorText(err)}`);
	}
	if (authorization.signatures.length === 0) throw new SubmissionError("the authorization has no signatures");
	return submittedOf(payload, authorization.payload, authorization.signatures);
}

function submittedOf(
	payload: AuthorizationPayload,
	payloadBytes: Uint8Array,
	signatures: Signature[],
): SubmittedAuthorization {
	return {
		payload,
		payloadBytes,
		signatures,
		id: createHash("sha256").update(payloadBytes).digest("hex"),
	};
}

/**
 * A Passkey assertion from the waiting page: the server rebuilds the `webauthn` Signature itself.
 * The payload comes from the task's stored pending payload (never from the client), and the
 * assertion must verify against one of the submitting user's own credentials.
 */
export async function parseWebauthnSubmission(
	db: Db,
	userId: string,
	payloadId: string,
	response: unknown,
): Promise<SubmittedAuthorization> {
	const value = response as AuthenticationResponseJSON;
	if (
		typeof value !== "object" ||
		value === null ||
		typeof value.id !== "string" ||
		typeof value.response !== "object" ||
		value.response === null ||
		typeof value.response.clientDataJSON !== "string" ||
		typeof value.response.authenticatorData !== "string" ||
		typeof value.response.signature !== "string"
	) {
		throw new SubmissionError("webauthn must be an AuthenticationResponseJSON");
	}
	const payloadBytes = await findPendingPayload(db, userId, payloadId);
	if (!payloadBytes) {
		throw new SubmissionError("no pending authorization with that id; reload the waiting page");
	}
	let payload: AuthorizationPayload;
	try {
		payload = decodeAuthorizationPayload(payloadBytes);
	} catch (err) {
		throw new SubmissionError(`the pending payload cannot be decoded: ${errorText(err)}`);
	}
	if (Buffer.from(createHash("sha256").update(payloadBytes).digest()).toString("hex") !== payloadId) {
		throw new SubmissionError("the pending payload does not hash to that id");
	}
	const credential = (await webauthnSigningCredentials(db, userId)).find(
		(candidate) => candidate.credentialId === value.id,
	);
	if (!credential) throw new SubmissionError("the assertion is for a credential that is not one of yours");
	try {
		await verifyAssertion({ credential, payload: payloadBytes, response: value });
	} catch (err) {
		throw new SubmissionError(`the Passkey assertion does not verify: ${errorText(err)}`);
	}
	return submittedOf(payload, payloadBytes, [signatureOfAssertion(value)]);
}

/** The stored pending payload of one of the user's waiting tasks. */
async function findPendingPayload(db: Db, userId: string, payloadId: string): Promise<Uint8Array | null> {
	const rows = await db
		.selectFrom("tasks")
		.select(["authorization"])
		.where("state", "=", "awaiting_authorization")
		.where("on_behalf_of_user_id", "=", userId)
		.execute();
	for (const row of rows) {
		const pending = parseTaskAuthorization(row.authorization)?.pending;
		if (pending?.id === payloadId) return Uint8Array.from(Buffer.from(pending.payload, "base64"));
	}
	return null;
}

/** base64url text to bytes, rejecting padding and non-base64url characters. */
export function fromBase64url(value: string, what: string): Uint8Array {
	if (!BASE64URL_RE.test(value)) throw new SubmissionError(`${what} is not base64url`);
	return Uint8Array.from(Buffer.from(value, "base64url"));
}

/** The protocol `Signature` of a browser's AuthenticationResponseJSON, ready to be signed into a payload. */
export function signatureOfAssertion(response: AuthenticationResponseJSON): Signature {
	return {
		kind: "webauthn",
		credentialId: fromBase64url(response.id, "the credential id"),
		authenticatorData: fromBase64url(response.response.authenticatorData, "authenticatorData"),
		clientDataJson: fromBase64url(response.response.clientDataJSON, "clientDataJSON"),
		signature: fromBase64url(response.response.signature, "the signature"),
	};
}

/** The browser's JSON form of a stored `webauthn` signature, for the assertion verifier. */
export function assertionOfSignature(signature: Extract<Signature, { kind: "webauthn" }>): AuthenticationResponseJSON {
	const id = Buffer.from(signature.credentialId).toString("base64url");
	return {
		id,
		rawId: id,
		type: "public-key",
		clientExtensionResults: {},
		response: {
			clientDataJSON: Buffer.from(signature.clientDataJson).toString("base64url"),
			authenticatorData: Buffer.from(signature.authenticatorData).toString("base64url"),
			signature: Buffer.from(signature.signature).toString("base64url"),
		},
	};
}

interface SshSigningKey {
	publicKey: string;
	fingerprint: string;
}

/** The user's own credentials, as submission checks need them. */
export interface UserSigningMaterial {
	ssh: SshSigningKey[];
	webauthn: Awaited<ReturnType<typeof webauthnSigningCredentials>>;
}

export async function loadUserSigningMaterial(db: Db, userId: string): Promise<UserSigningMaterial> {
	const rows = await db
		.selectFrom("signing_credentials")
		.select(["kind", "public_key", "fingerprint"])
		.where("user_id", "=", userId)
		.execute();
	return {
		ssh: rows.flatMap((row) =>
			row.kind === "ssh" && row.fingerprint ? [{ publicKey: row.public_key, fingerprint: row.fingerprint }] : [],
		),
		webauthn: await webauthnSigningCredentials(db, userId),
	};
}

export interface UserSignatureCheck {
	/** Indices of the signatures that verify against one of the user's credentials. */
	verified: number[];
	/** Why a signature that names one of the user's credentials did not verify. */
	failures: string[];
}

/**
 * Checks every signature against the submitting user's own credentials. A signature of a credential
 * that is not registered to the user is simply not theirs; a signature that *is* theirs but does not
 * verify is reported so the user sees why the submission was refused.
 */
export async function checkUserSignatures(
	material: UserSigningMaterial,
	payload: Uint8Array,
	signatures: readonly Signature[],
): Promise<UserSignatureCheck> {
	const verified: number[] = [];
	const failures: string[] = [];
	for (const [index, signature] of signatures.entries()) {
		if (signature.kind === "sshsig") {
			const blob = sshsigKeyBlob(signature.blob);
			const owner = blob ? material.ssh.find((key) => sameKeyBlob(key.publicKey, blob)) : undefined;
			if (!owner) continue;
			const result = verifySshsig(owner.publicKey, payload, signature.blob);
			if (result.valid) verified.push(index);
			else failures.push(`${owner.fingerprint}: ${result.reason}`);
			continue;
		}
		const credentialId = Buffer.from(signature.credentialId).toString("base64url");
		const credential = material.webauthn.find((candidate) => candidate.credentialId === credentialId);
		if (!credential) continue;
		try {
			await verifyAssertion({ credential, payload, response: assertionOfSignature(signature) });
			verified.push(index);
		} catch (err) {
			failures.push(`${credential.name}: ${errorText(err)}`);
		}
	}
	return { verified, failures };
}

function sameKeyBlob(publicKeyLine: string, blob: Uint8Array): boolean {
	try {
		return Buffer.from(parseAuthorizedKey(publicKeyLine).blob).equals(Buffer.from(blob));
	} catch {
		return false;
	}
}

/** Throws unless at least one signature belongs to the submitting user. */
export async function assertSubmittingUser(
	material: UserSigningMaterial,
	payload: Uint8Array,
	signatures: readonly Signature[],
): Promise<void> {
	if (material.ssh.length === 0 && material.webauthn.length === 0) {
		throw new SubmissionError("you have no signing credentials; add one in the WebUI first");
	}
	const check = await checkUserSignatures(material, payload, signatures);
	if (check.verified.length > 0) return;
	if (check.failures.length > 0) {
		throw new SubmissionError(`no signature verifies: ${check.failures.join("; ")}`);
	}
	throw new SubmissionError("none of the signatures is one of your signing credentials");
}

/**
 * Maps every signature to the trust entry that owns its key, so the decision port can judge it.
 * Signatures no entry knows are ignored (another node may trust them); a signature that names a
 * trusted key but does not verify is marked invalid, which invalidates the whole authorization in
 * `decide`, as crha's step 3 does.
 */
export async function verifyAgainstTrust(
	signatures: readonly Signature[],
	payload: Uint8Array,
	trust: readonly TrustEntry[],
): Promise<AuthzSignature[]> {
	const result: AuthzSignature[] = [];
	for (const signature of signatures) {
		const authz = await signatureEntry(signature, payload, trust);
		if (authz) result.push(authz);
	}
	return result;
}

async function signatureEntry(
	signature: Signature,
	payload: Uint8Array,
	trust: readonly TrustEntry[],
): Promise<AuthzSignature | null> {
	if (signature.kind === "sshsig") {
		const blob = sshsigKeyBlob(signature.blob);
		if (!blob) return null;
		for (const entry of trust) {
			if (entry.role === "local" || entry.key.kind !== "sshsig") continue;
			let expected: Uint8Array;
			try {
				expected = parseAuthorizedKey(entry.key.publicKey).blob;
			} catch {
				continue;
			}
			if (!Buffer.from(expected).equals(Buffer.from(blob))) continue;
			const verified = verifySshsig(entry.key.publicKey, payload, signature.blob);
			return {
				entry: authzEntryFromTrust(entry),
				valid: verified.valid,
				userVerified: verified.valid ? verified.userVerified : false,
			};
		}
		return null;
	}
	const credentialId = Buffer.from(signature.credentialId).toString("base64url");
	for (const entry of trust) {
		if (entry.role === "local" || entry.key.kind !== "webauthn") continue;
		if (Buffer.from(entry.key.credentialId).toString("base64url") !== credentialId) continue;
		try {
			const verified = await verifyAssertion({
				credential: {
					credentialId,
					coseKey: entry.key.coseKey,
					rpId: entry.key.rpId,
					origins: entry.key.origins,
				},
				payload,
				response: assertionOfSignature(signature),
			});
			return { entry: authzEntryFromTrust(entry), valid: true, userVerified: verified.userVerified };
		} catch {
			return { entry: authzEntryFromTrust(entry), valid: false, userVerified: false };
		}
	}
	return null;
}

/** Encodes the wire Authorization object of a payload and its signatures, for task.start. */
export function encodeAuthorization(payload: Uint8Array, signatures: readonly Signature[]): Uint8Array {
	return encodeCbor(authorizationCodec.encode({ payload, signatures: [...signatures] }));
}

/** The JSON form of `authorizations.signatures` (bytes as base64). */
export function signaturesToJson(signatures: readonly Signature[]): string {
	return JSON.stringify(
		signatures.map((signature) =>
			signature.kind === "sshsig"
				? { kind: "sshsig", blob: Buffer.from(signature.blob).toString("base64") }
				: {
						kind: "webauthn",
						credentialId: Buffer.from(signature.credentialId).toString("base64"),
						authenticatorData: Buffer.from(signature.authenticatorData).toString("base64"),
						clientDataJson: Buffer.from(signature.clientDataJson).toString("base64"),
						signature: Buffer.from(signature.signature).toString("base64"),
					},
		),
	);
}

/** Reads `authorizations.signatures`; malformed rows are treated as carrying no signature. */
export function signaturesFromJson(json: string): Signature[] {
	let value: unknown;
	try {
		value = JSON.parse(json);
	} catch {
		return [];
	}
	if (!Array.isArray(value)) return [];
	const out: Signature[] = [];
	for (const item of value) {
		if (typeof item !== "object" || item === null) continue;
		const record = item as Record<string, unknown>;
		if (record.kind === "sshsig" && typeof record.blob === "string") {
			out.push({ kind: "sshsig", blob: Uint8Array.from(Buffer.from(record.blob, "base64")) });
		} else if (
			record.kind === "webauthn" &&
			typeof record.credentialId === "string" &&
			typeof record.authenticatorData === "string" &&
			typeof record.clientDataJson === "string" &&
			typeof record.signature === "string"
		) {
			out.push({
				kind: "webauthn",
				credentialId: Uint8Array.from(Buffer.from(record.credentialId, "base64")),
				authenticatorData: Uint8Array.from(Buffer.from(record.authenticatorData, "base64")),
				clientDataJson: Uint8Array.from(Buffer.from(record.clientDataJson, "base64")),
				signature: Uint8Array.from(Buffer.from(record.signature, "base64")),
			});
		}
	}
	return out;
}

/** The trust entry a decision accepted, if its key belongs to the user's own credentials. */
export function entryBelongsToUser(
	entryName: string | null,
	trust: readonly TrustEntry[],
	material: UserSigningMaterial,
): boolean {
	const entry = trust.find((candidate) => candidate.name === entryName);
	if (entry?.role !== "user") return false;
	if (entry.key.kind === "sshsig") {
		let blob: Uint8Array;
		try {
			blob = parseAuthorizedKey(entry.key.publicKey).blob;
		} catch {
			return false;
		}
		return material.ssh.some((key) => sameKeyBlob(key.publicKey, blob));
	}
	if (entry.key.kind === "webauthn") {
		const credentialId = Buffer.from(entry.key.credentialId).toString("base64url");
		return material.webauthn.some((credential) => credential.credentialId === credentialId);
	}
	return false;
}

/** The AuthzEntry of a named trust entry, for cosignature candidates. */
export function authzEntryNamed(trust: readonly TrustEntry[], name: string | null): AuthzEntry | null {
	const entry = trust.find((candidate) => candidate.name === name);
	return entry ? authzEntryFromTrust(entry) : null;
}
