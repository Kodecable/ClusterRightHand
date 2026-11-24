/**
 * The terminal subsystem (doc/design/pty.md "crhs"): the memory-only copy of every terminal crhs
 * knows, the limits and access checks, the audit events, the headless screens, the viewers, the rule
 * approvals and the idle timers.
 *
 * A terminal is not a task: crhs holds the copy and crha holds the process. The two copies agree on
 * which terminals exist, and their byte streams continue from the offsets in the data-connection
 * handshake; a terminal that cannot be continued is closed. Nothing here is persisted.
 */
import type { ApprovalBody, PtyListResponse, PtyView, Rule } from "@crh/api";
import type { TransportCiphers } from "@crh/noise";
import { PTY_STREAM_LOST, type PtyStatus, type TaskSpec } from "@crh/protocol";
import type { WebSocket } from "ws";
import { alwaysRuleLifts } from "../approvals/always-allow.ts";
import { approvalRequestForPty } from "../approvals/request.ts";
import type { Audit, AuditActor } from "../audit/audit.ts";
import type { SessionUser } from "../auth/sessions.ts";
import { isAdmin } from "../auth/sessions.ts";
import type { TaskAuthorizationRecord } from "../cluster/authorization.ts";
import { AUTHORIZATION_CODES, type Cluster } from "../cluster/cluster.ts";
import { nodeAccess } from "../cluster/node-access.ts";
import { getNode, listNodesForUser, type NodeRow } from "../cluster/nodes.ts";
import { pendingAuthorizationOptions } from "../cluster/pending.ts";
import type { TerminalSink } from "../cluster/terminal-link.ts";
import { parseTrustReport } from "../cluster/trust.ts";
import { parseRulesForWrite } from "../policy/refs.ts";
import { appendRule, type RuleRef } from "../policy/store.ts";
import { windowIdentity } from "../privilege/planner.ts";
import type { SettingsStore } from "../settings/settings.ts";
import type { Db } from "../storage/db.ts";
import { defaultOrgId } from "../storage/org.ts";
import { newId } from "../util/id.ts";
import {
	alwaysAllowCandidates,
	approvalOperation,
	type PendingApproval,
	pendingApproval,
	type RuleApprovalRequest,
} from "./approval.ts";
import { PtyWire } from "./connection.ts";
import { TerminalScreen } from "./emulator.ts";
import {
	type Terminal,
	type TerminalApproval,
	type TerminalApprovalDecision,
	type TerminalCloseReason,
	type TerminalDataConnection,
	TerminalError,
	type Viewer,
} from "./types.ts";

/** How long an exited terminal stays visible after its process ended (doc/design/pty.md "Lifecycle"). */
export const EXITED_RETENTION_MS = 5 * 60 * 1000;
/** The default size of a terminal nobody sized explicitly. */
export const DEFAULT_ROWS = 24;
export const DEFAULT_COLS = 80;
/** How much output one `pty_read output` returns before the next read continues. */
export const OUTPUT_READ_CHARS = 64 * 1024;
/** A viewer whose socket has this many bytes queued is disconnected; it may attach again. */
export const VIEWER_BUFFER_BYTES = 4 * 1024 * 1024;
/**
 * How many recent input bytes crhs keeps to resend what crha did not receive after a reconnect
 * (doc/design/pty.md "crha").
 */
export const INPUT_BUFFER_BYTES = 64 * 1024;
/** The sweep that starts and checks idle timers. */
export const IDLE_SWEEP_MS = 1_000;

export interface TerminalServiceOptions {
	db: Db;
	cluster: Cluster;
	settings: SettingsStore;
	audit?: Audit;
	/** Test overrides. */
	exitedRetentionMs?: number;
	idleSweepMs?: number;
	/**
	 * A session's stored run state, for the idle rule. The runtime supplies `sessionStateOf`; a caller
	 * without sessions treats every one as idle.
	 */
	sessionState?: (sessionId: string) => Promise<"idle" | "running" | "awaiting" | undefined>;
	/**
	 * Told after a terminal rule approval appears or settles, so the acting session's run state follows
	 * it (doc/design/agent-runtime.md "Session state"): the runtime supplies `refreshState`.
	 */
	onApprovalChanged?: (sessionId: string) => void;
	/**
	 * Told after an agent-created privileged terminal starts or ends its signature wait, for the same
	 * run-state refresh.
	 */
	onAuthorizationChanged?: (sessionId: string) => void;
}

/** What a person asked for when opening a terminal from the WebUI or the API. */
export interface PersonOpenInput {
	user: SessionUser;
	node: string;
	argv?: readonly string[];
	privileged?: boolean;
	rows?: number;
	cols?: number;
}

/** What an agent's `pty_open` asked for. */
export interface AgentOpenInput {
	user: SessionUser;
	sessionId: string;
	chain: RuleRef[];
	node: string;
	argv?: readonly string[];
	privileged?: boolean;
	rows?: number;
	cols?: number;
	idleTimeoutMs: number;
	callKey?: string;
	/** The tool call's abort signal: a stopped session ends its waiting approval. */
	signal?: AbortSignal;
	/** Runs Auto Review for the request before the user is asked; absent when the preset is not Auto Review. */
	review?: (request: RuleApprovalRequest, screen: string) => Promise<"approve" | "reject" | "escalate">;
}

/** What one `pty_watch` reports. */
export interface WatchResult {
	reason: "timeout" | "keyword" | "bell" | "exited" | "closed" | "session_stopped";
	keyword?: string;
	screen: string;
	rows: number;
	cols: number;
}

/** The pieces of a validated open, before the record exists. */
interface PreparedOpen {
	node: NodeRow;
	user: SessionUser;
	argv: string[];
	privileged: boolean;
	rows: number;
	cols: number;
	creatingSessionId: string | null;
	idleTimeoutMs: number | null;
	callKey: string | null;
}

/** A usable privileged authorization, ready for `pty.open`. */
interface ApprovedOpen {
	authorization: Uint8Array;
	authorizationId: string;
	payloadBytes: Uint8Array;
	cosign: Uint8Array | null;
	via: "crhs" | "user";
	deadline: string;
}

/**
 * The terminal subsystem. One instance per crhs process; it installs itself as the cluster's
 * terminal sink and is closed before the database is destroyed.
 */
export class TerminalService implements TerminalSink {
	readonly #db: Db;
	readonly #cluster: Cluster;
	readonly #settings: SettingsStore;
	readonly #audit: Audit | undefined;
	readonly #exitedRetentionMs: number;
	readonly #idleSweepMs: number;
	readonly #sessionState: (sessionId: string) => Promise<"idle" | "running" | "awaiting" | undefined>;
	#onApprovalChanged: (sessionId: string) => void;
	#onAuthorizationChanged: (sessionId: string) => void;
	readonly #terminals = new Map<string, Terminal>();
	readonly #retention = new Map<string, NodeJS.Timeout>();
	readonly #nodeNames = new Map<string, string>();
	readonly #usernames = new Map<string, string | null>();
	readonly #pending = new Set<Promise<void>>();
	#sweep: NodeJS.Timeout | undefined;
	#closed = false;

	constructor(options: TerminalServiceOptions) {
		this.#db = options.db;
		this.#cluster = options.cluster;
		this.#settings = options.settings;
		this.#audit = options.audit;
		this.#exitedRetentionMs = options.exitedRetentionMs ?? EXITED_RETENTION_MS;
		this.#idleSweepMs = options.idleSweepMs ?? IDLE_SWEEP_MS;
		this.#sessionState = options.sessionState ?? (async () => "idle");
		this.#onApprovalChanged = options.onApprovalChanged ?? (() => {});
		this.#onAuthorizationChanged = options.onAuthorizationChanged ?? (() => {});
	}

	/**
	 * Follows terminal rule approvals, so the acting session's state becomes `awaiting/approval` and returns
	 * to `running` when it is decided. The runtime is created after the terminal service, so this is set
	 * afterwards instead of through the constructor.
	 */
	setApprovalListener(listener: ((sessionId: string) => void) | undefined): void {
		this.#onApprovalChanged = listener ?? (() => {});
	}

	/**
	 * Follows an agent-created privileged terminal's signature wait, so the acting session becomes
	 * `awaiting/authorization` and returns to `running` when the terminal opens, fails or is closed.
	 */
	setAuthorizationListener(listener: ((sessionId: string) => void) | undefined): void {
		this.#onAuthorizationChanged = listener ?? (() => {});
	}

	/** Installs the sink and starts the idle sweep. */
	start(): void {
		this.#cluster.setTerminalSink(this);
		if (this.#sweep === undefined) {
			this.#sweep = setInterval(() => void this.#sweepIdle(), this.#idleSweepMs);
			this.#sweep.unref();
		}
	}

	/** Stops accepting work, closes every terminal and releases the timers. */
	async shutdown(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		if (this.#sweep !== undefined) clearInterval(this.#sweep);
		this.#sweep = undefined;
		for (const timer of this.#retention.values()) clearTimeout(timer);
		this.#retention.clear();
		for (const terminal of [...this.#terminals.values()]) {
			this.#closeTerminal(terminal, "manual", { send: false, audit: false });
		}
		await Promise.allSettled([...this.#pending]);
	}

	/** Whether the subsystem is on; turning it off closed every terminal already. */
	get enabled(): boolean {
		return this.#settings.current().pty.enabled;
	}

	/** The longest `pty_watch` an agent may ask for, in milliseconds. */
	get watchTimeoutMaxMs(): number {
		return this.#settings.current().pty.watchTimeoutMaxMs;
	}

	/** A terminal by id, when it still exists. */
	get(id: string): Terminal | undefined {
		return this.#terminals.get(id);
	}

	/** Applies a settings change: turning the subsystem off closes every terminal. */
	applySettings(): void {
		if (!this.enabled) this.closeAll("disabled");
	}

	/** Every terminal a user may see: their own, or all for an administrator. */
	async list(user: SessionUser): Promise<PtyListResponse> {
		const visible = [...this.#terminals.values()].filter((terminal) => this.canSee(user, terminal));
		visible.sort((a, b) => a.openedAt - b.openedAt || (a.id < b.id ? -1 : 1));
		const terminals = await Promise.all(visible.map((terminal) => this.view(terminal)));
		return { enabled: this.enabled, terminals };
	}

	/** Every terminal a user may see, without the subsystem's enabled flag. */
	async views(user: SessionUser): Promise<PtyView[]> {
		return (await this.list(user)).terminals;
	}

	/** A terminal's view, with its node/user names, its authorization wait and its approval. */
	async view(terminal: Terminal): Promise<PtyView> {
		const [nodeName, username] = await Promise.all([this.#nodeName(terminal.nodeId), this.#username(terminal.userId)]);
		let authorization: PtyView["authorization"] = null;
		let authorizationPhase: PtyView["authorizationPhase"] = null;
		if (terminal.authorization !== null) {
			const record: TaskAuthorizationRecord = {
				options: terminal.authorization.options,
				crhsRejected: terminal.authorization.crhsRejected,
				rejectedBefore: terminal.authorization.rejectedBefore,
				dispatchedPath: terminal.authorization.path,
				payloadId: null,
				attempt: terminal.authorization.attempt,
				trustDigest: null,
				lastRejection: terminal.authorization.lastRejection,
				updatedAt: terminal.authorization.updatedAt,
			};
			const options = await pendingAuthorizationOptions(this.#db, terminal.userId, terminal.nodeId, record);
			if (options.length > 0) {
				authorization = { options, lastRejection: terminal.authorization.lastRejection };
				authorizationPhase = "waiting";
			} else {
				authorizationPhase = terminal.state === "opening" ? "preparing" : "ended";
			}
		}
		const approval = terminal.approval;
		const approvalView =
			approval === null
				? null
				: {
						id: approval.id,
						method: approval.method,
						privileged: approval.privileged,
						argv: [...approval.argv],
						input: approval.input,
						keys: [...approval.keys],
						createdAt: approval.createdAt,
						...(approval.attempt === undefined ? {} : { attempt: approval.attempt }),
						alwaysAllow: approval.alwaysAllow.map((candidate) => ({
							option: candidate.option,
							rule: { ...candidate.rule, ...(candidate.rule.nodes ? { nodes: [...candidate.rule.nodes] } : {}) },
						})),
					};
		const approvalRequest = approval === null ? null : await approvalRequestForPty(this.#db, terminal, approval);
		return {
			id: terminal.id,
			nodeId: terminal.nodeId,
			nodeName,
			userId: terminal.userId,
			username,
			privileged: terminal.privileged,
			argv: [...terminal.argv],
			size: { rows: terminal.rows, cols: terminal.cols },
			title: terminal.title,
			state: terminal.state,
			exitCode: terminal.exitCode,
			creatingSessionId: terminal.createdBySessionId,
			sessionIds: [...terminal.sessionIds],
			idleTimeoutMs: terminal.idleTimeoutMs,
			openedAt: new Date(terminal.openedAt).toISOString(),
			endedAt: terminal.endedAt === null ? null : new Date(terminal.endedAt).toISOString(),
			lastActivityAt: new Date(terminal.lastActivityAt).toISOString(),
			viewers: [...terminal.viewers.values()].map((viewer) => ({
				id: viewer.id,
				userId: viewer.userId,
				username: viewer.username,
				clientAddress: viewer.clientAddress,
				attachedAt: viewer.attachedAt,
			})),
			authorization,
			authorizationPhase,
			rejection:
				terminal.authorization?.lastRejection === null || terminal.authorization?.lastRejection === undefined
					? null
					: {
							code: terminal.authorization.lastRejection.code,
							message: terminal.authorization.lastRejection.message,
							attempt: terminal.authorization.lastRejection.attempt,
							at: terminal.authorization.lastRejection.at,
						},
			approval: approvalView,
			approvalRequest,
		};
	}

	/** Whether a user sees a terminal: its user, or an administrator. Share viewers see nothing. */
	canSee(user: SessionUser, terminal: Terminal): boolean {
		return isAdmin(user) || terminal.userId === user.userId;
	}

	/** The terminal, when the caller may see it; a 404-like error otherwise. */
	async requireTerminal(user: SessionUser, id: string): Promise<Terminal> {
		const terminal = this.#terminals.get(id);
		if (!terminal || !this.canSee(user, terminal)) throw new TerminalError("not_found", "no such terminal");
		return terminal;
	}

	/** Whether a session created or is associated with the terminal. */
	accessForSession(terminal: Terminal, sessionId: string): boolean {
		return terminal.createdBySessionId === sessionId || terminal.sessionIds.includes(sessionId);
	}

	// ---- open ----

	/** A person opens a terminal: only node access is checked, rules do not apply to people. */
	async openForPerson(input: PersonOpenInput): Promise<Terminal> {
		this.#requireEnabled();
		const prepared = await this.#prepare(input.user, input.node, {
			argv: input.argv ?? [],
			privileged: input.privileged === true,
			rows: input.rows ?? DEFAULT_ROWS,
			cols: input.cols ?? DEFAULT_COLS,
			creatingSessionId: null,
			idleTimeoutMs: null,
			callKey: null,
		});
		const terminal = this.#createTerminal(prepared, {
			actor: { type: "user", id: input.user.userId, onBehalfOfUserId: input.user.userId },
			username: input.user.username,
		});
		if (terminal.authorization !== null) {
			// Plan now, so a node that cannot authorize the terminal refuses the POST instead of leaving an
			// opening terminal that will never run. When options are planned the page polls the wait, and
			// the open continues after a signature.
			await this.#planAndOpen(terminal);
			if (terminal.openError !== null) {
				const error = terminal.openError;
				this.#discardOpening(terminal);
				throw error;
			}
			return terminal;
		}
		await this.#sendOpenOrFail(terminal, null);
		return terminal;
	}

	/**
	 * An agent opens a terminal: rules judge `pty.create`, an approval waits for the user (or Auto
	 * Review), and a privileged terminal then gets its authorization before `pty.open`.
	 */
	async openForAgent(input: AgentOpenInput): Promise<Terminal> {
		this.#requireEnabled();
		const idleMax = this.#settings.current().pty.agentIdleTimeoutMaxMs;
		if (!Number.isFinite(input.idleTimeoutMs) || input.idleTimeoutMs <= 0) {
			throw new TerminalError("idle_timeout_required", "an agent-opened terminal needs a positive idle_timeout");
		}
		if (input.idleTimeoutMs > idleMax) {
			throw new TerminalError(
				"idle_timeout_too_large",
				`idle_timeout must be at most ${Math.floor(idleMax / 1000)} seconds`,
			);
		}
		// A replayed pty_open finds the terminal its first run opened, by the in-memory call key.
		if (input.callKey !== undefined) {
			for (const existing of this.#terminals.values()) {
				if (existing.callKey === input.callKey && existing.createdBySessionId === input.sessionId) return existing;
			}
		}
		const prepared = await this.#prepare(input.user, input.node, {
			argv: input.argv ?? [],
			privileged: input.privileged === true,
			rows: input.rows ?? DEFAULT_ROWS,
			cols: input.cols ?? DEFAULT_COLS,
			creatingSessionId: input.sessionId,
			idleTimeoutMs: input.idleTimeoutMs,
			callKey: input.callKey ?? null,
		});
		const evaluation = await this.#cluster.evaluateFor(
			prepared.node,
			{ kind: "pty.create", argv: prepared.argv } as TaskSpec,
			input.chain,
			prepared.privileged,
		);
		if (evaluation.result === "deny") {
			throw new TerminalError("rule_denied", "the session's rules deny opening this terminal");
		}
		const terminal = this.#createTerminal(prepared, {
			actor: { type: "session", id: input.sessionId, onBehalfOfUserId: input.user.userId },
			username: input.user.username,
		});
		try {
			if (evaluation.result === "require-approval") {
				const request: RuleApprovalRequest = {
					method: "pty.create",
					privileged: terminal.privileged,
					nodeId: terminal.nodeId,
					sessionId: input.sessionId,
					argv: [...terminal.argv],
					input: null,
					keys: [],
					screen: "",
					chain: [...input.chain],
					attempt: terminal.authorization?.attempt ?? (terminal.privileged ? 1 : 0),
				};
				const outcome = await this.#ruleOutcome(terminal, request, input.review, input.signal);
				if (outcome !== "approve") {
					throw new TerminalError("approval_rejected", "the user rejected opening the terminal");
				}
			}
			if (terminal.authorization !== null) {
				await this.#planAndOpen(terminal);
				await this.#waitForRunning(terminal);
			} else {
				await this.#sendOpenOrFail(terminal, null);
			}
			return terminal;
		} catch (err) {
			this.#discardOpening(terminal);
			throw err;
		}
	}

	/** Validates an open: node access, transport, connectivity, size and limits. */
	async #prepare(
		user: SessionUser,
		nodeRef: string,
		input: {
			argv: readonly string[];
			privileged: boolean;
			rows: number;
			cols: number;
			creatingSessionId: string | null;
			idleTimeoutMs: number | null;
			callKey: string | null;
		},
	): Promise<PreparedOpen> {
		if (input.rows < 1 || input.cols < 1 || input.rows > 1000 || input.cols > 1000) {
			throw new TerminalError("invalid_size", "rows and cols must be between 1 and 1000");
		}
		if (input.argv.length > 64) throw new TerminalError("invalid_argv", "argv holds at most 64 entries");
		for (const arg of input.argv) {
			if (typeof arg !== "string" || arg === "")
				throw new TerminalError("invalid_argv", "argv entries must be non-empty");
		}
		const nodes = await listNodesForUser(this.#db, user);
		const publicNode =
			nodes.find((node) => node.id === nodeRef) ??
			nodes.find((node) => node.name.toLowerCase() === nodeRef.toLowerCase());
		const row = publicNode ? await getNode(this.#db, publicNode.id) : undefined;
		if (!row || !(await nodeAccess(this.#db, user, row.id))) {
			throw new TerminalError("node_not_found", `no node ${nodeRef} you have access to`);
		}
		if (row.transport === "ssh") throw new TerminalError("unsupported_node", "SSH nodes have no terminals");
		if (row.status !== "active") throw new TerminalError("node_offline", `node ${row.name} is not active`);
		const link = this.#cluster.terminalNodeLink(row.id);
		if (!link) throw new TerminalError("node_offline", `node ${row.name} is offline`);
		if (!link.peer.negotiated.has("pty.open")) {
			throw new TerminalError("unsupported_node", `node ${row.name} does not offer terminals (upgrade its crha)`);
		}
		this.#checkLimits(row.id, input.creatingSessionId);
		return {
			node: row,
			user,
			argv: [...input.argv],
			privileged: input.privileged,
			rows: input.rows,
			cols: input.cols,
			creatingSessionId: input.creatingSessionId,
			idleTimeoutMs: input.idleTimeoutMs,
			callKey: input.callKey,
		};
	}

	#createTerminal(prepared: PreparedOpen, context: { actor: AuditActor; username: string }): Terminal {
		const now = Date.now();
		const terminal: Terminal = {
			id: newId(),
			nodeId: prepared.node.id,
			nodeName: prepared.node.name,
			userId: prepared.user.userId,
			username: context.username,
			privileged: prepared.privileged,
			argv: [...prepared.argv],
			rows: prepared.rows,
			cols: prepared.cols,
			title: "",
			createdBySessionId: prepared.creatingSessionId,
			sessionIds: [],
			idleTimeoutMs: prepared.idleTimeoutMs,
			openedAt: now,
			state: "opening",
			exitCode: null,
			exitReason: null,
			endedAt: null,
			lastActivityAt: now,
			idleSince: null,
			scrollbackBytes: this.#settings.current().pty.scrollbackBytes,
			screen: new TerminalScreen(prepared.rows, prepared.cols),
			connection: null,
			viewers: new Map(),
			bytesIn: 0,
			bytesOut: 0,
			outputReceived: 0,
			inputSent: 0,
			inputStart: 0,
			inputBuffer: new Uint8Array(0),
			// Only a forward node authorizes a privileged terminal; native mode runs it without an
			// authorization, and a mode without a privileged channel refuses it on the node
			// (doc/design/pty.md "Privilege").
			authorization:
				prepared.privileged && prepared.node.privileged_mode === "forward"
					? {
							options: [],
							crhsRejected: null,
							rejectedBefore: null,
							attempt: 1,
							lastRejection: null,
							path: null,
							updatedAt: new Date().toISOString(),
						}
					: null,
			approval: null,
			approvalDecision: null,
			watches: new Map(),
			cursors: new Map(),
			openWaiter: null,
			callKey: prepared.callKey,
			openError: null,
			closing: false,
		};
		if (prepared.creatingSessionId !== null) terminal.cursors.set(prepared.creatingSessionId, 0);
		this.#terminals.set(terminal.id, terminal);
		this.#wireEmulatorAnswers(terminal);
		this.#nodeNames.set(prepared.node.id, prepared.node.name);
		this.#usernames.set(prepared.user.userId, context.username);
		return terminal;
	}

	/**
	 * Feeds the headless emulator's answers to terminal queries into the terminal's input stream,
	 * exactly as a viewer's input does (doc/design/pty.md "crhs", "Two continuous byte streams"):
	 * the same input numbering and the same 64 KiB resend buffer, so a reconnected data connection
	 * continues them. The emulator is crhs's single responder; browsers forward only user input.
	 */
	#wireEmulatorAnswers(terminal: Terminal): void {
		const screen = terminal.screen;
		if (!screen) return;
		const encoder = new TextEncoder();
		screen.onData((data) => {
			if (terminal.state !== "running") return;
			void this.write(terminal, encoder.encode(data)).catch((err: unknown) => {
				// A reply generated while no data connection is up has nowhere to go; it is not
				// recorded, so a reconnect does not resend input the node never received.
				if (err instanceof TerminalError) return;
				console.error("sending a terminal emulator answer failed:", err);
			});
		});
		// The program's title is untrusted text. Keeping it on the terminal makes it part of every
		// view and of the state frames a viewer receives; it never replaces the node name.
		screen.onTitleChange((title) => {
			if (terminal.title === title) return;
			terminal.title = title;
			terminal.lastActivityAt = Date.now();
			this.#broadcastState(terminal);
		});
	}

	#checkLimits(nodeId: string, sessionId: string | null): void {
		const settings = this.#settings.current().pty;
		const nodeCount = [...this.#terminals.values()].filter((terminal) => terminal.nodeId === nodeId).length;
		if (nodeCount >= settings.maxPerNode) {
			throw new TerminalError("limit_node", `at most ${settings.maxPerNode} terminals can be held on one node`);
		}
		if (this.#terminals.size >= settings.maxTotal) {
			throw new TerminalError("limit_total", `at most ${settings.maxTotal} terminals can be held`);
		}
		if (sessionId !== null && this.#sessionCount(sessionId) >= settings.maxPerSession) {
			throw new TerminalError(
				"limit_session",
				`a session may create or be associated with at most ${settings.maxPerSession} terminals`,
			);
		}
	}

	#sessionCount(sessionId: string): number {
		let count = 0;
		for (const terminal of this.#terminals.values()) {
			if (terminal.createdBySessionId === sessionId || terminal.sessionIds.includes(sessionId)) count++;
		}
		return count;
	}

	// ---- privileged authorization ----

	/** Tells the runtime that an agent-created terminal's signature wait may have started or ended. */
	#notifyAuthorization(terminal: Terminal): void {
		if (terminal.createdBySessionId !== null) this.#onAuthorizationChanged(terminal.createdBySessionId);
	}

	async #planAndOpen(terminal: Terminal): Promise<void> {
		if (terminal.closing || terminal.state !== "opening") return;
		const auth = terminal.authorization;
		if (auth === null) return;
		const plan = await this.#cluster.planTerminalAuthorization({
			ptyId: terminal.id,
			userId: terminal.userId,
			nodeId: terminal.nodeId,
			argv: terminal.argv,
			attempt: auth.attempt,
			since: terminal.openedAt,
			crhsRejected: auth.crhsRejected,
			rejectedBefore: auth.rejectedBefore,
			currentOptions: auth.options,
		});
		if (terminal.closing || terminal.state !== "opening" || this.#terminals.get(terminal.id) !== terminal) return;
		if (plan.kind === "failure") {
			this.#failOpen(terminal, new TerminalError(plan.code, plan.message));
			return;
		}
		if (plan.kind === "options") {
			auth.options = plan.options;
			auth.updatedAt = new Date().toISOString();
			this.#notifyAuthorization(terminal);
			return;
		}
		auth.options = [];
		auth.path = plan.via;
		auth.updatedAt = new Date().toISOString();
		await this.#sendOpenOrFail(terminal, plan);
	}

	/** Sends `pty.open`; a failure removes the opening terminal and throws. */
	async #sendOpenOrFail(terminal: Terminal, plan: ApprovedOpen | null): Promise<void> {
		const link = this.#cluster.terminalNodeLink(terminal.nodeId);
		if (!link) {
			const error = new TerminalError("node_offline", "the node is offline");
			this.#failOpen(terminal, error);
			throw error;
		}
		const attempt = terminal.authorization?.attempt ?? (terminal.privileged ? 1 : 0);
		try {
			await link.peer.request(
				"pty.open",
				{
					ptyId: terminal.id,
					argv: [...terminal.argv],
					rows: terminal.rows,
					cols: terminal.cols,
					privileged: terminal.privileged,
					scrollbackBytes: terminal.scrollbackBytes,
					attempt,
					authorizations: plan === null ? [] : [plan.authorization],
					cosign: plan?.cosign ?? null,
				},
				{ timeoutMs: 30_000 },
			);
		} catch (err) {
			const code = remoteCode(err);
			if (terminal.privileged && code !== null && AUTHORIZATION_CODES.has(code)) {
				this.#retryAuthorization(terminal, code, err, plan);
				return;
			}
			if (isTimeout(err)) {
				await linkRequest(this.#cluster, terminal.nodeId, "pty.close", { ptyId: terminal.id, reason: "manual" });
			}
			const error = new TerminalError(mapOpenErrorCode(code), openErrorMessage(code, err));
			this.#failOpen(terminal, error);
			throw error;
		}
		if (terminal.closing || this.#terminals.get(terminal.id) !== terminal) return;
		terminal.state = "running";
		terminal.lastActivityAt = Date.now();
		this.#auditOpen(terminal, plan);
		terminal.openWaiter?.resolve();
		terminal.openWaiter = null;
		this.#notifyAuthorization(terminal);
	}

	/** crha refused the authorization: the attempt is raised and the terminal waits for a new plan. */
	#retryAuthorization(terminal: Terminal, code: string, err: unknown, plan: ApprovedOpen | null): void {
		const auth = terminal.authorization;
		if (auth === null || terminal.closing) return;
		auth.lastRejection = {
			code,
			message: err instanceof Error ? err.message : String(err),
			attempt: auth.attempt,
			at: new Date().toISOString(),
		};
		if (plan?.via === "user") auth.rejectedBefore = new Date().toISOString();
		else auth.crhsRejected = { window: null };
		auth.attempt += 1;
		auth.options = [];
		auth.path = null;
		auth.updatedAt = new Date().toISOString();
		this.#background(
			"planning a terminal authorization after a refusal failed",
			(async () => {
				// crhs's own signature is only ruled out under the node's current local window; read the
				// report before the next plan decides whether the path is available again.
				if (plan?.via !== "user") {
					const node = await getNode(this.#db, terminal.nodeId);
					if (node) auth.crhsRejected = { window: trustWindowOf(node) };
				}
				await this.#planAndOpen(terminal);
			})(),
		);
	}

	/** Rejected by the user, Auto Review or the node: the opening terminal disappears without a close audit. */
	#failOpen(terminal: Terminal, error: Error): void {
		terminal.openError = error;
		if (this.#terminals.get(terminal.id) === terminal) this.#terminals.delete(terminal.id);
		this.#finishApproval(terminal, { decision: "rejected", reason: error.message });
		terminal.openWaiter?.reject(error);
		terminal.openWaiter = null;
		this.#retention.delete(terminal.id);
		terminal.screen?.dispose();
		terminal.screen = null;
		for (const viewer of terminal.viewers.values()) closeViewer(viewer, "closed");
		terminal.viewers.clear();
		this.#notifyAuthorization(terminal);
	}

	/** Ends an opening terminal that the rules rejected; the failure is reported by the caller. */
	#discardOpening(terminal: Terminal): void {
		if (this.#terminals.get(terminal.id) === terminal) this.#terminals.delete(terminal.id);
		this.#finishApproval(terminal, { decision: "rejected", reason: "the open ended" });
		terminal.openWaiter?.reject(new TerminalError("open_failed", "the terminal did not open"));
		terminal.openWaiter = null;
		terminal.screen?.dispose();
		terminal.screen = null;
		this.#notifyAuthorization(terminal);
	}

	async #waitForRunning(terminal: Terminal): Promise<void> {
		if (terminal.state === "running") return;
		if (terminal.openError) throw terminal.openError;
		if (this.#terminals.get(terminal.id) !== terminal) {
			throw terminal.openError ?? new TerminalError("open_failed", "the terminal did not open");
		}
		await new Promise<void>((resolve, reject) => {
			terminal.openWaiter = { resolve, reject };
		});
	}

	#auditOpen(terminal: Terminal, plan: ApprovedOpen | null): void {
		this.#audit?.record({
			actor: this.#actorOf(terminal),
			action: "pty.opened",
			target: { type: "pty", id: terminal.id },
			detail: {
				node: terminal.nodeId,
				privileged: terminal.privileged,
				argv: terminal.argv,
				size: { rows: terminal.rows, cols: terminal.cols },
				creating_session: terminal.createdBySessionId,
				authorization: plan?.via ?? "none",
				attempt: terminal.authorization?.attempt ?? 0,
			},
		});
	}

	#actorOf(terminal: Terminal): AuditActor {
		return terminal.createdBySessionId === null
			? { type: "user", id: terminal.userId, onBehalfOfUserId: terminal.userId }
			: { type: "session", id: terminal.createdBySessionId, onBehalfOfUserId: terminal.userId };
	}

	// ---- sizing, input and output ----

	/** Changes the terminal's one size; attaching never resizes it (doc/design/pty.md "Size"). */
	async resize(terminal: Terminal, rows: number, cols: number): Promise<void> {
		if (rows < 1 || cols < 1 || rows > 1000 || cols > 1000) {
			throw new TerminalError("invalid_size", "rows and cols must be between 1 and 1000");
		}
		if (terminal.state === "exited") throw new TerminalError("exited", "the terminal has exited");
		if (terminal.rows === rows && terminal.cols === cols) return;
		terminal.rows = rows;
		terminal.cols = cols;
		terminal.screen?.resize(rows, cols);
		terminal.lastActivityAt = Date.now();
		if (terminal.state === "running") {
			const link = this.#cluster.terminalNodeLink(terminal.nodeId);
			if (link) {
				try {
					await link.peer.request("pty.resize", { ptyId: terminal.id, rows, cols }, { timeoutMs: 10_000 });
				} catch (err) {
					if (!isConnectionError(err)) throw err;
				}
			}
		}
		this.#broadcastState(terminal);
	}

	/** Writes input as a viewer or an agent types it, preserving arrival order. */
	async write(terminal: Terminal, bytes: Uint8Array): Promise<void> {
		if (terminal.state !== "running") throw new TerminalError("not_running", "the terminal is not running");
		const connection = terminal.connection;
		if (!connection) throw new TerminalError("not_connected", "the terminal has no data connection");
		terminal.bytesIn += bytes.length;
		terminal.lastActivityAt = Date.now();
		// The bytes count as sent before the socket accepts them: if the connection breaks, the next
		// handshake says how many crha received and the rest is resent exactly once.
		recordInput(terminal, bytes);
		try {
			await connection.send(bytes);
		} catch {
			throw new TerminalError("not_connected", "the terminal's data connection ended");
		}
	}

	/** The terminal's shown screen. */
	async screen(
		terminal: Terminal,
	): Promise<{ text: string; cursor: { row: number; col: number }; rows: number; cols: number }> {
		if (!terminal.screen) throw new TerminalError("not_running", "the terminal has no screen yet");
		return terminal.screen.screen();
	}

	/**
	 * `pty_read output`: the escape-stripped output since a session's last read, capped. While a
	 * full-screen program holds the alternate screen there is no output to read back: the current
	 * screen is returned in the screen shape instead (doc/design/pty.md "Agent tools").
	 */
	async readOutput(
		terminal: Terminal,
		sessionId: string,
	): Promise<{
		text: string;
		truncated: boolean;
		lost: boolean;
		screen?: { text: string; cursor: { row: number; col: number }; rows: number; cols: number };
	}> {
		if (!terminal.screen) throw new TerminalError("not_running", "the terminal has no screen yet");
		const screen = terminal.screen;
		await screen.whenIdle();
		if (terminal.screen !== screen) throw new TerminalError("not_running", "the terminal closed");
		if (screen.alternate) {
			// The screen replaces the output for this read; moving the cursor to the end of the log as
			// it was on the alternate screen makes the next read after the program leaves continue
			// from there, not replay what the caller already saw (doc/design/pty.md "Agent tools").
			const logEnd = screen.logEnd;
			const snapshot = await screen.screen();
			if (terminal.screen !== screen) throw new TerminalError("not_running", "the terminal closed");
			terminal.cursors.set(sessionId, logEnd);
			return { text: snapshot.text, truncated: false, lost: false, screen: snapshot };
		}
		const cursor = terminal.cursors.get(sessionId) ?? screen.logEnd;
		const lost = cursor < screen.logStart;
		const from = Math.max(cursor, screen.logStart);
		const text = screen.textSince(from).text;
		const piece = text.slice(0, OUTPUT_READ_CHARS);
		terminal.cursors.set(sessionId, from + piece.length);
		return { text: piece, truncated: piece.length < text.length, lost };
	}

	/** Remembers a session's output cursor when it is associated or first reads. */
	initCursor(terminal: Terminal, sessionId: string): void {
		terminal.cursors.set(sessionId, terminal.screen?.logEnd ?? 0);
	}

	/**
	 * `pty_watch`: blocks until a keyword appears in the output written since the watch started, a
	 * BEL the parser sees, the timeout, the process exiting or the session stopping. On the normal
	 * screen the escape-stripped log is matched; while a full-screen program holds the alternate
	 * screen (whose drawing is not logged), a keyword matches when the current screen has it and the
	 * screen the watch began with — or the alternate screen when it began — did not
	 * (doc/design/pty.md "Agent tools").
	 */
	async watch(
		terminal: Terminal,
		_sessionId: string,
		options: { timeoutMs: number; keywords: readonly string[]; bell: boolean; signal?: AbortSignal },
	): Promise<WatchResult> {
		const initial = terminal.screen;
		if (!initial) throw new TerminalError("not_running", "the terminal has no screen yet");
		// The baseline is the screen and the log as they are when the watch really begins: a write
		// still being parsed belongs to the moment before it.
		await initial.whenIdle();
		if (terminal.screen !== initial) throw new TerminalError("not_running", "the terminal closed");
		const keywords = options.keywords.filter((keyword) => keyword !== "");
		const longest = keywords.length === 0 ? 0 : Math.max(...keywords.map((keyword) => keyword.length));
		// Only output written from now on counts: a keyword that appeared before the watch started
		// is not a match, and a continuing stream never rewrites what it already delivered.
		let cursor = initial.logEnd;
		let tail = "";
		let bells = initial.bellCount;
		// The alternate screen's baseline: what was already on it when the watch started, or the
		// blank screen it began with during the watch.
		let baseline = initial.alternate ? initial.screenTextNow() : "";
		const startedAt = Date.now();
		return new Promise<WatchResult>((resolve) => {
			let done = false;
			let timer: NodeJS.Timeout | undefined;
			let offAlternate: (() => void) | undefined;
			const finish = (reason: WatchResult["reason"], keyword?: string) => {
				if (done) return;
				done = true;
				cleanup();
				const current = terminal.screen;
				if (!current) {
					resolve({
						reason,
						...(keyword === undefined ? {} : { keyword }),
						screen: "",
						rows: terminal.rows,
						cols: terminal.cols,
					});
					return;
				}
				void current.screen().then((snapshot) =>
					resolve({
						reason,
						...(keyword === undefined ? {} : { keyword }),
						screen: snapshot.text,
						rows: snapshot.rows,
						cols: snapshot.cols,
					}),
				);
			};
			const onAbort = () => finish("session_stopped");
			const cleanup = () => {
				if (timer) clearTimeout(timer);
				terminal.watches.delete(key);
				options.signal?.removeEventListener("abort", onAbort);
				offAlternate?.();
			};
			const key = newId();
			const check = () => {
				if (done) return;
				const current = terminal.screen;
				if (!current) return finish("closed");
				if (terminal.closing) return finish("closed");
				if (terminal.state === "exited") return finish("exited");
				if (options.bell && current.bellCount > bells) return finish("bell");
				bells = current.bellCount;
				if (current.alternate) {
					// The screen is the picture; a keyword that the program already showed when this
					// alternate screen began is not new, however often it redraws it.
					if (longest > 0) {
						const text = current.screenTextNow();
						for (const keyword of keywords) {
							if (text.includes(keyword) && !baseline.includes(keyword)) return finish("keyword", keyword);
						}
					}
				} else {
					const { text, next, lost } = current.textSince(cursor);
					cursor = Math.max(cursor, next);
					if (lost) tail = "";
					if (longest > 0) {
						const chunk = tail + text;
						for (const keyword of keywords) {
							if (chunk.includes(keyword)) return finish("keyword", keyword);
						}
						tail = longest > 1 ? chunk.slice(Math.max(0, chunk.length - (longest - 1))) : "";
					}
				}
				if (Date.now() - startedAt >= options.timeoutMs) finish("timeout");
			};
			// A switch re-bases the alternate-screen match: on entry the screen is the baseline, on
			// return the normal log continues, with no keyword tail carried across the gap.
			offAlternate = initial.onAlternateChange((alternate, text) => {
				baseline = alternate ? text : "";
				tail = "";
				check();
			});
			timer = setTimeout(() => finish("timeout"), options.timeoutMs);
			options.signal?.addEventListener("abort", onAbort, { once: true });
			terminal.watches.set(key, check);
			if (options.signal?.aborted) finish("session_stopped");
			else check();
		});
	}

	// ---- viewers ----

	/** Attaches a WebUI viewer: the first frame is the serialized screen, then live output. */
	async attachViewer(
		terminal: Terminal,
		user: SessionUser,
		socket: WebSocket,
		clientAddress: string | null,
	): Promise<Viewer> {
		const viewer: Viewer = {
			id: newId(),
			userId: user.userId,
			username: user.username,
			clientAddress,
			attachedAt: new Date().toISOString(),
			socket,
			ready: false,
			pending: [],
		};
		// The snapshot is taken before the viewer joins, so no output can be missed or repeated: the
		// parser writes queued bytes before serializing, and the viewer is added in the same turn.
		const snapshot = terminal.screen ? await terminal.screen.snapshot() : "";
		viewer.ready = true;
		terminal.viewers.set(viewer.id, viewer);
		this.#sendJson(socket, { type: "snapshot", data: snapshot, rows: terminal.rows, cols: terminal.cols });
		for (const bytes of viewer.pending.splice(0)) this.#sendBinary(viewer, bytes);
		this.#broadcastState(terminal);
		this.#audit?.record({
			actor: { type: "user", id: user.userId, onBehalfOfUserId: user.userId },
			action: "pty.attached",
			target: { type: "pty", id: terminal.id },
			detail: { viewer: viewer.id, client_address: clientAddress },
		});
		if (terminal.state === "exited") {
			this.#sendJson(socket, { type: "exited", exitCode: terminal.exitCode ?? -1, reason: "exited" });
		}
		return viewer;
	}

	/** Detaches a viewer; an exited terminal may close now that nobody watches it. */
	detachViewer(terminal: Terminal, viewer: Viewer): void {
		if (!terminal.viewers.delete(viewer.id)) return;
		this.#broadcastState(terminal);
		this.#audit?.record({
			actor: { type: "user", id: viewer.userId, onBehalfOfUserId: viewer.userId },
			action: "pty.detached",
			target: { type: "pty", id: terminal.id },
			detail: { viewer: viewer.id, client_address: viewer.clientAddress },
		});
		this.#maybeRetireExited(terminal);
	}

	/** Sends bytes to every ready viewer; a viewer past the buffer limit is disconnected. */
	#broadcastOutput(terminal: Terminal, bytes: Uint8Array): void {
		for (const viewer of [...terminal.viewers.values()]) {
			if (!viewer.ready) {
				viewer.pending.push(bytes);
				continue;
			}
			if (viewer.socket.readyState === 1 && viewer.socket.bufferedAmount > VIEWER_BUFFER_BYTES) {
				this.detachViewer(terminal, viewer);
				closeViewer(viewer, "slow");
				continue;
			}
			this.#sendBinary(viewer, bytes);
		}
	}

	#sendBinary(viewer: Viewer, bytes: Uint8Array): void {
		if (viewer.socket.readyState !== 1) return;
		viewer.socket.send(bytes, { binary: true });
	}

	#broadcastState(terminal: Terminal): void {
		const frame = {
			type: "state",
			rows: terminal.rows,
			cols: terminal.cols,
			title: terminal.title,
			state: terminal.state,
			viewers: [...terminal.viewers.values()].map((viewer) => ({
				id: viewer.id,
				userId: viewer.userId,
				username: viewer.username,
				clientAddress: viewer.clientAddress,
				attachedAt: viewer.attachedAt,
			})),
		};
		for (const viewer of terminal.viewers.values()) this.#sendJson(viewer.socket, frame);
	}

	#sendJson(socket: WebSocket, value: unknown): void {
		if (socket.readyState === 1) socket.send(JSON.stringify(value));
	}

	// ---- associations ----

	/** Associates one of the terminal's user's sessions; an administrator may associate the user's. */
	async associate(terminal: Terminal, sessionId: string, actor: SessionUser): Promise<void> {
		if (terminal.sessionIds.includes(sessionId)) return;
		const session = await this.#db
			.selectFrom("sessions")
			.select(["id", "owner_user_id"])
			.where("id", "=", sessionId)
			.executeTakeFirst();
		if (!session) throw new TerminalError("session_not_found", "no such session");
		if (session.owner_user_id !== terminal.userId) {
			throw new TerminalError("session_not_owned", "the session belongs to another user");
		}
		const max = this.#settings.current().pty.maxPerSession;
		if (this.#sessionCount(sessionId) >= max) {
			throw new TerminalError("limit_session", `a session may be associated with at most ${max} terminals`);
		}
		terminal.sessionIds.push(sessionId);
		terminal.cursors.set(sessionId, terminal.screen?.logEnd ?? 0);
		this.#audit?.record({
			actor: { type: "user", id: actor.userId, onBehalfOfUserId: actor.userId },
			action: "pty.associated",
			target: { type: "pty", id: terminal.id },
			detail: { session: sessionId },
		});
	}

	async unassociate(terminal: Terminal, sessionId: string, actor: SessionUser): Promise<void> {
		const index = terminal.sessionIds.indexOf(sessionId);
		if (index === -1) return;
		terminal.sessionIds.splice(index, 1);
		terminal.cursors.delete(sessionId);
		this.#audit?.record({
			actor: { type: "user", id: actor.userId, onBehalfOfUserId: actor.userId },
			action: "pty.unassociated",
			target: { type: "pty", id: terminal.id },
			detail: { session: sessionId },
		});
	}

	// ---- closing ----

	/** Closes one terminal with a reason; idempotent. */
	async close(terminal: Terminal, reason: TerminalCloseReason): Promise<void> {
		if (this.#terminals.get(terminal.id) !== terminal) return;
		this.#closeTerminal(terminal, reason, { send: true, audit: true });
	}

	/**
	 * Removes a terminal and tells the node to drop it. `pty.close` is best effort: a node that is
	 * already gone has nothing left to close, and crha drops terminals it does not know as a success.
	 */
	#closeTerminal(terminal: Terminal, reason: TerminalCloseReason, options: { send: boolean; audit: boolean }): void {
		if (terminal.closing) return;
		terminal.closing = true;
		if (this.#terminals.get(terminal.id) === terminal) this.#terminals.delete(terminal.id);
		const retention = this.#retention.get(terminal.id);
		if (retention) clearTimeout(retention);
		this.#retention.delete(terminal.id);
		for (const viewer of terminal.viewers.values()) closeViewer(viewer, reason);
		terminal.viewers.clear();
		for (const cancel of terminal.watches.values()) cancel();
		terminal.watches.clear();
		if (terminal.openWaiter !== null) {
			const error = new TerminalError("closed", `the terminal was closed (${reason})`);
			terminal.openError = error;
			terminal.openWaiter.reject(error);
			terminal.openWaiter = null;
		}
		this.#finishApproval(terminal, { decision: "rejected", reason: `the terminal closed (${reason})` });
		this.#notifyAuthorization(terminal);
		terminal.connection?.close();
		terminal.connection = null;
		terminal.screen?.dispose();
		terminal.screen = null;
		if (options.send) {
			void linkRequest(this.#cluster, terminal.nodeId, "pty.close", {
				ptyId: terminal.id,
				reason,
			});
		}
		if (options.audit) {
			this.#audit?.record({
				actor: this.#actorOf(terminal),
				action: "pty.closed",
				target: { type: "pty", id: terminal.id },
				detail: {
					reason,
					exit_code: terminal.exitCode,
					duration_ms: Date.now() - terminal.openedAt,
					bytes_in: terminal.bytesIn,
					bytes_out: terminal.bytesOut,
				},
			});
		}
	}

	/** Closes every terminal with a reason (subsystem off, node removed). */
	closeAll(reason: TerminalCloseReason, nodeId?: string): void {
		for (const terminal of [...this.#terminals.values()]) {
			if (nodeId !== undefined && terminal.nodeId !== nodeId) continue;
			this.#closeTerminal(terminal, reason, { send: true, audit: true });
		}
	}

	// ---- rules and approvals ----

	/**
	 * Waits for the user's answer to a terminal rule approval. Auto Review, when it is enabled for the
	 * chain, is run by the tool layer before this is called.
	 */
	async awaitRuleApproval(
		terminal: Terminal,
		request: RuleApprovalRequest,
		signal?: AbortSignal,
	): Promise<"approve" | "reject"> {
		if (terminal.approval !== null)
			throw new TerminalError("approval_pending", "another approval waits on this terminal");
		const alwaysAllow = await alwaysAllowCandidates(this.#db, request);
		return new Promise<"approve" | "reject">((resolve) => {
			const onAbort = () => {
				this.#finishApproval(terminal, { decision: "rejected", reason: "the session stopped" });
			};
			const approval = pendingApproval(request, alwaysAllow, (outcome) => {
				signal?.removeEventListener("abort", onAbort);
				if (terminal.approval === approval) terminal.approval = null;
				resolve(outcome.decision === "approved" ? "approve" : "reject");
			});
			terminal.approval = approval;
			terminal.approvalDecision = null;
			this.#onApprovalChanged(approval.sessionId);
			if (signal?.aborted) onAbort();
			else signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	/**
	 * The owner's decision on a terminal rule approval, through the same body every other approval takes
	 * (doc/design/access-control.md "Approvals"): approve or reject with a reason, and optionally append one
	 * of the server-built "always allow" candidates to the root.
	 */
	async decideApproval(terminal: Terminal, user: SessionUser, body: ApprovalBody): Promise<void> {
		const approval = terminal.approval as PendingApproval | null;
		if (!approval) throw new TerminalError("not_waiting", "the request is no longer waiting for approval");
		// An approval belongs to the terminal's user, like every other approval belongs to its owner.
		if (terminal.userId !== user.userId) throw new TerminalError("not_found", "no such approval");
		const decision = body.decision === "approve" ? "approved" : "rejected";
		if (body.always !== undefined && decision !== "approved") {
			throw new TerminalError("invalid_rule", 'an "always" rule needs an approval');
		}
		const reason =
			typeof body.reason === "string" && body.reason.trim() ? body.reason.trim().slice(0, 1000) : undefined;
		let rule: Rule | undefined;
		if (decision === "approved" && body.always !== undefined) {
			const [parsed] = await parseRulesForWrite(this.#db, await defaultOrgId(this.#db), [body.always]);
			if (parsed?.action !== "allow") throw new TerminalError("invalid_rule", 'an "always" rule must be an allow rule');
			const lifts = await alwaysRuleLifts(
				this.#db,
				approval.chain,
				approvalOperation(approval),
				approval.privileged,
				[terminal.nodeId],
				parsed,
			);
			if (!lifts) {
				throw new TerminalError(
					"invalid_rule",
					'this "always allow" rule would not end the approval: the restriction comes from a lower level of the ' +
						"rule chain or a stricter rule, which the rule on the root cannot lift",
				);
			}
			rule = parsed;
		}
		this.#finishApproval(terminal, { decision, ...(reason ? { reason } : {}), by: { type: "user", id: user.userId } });
		this.#audit?.record({
			actor: { type: "user", id: user.userId, onBehalfOfUserId: user.userId },
			action: "pty.approval",
			target: { type: "pty", id: terminal.id },
			detail: { decision, method: approval.method, ...(reason ? { reason } : {}) },
		});
		if (rule) {
			const root = approval.chain[0] as RuleRef;
			await appendRule(this.#db, root, rule);
			this.#audit?.record({
				actor: { type: "user", id: user.userId, onBehalfOfUserId: user.userId },
				action: "rules.changed",
				target: root,
				detail: { appended: rule },
			});
		}
	}

	/**
	 * Rejects the pending rule approvals of these sessions (a stop, or a run that ended): nothing will
	 * answer them, and the waiting tool returns a rejection like any other approval (doc/design/agent-runtime.md
	 * "Session state").
	 */
	rejectApprovals(sessionIds: readonly string[], reason: string): void {
		const sessions = new Set(sessionIds);
		for (const terminal of [...this.#terminals.values()]) {
			const approval = terminal.approval;
			if (!approval || !sessions.has(approval.sessionId)) continue;
			this.#finishApproval(terminal, { decision: "rejected", reason, by: { type: "system", id: "session" } });
		}
	}

	/** The terminals with a rule approval waiting, for the approvals API and the chat channels. */
	pendingApprovals(): { terminal: Terminal; approval: TerminalApproval }[] {
		const waiting: { terminal: Terminal; approval: TerminalApproval }[] = [];
		for (const terminal of this.#terminals.values()) {
			if (terminal.approval !== null) waiting.push({ terminal, approval: terminal.approval });
		}
		return waiting;
	}

	/**
	 * The agent-created privileged terminals waiting for their owner's signature (doc/design/pty.md
	 * "Approvals"). A rule approval still holds the open, and a person-opened terminal has no session to
	 * dock into: neither is a signature wait yet.
	 */
	pendingAuthorizations(): Terminal[] {
		const waiting: Terminal[] = [];
		for (const terminal of this.#terminals.values()) {
			if (
				terminal.authorization !== null &&
				terminal.state === "opening" &&
				terminal.approval === null &&
				terminal.createdBySessionId !== null
			) {
				waiting.push(terminal);
			}
		}
		return waiting;
	}

	/** Whether a session's tool call waits for a terminal rule approval. */
	hasPendingApproval(sessionId: string): boolean {
		for (const terminal of this.#terminals.values()) {
			if (terminal.approval?.sessionId === sessionId) return true;
		}
		return false;
	}

	/** Whether a session's tool call waits for its agent-created privileged terminal's signature. */
	hasPendingAuthorization(sessionId: string): boolean {
		for (const terminal of this.#terminals.values()) {
			if (
				terminal.createdBySessionId === sessionId &&
				terminal.authorization !== null &&
				terminal.state === "opening" &&
				terminal.approval === null
			) {
				return true;
			}
		}
		return false;
	}

	/** The sessions with a terminal signature wait waiting, for a batched session-state recompute. */
	pendingAuthorizationSessions(): Set<string> {
		const sessions = new Set<string>();
		for (const terminal of this.#terminals.values()) {
			if (
				terminal.createdBySessionId !== null &&
				terminal.authorization !== null &&
				terminal.state === "opening" &&
				terminal.approval === null
			) {
				sessions.add(terminal.createdBySessionId);
			}
		}
		return sessions;
	}

	/** The sessions with a terminal rule approval waiting, for a batched session-state recompute. */
	pendingApprovalSessions(): Set<string> {
		const sessions = new Set<string>();
		for (const terminal of this.#terminals.values()) {
			if (terminal.approval !== null) sessions.add(terminal.approval.sessionId);
		}
		return sessions;
	}

	/** One terminal's waiting approval, when it is the one the caller named. */
	pendingApprovalOf(terminalId: string): { terminal: Terminal; approval: TerminalApproval } | undefined {
		const terminal = this.#terminals.get(terminalId);
		if (!terminal?.approval) return undefined;
		return { terminal, approval: terminal.approval };
	}

	/** The owner declined to sign an opening privileged terminal: it never opens. */
	rejectAuthorization(terminal: Terminal, reason: string | undefined): void {
		if (terminal.state !== "opening" || terminal.authorization === null) {
			throw new TerminalError("not_waiting", "the terminal is not waiting for an authorization");
		}
		const message = reason?.trim() ? reason.trim().slice(0, 1000) : "the owner declined to sign";
		this.#failOpen(terminal, new TerminalError("authorization_declined", message));
	}

	#finishApproval(
		terminal: Terminal,
		outcome: {
			decision: "approved" | "rejected";
			reason?: string;
			by?: TerminalApprovalDecision["by"];
		},
	): void {
		const approval = terminal.approval;
		if (!approval) return;
		terminal.approval = null;
		terminal.approvalDecision = {
			decision: outcome.decision,
			by: outcome.by ?? { type: "system", id: "system" },
			...(outcome.reason ? { reason: outcome.reason } : {}),
			at: new Date().toISOString(),
		};
		approval.resolve({ decision: outcome.decision, ...(outcome.reason ? { reason: outcome.reason } : {}) });
		this.#onApprovalChanged(approval.sessionId);
	}

	/** Runs Auto Review, then asks the user; the terminal itself supplies the screen. */
	async #ruleOutcome(
		terminal: Terminal,
		request: RuleApprovalRequest,
		review: AgentOpenInput["review"],
		signal?: AbortSignal,
	): Promise<"approve" | "reject"> {
		if (review) {
			const screen = terminal.screen ? (await terminal.screen.screen()).text : "";
			const verdict = await review(request, screen);
			if (verdict === "approve" || verdict === "reject") return verdict;
		}
		return this.awaitRuleApproval(terminal, request, signal);
	}

	// ---- session events ----

	/**
	 * A session was deleted: if it created the terminal, the terminal closes (`session_deleted`);
	 * the association disappears otherwise.
	 */
	sessionDeleted(sessionId: string): void {
		for (const terminal of [...this.#terminals.values()]) {
			if (terminal.createdBySessionId === sessionId) {
				this.#closeTerminal(terminal, "session_deleted", { send: true, audit: true });
				continue;
			}
			const index = terminal.sessionIds.indexOf(sessionId);
			if (index === -1) continue;
			terminal.sessionIds.splice(index, 1);
			terminal.cursors.delete(sessionId);
		}
	}

	// ---- cluster sink ----

	onTrustSummary(nodeId: string): void {
		for (const terminal of [...this.#terminals.values()]) {
			if (terminal.nodeId !== nodeId || terminal.state !== "opening" || !terminal.privileged) continue;
			this.#background("planning a terminal authorization failed", this.#planAndOpen(terminal));
		}
	}

	onAuthorizationSubmitted(userId: string, payload: { taskIds: readonly string[] | null }): void {
		for (const terminal of [...this.#terminals.values()]) {
			if (terminal.state !== "opening" || !terminal.privileged || terminal.userId !== userId) continue;
			if (payload.taskIds !== null && !payload.taskIds.includes(terminal.id)) continue;
			this.#background("planning a terminal authorization failed", this.#planAndOpen(terminal));
		}
	}

	onLinkLost(nodeId: string): void {
		// The terminals stay; only their data connections died with the control connection.
		for (const terminal of this.#terminals.values()) {
			if (terminal.nodeId !== nodeId) continue;
			terminal.connection?.close();
			terminal.connection = null;
		}
	}

	onNodeRemoved(nodeId: string): void {
		this.closeAll("node_removed", nodeId);
	}

	/**
	 * A node's key was revoked (re-enrollment replaced it): its terminals close with `node_removed`, like a
	 * deleted node's (doc/design/pty.md "Lifecycle").
	 */
	nodeRevoked(nodeId: string): void {
		this.closeAll("node_removed", nodeId);
	}

	/**
	 * A user was deleted or disabled: every terminal it owns closes with `user_removed` (doc/design/pty.md
	 * "Lifecycle"), and a waiting approval is rejected with it.
	 */
	userRemoved(userId: string): void {
		for (const terminal of [...this.#terminals.values()]) {
			if (terminal.userId !== userId) continue;
			this.#closeTerminal(terminal, "user_removed", { send: true, audit: true });
		}
	}

	/**
	 * `pty.list`, sent after hello: crhs holds only terminals it opened in this process, so the list is
	 * reconciled against its memory, never adopted (doc/design/pty.md "Reconnect"). A listed terminal
	 * crhs holds continues, and an exit crhs missed is taken from the list; a listed terminal it does
	 * not hold is one it forgot by restarting and is closed `crhs_restarted`; a held terminal of this
	 * node that is absent from the list is gone from crha and closes `crha_restarted`.
	 */
	onPtyList(nodeId: string, statuses: readonly PtyStatus[]): void {
		const seen = new Set<string>();
		for (const status of statuses) {
			seen.add(status.ptyId);
			const existing = this.#terminals.get(status.ptyId);
			if (existing && existing.nodeId === nodeId && !existing.closing) {
				if (status.exited && existing.state !== "exited") this.#markExited(existing, status.exitCode, "exited");
				continue;
			}
			// crhs does not hold it for this node: it was forgotten by a crhs restart, or never
			// existed here. It is dropped on the node; nothing is adopted.
			this.#rejectListed(nodeId, status.ptyId, "crhs_restarted");
		}
		for (const terminal of [...this.#terminals.values()]) {
			if (terminal.nodeId !== nodeId || seen.has(terminal.id) || terminal.closing) continue;
			this.#closeTerminal(terminal, "crha_restarted", { send: false, audit: true });
		}
	}

	/** A listed terminal crhs does not hold is dropped on the node; the audit records why. */
	#rejectListed(nodeId: string, ptyId: string, reason: TerminalCloseReason): void {
		void linkRequest(this.#cluster, nodeId, "pty.close", { ptyId, reason });
		this.#audit?.record({
			actor: { type: "system", id: "cluster" },
			action: "pty.closed",
			target: { type: "pty", id: ptyId },
			detail: { reason },
		});
	}

	/**
	 * How many output bytes crhs has received for a terminal, for a data connection's handshake
	 * (doc/design/pty.md "crha"). Undefined means crhs does not hold the terminal for that node, so
	 * the connection is refused before its handshake completes.
	 */
	ptyConnectionOffset(nodeId: string, ptyId: string): number | undefined {
		const terminal = this.#terminals.get(ptyId);
		if (!terminal || terminal.nodeId !== nodeId || terminal.closing) return undefined;
		return terminal.outputReceived;
	}

	onPtyExited(nodeId: string, exit: { ptyId: string; exitCode: number; reason: string }): void {
		const terminal = this.#terminals.get(exit.ptyId);
		if (!terminal || terminal.nodeId !== nodeId) return;
		this.#markExited(terminal, exit.exitCode, exit.reason === "helper_lost" ? "helper_lost" : "exited");
	}

	#markExited(terminal: Terminal, exitCode: number, reason: "exited" | "helper_lost"): void {
		if (terminal.state === "exited") return;
		terminal.state = "exited";
		terminal.exitCode = exitCode;
		terminal.exitReason = reason;
		terminal.endedAt = Date.now();
		terminal.lastActivityAt = terminal.endedAt;
		terminal.idleSince = null;
		for (const cancel of terminal.watches.values()) cancel();
		terminal.watches.clear();
		for (const viewer of terminal.viewers.values()) {
			this.#sendJson(viewer.socket, { type: "exited", exitCode, reason });
		}
		this.#broadcastState(terminal);
		this.#scheduleRetention(terminal);
	}

	#scheduleRetention(terminal: Terminal): void {
		const existing = this.#retention.get(terminal.id);
		if (existing) clearTimeout(existing);
		const timer = setTimeout(() => this.#maybeRetireExited(terminal), this.#exitedRetentionMs);
		timer.unref();
		this.#retention.set(terminal.id, timer);
	}

	/** An exited terminal goes once five minutes passed and the last viewer detached. */
	#maybeRetireExited(terminal: Terminal): void {
		if (terminal.state !== "exited" || terminal.endedAt === null) return;
		if (terminal.viewers.size > 0) return;
		if (Date.now() - terminal.endedAt < this.#exitedRetentionMs) return;
		this.#closeTerminal(terminal, terminal.exitReason === "helper_lost" ? "helper_lost" : "exited", {
			send: true,
			audit: true,
		});
	}

	/**
	 * Accepts a terminal's data connection. The handshake already carried crhs's output offset and
	 * crha's input offset; the streams continue from exactly there. A replacement connection keeps the
	 * emulator, the log and every watch: nothing is replayed or rebuilt (doc/design/pty.md "crha"). A
	 * stream whose missing bytes a buffer no longer holds ends the terminal `stream_lost`.
	 */
	onDataConnection(
		nodeId: string,
		ws: WebSocket,
		ciphers: TransportCiphers,
		init: { ptyId: string; inputReceived: number },
	): void {
		if (!this.#cluster.terminalNodeLink(nodeId)) {
			try {
				ws.close(1008, "no active control connection");
			} catch {}
			return;
		}
		const terminal = this.#terminals.get(init.ptyId);
		if (!terminal || terminal.nodeId !== nodeId || terminal.closing) {
			try {
				ws.close(1008, "unknown terminal");
			} catch {}
			return;
		}
		const screen = terminal.screen;
		if (!screen) {
			try {
				ws.close(1008, "unknown terminal");
			} catch {}
			return;
		}
		if (init.inputReceived < terminal.inputStart || init.inputReceived > terminal.inputSent) {
			// crha reports input this side can no longer resend: its stream cannot continue. Answer
			// with the abort, then close the terminal locally and on the node.
			this.#abortStream(terminal, ws, ciphers);
			return;
		}
		// A newer connection replaces an older one. The screen, the log, the watches and the cursors
		// stay: both streams continue from their offsets.
		terminal.connection?.close();
		let wire: PtyWire | null = null;
		const connection: TerminalDataConnection = {
			nodeId,
			ptyId: terminal.id,
			close: () => {
				wire?.close("closed");
			},
			send: async (bytes) => {
				if (!wire) throw new Error("terminal data connection closed");
				await wire.send(bytes);
			},
		};
		wire = new PtyWire(ws, ciphers, {
			onData: (bytes) => {
				if (terminal.screen !== screen) return;
				terminal.bytesOut += bytes.length;
				terminal.outputReceived += bytes.length;
				terminal.lastActivityAt = Date.now();
				screen.write(bytes);
				this.#broadcastOutput(terminal, bytes);
				for (const check of [...terminal.watches.values()]) check();
				// The parser sees a BEL asynchronously: the watches check again once the bytes are parsed.
				void screen.whenIdle().then(() => {
					for (const check of [...terminal.watches.values()]) check();
				});
			},
			onEnd: () => {
				// crha ends the stream after the terminal's last output; pty.exited carries the exit code.
			},
			onAbort: (code) => {
				// crha could not continue the output stream: the terminal is closed, never rebuilt.
				if (code === PTY_STREAM_LOST) {
					this.#closeTerminal(terminal, "stream_lost", { send: true, audit: true });
				}
			},
			onClose: () => {
				if (terminal.connection === connection) terminal.connection = null;
			},
		});
		// Resend exactly the input crha did not report, before any new input can be queued. An exited
		// terminal takes no more input: its stream only has output left to deliver.
		if (terminal.state !== "exited" && init.inputReceived < terminal.inputSent) {
			const missing = terminal.inputBuffer.subarray(init.inputReceived - terminal.inputStart);
			if (missing.length > 0) {
				void wire.send(missing).catch(() => {
					// A socket that died mid-resend surfaces through onClose; the next connection resends.
				});
			}
		}
		if (!wire.closed) terminal.connection = connection;
	}

	/** Answers a stream that cannot continue with the abort frame, then closes the terminal. */
	#abortStream(terminal: Terminal, ws: WebSocket, ciphers: TransportCiphers): void {
		const wire = new PtyWire(ws, ciphers, {
			onData: () => {},
			onEnd: () => {},
			onAbort: () => {},
			onClose: () => {},
		});
		void wire.abort(PTY_STREAM_LOST).finally(() => {
			this.#closeTerminal(terminal, "stream_lost", { send: true, audit: true });
		});
	}

	// ---- idle ----

	async #sweepIdle(): Promise<void> {
		if (this.#closed) return;
		const now = Date.now();
		for (const terminal of [...this.#terminals.values()]) {
			if (terminal.state !== "running") continue;
			const timeout = terminal.idleTimeoutMs;
			if (timeout === null) continue;
			const idle = terminal.viewers.size === 0 && terminal.watches.size === 0 && (await this.#sessionsIdle(terminal));
			if (!idle) {
				terminal.idleSince = null;
				continue;
			}
			if (terminal.idleSince === null) {
				terminal.idleSince = now;
				continue;
			}
			if (now - terminal.idleSince < timeout) continue;
			await this.close(terminal, "idle");
		}
	}

	/** Whether every session that created or is associated with the terminal is idle. */
	async #sessionsIdle(terminal: Terminal): Promise<boolean> {
		const ids = [
			...(terminal.createdBySessionId === null ? [] : [terminal.createdBySessionId]),
			...terminal.sessionIds,
		];
		for (const id of ids) {
			// A deleted session is no reason to keep a terminal alive.
			const state = await this.#sessionState(id);
			if (state !== undefined && state !== "idle") return false;
		}
		return true;
	}

	// ---- helpers ----

	#requireEnabled(): void {
		if (!this.enabled) throw new TerminalError("disabled", "the terminal subsystem is turned off");
	}

	#background(what: string, work: Promise<unknown>): void {
		const tracked: Promise<void> = work
			.then(() => {})
			.catch((err: unknown) => console.error(`${what}:`, err))
			.then(() => {
				this.#pending.delete(tracked);
			});
		this.#pending.add(tracked);
	}

	async #nodeName(nodeId: string): Promise<string | null> {
		const cached = this.#nodeNames.get(nodeId);
		if (cached !== undefined) return cached;
		const row = await this.#db.selectFrom("nodes").select("name").where("id", "=", nodeId).executeTakeFirst();
		if (row) this.#nodeNames.set(nodeId, row.name);
		return row?.name ?? null;
	}

	async #username(userId: string): Promise<string | null> {
		if (this.#usernames.has(userId)) return this.#usernames.get(userId) ?? null;
		const row = await this.#db.selectFrom("users").select("username").where("id", "=", userId).executeTakeFirst();
		this.#usernames.set(userId, row?.username ?? null);
		return row?.username ?? null;
	}
}

// ---- module helpers ----

/**
 * Records input bytes handed to the node and keeps the most recent ones, so a connection that says
 * crha received fewer can resend exactly the rest (doc/design/pty.md "crha").
 */
function recordInput(terminal: Terminal, bytes: Uint8Array): void {
	terminal.inputSent += bytes.length;
	if (bytes.length >= INPUT_BUFFER_BYTES) {
		terminal.inputBuffer = bytes.slice(bytes.length - INPUT_BUFFER_BYTES);
		terminal.inputStart = terminal.inputSent - terminal.inputBuffer.length;
		return;
	}
	let buffer = new Uint8Array(terminal.inputBuffer.length + bytes.length);
	buffer.set(terminal.inputBuffer);
	buffer.set(bytes, terminal.inputBuffer.length);
	if (buffer.length > INPUT_BUFFER_BYTES) {
		terminal.inputStart += buffer.length - INPUT_BUFFER_BYTES;
		buffer = buffer.slice(buffer.length - INPUT_BUFFER_BYTES);
	}
	terminal.inputBuffer = buffer;
}

function closeViewer(viewer: Viewer, reason: string): void {
	try {
		if (viewer.socket.readyState === 1) {
			viewer.socket.send(JSON.stringify({ type: "closed", reason }), () => viewer.socket.close(1000, "closed"));
		} else {
			viewer.socket.terminate();
		}
	} catch {
		try {
			viewer.socket.terminate();
		} catch {}
	}
}

function remoteCode(err: unknown): string | null {
	if (
		typeof err === "object" &&
		err !== null &&
		"code" in err &&
		typeof (err as { code?: unknown }).code === "string"
	) {
		return (err as { code: string }).code;
	}
	return null;
}

function isTimeout(err: unknown): boolean {
	return typeof err === "object" && err !== null && (err as { name?: unknown }).name === "RequestTimeoutError";
}

function isConnectionError(err: unknown): boolean {
	return typeof err === "object" && err !== null && (err as { name?: unknown }).name === "ConnectionError";
}

function mapOpenErrorCode(code: string | null): string {
	if (code === null) return "node_offline";
	if (
		code === "busy" ||
		code === "invalid_spec" ||
		code === "privileged_unsupported" ||
		code === "privileged_unavailable"
	) {
		return code;
	}
	return "open_failed";
}

function openErrorMessage(code: string | null, err: unknown): string {
	if (code === "busy") return "the node holds too many terminals";
	if (code === "privileged_unsupported")
		return "the node's privileged mode does not support terminals; upgrade its crha";
	if (code === "privileged_unavailable") return "the node has no privileged channel for the terminal";
	return err instanceof Error ? err.message : String(err);
}

/** The node's local window identity from its stored trust report; null while none is open. */
function trustWindowOf(node: NodeRow): number | null {
	const report = parseTrustReport(node.trust_report);
	return report?.kind === "ok" ? windowIdentity(report.summary) : null;
}

/** Sends a terminal command to a node, ignoring a missing link. */
async function linkRequest(
	cluster: Cluster,
	nodeId: string,
	command: "pty.close" | "pty.resize",
	body: { ptyId: string; reason?: string; rows?: number; cols?: number },
): Promise<void> {
	const link = cluster.terminalNodeLink(nodeId);
	if (!link) return;
	try {
		if (command === "pty.close") {
			await link.peer.request("pty.close", { ptyId: body.ptyId, reason: body.reason ?? "manual" });
		} else {
			await link.peer.request("pty.resize", { ptyId: body.ptyId, rows: body.rows ?? 0, cols: body.cols ?? 0 });
		}
	} catch {
		// The node is gone or refused; the terminal copy is settled locally anyway.
	}
}
