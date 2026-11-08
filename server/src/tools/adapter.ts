import type { Audit } from "../audit/audit.ts";
import { NotFoundError, UserError } from "../util/errors.ts";
import type { ClusterTool, ToolContext } from "./catalog.ts";
import { errorResult, type ToolResult } from "./render.ts";

/**
 * One cluster tool call, as both surfaces run it (doc/mcp.md and doc/agent-runtime.md#cluster-工具): the
 * `tool.call` audit entry, the handler, and the mapping of an expected refusal to an error result with a
 * stable code. Every call is audited before it runs, and an unexpected failure stays a server bug rather
 * than a tool error.
 */
export async function callTool(
	tool: ClusterTool,
	args: unknown,
	ctx: ToolContext,
	options: { via: "session" | "mcp"; audit?: Audit },
): Promise<ToolResult> {
	void options.audit?.record({
		actor: { type: ctx.actor.type, id: ctx.actor.id, onBehalfOfUserId: ctx.actor.onBehalfOfUserId },
		action: "tool.call",
		target: { type: "tool", id: tool.name },
		detail: { via: options.via },
	});
	try {
		return await tool.handler(args as never, ctx);
	} catch (err) {
		// Expected failures are error results the model can act on; anything else is a server bug.
		if (!(err instanceof UserError)) throw err;
		const code = err.code ?? (err instanceof NotFoundError ? "not_found" : "invalid_argument");
		return errorResult(tool.output, code, err.message);
	}
}
