/**
 * Frame layer: [0, id, cmd, body] requests, [1, id, cmd, ok, body] responses
 * and [2, name, body] events. See doc/protocol.md.
 */
import { CborError, decode as decodeCbor, encode as encodeCbor } from "./cbor.ts";
import { COMMANDS, type CommandName, EVENTS, type EventName, errorCodec, type WireError } from "./messages.ts";
import { type Codec, SchemaError, text, uint } from "./schema.ts";

/** Maximum encoded size of one frame (one Noise transport message). */
export const MAX_FRAME_BYTES = 61440;

export class ProtocolError extends Error {
	override name = "ProtocolError";
}

export type Frame =
	| { kind: "request"; id: number; cmd: string; body: unknown }
	| { kind: "request.unsupported"; id: number; cmd: string }
	| { kind: "response"; id: number; cmd: string; ok: true; body: unknown }
	| { kind: "response"; id: number; cmd: string; ok: false; error: WireError }
	| { kind: "event"; name: string; body: unknown };

function message(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function decodeField<T>(codec: Codec<T>, value: unknown, what: string): T {
	try {
		return codec.decode(value);
	} catch (err) {
		throw new ProtocolError(`invalid ${what}: ${message(err)}`);
	}
}

function command(cmd: string): (typeof COMMANDS)[CommandName] | undefined {
	return Object.hasOwn(COMMANDS, cmd) ? COMMANDS[cmd as CommandName] : undefined;
}

function event(name: string): (typeof EVENTS)[EventName] | undefined {
	return Object.hasOwn(EVENTS, name) ? EVENTS[name as EventName] : undefined;
}

function decodeRequest(value: unknown[]): Frame {
	if (value.length !== 4) throw new ProtocolError(`request: expected 4 elements, got ${value.length}`);
	const id = decodeField(uint, value[1], "request id");
	const cmd = decodeField(text, value[2], "request cmd");
	const definition = command(cmd);
	if (definition === undefined) return { kind: "request.unsupported", id, cmd };
	try {
		return { kind: "request", id, cmd, body: definition.request.decode(value[3]) };
	} catch (err) {
		throw new ProtocolError(`invalid ${cmd} request body: ${message(err)}`);
	}
}

function decodeResponse(value: unknown[]): Frame {
	if (value.length !== 5) throw new ProtocolError(`response: expected 5 elements, got ${value.length}`);
	const id = decodeField(uint, value[1], "response id");
	const cmd = decodeField(text, value[2], "response cmd");
	const ok = value[3];
	if (ok !== true && ok !== false) throw new ProtocolError("response: ok is not a boolean");
	if (!ok) {
		// Error responses are legal for commands this side does not know
		// (e.g. the unsupported_command reply).
		return { kind: "response", id, cmd, ok: false, error: decodeField(errorCodec, value[4], "error") };
	}
	const definition = command(cmd);
	if (definition === undefined) throw new ProtocolError(`response for unknown command: ${cmd}`);
	try {
		return { kind: "response", id, cmd, ok: true, body: definition.response.decode(value[4]) };
	} catch (err) {
		throw new ProtocolError(`invalid ${cmd} response body: ${message(err)}`);
	}
}

function decodeEvent(value: unknown[]): Frame {
	if (value.length !== 3) throw new ProtocolError(`event: expected 3 elements, got ${value.length}`);
	const name = decodeField(text, value[1], "event name");
	const definition = event(name);
	if (definition === undefined) throw new ProtocolError(`unknown event: ${name}`);
	try {
		return { kind: "event", name, body: definition.decode(value[2]) };
	} catch (err) {
		throw new ProtocolError(`invalid ${name} event body: ${message(err)}`);
	}
}

/** Decode one frame. Unknown commands become `request.unsupported`; anything
 * else (unknown events, bad bodies, non-canonical CBOR) is a ProtocolError. */
export function decodeFrame(bytes: Uint8Array): Frame {
	if (!(bytes instanceof Uint8Array)) throw new ProtocolError("frame must be a Uint8Array");
	if (bytes.length > MAX_FRAME_BYTES) {
		throw new ProtocolError(`frame too large: ${bytes.length} bytes (max ${MAX_FRAME_BYTES})`);
	}
	let value: unknown;
	try {
		value = decodeCbor(bytes);
	} catch (err) {
		if (err instanceof CborError || err instanceof SchemaError) {
			throw new ProtocolError(`CBOR decode failed: ${message(err)}`);
		}
		throw err;
	}
	if (!Array.isArray(value)) throw new ProtocolError("frame is not an array");
	const type = value[0];
	if (type === 0) return decodeRequest(value);
	if (type === 1) return decodeResponse(value);
	if (type === 2) return decodeEvent(value);
	throw new ProtocolError(`unknown frame type: ${String(type)}`);
}

function encode<T>(codec: Codec<T>, value: T, what: string): unknown {
	try {
		return codec.encode(value);
	} catch (err) {
		throw new ProtocolError(`invalid ${what}: ${message(err)}`);
	}
}

/** Encode one frame, rejecting anything larger than MAX_FRAME_BYTES. */
export function encodeFrame(frame: Frame): Uint8Array {
	let value: unknown;
	if (frame.kind === "request.unsupported") {
		throw new ProtocolError("cannot encode an unsupported request");
	}
	if (frame.kind === "request") {
		const definition = command(frame.cmd);
		if (definition === undefined) throw new ProtocolError(`unknown command: ${frame.cmd}`);
		value = [
			0,
			encode(uint, frame.id, "request id"),
			frame.cmd,
			encode(definition.request, frame.body, `${frame.cmd} request`),
		];
	} else if (frame.kind === "response") {
		const id = encode(uint, frame.id, "response id");
		if (!frame.ok) {
			value = [1, id, frame.cmd, false, encode(errorCodec, frame.error, "error")];
		} else {
			const definition = command(frame.cmd);
			if (definition === undefined) throw new ProtocolError(`unknown command: ${frame.cmd}`);
			value = [1, id, frame.cmd, true, encode(definition.response, frame.body, `${frame.cmd} response`)];
		}
	} else {
		const definition = event(frame.name);
		if (definition === undefined) throw new ProtocolError(`unknown event: ${frame.name}`);
		value = [2, frame.name, encode(definition, frame.body, `${frame.name} event`)];
	}
	const bytes = encodeCbor(value);
	if (bytes.length > MAX_FRAME_BYTES) {
		throw new ProtocolError(`frame too large: ${bytes.length} bytes (max ${MAX_FRAME_BYTES})`);
	}
	return bytes;
}

// ---------------------------------------------------------------------------
// Handshake payloads (Noise IK messages, not frames)
// ---------------------------------------------------------------------------

const MINIMUM_LENGTH = [24n, 256n, 65536n, 4294967296n] as const;

function payloadByte(bytes: Uint8Array, offset: number, what: string): number {
	const value = bytes[offset];
	if (value === undefined) throw new ProtocolError(`truncated ${what}`);
	return value;
}

function readUnsigned(
	bytes: Uint8Array,
	offset: number,
	additionalInfo: number,
	what: string,
): { value: bigint; next: number } {
	if (additionalInfo < 24) return { value: BigInt(additionalInfo), next: offset + 1 };
	if (additionalInfo > 27) throw new ProtocolError(`${what}: indefinite or reserved length`);
	const width = 1 << (additionalInfo - 24);
	const next = offset + 1 + width;
	if (next > bytes.length) throw new ProtocolError(`truncated ${what}`);
	let value = 0n;
	for (let i = offset + 1; i < next; i++) value = (value << 8n) | BigInt(payloadByte(bytes, i, what));
	const minimum = MINIMUM_LENGTH[additionalInfo - 24];
	if (minimum === undefined) throw new ProtocolError(`${what}: invalid length`);
	if (value < minimum) throw new ProtocolError(`non-shortest ${what}`);
	return { value, next };
}

/**
 * Read only `protocol_major` from a handshake payload. The payload is a
 * definite-length array whose first element is a uint; the rest may belong to
 * an unknown future layout and is deliberately not decoded.
 */
export function peekProtocolMajor(bytes: Uint8Array): number {
	if (!(bytes instanceof Uint8Array)) throw new ProtocolError("handshake payload must be a Uint8Array");
	const first = payloadByte(bytes, 0, "handshake payload");
	if (first >> 5 !== 4) throw new ProtocolError("handshake payload is not an array");
	const array = readUnsigned(bytes, 0, first & 0x1f, "handshake array");
	if (array.value === 0n) throw new ProtocolError("handshake payload array is empty");
	const element = payloadByte(bytes, array.next, "handshake protocol_major");
	if (element >> 5 !== 0) throw new ProtocolError("handshake protocol_major is not a uint");
	const value = readUnsigned(bytes, array.next, element & 0x1f, "handshake protocol_major");
	if (value.value > BigInt(Number.MAX_SAFE_INTEGER)) {
		throw new ProtocolError("handshake protocol_major exceeds 2^53−1");
	}
	return Number(value.value);
}
