import type {
	ExtensionAvailability,
	ExtensionKind,
	ExtensionState,
	ExtensionStatus,
	ExtensionToolAnnotations,
	Operation,
} from "@crh/api";
import type { Db } from "../storage/db.ts";

/**
 * What every extension looks like to sessions (doc/design/extensions.md): an MCP server an administrator
 * connected and a built-in of crhs differ in how they are configured, but a session sees the same fields,
 * finds their tools the same way and calls them the same way. The adapters in `registry.ts` implement it;
 * nothing session-facing knows which kind it holds.
 */

/** One tool of an extension, in the shape the agent layer and the API need. */
export interface ExtensionTool {
	name: string;
	title: string | null;
	description: string | null;
	inputSchema: Record<string, unknown>;
	annotations: ExtensionToolAnnotations | null;
	/**
	 * The extension's `tools_rev` at which this tool's definition last changed (doc/design/extensions.md
	 * "MCP connections"); absent for a built-in extension, whose tools change only with crhs.
	 */
	rev?: number;
}

/** The CRH identity sent to an MCP extension for one call; the identity headers are not authentication. */
export interface ExtensionIdentity {
	username: string;
	sessionId: string;
}

/** What a call may pass down to the extension. */
export interface ExtensionCallContext {
	signal?: AbortSignal;
	identity?: ExtensionIdentity;
	/**
	 * What a built-in extension may use while it runs inside crhs (step 2: the documentation tree and the
	 * app's router). An MCP extension ignores it.
	 */
	builtin?: {
		db: Db;
		actor: { type: string; id: string; onBehalfOfUserId: string };
	};
	/** A built-in extension's settings, secrets decrypted and defaults applied; set by the registry. */
	config?: Readonly<Record<string, string | number | boolean>>;
}

/** One extension as the session sees it: its configuration, its state and how to call it. */
export interface Extension {
	readonly name: string;
	readonly kind: ExtensionKind;
	readonly description: string | null;
	readonly enabled: boolean;
	readonly listDirectly: boolean;
	readonly availability: ExtensionAvailability;
	/** The state of the last refresh and the connection; a built-in extension is always `ready`. */
	status(): ExtensionStatus;
	/** The tool list last known for this extension; empty before the first listing. */
	tools(): readonly ExtensionTool[];
	/**
	 * Makes sure a tool list is known before a search: an MCP extension never listed yet connects once; one
	 * with a cached list does not connect. A no-op for a built-in extension.
	 */
	ensureAvailable(): Promise<void>;
	/**
	 * Gets an MCP extension ready for a call: connects at once (or fails, see the failure window) and brings
	 * the tool list up to date, so the call is judged on the server's current definitions. A no-op for a
	 * built-in extension.
	 */
	prepareCall(): Promise<void>;
	/** Reloads the tool list where the extension supports it. */
	refreshTools(): Promise<readonly ExtensionTool[]>;
	/** Calls one tool; a connection-level loss of an MCP call is an `ExtensionCallLostError`. */
	call(tool: string, args: Record<string, unknown>, context: ExtensionCallContext): Promise<unknown>;
	/**
	 * The rules operation of one call (doc/design/extensions.md "Rules and approvals"). An MCP extension maps
	 * a trusted `readOnlyHint` to `ext.read` and everything else to `ext.write`; a built-in states its own
	 * methods, such as `api.read`/`api.write` on the route of an API request.
	 */
	operation(tool: string, args: Record<string, unknown>): Operation;
}

/** The extension and the session's own on/off choice for it. */
export interface SessionExtension {
	extension: Extension;
	/** False when the owner turned the extension off in the session settings. */
	enabled: boolean;
}

/** A built-in extension's tools are always there; the state is ready. */
export function readyStatus(toolCount: number): ExtensionStatus {
	return {
		state: "ready" satisfies ExtensionState,
		lastError: null,
		nextAttemptAt: null,
		toolCount,
		connected: false,
		refreshedAt: null,
	};
}

/** An extension this process cannot provide, e.g. a built-in that another crhs version stored. */
export function unprovidedStatus(): ExtensionStatus {
	return {
		state: "unavailable",
		lastError: "this extension is not available in this crhs",
		nextAttemptAt: null,
		toolCount: 0,
		connected: false,
		refreshedAt: null,
	};
}

/** The call succeeded but a connection-level failure makes its outcome unknown. */
export class ExtensionCallLostError extends Error {}

/** The call never reached the extension: it is unavailable right now. */
export class ExtensionUnavailableError extends Error {}

/** The extension answered with a protocol error: the call did not run. */
export class ExtensionToolError extends Error {}
