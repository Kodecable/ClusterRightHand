import {
	createServer,
	type IncomingHttpHeaders,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { type WebSocket, WebSocketServer } from "ws";

/**
 * A fake Satori gateway for channel tests (doc/design/channels.md "Channel kinds"). It is one HTTP server with the
 * WebSocket at `<base>/v1/events` and the JSON API under `<base>/v1/<resource>.<method>`, records every call and
 * header, serves proxied files, and can inject events with controlled `sn` values. It understands only what the
 * adapter uses.
 */

export interface FakeSatoriCall {
	resource: string;
	method: string;
	body: Record<string, unknown>;
	headers: IncomingHttpHeaders;
	at: string;
}

export interface FakeSatoriFile {
	bytes: Uint8Array;
	name: string;
	mediaType: string;
	/** Serve without a content-length, so a download must stop reading at the limit. */
	chunked?: boolean;
}

export interface FakeSatoriIdentify {
	token?: string;
	sn?: number;
	headers: IncomingHttpHeaders;
}

export interface FakeSatoriLogin {
	platform?: string;
	id: string;
	name?: string;
	nick?: string;
	/** The Satori login status: 1 is ONLINE. */
	status?: number;
}

export interface FakeSatoriOptions {
	/** The gateway token; when set, calls and the proxy must carry it. */
	token?: string;
	/** The path the gateway lives under, such as `/satori`. */
	prefix?: string;
	logins?: FakeSatoriLogin[];
	/** On IDENTIFY, re-send every recorded event with a greater sn, like a gateway replaying its backlog. */
	replayOnIdentify?: boolean;
}

export interface FakeSatoriEvent {
	sn: number;
	type: string;
	login: {
		sn: number;
		adapter: string;
		platform: string;
		user: { id: string; name?: string; nick?: string; isBot?: boolean };
		selfId: string;
		status: number;
		features: string[];
	};
	selfId: string;
	platform: string;
	timestamp: number;
	channel?: { id: string; type: number; name?: string };
	guild?: { id: string; name?: string };
	user?: { id: string; name?: string; nick?: string; isBot?: boolean };
	member?: { name?: string; nick?: string };
	message?: { id?: string; content?: string };
	[key: string]: unknown;
}

function json(res: ServerResponse, value: unknown, status = 200): void {
	const body = JSON.stringify(value);
	res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
	res.end(body);
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(Buffer.from(chunk as Buffer));
	const raw = Buffer.concat(chunks);
	if (raw.length === 0) return {};
	try {
		return JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
	} catch {
		return {};
	}
}

const FALLBACK_LOGIN: FakeSatoriLogin = {
	platform: "telegram",
	id: "424242",
	name: "Test Bot",
	nick: "test_bot",
	status: 1,
};

function defaultLogins(): FakeSatoriLogin[] {
	return [FALLBACK_LOGIN];
}

export interface FakeSatori {
	/** The gateway base URL, such as `http://127.0.0.1:1234/satori`. */
	readonly url: string;
	readonly token: string;
	readonly calls: FakeSatoriCall[];
	readonly identifies: FakeSatoriIdentify[];
	readonly proxyRequests: { path: string; headers: IncomingHttpHeaders }[];
	/** Paths fetched directly on the gateway's origin, outside the API. */
	readonly directRequests: string[];
	/** The gateway's origin, such as `http://127.0.0.1:1234`. */
	readonly origin: string;
	readonly files: Map<string, FakeSatoriFile>;
	readonly events: FakeSatoriEvent[];
	readonly logins: FakeSatoriLogin[];
	setLogins(logins: FakeSatoriLogin[]): void;
	/** Sends one private text message; returns its sn. */
	message(
		userId: string | number,
		text: string,
		options?: { channelId?: string | number; channelType?: number; name?: string; content?: string },
	): number;
	/** Sends a raw event, filling in the login, platform and sn. */
	sendEvent(event: Partial<FakeSatoriEvent> & { type?: string }): number;
	addFile(src: string, file: Partial<FakeSatoriFile> & { bytes: Uint8Array }): void;
	closeSocket(reason?: string, code?: number): void;
	/** Simulates a gateway restart: the sn counter starts over and the backlog is gone; message ids stay unique. */
	restart(): void;
	/** Refuses every later connection with this close reason, closing the current socket first. */
	rejectConnections(reason: string): void;
	/** Makes the next message.delete fail, for the delete-then-edit fallback. */
	failNextDelete(description?: string): void;
	/** Makes the next message.update fail, so the manager falls back to sending the result as a new message. */
	failNextUpdate(description?: string): void;
	callsOf(method: string): FakeSatoriCall[];
	waitForCall(
		method: string,
		predicate?: (call: FakeSatoriCall) => boolean,
		timeoutMs?: number,
	): Promise<FakeSatoriCall>;
	waitForIdentify(count?: number, timeoutMs?: number): Promise<FakeSatoriIdentify>;
	waitForProxy(
		predicate?: (path: string) => boolean,
		timeoutMs?: number,
	): Promise<{ path: string; headers: IncomingHttpHeaders }>;
	close(): Promise<void>;
}

export async function startFakeSatori(options: FakeSatoriOptions = {}): Promise<FakeSatori> {
	const token = options.token ?? "satori-secret-token";
	const prefix = (options.prefix ?? "/satori").replace(/\/+$/, "");
	const logins: FakeSatoriLogin[] = options.logins ?? defaultLogins();
	const calls: FakeSatoriCall[] = [];
	const identifies: FakeSatoriIdentify[] = [];
	const proxyRequests: { path: string; headers: IncomingHttpHeaders }[] = [];
	const directRequests: string[] = [];
	let origin = "";
	const files = new Map<string, FakeSatoriFile>();
	const events: FakeSatoriEvent[] = [];
	const waiters = new Set<() => void>();
	let nextSn = 1;
	let nextMessageId = 1000;
	let socket: WebSocket | undefined;
	let socketReady = false;
	let rejectWith: string | null = null;
	let deleteFailure: string | null = null;
	let updateFailure: string | null = null;
	let server: Server;
	let url = "";

	const wake = (): void => {
		for (const waiter of [...waiters]) {
			waiters.delete(waiter);
			waiter();
		}
	};

	const loginOf = (login: FakeSatoriLogin): FakeSatoriEvent["login"] => ({
		sn: 0,
		adapter: "fake",
		platform: login.platform ?? "telegram",
		user: {
			id: login.id,
			...(login.name === undefined ? {} : { name: login.name }),
			...(login.nick === undefined ? {} : { nick: login.nick }),
			isBot: true,
		},
		selfId: login.id,
		status: login.status ?? 1,
		features: [],
	});

	const readyPayload = () => ({
		op: 4,
		body: {
			logins: logins.map((login) => ({ ...loginOf(login), sn: nextSn, hidden: false })),
			proxyUrls: [],
		},
	});

	const sendFrame = (frame: unknown): void => {
		if (socket === undefined || !socketReady) return;
		socket.send(JSON.stringify(frame));
	};

	const authorize = (headers: IncomingHttpHeaders): boolean => {
		return token === "" || headers.authorization === `Bearer ${token}` || headers.Authorization === `Bearer ${token}`;
	};

	const api = async (
		resource: string,
		method: string,
		body: Record<string, unknown>,
		headers: IncomingHttpHeaders,
		res: ServerResponse,
	): Promise<void> => {
		calls.push({ resource, method, body, headers, at: new Date().toISOString() });
		wake();
		if (!authorize(headers)) {
			json(res, { code: 401, message: "unauthorized" }, 401);
			return;
		}
		if (resource === "message" && method === "delete" && deleteFailure !== null) {
			const description = deleteFailure;
			deleteFailure = null;
			json(res, { code: 500, message: description }, 500);
			return;
		}
		if (resource === "message" && method === "update" && updateFailure !== null) {
			const description = updateFailure;
			updateFailure = null;
			json(res, { code: 500, message: description }, 500);
			return;
		}
		if (resource === "message" && method === "create") {
			const message = {
				id: `msg-${++nextMessageId}`,
				channel: { id: String(body.channel_id ?? ""), type: 1 },
			};
			json(res, [message]);
			return;
		}
		json(res, true);
	};

	const sendEvent = (partial: Partial<FakeSatoriEvent> & { type?: string }): number => {
		const base = loginOf(logins[0] ?? FALLBACK_LOGIN);
		const sn = nextSn++;
		const event: FakeSatoriEvent = {
			sn,
			type: partial.type ?? "message-created",
			login: base,
			selfId: base.selfId,
			platform: base.platform,
			timestamp: Date.now(),
			...partial,
		};
		events.push(event);
		sendFrame({ op: 0, body: event });
		wake();
		return sn;
	};

	let messageSeq = 0;
	const message: FakeSatori["message"] = (userId, text, opts = {}) => {
		const user = String(userId);
		const base = loginOf(logins[0] ?? FALLBACK_LOGIN);
		return sendEvent({
			type: "message-created",
			login: base,
			selfId: base.selfId,
			platform: base.platform,
			channel: { id: String(opts.channelId ?? user), type: opts.channelType ?? 1 },
			user: {
				id: user,
				...(opts.name === undefined ? { name: "Tester", nick: "Tester" } : { name: opts.name, nick: opts.name }),
				isBot: false,
			},
			message: { id: `m-${++messageSeq}`, content: opts.content ?? text },
		});
	};

	const waitFor = async <T>(find: () => T | undefined, label: string, timeoutMs = 5_000): Promise<T> => {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const found = find();
			if (found !== undefined) return found;
			if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	};

	const wss = new WebSocketServer({ noServer: true });
	wss.on("connection", (ws) => {
		if (rejectWith !== null) {
			ws.close(4001, rejectWith);
			return;
		}
		socket = ws;
		socketReady = true;
		ws.on("message", (data) => {
			let frame: { op?: number; body?: { token?: string; sn?: number } };
			try {
				frame = JSON.parse(data.toString()) as { op?: number; body?: { token?: string; sn?: number } };
			} catch {
				return;
			}
			if (frame.op === 3) {
				identifies.push({
					token: frame.body?.token,
					sn: frame.body?.sn,
					headers: {},
				});
				ws.send(JSON.stringify(readyPayload()));
				if (options.replayOnIdentify === true) {
					const sn = frame.body?.sn ?? 0;
					for (const event of events) if (event.sn > sn) ws.send(JSON.stringify({ op: 0, body: event }));
				}
				wake();
				return;
			}
			if (frame.op === 1) {
				ws.send(JSON.stringify({ op: 2, body: {} }));
			}
		});
		ws.on("close", () => {
			if (socket === ws) {
				socket = undefined;
				socketReady = false;
			}
		});
	});

	server = createServer(async (req, res) => {
		const requestUrl = new URL(req.url ?? "/", "http://localhost");
		const path = requestUrl.pathname;
		if (!path.startsWith(`${prefix}/v1/`)) {
			// A file the gateway serves itself on its own origin (Koishi's `<selfUrl>/telegram/...`).
			const own = files.get(`${origin}${path}`);
			if (own) {
				directRequests.push(path);
				res.writeHead(
					200,
					own.chunked
						? { "content-type": own.mediaType }
						: { "content-type": own.mediaType, "content-length": own.bytes.length },
				);
				res.end(own.bytes);
				return;
			}
			res.writeHead(404);
			res.end("not found");
			return;
		}
		const rest = path.slice(`${prefix}/v1/`.length);
		if (rest.startsWith("proxy/")) {
			const src = decodeURIComponent(rest.slice("proxy/".length));
			proxyRequests.push({ path: src, headers: req.headers });
			wake();
			if (!authorize(req.headers)) {
				json(res, { code: 401, message: "unauthorized" }, 401);
				return;
			}
			const file = files.get(src);
			if (!file) {
				json(res, { code: 404, message: "file not found" }, 404);
				return;
			}
			res.writeHead(
				200,
				file.chunked
					? { "content-type": file.mediaType }
					: { "content-type": file.mediaType, "content-length": file.bytes.length },
			);
			res.end(file.bytes);
			return;
		}
		const match = /^([a-z.]+)\.([a-z]+)$/.exec(rest);
		if (!match) {
			json(res, { code: 404, message: "not found" }, 404);
			return;
		}
		await api(match[1] ?? "", match[2] ?? "", await readBody(req), req.headers, res);
	});
	server.on("upgrade", (req, rawSocket, head) => {
		const requestUrl = new URL(req.url ?? "/", "http://localhost");
		if (!requestUrl.pathname.startsWith(`${prefix}/v1/events`)) {
			rawSocket.destroy();
			return;
		}
		wss.handleUpgrade(req, rawSocket, head, (ws) => wss.emit("connection", ws, req));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	url = `${origin}${prefix}`;

	return {
		url,
		token,
		calls,
		identifies,
		proxyRequests,
		directRequests,
		origin,
		files,
		events,
		logins,
		setLogins: (next) => {
			logins.splice(0, logins.length, ...next);
		},
		message,
		sendEvent,
		addFile: (src, file) => {
			files.set(src, {
				bytes: file.bytes,
				name: file.name ?? src.split("/").pop() ?? "file",
				mediaType: file.mediaType ?? "application/octet-stream",
				...(file.chunked !== undefined ? { chunked: file.chunked } : {}),
			});
		},
		restart: () => {
			nextSn = 1;
			events.length = 0;
			socket?.close(1012, "restart");
		},
		closeSocket: (reason = "closed by the test", code = 4001) => {
			socket?.close(code, reason);
		},
		rejectConnections: (reason) => {
			rejectWith = reason;
			socket?.close(4001, reason);
		},
		failNextDelete: (description = "message cannot be deleted") => {
			deleteFailure = description;
		},
		failNextUpdate: (description = "message cannot be updated") => {
			updateFailure = description;
		},
		callsOf: (method) => calls.filter((call) => call.method === method),
		waitForCall: (method, predicate = () => true, timeoutMs = 5_000) =>
			waitFor(() => calls.find((call) => call.method === method && predicate(call)), method, timeoutMs),
		waitForIdentify: (count = 1, timeoutMs = 5_000) =>
			waitFor(() => (identifies.length >= count ? identifies[count - 1] : undefined), "IDENTIFY", timeoutMs),
		waitForProxy: (predicate = () => true, timeoutMs = 5_000) =>
			waitFor(() => proxyRequests.find((request) => predicate(request.path)), "a proxied file", timeoutMs),
		close: async () => {
			for (const ws of wss.clients) ws.terminate();
			wss.close();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}
