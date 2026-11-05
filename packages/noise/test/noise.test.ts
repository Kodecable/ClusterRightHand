import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	generateKeyPair,
	HandshakeState,
	keyPairFromPrivate,
	MAX_MESSAGE_LEN,
	NoiseError,
	type TransportCiphers,
} from "../src/index.ts";

interface Vector {
	fields: Map<string, string>;
	messages: { payload: string; ciphertext: string }[];
}

function loadVectors(): Vector[] {
	const text = readFileSync(new URL("./vectors/ik_25519_chachapoly_blake2s.txt", import.meta.url), "utf8");
	const vectors: Vector[] = [];
	for (const block of text.split(/\n\s*\n/)) {
		const fields = new Map<string, string>();
		for (const line of block.split("\n")) {
			const m = /^([a-z0-9_]+)=(.*)$/.exec(line.trim());
			if (m?.[1] !== undefined && m[2] !== undefined) fields.set(m[1], m[2]);
		}
		if (!fields.has("handshake")) continue;
		const messages = [];
		for (let i = 0; fields.has(`msg_${i}_ciphertext`); i++) {
			messages.push({
				payload: fields.get(`msg_${i}_payload`) ?? "",
				ciphertext: fields.get(`msg_${i}_ciphertext`) ?? "",
			});
		}
		vectors.push({ fields, messages });
	}
	return vectors;
}

const hex = (s: string) => Buffer.from(s, "hex");

describe("Noise_IK_25519_ChaChaPoly_BLAKE2s", () => {
	const vectors = loadVectors();

	it("has the vectors", () => {
		expect(vectors).toHaveLength(4);
	});

	it.each(vectors.map((v, i) => [i, v] as const))("matches test vector %i", (_i, v) => {
		const f = (k: string) => hex(v.fields.get(k) ?? "");
		const prologue = f("prologue");
		const initStatic = keyPairFromPrivate(f("init_static"));
		const respStatic = keyPairFromPrivate(f("resp_static"));
		const initiator = HandshakeState.initiator({
			prologue,
			staticKey: initStatic,
			remoteStaticKey: respStatic.publicKey,
			ephemeralKey: keyPairFromPrivate(f("gen_init_ephemeral")),
		});
		const responder = HandshakeState.responder({
			prologue,
			staticKey: respStatic,
			ephemeralKey: keyPairFromPrivate(f("gen_resp_ephemeral")),
		});

		const [m0, m1, ...transport] = v.messages;
		if (!m0 || !m1) throw new Error("vector without handshake messages");
		const c0 = initiator.writeMessage(hex(m0.payload));
		expect(c0.toString("hex")).toBe(m0.ciphertext);
		expect(responder.readMessage(c0).toString("hex")).toBe(m0.payload);
		expect(Buffer.from(responder.remoteStaticKey ?? []).equals(initStatic.publicKey)).toBe(true);

		const c1 = responder.writeMessage(hex(m1.payload));
		expect(c1.toString("hex")).toBe(m1.ciphertext);
		expect(initiator.readMessage(c1).toString("hex")).toBe(m1.payload);

		const i = initiator.split();
		const r = responder.split();
		expect(Buffer.from(i.handshakeHash).equals(r.handshakeHash)).toBe(true);
		transport.forEach((m, n) => {
			// Messages alternate, starting with the initiator.
			const [sender, receiver] = n % 2 === 0 ? [i, r] : [r, i];
			const ct = sender.send.encrypt(new Uint8Array(0), hex(m.payload));
			expect(ct.toString("hex")).toBe(m.ciphertext);
			expect(receiver.receive.decrypt(new Uint8Array(0), ct).toString("hex")).toBe(m.payload);
		});
	});
});

function handshake(prologue = Buffer.from("crh/3")): { i: TransportCiphers; r: TransportCiphers } {
	const server = generateKeyPair();
	const client = generateKeyPair();
	const initiator = HandshakeState.initiator({ prologue, staticKey: client, remoteStaticKey: server.publicKey });
	const responder = HandshakeState.responder({ prologue, staticKey: server });
	responder.readMessage(initiator.writeMessage(Buffer.from("hello")));
	initiator.readMessage(responder.writeMessage(Buffer.from("welcome")));
	return { i: initiator.split(), r: responder.split() };
}

describe("handshake failures", () => {
	it("rejects a tampered message 1", () => {
		const server = generateKeyPair();
		const initiator = HandshakeState.initiator({
			prologue: Buffer.from("p"),
			staticKey: generateKeyPair(),
			remoteStaticKey: server.publicKey,
		});
		const msg = initiator.writeMessage(Buffer.from("payload"));
		msg[40] = (msg[40] ?? 0) ^ 1;
		const responder = HandshakeState.responder({ prologue: Buffer.from("p"), staticKey: server });
		expect(() => responder.readMessage(msg)).toThrow(NoiseError);
	});

	it("fails when the initiator has the wrong server key", () => {
		const initiator = HandshakeState.initiator({
			prologue: Buffer.from("p"),
			staticKey: generateKeyPair(),
			remoteStaticKey: generateKeyPair().publicKey,
		});
		const responder = HandshakeState.responder({ prologue: Buffer.from("p"), staticKey: generateKeyPair() });
		expect(() => responder.readMessage(initiator.writeMessage(new Uint8Array(0)))).toThrow(NoiseError);
	});

	it("fails when the prologues differ (replay onto another connection's challenge)", () => {
		const server = generateKeyPair();
		const initiator = HandshakeState.initiator({
			prologue: Buffer.from("crh/3 challenge-A"),
			staticKey: generateKeyPair(),
			remoteStaticKey: server.publicKey,
		});
		const responder = HandshakeState.responder({ prologue: Buffer.from("crh/3 challenge-B"), staticKey: server });
		expect(() => responder.readMessage(initiator.writeMessage(new Uint8Array(0)))).toThrow(NoiseError);
	});

	it("rejects a low-order ephemeral key", () => {
		const responder = HandshakeState.responder({ prologue: Buffer.from("p"), staticKey: generateKeyPair() });
		const msg = Buffer.alloc(32 + 48 + 16); // all-zero ephemeral public key is a low-order point
		expect(() => responder.readMessage(msg)).toThrow(/low order/);
	});

	it("enforces message order and size", () => {
		const server = generateKeyPair();
		const initiator = HandshakeState.initiator({
			prologue: Buffer.from("p"),
			staticKey: generateKeyPair(),
			remoteStaticKey: server.publicKey,
		});
		expect(() => initiator.readMessage(Buffer.alloc(48))).toThrow(/out of turn/);
		expect(() => initiator.split()).toThrow(/not complete/);
		expect(() => initiator.writeMessage(Buffer.alloc(MAX_MESSAGE_LEN))).toThrow(/too large/);
	});
});

describe("transport", () => {
	it("round-trips in both directions and rejects reordering and tampering", () => {
		const { i, r } = handshake();
		const ad = new Uint8Array(0);
		const a = i.send.encrypt(ad, Buffer.from("one"));
		const b = i.send.encrypt(ad, Buffer.from("two"));
		expect(() => r.receive.decrypt(ad, b)).toThrow(NoiseError); // out of order: wrong nonce
		expect(r.receive.decrypt(ad, a).toString()).toBe("one"); // a failed decrypt does not advance the nonce
		const tampered = Buffer.from(b);
		tampered[0] = (tampered[0] ?? 0) ^ 1;
		expect(() => r.receive.decrypt(ad, tampered)).toThrow(NoiseError);
		expect(r.receive.decrypt(ad, b).toString()).toBe("two");
		expect(i.receive.decrypt(ad, r.send.encrypt(ad, Buffer.from("back"))).toString()).toBe("back");
	});
});

describe("interop fixture", () => {
	// Also verified by client/internal/noise/interop_test.go against flynn/noise.
	it("reproduces test/interop/noise-crh.json", () => {
		const f = JSON.parse(
			readFileSync(new URL("../../../test/interop/noise-crh.json", import.meta.url), "utf8"),
		) as Record<string, string>;
		const b = (k: string) => hex(f[k] ?? "");
		const prologue = Buffer.concat([Buffer.from("crh/3"), b("challenge")]);
		const server = keyPairFromPrivate(b("server_static"));
		const i = HandshakeState.initiator({
			prologue,
			staticKey: keyPairFromPrivate(b("client_static")),
			remoteStaticKey: server.publicKey,
			ephemeralKey: keyPairFromPrivate(b("client_ephemeral")),
		});
		const r = HandshakeState.responder({
			prologue,
			staticKey: server,
			ephemeralKey: keyPairFromPrivate(b("server_ephemeral")),
		});
		const m1 = i.writeMessage(b("init_payload"));
		expect(m1.toString("hex")).toBe(f.message1);
		r.readMessage(m1);
		const m2 = r.writeMessage(b("response_payload"));
		expect(m2.toString("hex")).toBe(f.message2);
		i.readMessage(m2);
		expect(i.split().send.encrypt(new Uint8Array(0), b("client_to_server")).toString("hex")).toBe(f.transport_c2s);
	});
});
