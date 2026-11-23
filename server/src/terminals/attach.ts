/**
 * The WebUI's terminal attachment (doc/design/pty.md "Viewers"): `GET /api/ptys/:id/attach` is a
 * WebSocket on the HTTP listener, authenticated by the same session cookie as the API. Binary frames
 * are terminal bytes in both directions; JSON text frames are the snapshot, the state changes a
 * viewer applies, and the viewer's own resize request.
 *
 * The first server frame is always a `snapshot` of the serialized screen. Attaching never resizes
 * the terminal; the viewer asks explicitly and every viewer adopts the answer.
 */
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { type WebSocket, WebSocketServer } from "ws";
import { resolveWebSession, SESSION_COOKIE, type SessionUser } from "../auth/sessions.ts";
import { closeReason, toBytes } from "../cluster/connection.ts";
import type { Db } from "../storage/db.ts";
import { resolveClientAddress } from "../util/client-address.ts";
import { normalizedHost } from "../util/host.ts";
import type { TerminalService } from "./registry.ts";
import type { Viewer } from "./types.ts";

/** The attach path's pattern; the id is everything between `/api/ptys/` and `/attach`. */
const ATTACH_PATH = /^\/api\/ptys\/([^/]+)\/attach$/;

/** Reads the session cookie from a raw `Cookie` header. */
function sessionCookie(req: IncomingMessage): string | undefined {
	const header = req.headers.cookie;
	if (!header) return undefined;
	for (const part of header.split(";")) {
		const [name, ...rest] = part.trim().split("=");
		if (name === SESSION_COOKIE) return decodeURIComponent(rest.join("="));
	}
	return undefined;
}

/**
 * The origin check a WebSocket needs: a browser's Origin must match the Host it connects to. The
 * comparison is the API's (doc/design/webui.md "API conventions"), so a proxied HTTPS origin and a
 * `host:443` header compare equal and both paths agree.
 */
function sameOrigin(req: IncomingMessage): boolean {
	const origin = req.headers.origin;
	if (origin === undefined) return true;
	let url: URL;
	try {
		url = new URL(origin);
	} catch {
		return false;
	}
	const host = req.headers.host;
	if (host === undefined) return false;
	const scheme = url.protocol.slice(0, -1);
	return normalizedHost(host, scheme) === normalizedHost(url.host, scheme);
}

/** One live attachment's bookkeeping. */
interface Attachment {
	viewer: Viewer;
	detach: () => void;
}

/**
 * The browser-side WebSocket endpoint of terminals. `main.ts` gives it the HTTP server's upgrade
 * events before the agent endpoint; it returns false for every other path.
 */
export class TerminalAttachServer {
	readonly #db: Db;
	readonly #terminals: TerminalService;
	readonly #wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
	/** The terminal service closed: no new attachment is accepted. */
	#accepting = true;

	/**
	 * The configured real-IP header, read per attachment so a System settings change applies without a
	 * restart; the same resolution the API's audit records use (`api/client-address.ts`).
	 */
	readonly #realIpHeader: () => string | null | undefined;

	constructor(db: Db, terminals: TerminalService, options: { realIpHeader?: () => string | null | undefined } = {}) {
		this.#db = db;
		this.#terminals = terminals;
		this.#realIpHeader = options.realIpHeader ?? (() => undefined);
	}

	/** Attach to the HTTP server's `upgrade` event; false for a path this endpoint does not own. */
	handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
		if (!this.#accepting) return false;
		let path: string;
		try {
			path = new URL(req.url ?? "/", "http://x").pathname;
		} catch {
			return false;
		}
		const match = ATTACH_PATH.exec(path);
		if (!match) return false;
		if (req.method !== "GET") {
			socket.end("HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
			return true;
		}
		if (!sameOrigin(req)) {
			socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
			return true;
		}
		const ptyId = decodeURIComponent(match[1] ?? "");
		const token = sessionCookie(req);
		const header = this.#realIpHeader() ?? undefined;
		const headerValue = header === undefined ? undefined : req.headers[header.toLowerCase()];
		const clientAddress =
			resolveClientAddress(
				req.socket.remoteAddress,
				header,
				Array.isArray(headerValue) ? headerValue[0] : headerValue,
			) ?? null;
		this.#wss.handleUpgrade(req, socket, head, (ws) => {
			ws.on("error", () => {});
			void this.#attach(ws, ptyId, token, clientAddress).catch((err: unknown) => {
				console.error("terminal attach failed:", err);
				ws.terminate();
			});
		});
		return true;
	}

	/** Stops accepting attachments and closes the endpoint's own server. */
	async close(): Promise<void> {
		this.#accepting = false;
		for (const client of this.#wss.clients) client.terminate();
		await new Promise<void>((resolve) => this.#wss.close(() => resolve()));
	}

	async #attach(ws: WebSocket, ptyId: string, token: string | undefined, clientAddress: string | null): Promise<void> {
		let user: SessionUser | undefined;
		if (token) user = await resolveWebSession(this.#db, token);
		if (!user) {
			ws.close(1008, "not signed in");
			return;
		}
		const terminal = this.#terminals.get(ptyId);
		if (!terminal || !this.#terminals.canSee(user, terminal)) {
			ws.close(1008, "no such terminal");
			return;
		}
		if (terminal.closing) {
			ws.close(1008, "the terminal closed");
			return;
		}
		const attachment: { value?: Attachment } = {};
		const viewer = await this.#terminals.attachViewer(terminal, user, ws, clientAddress);
		attachment.value = {
			viewer,
			detach: () => this.#terminals.detachViewer(terminal, viewer),
		};
		ws.on("message", (data, isBinary) => {
			if (isBinary) {
				void this.#terminals.write(terminal, toBytes(data)).catch((err: unknown) => {
					ws.send(JSON.stringify({ type: "error", message: err instanceof Error ? err.message : String(err) }));
				});
				return;
			}
			let frame: unknown;
			try {
				frame = JSON.parse(data.toString());
			} catch {
				return;
			}
			if (typeof frame !== "object" || frame === null) return;
			const text = frame as { type?: unknown; rows?: unknown; cols?: unknown };
			if (text.type === "resize" && typeof text.rows === "number" && typeof text.cols === "number") {
				void this.#terminals.resize(terminal, text.rows, text.cols).catch((err: unknown) => {
					ws.send(JSON.stringify({ type: "error", message: err instanceof Error ? err.message : String(err) }));
				});
			}
		});
		ws.on("close", () => attachment.value?.detach());
		ws.on("error", () => attachment.value?.detach());
	}
}

/** A close with a well-formed reason, for callers that close an attachment themselves. */
export function closeAttachment(ws: WebSocket, reason: string): void {
	try {
		ws.close(1000, closeReason(reason));
	} catch {
		ws.terminate();
	}
}
