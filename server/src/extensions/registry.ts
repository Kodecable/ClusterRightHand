import type { ExtensionStatus, Operation, SessionExtension as SessionExtensionView } from "@crh/api";
import type { Db } from "../storage/db.ts";
import { type BuiltinExtensionProvider, builtinProvider } from "./builtin.ts";
import type { McpConnections } from "./connections.ts";
import {
	type Extension,
	type ExtensionCallContext,
	type ExtensionTool,
	ExtensionUnavailableError,
	readyStatus,
	type SessionExtension,
} from "./model.ts";
import { DEFAULT_EXTENSION_TIMEOUT_MS, type ExtensionRow, extensionsForUser, missingBuiltinConfig } from "./store.ts";

/**
 * The adapters behind the unified extension interface (doc/design/extensions.md): a row becomes an `Extension`
 * either through the MCP connection manager or through a built-in provider. Everything session-facing —
 * `search_tools`, `call_tool`, the direct tools, the tool guide, the session toggles and the admin views —
 * works on these adapters and never branches on the kind.
 */

/** An MCP extension: its tools, state and calls come from the connection manager. */
class McpExtension implements Extension {
	readonly #connections: McpConnections;
	readonly #row: ExtensionRow;

	constructor(connections: McpConnections, row: ExtensionRow) {
		this.#connections = connections;
		this.#row = row;
		// The row carries the cached tool list and description; the connections keep whichever is newer.
		connections.seed(row);
	}

	get name(): string {
		return this.#row.name;
	}
	get kind(): "mcp" {
		return "mcp";
	}
	get description(): string | null {
		// The administrator's text, else what the server last reported (doc/design/extensions.md "Extensions").
		const name = this.#row.name;
		return this.#row.description ?? this.#connections.instructions(name) ?? this.#connections.serverDescription(name);
	}
	get enabled(): boolean {
		return this.#row.enabled === 1;
	}
	get listDirectly(): boolean {
		return this.#row.list_directly === 1;
	}
	get availability(): "everyone" | "granted" {
		return this.#row.availability;
	}
	status(): ExtensionStatus {
		return this.#connections.status(this.#row.name);
	}
	tools(): readonly ExtensionTool[] {
		return this.#connections.tools(this.#row.name);
	}
	ensureAvailable(): Promise<void> {
		return this.#connections.ensureListed(this.#row.name);
	}
	prepareCall(): Promise<void> {
		return this.#connections.prepareCall(this.#row.name);
	}
	refreshTools(): Promise<readonly ExtensionTool[]> {
		return this.#connections.refreshTools(this.#row.name);
	}
	call(tool: string, args: Record<string, unknown>, context: ExtensionCallContext): Promise<unknown> {
		return this.#connections.callTool(this.#row.name, tool, args, {
			...(context.signal ? { signal: context.signal } : {}),
			...(context.identity ? { identity: context.identity } : {}),
			timeoutMs: this.#row.timeout_ms ?? DEFAULT_EXTENSION_TIMEOUT_MS,
		});
	}
	operation(tool: string, _args: Record<string, unknown>): Operation {
		// The annotations of the last listing decide the method; a trusted readOnlyHint makes it a read.
		const annotations = this.#connections.tool(this.#row.name, tool)?.annotations;
		const read = annotations?.readOnlyHint === true && this.#row.trust_annotations === 1;
		return { method: read ? "ext.read" : "ext.write", target: `${this.#row.name}/${tool}` };
	}
}

/** A built-in extension: it runs inside crhs, has no connection, and is ready once its required settings are set. */
class BuiltinExtension implements Extension {
	readonly #row: ExtensionRow;
	readonly #provider: BuiltinExtensionProvider;
	readonly #connections: McpConnections | undefined;

	constructor(row: ExtensionRow, provider: BuiltinExtensionProvider, connections: McpConnections | undefined) {
		this.#row = row;
		this.#provider = provider;
		this.#connections = connections;
	}

	get name(): string {
		return this.#row.name;
	}
	get kind(): "builtin" {
		return "builtin";
	}
	get description(): string | null {
		// A constant of crhs: it is never stored, so a new version's wording reaches every installation.
		return this.#provider.description;
	}
	get enabled(): boolean {
		return this.#row.enabled === 1;
	}
	get listDirectly(): boolean {
		return this.#row.list_directly === 1;
	}
	get availability(): "everyone" | "granted" {
		return this.#row.availability;
	}
	status(): ExtensionStatus {
		const missing = missingBuiltinConfig(this.#row, this.#provider);
		if (missing.length > 0) {
			return {
				...readyStatus(this.#provider.tools().length),
				state: "unavailable",
				lastError: `needs ${missing.join(", ")}; an administrator sets it on the Extensions page`,
			};
		}
		return readyStatus(this.#provider.tools().length);
	}
	tools(): readonly ExtensionTool[] {
		return this.#provider.tools();
	}
	async ensureAvailable(): Promise<void> {}
	async prepareCall(): Promise<void> {}
	async refreshTools(): Promise<readonly ExtensionTool[]> {
		return this.#provider.tools();
	}
	async call(tool: string, args: Record<string, unknown>, context: ExtensionCallContext): Promise<unknown> {
		if (!this.#provider.config || this.#provider.config.length === 0) return this.#provider.call(tool, args, context);
		if (!this.#connections) throw new ExtensionUnavailableError(`${this.#row.name} has no settings in this process`);
		const config = await this.#connections.builtinConfig(this.#row.name, this.#provider);
		return this.#provider.call(tool, args, { ...context, config });
	}
	operation(tool: string, args: Record<string, unknown>): Operation {
		return this.#provider.operation(tool, args);
	}
}

/** The adapter for one stored row, or undefined when its tool list cannot be provided in this process. */
export function extensionOf(row: ExtensionRow, connections: McpConnections | undefined): Extension | undefined {
	if (row.kind === "builtin") {
		const provider = builtinProvider(row.name);
		return provider ? new BuiltinExtension(row, provider, connections) : undefined;
	}
	return connections ? new McpExtension(connections, row) : undefined;
}

/**
 * The extensions a session may use, with its owner's on/off choice: enabled extensions available to the
 * owner (everyone, or a grant) minus the names the session turned off.
 */
export async function sessionExtensionsForUser(
	db: Db,
	userId: string,
	disabled: readonly string[],
	connections: McpConnections | undefined,
): Promise<SessionExtension[]> {
	const rows = await extensionsForUser(db, userId);
	const out: SessionExtension[] = [];
	for (const row of rows) {
		const extension = extensionOf(row, connections);
		if (!extension) continue;
		out.push({ extension, enabled: !disabled.includes(row.name) });
	}
	return out;
}

/** The plain form the API's session view and the WebUI toggles use. */
export function sessionExtensionView(entry: SessionExtension): SessionExtensionView {
	const { extension } = entry;
	return {
		name: extension.name,
		kind: extension.kind,
		description: extension.description,
		enabled: entry.enabled,
		available: extension.status().state !== "unavailable",
		listDirectly: extension.listDirectly,
	};
}
