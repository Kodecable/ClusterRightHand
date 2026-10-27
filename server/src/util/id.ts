import { createHash } from "node:crypto";

const MAX_COUNTER = 0xfff;

let lastMs = 0;
let counter = 0;

/** Generate a UUIDv7 (RFC 9562, monotonic random counter method). */
export function newId(): string {
	const rand = crypto.getRandomValues(new Uint8Array(10));
	const now = Date.now();
	if (now > lastMs) {
		lastMs = now;
		// Seed below the top of the range so a few increments fit within the same ms.
		counter = (((rand[0] ?? 0) << 8) | (rand[1] ?? 0)) & 0x7ff;
	} else {
		counter++;
		if (counter > MAX_COUNTER) {
			lastMs++;
			counter = (((rand[0] ?? 0) << 8) | (rand[1] ?? 0)) & 0x7ff;
		}
	}

	const bytes = new Uint8Array(16);
	const view = new DataView(bytes.buffer);
	view.setUint16(0, Math.floor(lastMs / 2 ** 32));
	view.setUint32(2, lastMs % 2 ** 32);
	bytes[6] = 0x70 | (counter >> 8);
	bytes[7] = counter & 0xff;
	bytes[8] = 0x80 | ((rand[2] ?? 0) & 0x3f);
	bytes.set(rand.subarray(3), 9);

	const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Extract the Unix millisecond timestamp from a UUIDv7. */
export function idTimestamp(id: string): number {
	return Number.parseInt(id.replaceAll("-", "").slice(0, 12), 16);
}

/**
 * A stable UUIDv8 (RFC 9562 custom layout) derived from a key: the same key always gives the same id. Used where a
 * retried operation must find what its first attempt created, e.g. a Cluster task for a durable tool call.
 */
export function derivedId(key: string): string {
	const bytes = createHash("sha256").update(`crh-derived-id\0${key}`).digest().subarray(0, 16);
	bytes[6] = 0x80 | ((bytes[6] ?? 0) & 0x0f);
	bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f);
	const hex = bytes.toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
