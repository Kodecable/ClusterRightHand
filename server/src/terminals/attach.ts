/**
 * The WebUI's terminal attachment (doc/design/pty.md "Viewers"): `GET /api/ptys/:id/attach` is a
 * WebSocket on the HTTP listener, authenticated by the same session cookie as the API. Binary frames
 * are terminal bytes in both directions; JSON text frames are the snapshot, the state changes a
 * viewer applies, and the viewer's own resize request.
 *
 * The first server frame is always a `snapshot` of the serialized screen. Attaching never resizes
 * the terminal; the viewer asks explicitly and every viewer adopts the answer.
 *
 * An attachment belongs to the WebUI session that opened it. Logout, a password reset or an expired
 * cookie ends it, and an administrator's demotion ends the ones whose terminal is no longer visible.
 */
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { type RawData, type WebSocket, WebSocketServer } from "ws";
import { resolveWebSession, SESSION_COOKIE, type SessionUser, webSessionAlive } from "../auth/sessions.ts";
import { closeReason, toBytes } from "../cluster/connection.ts";
import type { Db } from "../storage/db.ts";
import { resolveClientAddress } from "../util/client-address.ts";
import { normalizedHost } from "../util/host.ts";
import type { TerminalService } from "./registry.ts";
import type { Terminal, Viewer } from "./types.ts";

/** The attach path's pattern; the id is everything between `/api/ptys/` and `/attach`. */
const ATTACH_PATH = /^\/api\/ptys\/([^/]+)\/attach$/;
/** How long a server-initiated close waits for its reason frame before dropping the socket. */
const CLOSE_NOTICE_TIMEOUT_MS = 1_000;

/** What the rest of the app may ask of terminal attachments; `createApp` keeps this narrow. */
export interface TerminalAttachments {
	/** Ends the attachments whose WebUI session no longer exists (logout, password change, reset). */
	revalidateWebSessions(userId: string): Promise<void>;
	/** Ends the attachments whose user may no longer see their terminal (a role change or disable). */
	revalidateVisibility(userId: string): Promise<void>;
}

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

/**
 * One live attachment. The viewer is absent while the snapshot is being serialized, so a disconnect
 * in that window is still recorded and cleaned up when the snapshot resolves.
 */
interface Attachment {
	ws: WebSocket;
	terminal: Terminal;
	ptyId: string;
	webSessionId: string;
	userId: string;
	viewer?: Viewer;
	closed: boolean;
	/** Installed only after the snapshot; `#detach` removes it so a revoked socket cannot type. */
	onMessage?: (data: RawData, isBinary: boolean) => void;
}

/**
 * The browser-side WebSocket endpoint of terminals. `main.ts` gives it the HTTP server's upgrade
 * events before the agent endpoint; it returns false for every other path.
 */
export class TerminalAttachServer implements TerminalAttachments {
	readonly #db: Db;
	readonly #terminals: TerminalService;
	readonly #wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
	/** The terminal service closed: no new attachment is accepted. */
	#accepting = true;
	/** Every live attachment, including one still waiting for its first snapshot. */
	readonly #attachments = new Map<WebSocket, Attachment>();
	/** How often a WebUI session is re-checked when no request revoked it (expiry, an out-of-process reset). */
	readonly #sessionSweepMs: number;
	#sweepTimer: NodeJS.Timeout | undefined;
	#sweeping = false;

	/**
	 * The configured real-IP header, read per attachment so a System settings change applies without a
	 * restart; the same resolution the API's audit records use (`api/client-address.ts`).
	 */
	readonly #realIpHeader: () => string | null | undefined;

	constructor(
		db: Db,
		terminals: TerminalService,
		options: { realIpHeader?: () => string | null | undefined; sessionSweepMs?: number } = {},
	) {
		this.#db = db;
		this.#terminals = terminals;
		this.#realIpHeader = options.realIpHeader ?? (() => undefined);
		this.#sessionSweepMs = options.sessionSweepMs ?? 30_000;
		if (this.#sessionSweepMs > 0) {
			this.#sweepTimer = setInterval(() => {
				void this.#sweepSessions().catch((err: unknown) => console.error("terminal session sweep failed:", err));
			}, this.#sessionSweepMs);
			this.#sweepTimer.unref();
		}
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
		if (this.#sweepTimer !== undefined) {
			clearInterval(this.#sweepTimer);
			this.#sweepTimer = undefined;
		}
		for (const attachment of [...this.#attachments.values()]) this.#detach(attachment);
		for (const client of this.#wss.clients) client.terminate();
		await new Promise<void>((resolve) => this.#wss.close(() => resolve()));
	}

	/**
	 * Ends the attachments of a user whose WebUI sessions were revoked (logout, a password change, an
	 * administrator's reset). The sweep is the fallback for an out-of-process revocation or expiry.
	 */
	async revalidateWebSessions(userId: string): Promise<void> {
		const alive = new Map<string, boolean>();
		for (const attachment of [...this.#attachments.values()]) {
			if (attachment.userId !== userId || attachment.closed) continue;
			let current = alive.get(attachment.webSessionId);
			if (current === undefined) {
				current = await webSessionAlive(this.#db, attachment.webSessionId);
				alive.set(attachment.webSessionId, current);
			}
			if (!current) this.#closeAttachment(attachment, "signed_out");
		}
	}

	/**
	 * Ends the attachments of a user who may no longer see their terminal. A demoted administrator
	 * loses the terminals of other users; a disabled user loses every attachment they still hold.
	 */
	async revalidateVisibility(userId: string): Promise<void> {
		const row = await this.#db
			.selectFrom("users")
			.select(["username", "kind", "status"])
			.where("id", "=", userId)
			.executeTakeFirst();
		for (const attachment of [...this.#attachments.values()]) {
			if (attachment.userId !== userId || attachment.closed) continue;
			const terminal = this.#terminals.get(attachment.ptyId);
			if (row?.status !== "active" || !terminal) {
				this.#closeAttachment(attachment, "access_revoked");
				continue;
			}
			const user: SessionUser = {
				sessionId: attachment.webSessionId,
				userId,
				username: row.username,
				kind: row.kind,
			};
			if (!this.#terminals.canSee(user, terminal)) this.#closeAttachment(attachment, "access_revoked");
		}
	}

	/** A WebUI session that expired or was deleted outside this process: close its attachments. */
	async #sweepSessions(): Promise<void> {
		if (!this.#accepting || this.#sweeping) return;
		this.#sweeping = true;
		try {
			const alive = new Map<string, boolean>();
			for (const attachment of [...this.#attachments.values()]) {
				if (attachment.closed) continue;
				let current = alive.get(attachment.webSessionId);
				if (current === undefined) {
					current = await webSessionAlive(this.#db, attachment.webSessionId);
					alive.set(attachment.webSessionId, current);
				}
				if (!current) this.#closeAttachment(attachment, "signed_out");
			}
		} finally {
			this.#sweeping = false;
		}
	}

	async #attach(ws: WebSocket, ptyId: string, token: string | undefined, clientAddress: string | null): Promise<void> {
		// Register before the first await: a close during session lookup or snapshot serialization must
		// set the flag and clean up the attachment, not be missed by a listener installed afterwards.
		let closed = false;
		let attachment: Attachment | undefined;
		const gone = () => {
			closed = true;
			if (attachment !== undefined) this.#detach(attachment);
		};
		ws.once("close", gone);
		ws.once("error", gone);

		let user: SessionUser | undefined;
		if (token) user = await resolveWebSession(this.#db, token);
		if (closed) return;
		if (!user) {
			ws.close(1008, "not signed in");
			return;
		}
		if (ws.readyState !== 1) return;
		const terminal = this.#terminals.get(ptyId);
		if (!terminal) {
			ws.close(1008, "no such terminal");
			return;
		}

		const live: Attachment = {
			ws,
			terminal,
			ptyId,
			webSessionId: user.sessionId,
			userId: user.userId,
			closed: false,
		};
		attachment = live;
		// Register before checking the current role and session: revocation scans this map, so a change
		// that committed before this check is caught by the check and one after it sees this entry.
		this.#attachments.set(ws, live);
		if (closed || ws.readyState !== 1) {
			this.#detach(live);
			if (ws.readyState === 1) ws.close(1008, "the connection closed");
			return;
		}

		let current: { username: string; kind: "admin" | "member"; status: "active" | "disabled" } | undefined;
		let sessionAlive = false;
		try {
			[current, sessionAlive] = await Promise.all([
				this.#db
					.selectFrom("users")
					.select(["username", "kind", "status"])
					.where("id", "=", user.userId)
					.executeTakeFirst(),
				webSessionAlive(this.#db, user.sessionId),
			]);
		} catch (err) {
			this.#detach(live);
			throw err;
		}
		if (closed || live.closed || ws.readyState !== 1) {
			this.#detach(live);
			return;
		}
		if (!sessionAlive) {
			this.#closeAttachment(live, "signed_out");
			return;
		}
		if (terminal.closing) {
			this.#rejectUnknownTerminal(live);
			return;
		}
		if (current?.status !== "active") {
			this.#rejectUnknownTerminal(live);
			return;
		}
		const verified: SessionUser = {
			sessionId: user.sessionId,
			userId: user.userId,
			username: current.username,
			kind: current.kind,
		};
		if (!this.#terminals.canSee(verified, terminal)) {
			this.#rejectUnknownTerminal(live);
			return;
		}

		let viewer: Viewer;
		try {
			viewer = await this.#terminals.attachViewer(terminal, verified, ws, clientAddress, {
				cancelled: () => live.closed,
			});
		} catch (err) {
			// Capture this before #detach: it sets live.closed, which must not hide a real attach
			// failure from the outer handler that logs it and terminates the socket.
			const wasClosed = closed || live.closed || ws.readyState !== 1;
			this.#detach(live);
			if (wasClosed) return;
			throw err;
		}
		live.viewer = viewer;
		if (closed || live.closed || ws.readyState !== 1 || terminal.closing) {
			this.#detach(live);
			if (ws.readyState === 1) ws.close(1008, "the connection closed");
			return;
		}

		const onMessage = (data: RawData, isBinary: boolean) => {
			if (live.closed || ws.readyState !== 1) return;
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
		};
		live.onMessage = onMessage;
		ws.on("message", onMessage);
	}

	/**
	 * Refuses a connection that never passed the first authorization. It gets the same response as an
	 * unknown terminal id, so an authenticated caller cannot use the attach endpoint as an existence
	 * oracle. A connection authorized earlier is revoked with `access_revoked` instead.
	 */
	#rejectUnknownTerminal(attachment: Attachment): void {
		this.#detach(attachment);
		const ws = attachment.ws;
		try {
			if (ws.readyState === 1) ws.close(1008, "no such terminal");
			else ws.terminate();
		} catch {
			ws.terminate();
		}
	}

	/** Forgets an attachment and its viewer; safe to call more than once and with no viewer yet. */
	#detach(attachment: Attachment): void {
		attachment.closed = true;
		if (this.#attachments.get(attachment.ws) === attachment) this.#attachments.delete(attachment.ws);
		// Stop accepting frames synchronously. The close notification is sent before the socket is
		// closed, so without this a revoked viewer could still type until that send drains.
		const onMessage = attachment.onMessage;
		if (onMessage !== undefined) {
			attachment.onMessage = undefined;
			attachment.ws.off("message", onMessage);
		}
		const viewer = attachment.viewer;
		if (viewer !== undefined) {
			attachment.viewer = undefined;
			this.#terminals.detachViewer(attachment.terminal, viewer);
		}
	}

	/** Server-initiated close: tells the page why (so it does not retry), then closes the socket. */
	#closeAttachment(attachment: Attachment, reason: string): void {
		if (attachment.closed) return;
		this.#detach(attachment);
		const ws = attachment.ws;
		try {
			if (ws.readyState === 1) {
				// Input is already disabled; the timeout only keeps a stalled reason frame from retaining
				// a revoked socket indefinitely.
				const timer = setTimeout(() => ws.terminate(), CLOSE_NOTICE_TIMEOUT_MS);
				timer.unref();
				ws.send(JSON.stringify({ type: "closed", reason }), () => {
					clearTimeout(timer);
					ws.close(1000, "closed");
				});
			} else {
				ws.terminate();
			}
		} catch {
			ws.terminate();
		}
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
