import type { ExtensionStatus, Operation, SessionExtension as SessionExtensionView } from "@crh/api";
import type { Db } from "../storage/db.ts";
import { type BuiltinExtensionProvider, builtinProvider } from "./builtin.ts";
import type { McpConnections } from "./connections.ts";
import {
	type Extension,
	type ExtensionCallContext,
	type ExtensionTool,
	readyStatus,
	type SessionExtension,
} from "./model.ts";
import { DEFAULT_EXTENSION_TIMEOUT_MS, type ExtensionRow, extensionsForUser } from "./store.ts";

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
	}

	get name(): string {
		return this.#row.name;
	}
	get kind(): "mcp" {
		return "mcp";
	}
	get description(): string | null {
		return this.#row.description ?? this.#connections.instructions(this.#row.name) ?? null;
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
	async ensureAvailable(options: { immediate?: boolean } = {}): Promise<void> {
		await this.#connections.ensureConnected(this.#row.name, options);
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

/** A built-in extension: it runs inside crhs, has no connection and is always ready. */
class BuiltinExtension implements Extension {
	readonly #row: ExtensionRow;
	readonly #provider: BuiltinExtensionProvider;

	constructor(row: ExtensionRow, provider: BuiltinExtensionProvider) {
		this.#row = row;
		this.#provider = provider;
	}

	get name(): string {
		return this.#row.name;
	}
	get kind(): "builtin" {
		return "builtin";
	}
	get description(): string | null {
		return this.#row.description ?? this.#provider.description;
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
		return readyStatus(this.#provider.tools().length);
	}
	tools(): readonly ExtensionTool[] {
		return this.#provider.tools();
	}
	async ensureAvailable(): Promise<void> {}
	async refreshTools(): Promise<readonly ExtensionTool[]> {
		return this.#provider.tools();
	}
	call(tool: string, args: Record<string, unknown>, context: ExtensionCallContext): Promise<unknown> {
		return this.#provider.call(tool, args, context);
	}
	operation(tool: string, args: Record<string, unknown>): Operation {
		return this.#provider.operation(tool, args);
	}
}

/** The adapter for one stored row, or undefined when its tool list cannot be provided in this process. */
export function extensionOf(row: ExtensionRow, connections: McpConnections | undefined): Extension | undefined {
	if (row.kind === "builtin") {
		const provider = builtinProvider(row.name);
		return provider ? new BuiltinExtension(row, provider) : undefined;
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
