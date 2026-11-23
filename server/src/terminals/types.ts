/**
 * The terminal subsystem's internal types (doc/design/pty.md): the copy crhs holds of one terminal,
 * the offsets of its two byte streams, the viewer and data-connection bookkeeping, and the in-memory
 * rule approvals.
 *
 * Nothing here is persisted: a terminal lives in crha's memory and in crhs's copy, and the two must
 * agree on what exists and where the streams continue, or the terminal is closed.
 */
import type { AuthorizationOption, PtyApproval, PtyViewer } from "@crh/api";
import type { DataFrame } from "@crh/protocol";
import type { WebSocket } from "ws";
import type { TerminalScreen } from "./emulator.ts";

/** The terminal's state: `opening` while its approval or authorization is pending. */
export type TerminalState = "opening" | "running" | "exited";

/** Every way a terminal ends; the close reason travels in `pty.closed` and in `pty.close`. */
export type TerminalCloseReason =
	| "manual"
	| "idle"
	| "exited"
	| "session_deleted"
	| "crha_restarted"
	| "crhs_restarted"
	| "stream_lost"
	| "disabled"
	| "node_removed"
	| "user_removed"
	| "helper_lost";

/** The stored authorization state of an opening privileged terminal, in the same shape a task records. */
export interface TerminalAuthorization {
	options: AuthorizationOption[];
	crhsRejected: { window: number | null } | null;
	rejectedBefore: string | null;
	attempt: number;
	lastRejection: { code: string; message: string; attempt: number; at: string } | null;
	/** The path the last `pty.open` used; null until one was sent. */
	path: "crhs" | "user" | null;
	updatedAt: string;
}

/** One WebUI viewer attached to a terminal. */
export interface Viewer extends PtyViewer {
	readonly socket: WebSocket;
	/** False while the first snapshot is being built; output is buffered, never sent before it. */
	ready: boolean;
	/** Output that arrived before the snapshot was sent. */
	pending: Uint8Array[];
}

/** A rule approval waiting for the user on one terminal. */
export interface TerminalApproval extends PtyApproval {
	/** The acting session whose tool call waits; its root is the request's source. */
	readonly sessionId: string;
	/** Resolves when the user or Auto Review settles the request. */
	resolve: (decision: ApprovalOutcome) => void;
}

export interface ApprovalOutcome {
	decision: "approved" | "rejected";
	reason?: string;
}

/**
 * How a terminal approval ended, kept on the terminal so a chat card can name the decider after the
 * in-memory approval is gone (the terminal itself may outlive it).
 */
export interface TerminalApprovalDecision {
	decision: "approved" | "rejected";
	by: { type: "user" | "system"; id: string };
	reason?: string;
	at: string;
}

/** One accepted terminal data connection. */
export interface TerminalDataConnection {
	nodeId: string;
	ptyId: string;
	close(): void;
	/** Sends output bytes to the node, preserving order with the other writers. */
	send(bytes: Uint8Array): Promise<void>;
}

/** The terminal object crhs keeps. */
export interface Terminal {
	readonly id: string;
	readonly nodeId: string;
	nodeName: string | null;
	userId: string;
	username: string | null;
	privileged: boolean;
	argv: string[];
	rows: number;
	cols: number;
	createdBySessionId: string | null;
	/** Associated sessions, in association order. */
	sessionIds: string[];
	/** The idle timeout; null for a person-opened terminal. */
	idleTimeoutMs: number | null;
	/** crhs's clock at open (unix milliseconds). */
	readonly openedAt: number;
	state: TerminalState;
	exitCode: number | null;
	/** Why the process side ended; the close audit uses it after the retention. */
	exitReason: "exited" | "helper_lost" | null;
	endedAt: number | null;
	lastActivityAt: number;
	scrollbackBytes: number;
	/** The headless emulator fed with the terminal's output; created on the first data connection. */
	screen: TerminalScreen | null;
	/** The current data connection; a newer one replaces it. */
	connection: TerminalDataConnection | null;
	viewers: Map<string, Viewer>;
	/** Bytes written to the PTY and bytes received from it, for the close audit. */
	bytesIn: number;
	bytesOut: number;
	/** Output bytes received and fed to the screen: where the output stream continues. */
	outputReceived: number;
	/** Input bytes handed to the node, the absolute count of distinct bytes. */
	inputSent: number;
	/** The absolute offset of the first byte still in inputBuffer. */
	inputStart: number;
	/** The most recent input bytes handed to the node, for resending what it did not receive. */
	inputBuffer: Uint8Array;
	/** The authorization of an opening privileged terminal; null for an ordinary one. */
	authorization: TerminalAuthorization | null;
	/** The rule approval currently waiting, if any. */
	approval: TerminalApproval | null;
	/** How the last rule approval ended, for the chat card that showed it; null until one is decided. */
	approvalDecision: TerminalApprovalDecision | null;
	/** The running `pty_watch` calls, by tool call key; each callback re-checks its conditions. */
	watches: Map<string, () => void>;
	/** `pty_read output` cursors, per session: the absolute offset of the stripped log it read to. */
	cursors: Map<string, number>;
	/** A tool call waiting for the open to finish; settled when the terminal runs or fails. */
	openWaiter: { resolve: () => void; reject: (err: Error) => void } | null;
	/** The tool call key that opened it, when an agent did; a replayed call finds it again. */
	callKey: string | null;
	/** The failure of an opening terminal, so an await sees why it never ran. */
	openError: Error | null;
	/** When the terminal became idle, per the idle rules; null while it is not idle. */
	idleSince: number | null;
	/** Set once the terminal started closing, so a second close is a no-op. */
	closing: boolean;
}

/** What a session may do with a terminal, as the tools and the API check it. */
export interface TerminalAccess {
	terminal: Terminal;
	/** The caller created the terminal or is associated with it. */
	session: boolean;
	/** The caller is the terminal's user or an administrator. */
	manage: boolean;
}

/** A refusal the terminal subsystem returns; the tool and API layers turn it into their own errors. */
export class TerminalError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "TerminalError";
		this.code = code;
	}
}

/** The frame a data connection sends; kept next to the type for the connection module. */
export type PtyFrame = DataFrame;
