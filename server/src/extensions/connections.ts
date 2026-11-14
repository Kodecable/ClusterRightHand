import { AsyncLocalStorage } from "node:async_hooks";
import type { McpToolAnnotations as ApiMcpToolAnnotations, McpServerStatus } from "@crh/api";
import {
	Client,
	type FetchLike,
	ProtocolError,
	StreamableHTTPClientTransport,
	type Tool,
} from "@modelcontextprotocol/client";
import type { MasterKey } from "../keys/master-key.ts";
import type { Db } from "../storage/db.ts";
import { errorText } from "../util/errors.ts";
import { CRH_VERSION } from "../version.ts";
import { getMcpServerRow, type McpServerRow, mcpServerConfig } from "./servers.ts";

/**
 * The MCP client connections behind extensions (doc/design/extensions.md "Connections"): one connection per
 * server for all sessions, opened when it is first needed, with the tool list cached and refreshed on
 * `notifications/tools/list_changed`, on reconnect and when an administrator asks. A failed connection is
 * retried with exponential backoff; while it is unavailable the last error is kept and its last tool list
 * stays searchable.
 *
 * The module holds no pi types: the agent layer installs the direct tools when a list changes.
 */

/** One tool of a server, in the shape the agent layer and the API need. */
export interface McpTool {
	name: string;
	title: string | null;
	description: string | null;
	inputSchema: Record<string, unknown>;
	annotations: ApiMcpToolAnnotations | null;
}

/** The CRH identity sent to a server for one call; the identity headers are not authentication. */
export interface McpIdentity {
	username: string;
	sessionId: string;
}

/** The call succeeded but a connection-level failure makes its outcome unknown. */
export class McpCallLostError extends Error {}

/** The call never reached the server: it is unavailable right now. */
export class McpUnavailableError extends Error {}

/** The server answered with a protocol error: the call did not run. */
export class McpToolError extends Error {}

/** How a server waits for its next automatic attempt (diagnostics and the settings page). */
export interface McpConnectionOptions {
	db: Db;
	masterKey: MasterKey;
	/** In-process fetch for tests; the global fetch otherwise. */
	fetch?: FetchLike;
	/** Called when a server's tool list changes, so the agent layer can reinstall its direct tools. */
	onToolsChanged?: (server: McpServerRow, tools: readonly McpTool[]) => void;
	/** Called when a server's connection state changes, for diagnostics. */
	onStatusChanged?: (name: string, status: McpServerStatus) => void;
	/** Backoff base in milliseconds; tests shorten it. */
	backoffBaseMs?: number;
	/** Backoff cap in milliseconds (5 minutes by default). */
	backoffMaxMs?: number;
	/** How long an on-demand connection attempt may take (10 s by default); tests shorten it. */
	connectTimeoutMs?: number;
	/** The clock the failure window reads; tests inject one. */
	now?: () => number;
	/** Skill/version reported to the server. */
	version?: string;
}

interface ServerState {
	row: McpServerRow | null;
	status: McpServerStatus["state"];
	lastError: string | null;
	nextAttemptAt: string | null;
	attempt: number;
	client?: Client;
	transport?: StreamableHTTPClientTransport;
	tools: McpTool[];
	instructions: string | null;
	retryTimer?: ReturnType<typeof setTimeout>;
	connecting?: Promise<void>;
	/** When the last connection attempt failed; a call in the next window tries no further. */
	lastFailureAt: number | null;
}

const DEFAULT_BACKOFF_BASE_MS = 1000;
const DEFAULT_BACKOFF_MAX_MS = 5 * 60_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
/**
 * A call on an unavailable server gives up at once when a connection attempt failed within this window
 * (doc/design/extensions.md "Connections"): one hung or looping model cannot hammer the server.
 */
const FAILED_ATTEMPT_WINDOW_MS = 10_000;
/** The jitter band around a backoff delay: 80–120% of the exponential value. */
const JITTER_LOW = 0.8;
const JITTER_SPAN = 0.4;

function toTool(tool: Tool): McpTool {
	const annotations = (tool.annotations ?? null) as ApiMcpToolAnnotations | null;
	return {
		name: tool.name,
		title: tool.title ?? annotations?.title ?? null,
		description: tool.description ?? null,
		inputSchema:
			typeof tool.inputSchema === "object" && tool.inputSchema !== null
				? (tool.inputSchema as Record<string, unknown>)
				: { type: "object", properties: {} },
		annotations,
	};
}

export class McpConnections {
	readonly #options: McpConnectionOptions;
	readonly #states = new Map<string, ServerState>();
	readonly #identity = new AsyncLocalStorage<McpIdentity>();
	readonly #fetch: FetchLike;
	#closing = false;

	constructor(options: McpConnectionOptions) {
		this.#options = options;
		this.#fetch = options.fetch ?? fetch;
	}

	/** Lets the agent layer install the direct tools after the connections exist (runtime startup). */
	setToolsChangedHandler(handler: (server: McpServerRow, tools: readonly McpTool[]) => void): void {
		this.#options.onToolsChanged = handler;
	}

	#state(name: string): ServerState {
		let state = this.#states.get(name);
		if (!state) {
			state = {
				row: null,
				status: "unknown",
				lastError: null,
				nextAttemptAt: null,
				attempt: 0,
				tools: [],
				instructions: null,
				lastFailureAt: null,
			};
			this.#states.set(name, state);
		}
		return state;
	}

	#statusOf(state: ServerState): McpServerStatus {
		return {
			state: state.status,
			lastError: state.lastError,
			nextAttemptAt: state.nextAttemptAt,
			toolCount: state.tools.length,
		};
	}

	/** The status last known in this process; a server never connected here reports `unknown`. */
	status(name: string): McpServerStatus {
		return this.#statusOf(this.#state(name));
	}

	statuses(names: readonly string[]): Map<string, McpServerStatus> {
		return new Map(names.map((name) => [name, this.status(name)]));
	}

	/** The tool list last listed for a server; empty before the first successful connection. */
	tools(name: string): readonly McpTool[] {
		return this.#state(name).tools;
	}

	instructions(name: string): string | null {
		return this.#state(name).instructions;
	}

	#setStatus(state: ServerState, status: McpServerStatus["state"], error: string | null = null): void {
		state.status = status;
		state.lastError = error;
		const name = state.row?.name;
		if (name !== undefined) this.#options.onStatusChanged?.(name, this.#statusOf(state));
	}

	/** The delay before attempt number `attempt` (1-based): 1 s doubling with jitter, capped at 5 minutes. */
	#backoffDelay(attempt: number): number {
		const base = this.#options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
		const max = this.#options.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS;
		const exponential = Math.min(base * 2 ** Math.max(0, attempt - 1), max);
		return Math.round(exponential * (JITTER_LOW + Math.random() * JITTER_SPAN));
	}

	#clearRetry(state: ServerState): void {
		if (state.retryTimer !== undefined) clearTimeout(state.retryTimer);
		state.retryTimer = undefined;
		state.nextAttemptAt = null;
	}

	#now(): number {
		return this.#options.now ? this.#options.now() : Date.now();
	}

	/** Schedules the next automatic attempt; an administrator's reconnect, or one whose call failed, discards it. */
	#scheduleRetry(name: string, state: ServerState): void {
		this.#clearRetry(state);
		if (this.#closing) return;
		const delay = this.#backoffDelay(state.attempt + 1);
		state.nextAttemptAt = new Date(this.#now() + delay).toISOString();
		state.retryTimer = setTimeout(() => {
			state.retryTimer = undefined;
			state.nextAttemptAt = null;
			void this.#connect(name, state).catch(() => undefined);
		}, delay);
		// A pending retry must not keep the process alive by itself.
		state.retryTimer.unref?.();
	}

	/**
	 * Drops a server's connection: deleted by an administrator (the whole state goes), or reset for a
	 * configuration change, where the last known tool list stays so a direct tool is not lost until the next
	 * connection. A config change does not mean the tools changed.
	 */
	async invalidate(name: string, options: { keepTools?: boolean } = {}): Promise<void> {
		const state = this.#states.get(name);
		if (!state) return;
		this.#clearRetry(state);
		await this.#closeState(state);
		if (!options.keepTools) {
			this.#states.delete(name);
			return;
		}
		state.attempt = 0;
		state.lastFailureAt = null;
		state.instructions = null;
		this.#setStatus(state, "unknown");
	}

	/** Closes one state's client; a close during a connection attempt is joined. */
	async #closeState(state: ServerState): Promise<void> {
		const connecting = state.connecting;
		if (connecting) await connecting.catch(() => undefined);
		const client = state.client;
		state.client = undefined;
		state.transport = undefined;
		if (client) await client.close().catch(() => undefined);
	}

	/** The server's row, read fresh at every connection so an edited URL or header is used at once. */
	async #freshRow(name: string): Promise<McpServerRow | undefined> {
		return getMcpServerRow(this.#options.db, name);
	}

	/**
	 * Connects one server now, sharing an attempt in flight. Throws on failure; the state then holds the
	 * error and the retry schedule. `keepSchedule` is an on-demand attempt for a waiting call: it leaves a
	 * scheduled retry in place, so a failure moves the backoff schedule on instead of restarting it.
	 */
	async #connect(
		name: string,
		state: ServerState,
		options: { keepSchedule?: boolean; timeoutMs?: number } = {},
	): Promise<void> {
		if (this.#closing) throw new McpUnavailableError("crhs is shutting down");
		if (state.connecting) return state.connecting;
		const attempt = (async () => {
			if (!options.keepSchedule) this.#clearRetry(state);
			this.#setStatus(state, "connecting");
			// Close a previous client first: reconnect and an edited configuration both start from scratch.
			const previous = state.client;
			state.client = undefined;
			state.transport = undefined;
			if (previous) await previous.close().catch(() => undefined);
			const row = await this.#freshRow(name);
			if (!row) {
				this.#setStatus(state, "unavailable", "no such MCP server");
				throw new McpUnavailableError("no such MCP server");
			}
			state.row = row;
			const config = await mcpServerConfig(this.#options.db, this.#options.masterKey, row);
			const identity = this.#identity;
			const baseFetch = this.#fetch;
			const fetchWithIdentity: FetchLike = async (input, init) => {
				const who = identity.getStore();
				if (!who) return baseFetch(input, init);
				const headers = new Headers(init?.headers);
				if (config.identityHeaders.username) headers.set(config.identityHeaders.username, who.username);
				if (config.identityHeaders.session) headers.set(config.identityHeaders.session, who.sessionId);
				return baseFetch(input, { ...init, headers });
			};
			const client = new Client(
				{ name: "clusterrighthand", version: this.#options.version ?? CRH_VERSION },
				{
					listChanged: {
						tools: {
							onChanged: (error, tools) => {
								if (error || !tools) return;
								this.#setTools(state, tools).catch((err: unknown) => {
									console.error(`mcp: refreshing the tool list of ${name} failed:`, errorText(err));
								});
							},
						},
					},
				},
			);
			const transport = new StreamableHTTPClientTransport(new URL(config.url), {
				requestInit: { headers: config.headers },
				fetch: fetchWithIdentity,
				// crhs owns the backoff; the transport must not retry the event stream behind its back.
				reconnectionOptions: {
					initialReconnectionDelay: 1000,
					maxReconnectionDelay: 300_000,
					reconnectionDelayGrowFactor: 2,
					maxRetries: 0,
				},
			});
			state.client = client;
			state.transport = transport;
			try {
				await this.#connectClient(
					name,
					client,
					transport,
					options.timeoutMs ?? this.#options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
				);
				const result = await client.listTools();
				await this.#setTools(state, result.tools);
				state.instructions = client.getInstructions() ?? null;
				state.attempt = 0;
				state.lastFailureAt = null;
				// A successful attempt resets the backoff, a scheduled retry included.
				this.#clearRetry(state);
				this.#setStatus(state, "ready");
				// The connection dropping later is a failure like a refused one: retry with backoff.
				transport.onclose = () => {
					if (this.#closing || state.client !== client) return;
					state.client = undefined;
					state.transport = undefined;
					state.attempt += 1;
					this.#setStatus(state, "unavailable", "the connection closed");
					this.#scheduleRetry(name, state);
				};
			} catch (err) {
				state.client = undefined;
				state.transport = undefined;
				await client.close().catch(() => undefined);
				state.attempt += 1;
				state.lastFailureAt = this.#now();
				this.#setStatus(state, "unavailable", errorText(err));
				// An on-demand attempt with a retry still scheduled leaves that schedule alone; otherwise
				// this failure schedules the next one (scheduled attempt, administrator, first use).
				if (!(options.keepSchedule === true && state.retryTimer !== undefined)) this.#scheduleRetry(name, state);
				throw new McpUnavailableError(errorText(err));
			}
		})();
		state.connecting = attempt;
		try {
			await attempt;
		} finally {
			if (state.connecting === attempt) state.connecting = undefined;
		}
	}

	/** Connects with a bound: a server that accepts the request but never completes cannot hold a call. */
	async #connectClient(
		name: string,
		client: Client,
		transport: StreamableHTTPClientTransport,
		timeoutMs: number,
	): Promise<void> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				client.connect(transport),
				new Promise<never>((_resolve, reject) => {
					timer = setTimeout(
						() => reject(new McpUnavailableError(`connecting to ${name} timed out after ${timeoutMs / 1000} s`)),
						timeoutMs,
					);
					timer.unref?.();
				}),
			]);
		} finally {
			if (timer !== undefined) clearTimeout(timer);
		}
	}

	async #setTools(state: ServerState, tools: readonly Tool[]): Promise<void> {
		state.tools = tools.map(toTool);
		// Read the row again: the administrator may have flipped a flag since this connection was opened.
		if (state.row) state.row = (await this.#freshRow(state.row.name)) ?? state.row;
		if (state.row) {
			this.#options.onToolsChanged?.(state.row, state.tools);
			this.#options.onStatusChanged?.(state.row.name, this.#statusOf(state));
		}
	}

	/**
	 * Makes sure a server is connected. `immediate` (a call, an administrator's reconnect) tries now
	 * instead of waiting for a scheduled retry; without one a server in backoff stays unavailable.
	 */
	async ensureConnected(name: string, options: { immediate?: boolean } = {}): Promise<ServerState> {
		const state = this.#state(name);
		if (state.status === "ready" && state.client) return state;
		// A connection attempt in flight is shared, whichever path started it.
		if (state.connecting) {
			await state.connecting;
			return state;
		}
		if (!options.immediate) {
			if (state.status === "unavailable") throw new McpUnavailableError(state.lastError ?? "the server is unavailable");
			await this.#connect(name, state);
			return state;
		}
		// A call right after a failed attempt fails at once instead of hammering the server; the scheduled
		// retry is the next try.
		if (state.lastFailureAt !== null && this.#now() - state.lastFailureAt < FAILED_ATTEMPT_WINDOW_MS) {
			throw new McpUnavailableError(state.lastError ?? "the server is unavailable");
		}
		await this.#connect(name, state, { keepSchedule: true });
		return state;
	}

	/** An administrator asked: connect now and reload the tools, even when it was ready. */
	async reconnect(name: string): Promise<McpServerStatus> {
		const state = this.#state(name);
		this.#clearRetry(state);
		await this.#closeState(state);
		state.status = "unknown";
		state.attempt = 0;
		try {
			await this.#connect(name, state);
		} catch {
			// The state carries the error and its retry.
		}
		return this.#statusOf(state);
	}

	/** Reloads the tool list of a connected server (the settings page's "view tools" also uses this). */
	async refreshTools(name: string): Promise<readonly McpTool[]> {
		const state = this.#state(name);
		if (state.status !== "ready" || !state.client) {
			await this.ensureConnected(name, { immediate: true });
		}
		const client = this.#state(name).client;
		if (!client) throw new McpUnavailableError("the server is unavailable");
		const result = await client.listTools({}, { cacheMode: "refresh" });
		await this.#setTools(state, result.tools);
		return state.tools;
	}

	/** The tool's annotations from the last listing, if it is still listed. */
	tool(name: string, toolName: string): McpTool | undefined {
		return this.#states.get(name)?.tools.find((candidate) => candidate.name === toolName);
	}

	/**
	 * Calls a tool with the per-server timeout. The identity headers carry the calling user and session.
	 * A timeout or an abort aborts the request, which the Streamable HTTP transport turns into an MCP
	 * cancellation; a connection failure after the request started has an unknown outcome.
	 */
	async callTool(
		name: string,
		toolName: string,
		args: Record<string, unknown>,
		options: { signal?: AbortSignal; identity?: McpIdentity; timeoutMs?: number } = {},
	): Promise<unknown> {
		const state = await this.ensureConnected(name, { immediate: true });
		const client = state.client;
		if (!client) throw new McpUnavailableError("the server is unavailable");
		const timeoutMs = options.timeoutMs ?? state.row?.timeout_ms ?? 300_000;
		const controller = new AbortController();
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, timeoutMs);
		timer.unref?.();
		const onAbort = () => controller.abort();
		if (options.signal?.aborted) controller.abort();
		else options.signal?.addEventListener("abort", onAbort, { once: true });
		const run = async (): Promise<unknown> => {
			try {
				return await client.callTool({ name: toolName, arguments: args }, { signal: controller.signal });
			} catch (err) {
				if (timedOut) throw new McpCallLostError(`the call timed out after ${timeoutMs / 1000} s`);
				if (options.signal?.aborted) throw new McpCallLostError("the call was aborted");
				if (err instanceof ProtocolError) throw new McpToolError(errorText(err));
				// The request did not complete normally: its outcome is unknown, and the server is no longer
				// trusted to be connected.
				if (state.client === client) {
					state.client = undefined;
					state.transport = undefined;
					state.attempt += 1;
					state.lastFailureAt = this.#now();
					this.#setStatus(state, "unavailable", errorText(err));
					this.#scheduleRetry(name, state);
				}
				throw new McpCallLostError(errorText(err));
			} finally {
				clearTimeout(timer);
				options.signal?.removeEventListener("abort", onAbort);
			}
		};
		return options.identity ? this.#identity.run(options.identity, run) : run();
	}

	/** Closes every connection and timer; a later call reports shutdown. */
	async close(): Promise<void> {
		this.#closing = true;
		for (const state of this.#states.values()) {
			this.#clearRetry(state);
			await this.#closeState(state);
		}
		this.#states.clear();
	}
}
