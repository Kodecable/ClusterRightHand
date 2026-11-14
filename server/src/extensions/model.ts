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
}

/** One extension as the session sees it: its configuration, its state and how to call it. */
export interface Extension {
	readonly name: string;
	readonly kind: ExtensionKind;
	readonly description: string | null;
	readonly enabled: boolean;
	readonly listDirectly: boolean;
	readonly availability: ExtensionAvailability;
	/** The connection state; a built-in extension is always `ready`. */
	status(): ExtensionStatus;
	/** The tool list last known for this extension; empty before the first listing. */
	tools(): readonly ExtensionTool[];
	/** Makes the extension reachable before a search or a call; a no-op for a built-in extension. */
	ensureAvailable(options?: { immediate?: boolean }): Promise<void>;
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
	return { state: "ready" satisfies ExtensionState, lastError: null, nextAttemptAt: null, toolCount };
}

/** The call succeeded but a connection-level failure makes its outcome unknown. */
export class ExtensionCallLostError extends Error {}

/** The call never reached the extension: it is unavailable right now. */
export class ExtensionUnavailableError extends Error {}

/** The extension answered with a protocol error: the call did not run. */
export class ExtensionToolError extends Error {}
