import { describe, expect, it } from "vitest";
import { encode as encodeCbor } from "../src/cbor.ts";
import { decodeFrame, encodeFrame, type Frame, MAX_ERROR_MESSAGE_BYTES, ProtocolError } from "../src/frame.ts";
import type { Facts, TaskStart, TaskStatus } from "../src/messages.ts";
import { afterResponse, ConnectionError, Peer, RemoteError } from "../src/peer.ts";
import { type CommandResponse, SUPPORTED_NAMES } from "../src/registry.ts";

const FACTS: Facts = {
	hostname: "node-1",
	osId: "ubuntu",
	osVersionId: "24.04",
	osPrettyName: "Ubuntu 24.04 LTS",
	kernel: "6.8.0",
	arch: "x86_64",
	initSystem: "systemd",
	packageManagers: ["apt"],
	privilegeTools: ["sudo"],
	notesPath: "/etc/notes",
	groups: ["sudo"],
	clockOffsetMs: 0,
	shells: { sh: "/bin/sh", bash: null },
};

const TASK_START: TaskStart = {
	taskId: "t-1",
	attempt: 1,
	spec: { kind: "exec", command: { argv: ["echo", "hi"] }, env: {}, cwd: "/tmp", stdin: null },
	privileged: false,
	authorizations: [],
	timeoutMs: 0,
	killGraceMs: 0,
	output: { kind: "text" },
};

const TASK_STATUS: TaskStatus = { taskId: "t-1", state: "unknown", stdoutEnd: 0, stderrEnd: 0 };

interface Pair {
	a: Peer;
	b: Peer;
	fromA: Frame[];
	fromB: Frame[];
}

function makePair(
	negotiatedA: readonly string[] = SUPPORTED_NAMES,
	negotiatedB?: readonly string[],
	onErrorA?: (error: Error) => void,
	onErrorB?: (error: Error) => void,
): Pair {
	const fromA: Frame[] = [];
	const fromB: Frame[] = [];
	let a!: Peer;
	let b!: Peer;
	a = new Peer({
		negotiated: negotiatedA,
		onError: onErrorA,
		send: (bytes) => {
			fromA.push(decodeFrame(bytes));
			b.receive(bytes);
		},
	});
	b = new Peer({
		negotiated: negotiatedB ?? negotiatedA,
		onError: onErrorB,
		send: (bytes) => {
			fromB.push(decodeFrame(bytes));
			a.receive(bytes);
		},
	});
	return { a, b, fromA, fromB };
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("Peer", () => {
	it("allocates request ids from 1 per direction", async () => {
		const { a, b, fromA, fromB } = makePair();
		b.onRequest("ping", (body) => body);
		a.onRequest("ping", (body) => body);
		expect(await a.request("ping", { seq: 1 })).toEqual({ seq: 1 });
		expect(await a.request("ping", { seq: 2 })).toEqual({ seq: 2 });
		expect(await b.request("ping", { seq: 3 })).toEqual({ seq: 3 });
		expect(fromA.filter((frame) => frame.kind === "request").map((frame) => frame.id)).toEqual([1, 2]);
		expect(fromB.filter((frame) => frame.kind === "request").map((frame) => frame.id)).toEqual([1]);
	});

	it("matches responses by id and completes them out of order", async () => {
		const { a, b, fromB } = makePair();
		const order: string[] = [];
		b.onRequest("ping", async (body) => {
			await delay(30);
			order.push("ping");
			return body;
		});
		b.onRequest("task.query", (body) => {
			order.push("query");
			return { ...TASK_STATUS, taskId: body.taskId };
		});
		const ping = a.request("ping", { seq: 1 });
		const query = a.request("task.query", { taskId: "t-1" });
		expect(await query).toEqual(TASK_STATUS);
		expect(await ping).toEqual({ seq: 1 });
		expect(order).toEqual(["query", "ping"]);
		const responses = fromB.filter((frame) => frame.kind === "response");
		expect(responses.map((frame) => frame.id)).toEqual([2, 1]);
	});

	it("rejects error responses with RemoteError", async () => {
		const { a, b } = makePair();
		b.onRequest("task.start", () => {
			throw new RemoteError("invalid_spec", "empty task id");
		});
		b.onRequest("task.cancel", () => {
			throw new Error("boom");
		});
		await expect(a.request("task.start", TASK_START)).rejects.toMatchObject({
			name: "RemoteError",
			code: "invalid_spec",
			message: "empty task id",
		});
		await expect(a.request("task.cancel", { taskId: "t-1" })).rejects.toMatchObject({
			name: "RemoteError",
			code: "internal_error",
			message: "boom",
		});
	});

	it("sends exactly one error response with a bounded message", async () => {
		const { a, b, fromB } = makePair();
		b.onRequest("task.cancel", () => {
			throw new RemoteError("internal_error", "x".repeat(100_000));
		});
		await expect(a.request("task.cancel", { taskId: "t-1" })).rejects.toMatchObject({
			name: "RemoteError",
			code: "internal_error",
		});
		const errors = fromB.flatMap((frame) => (frame.kind === "response" && !frame.ok ? [frame.error] : []));
		expect(errors).toHaveLength(1);
		expect(Buffer.byteLength(errors[0]?.message ?? "", "utf8")).toBeLessThanOrEqual(MAX_ERROR_MESSAGE_BYTES);
		expect(errors[0]?.message.length).toBe(MAX_ERROR_MESSAGE_BYTES);
	});

	it("makes a lone surrogate in a handler error message well-formed", async () => {
		const { a, b, fromB } = makePair();
		b.onRequest("task.cancel", () => {
			throw new Error("bad \ud800 name");
		});
		await expect(a.request("task.cancel", { taskId: "t-1" })).rejects.toMatchObject({
			name: "RemoteError",
			code: "internal_error",
			message: "bad \uFFFD name",
		});
		const errors = fromB.flatMap((frame) => (frame.kind === "response" && !frame.ok ? [frame.error] : []));
		expect(errors).toHaveLength(1);
		expect(errors[0]?.message.isWellFormed()).toBe(true);
	});

	it("answers unregistered and non-negotiated commands with unsupported_command", async () => {
		const { a } = makePair();
		await expect(a.request("task.cancel", { taskId: "t-1" })).rejects.toMatchObject({
			name: "RemoteError",
			code: "unsupported_command",
		});

		const replies: Frame[] = [];
		const peer = new Peer({
			negotiated: SUPPORTED_NAMES,
			send: (bytes) => {
				replies.push(decodeFrame(bytes));
			},
		});
		peer.receive(encodeCbor([0, 5, "trust.query", []]));
		expect(replies[0]).toMatchObject({
			kind: "response",
			id: 5,
			cmd: "trust.query",
			ok: false,
			error: { code: "unsupported_command" },
		});

		const restricted = makePair(SUPPORTED_NAMES, ["hello"]);
		restricted.b.onRequest("ping", (body) => body);
		await expect(restricted.a.request("ping", { seq: 1 })).rejects.toMatchObject({
			name: "RemoteError",
			code: "unsupported_command",
		});
	});

	it("rejects locally when a command was not negotiated", async () => {
		const peer = new Peer({ send: () => {}, negotiated: ["hello"] });
		await expect(peer.request("ping", { seq: 1 })).rejects.toBeInstanceOf(ProtocolError);
	});

	it("decodes a known command body before rejecting it as un-negotiated", () => {
		const replies: Frame[] = [];
		const peer = new Peer({
			negotiated: ["hello"],
			send: (bytes) => {
				replies.push(decodeFrame(bytes));
			},
		});
		expect(() => peer.receive(encodeCbor([0, 1, "ping", []]))).toThrow(ProtocolError);
		expect(replies).toEqual([]);
		peer.receive(encodeCbor([0, 2, "trust.query", { unknown: true }]));
		expect(replies.at(-1)).toMatchObject({
			kind: "response",
			id: 2,
			cmd: "trust.query",
			ok: false,
			error: { code: "unsupported_command" },
		});
	});

	it("rejects pending requests when the connection closes", async () => {
		const { a, b } = makePair();
		b.onRequest("ping", () => new Promise(() => {}));
		const pending = a.request("ping", { seq: 1 });
		a.close("connection lost");
		await expect(pending).rejects.toMatchObject({ name: "ConnectionError", reason: "connection lost" });
		await expect(a.request("ping", { seq: 2 })).rejects.toBeInstanceOf(ConnectionError);
	});

	it("propagates frame decode failures as ProtocolError", () => {
		const { a } = makePair();
		expect(() => a.receive(Uint8Array.of(0xff))).toThrow(ProtocolError);
	});

	it("rejects an unknown response id", () => {
		const { a } = makePair();
		expect(() => a.receive(encodeFrame({ kind: "response", id: 99, cmd: "ping", ok: true, body: { seq: 1 } }))).toThrow(
			ProtocolError,
		);
	});

	it("rejects a response whose cmd does not match the request", async () => {
		const { a, b } = makePair();
		b.onRequest("ping", () => new Promise(() => {}));
		const pending = a.request("ping", { seq: 1 });
		expect(() =>
			a.receive(
				encodeFrame({
					kind: "response",
					id: 1,
					cmd: "task.query",
					ok: true,
					body: TASK_STATUS,
				}),
			),
		).toThrow(ProtocolError);
		a.close("protocol error");
		await expect(pending).rejects.toBeInstanceOf(ConnectionError);
	});

	it("rejects un-negotiated events", () => {
		const peer = new Peer({ negotiated: ["hello"], send: () => {} });
		expect(() => peer.receive(encodeFrame({ kind: "event", name: "facts", body: FACTS }))).toThrow(ProtocolError);
		expect(() => peer.emit("facts", FACTS)).toThrow(ProtocolError);
	});

	it("delivers events to registered handlers", () => {
		const { a, b } = makePair();
		const seen: unknown[] = [];
		a.onEvent("task.exit.ack", (body) => {
			seen.push(body);
		});
		b.emit("task.exit.ack", { taskId: "t-1" });
		expect(seen).toEqual([{ taskId: "t-1" }]);
	});

	it("rejects a negotiated event with no registered handler", () => {
		const peer = new Peer({ negotiated: SUPPORTED_NAMES, send: () => {} });
		expect(() => peer.receive(encodeFrame({ kind: "event", name: "task.exit.ack", body: { taskId: "t-1" } }))).toThrow(
			ProtocolError,
		);
	});

	it("reports a throwing event handler through onError", () => {
		const errors: Error[] = [];
		const { a, b } = makePair(SUPPORTED_NAMES, undefined, (error) => errors.push(error));
		a.onEvent("task.exit.ack", () => {
			throw new Error("handler bug");
		});
		expect(() => b.emit("task.exit.ack", { taskId: "t-1" })).not.toThrow();
		expect(errors.map((error) => error.message)).toEqual(["handler bug"]);
	});

	it("reports a rejected event handler promise through onError", async () => {
		const errors: Error[] = [];
		const { a, b } = makePair(SUPPORTED_NAMES, undefined, (error) => errors.push(error));
		a.onEvent("task.exit.ack", async () => {
			throw new Error("async handler bug");
		});
		b.emit("task.exit.ack", { taskId: "t-1" });
		await delay(0);
		expect(errors.map((error) => error.message)).toEqual(["async handler bug"]);
	});

	it("does not report request handler failures through onError", async () => {
		const errors: Error[] = [];
		const { a, b } = makePair(SUPPORTED_NAMES, undefined, undefined, (error) => errors.push(error));
		b.onRequest("task.cancel", async () => {
			throw new Error("boom");
		});
		await expect(a.request("task.cancel", { taskId: "t-1" })).rejects.toMatchObject({
			name: "RemoteError",
			code: "internal_error",
			message: "boom",
		});
		expect(errors).toEqual([]);
	});

	it("sends the success response before running an afterResponse hook", () => {
		const order: string[] = [];
		const peer = new Peer({
			negotiated: SUPPORTED_NAMES,
			send: (bytes) => {
				order.push(`send:${decodeFrame(bytes).kind}`);
			},
		});
		peer.onRequest("task.start", () => afterResponse({}, () => order.push("after")));
		peer.receive(encodeFrame({ kind: "request", id: 1, cmd: "task.start", body: TASK_START }));
		expect(order).toEqual(["send:response", "after"]);
	});

	it("reports a throwing afterResponse hook through onError", async () => {
		const errors: Error[] = [];
		const { a, b } = makePair(SUPPORTED_NAMES, undefined, undefined, (error) => errors.push(error));
		b.onRequest("ping", () =>
			afterResponse({ seq: 1 }, () => {
				throw new Error("sync hook bug");
			}),
		);
		await expect(a.request("ping", { seq: 1 })).resolves.toEqual({ seq: 1 });
		expect(errors.map((error) => error.message)).toEqual(["sync hook bug"]);
	});

	it("reports a throwing async afterResponse hook through onError", async () => {
		const errors: Error[] = [];
		const { a, b } = makePair(SUPPORTED_NAMES, undefined, undefined, (error) => errors.push(error));
		b.onRequest("ping", async () => {
			await delay(1);
			return afterResponse({ seq: 2 }, () => {
				throw new Error("async hook bug");
			});
		});
		await expect(a.request("ping", { seq: 2 })).resolves.toEqual({ seq: 2 });
		await delay(0);
		expect(errors.map((error) => error.message)).toEqual(["async hook bug"]);
	});

	it("answers internal_error when a plain success response body violates the schema", async () => {
		const { a, b, fromB } = makePair();
		b.onRequest("ping", () => ({ notSeq: true }) as unknown as CommandResponse<"ping">);
		const pending = a.request("ping", { seq: 1 });
		expect(fromB.at(-1)).toMatchObject({
			kind: "response",
			id: 1,
			cmd: "ping",
			ok: false,
			error: { code: "internal_error" },
		});
		await expect(pending).rejects.toMatchObject({
			name: "RemoteError",
			code: "internal_error",
			message: expect.stringContaining("invalid ping response"),
		});
	});

	it("answers internal_error and skips afterResponse when a success body violates the schema", async () => {
		const { a, b, fromB } = makePair();
		const afterCalls: string[] = [];
		b.onRequest("ping", () =>
			afterResponse({ notSeq: true } as unknown as CommandResponse<"ping">, () => afterCalls.push("after")),
		);
		const pending = a.request("ping", { seq: 1 });
		expect(fromB.at(-1)).toMatchObject({
			kind: "response",
			id: 1,
			cmd: "ping",
			ok: false,
			error: { code: "internal_error" },
		});
		await expect(pending).rejects.toMatchObject({
			name: "RemoteError",
			code: "internal_error",
			message: expect.stringContaining("invalid ping response"),
		});
		expect(afterCalls).toEqual([]);
	});

	it("answers internal_error when a success response exceeds MAX_FRAME_BYTES", async () => {
		const { a, b, fromB } = makePair();
		const afterCalls: string[] = [];
		const acks = Array.from({ length: 13000 }, () => ({ taskId: "t", stdoutOffset: 0, stderrOffset: 0 }));
		b.onRequest("hello", () => afterResponse({ acks }, () => afterCalls.push("after")));
		const pending = a.request("hello", { tasks: [], taskKinds: [], privilegedMode: "disabled" });
		expect(fromB.at(-1)).toMatchObject({
			kind: "response",
			id: 1,
			cmd: "hello",
			ok: false,
			error: { code: "internal_error" },
		});
		await expect(pending).rejects.toMatchObject({
			name: "RemoteError",
			code: "internal_error",
			message: expect.stringContaining("frame too large"),
		});
		expect(afterCalls).toEqual([]);
	});

	it("sends the response before events emitted by an async afterResponse hook", async () => {
		const { a, b, fromB } = makePair();
		const exits: unknown[] = [];
		a.onEvent("task.exit", (body) => {
			exits.push(body);
		});
		b.onRequest("task.start", async () => {
			await delay(1);
			return afterResponse({}, () => {
				b.emit("task.exit", {
					taskId: "t-1",
					outcome: { kind: "code", value: 0 },
					timedOut: false,
					cancelled: false,
					stdoutEnd: 0,
					stderrEnd: 0,
					outputFile: "",
					result: null,
				});
			});
		});
		await a.request("task.start", TASK_START);
		expect(fromB.map((frame) => frame.kind)).toEqual(["response", "event"]);
		expect(exits).toHaveLength(1);
	});

	it("waits for an async send before running an afterResponse hook", async () => {
		const order: string[] = [];
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const peer = new Peer({
			negotiated: SUPPORTED_NAMES,
			send: async () => {
				await gate;
				order.push("sent");
			},
		});
		peer.onRequest("task.start", () => afterResponse({}, () => order.push("after")));
		peer.receive(encodeFrame({ kind: "request", id: 1, cmd: "task.start", body: TASK_START }));
		expect(order).toEqual([]);
		release();
		await delay(0);
		expect(order).toEqual(["sent", "after"]);
	});

	it("does not run an afterResponse hook when sending fails", async () => {
		const afterCalls: string[] = [];
		const throwing = new Peer({
			negotiated: SUPPORTED_NAMES,
			send: () => {
				throw new Error("transport down");
			},
		});
		throwing.onRequest("task.start", () => afterResponse({}, () => afterCalls.push("throwing")));
		expect(() =>
			throwing.receive(encodeFrame({ kind: "request", id: 1, cmd: "task.start", body: TASK_START })),
		).not.toThrow();

		const rejecting = new Peer({
			negotiated: SUPPORTED_NAMES,
			send: async () => {
				throw new Error("transport down");
			},
		});
		rejecting.onRequest("task.start", () => afterResponse({}, () => afterCalls.push("rejecting")));
		rejecting.receive(encodeFrame({ kind: "request", id: 1, cmd: "task.start", body: TASK_START }));
		await delay(0);
		expect(afterCalls).toEqual([]);
	});

	it("does not run an afterResponse hook if the peer closed before the response", () => {
		const afterCalls: string[] = [];
		let peer!: Peer;
		peer = new Peer({
			negotiated: SUPPORTED_NAMES,
			send: () => {
				throw new Error("must not send");
			},
		});
		peer.onRequest("task.start", () => {
			peer.close("closed by handler");
			return afterResponse({}, () => afterCalls.push("after"));
		});
		expect(() =>
			peer.receive(encodeFrame({ kind: "request", id: 1, cmd: "task.start", body: TASK_START })),
		).not.toThrow();
		expect(afterCalls).toEqual([]);
	});
});
