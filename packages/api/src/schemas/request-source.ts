/**
 * Who a request came from (`../request-source.ts`, doc/design/webui.md "Shared components"). The values are
 * only the caller's type and display name, never prose. Audit events add the non-user actors they record
 * (system, Auto Review, a schedule); task and approval sources are only a session, an API token or a user.
 */
import { z } from "zod";

export const RequestSourceSchema = z
	.discriminatedUnion("type", [
		z.object({
			type: z.literal("session"),
			sessionId: z.string().describe("The root session's id."),
			title: z
				.string()
				.describe("The stored title; empty when the session has none, so the renderer uses its untitled name."),
		}),
		z.object({ type: z.literal("api_token"), tokenId: z.string(), name: z.string() }),
		z.object({ type: z.literal("user"), userId: z.string(), username: z.string() }),
		z.object({ type: z.literal("system") }).describe("An audit actor the server runs itself."),
		z.object({ type: z.literal("auto_review") }).describe("Auto Review's own decision."),
		z.object({
			type: z.literal("schedule"),
			scheduleId: z.string(),
			name: z.string().describe("The schedule's name; its id when the schedule was deleted."),
		}),
	])
	.meta({ id: "RequestSource", description: "Who a request came from." });
