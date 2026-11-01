import type { Audit } from "../audit/audit.ts";
import { NotFoundError, UserError } from "../users/service.ts";
import type { ClusterTool, ToolContext } from "./catalog.ts";

/**
 * One cluster tool call, as both surfaces run it (doc/mcp.md and doc/agent-runtime.md#cluster-工具): the
 * `tool.call` audit entry, the handler, and the mapping of an expected refusal to a tool error. Every call is
 * audited before it runs, and an unexpected failure stays a server bug rather than a tool error.
 */
export type ToolCallOutcome = { ok: true; result: unknown } | { ok: false; error: string };

export async function callTool(
	tool: ClusterTool,
	args: unknown,
	ctx: ToolContext,
	options: { via: "session" | "mcp"; audit?: Audit },
): Promise<ToolCallOutcome> {
	void options.audit?.record({
		actor: { type: ctx.actor.type, id: ctx.actor.id, onBehalfOfUserId: ctx.actor.onBehalfOfUserId },
		action: "tool.call",
		target: { type: "tool", id: tool.name },
		detail: { via: options.via },
	});
	try {
		return { ok: true, result: await tool.handler(args as never, ctx) };
	} catch (err) {
		// Expected failures go back to the model as tool errors; anything else is a server bug.
		if (!(err instanceof UserError || err instanceof NotFoundError)) throw err;
		return { ok: false, error: err.message };
	}
}
