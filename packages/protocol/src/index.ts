import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { type Envelope, EnvelopeSchema } from "./gen/crh/v1/envelope_pb.ts";

export * from "./gen/crh/v1/envelope_pb.ts";
export * from "./gen/crh/v1/facts_pb.ts";
export * from "./gen/crh/v1/handshake_pb.ts";
export * from "./gen/crh/v1/task_pb.ts";

/** Upper bound for one encoded envelope: a Noise transport message carries at most 65535 bytes. */
export const MAX_ENVELOPE_BYTES = 60 * 1024;

export function encodeEnvelope(body: Envelope["body"]): Uint8Array {
	const bytes = toBinary(EnvelopeSchema, create(EnvelopeSchema, { body }));
	if (bytes.length > MAX_ENVELOPE_BYTES) {
		throw new RangeError(`envelope too large: ${bytes.length} bytes`);
	}
	return bytes;
}

export function decodeEnvelope(bytes: Uint8Array): Envelope {
	if (bytes.length > MAX_ENVELOPE_BYTES) {
		throw new RangeError(`envelope too large: ${bytes.length} bytes`);
	}
	return fromBinary(EnvelopeSchema, bytes);
}
