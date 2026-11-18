import type { Audit } from "../audit/audit.ts";
import { userActor } from "../audit/audit.ts";
import type { SessionUser } from "../auth/sessions.ts";

/**
 * One root-quota decision shared by the WebUI route and the chat commands (doc/design/agent-runtime.md
 * "Quota and token accounting"): note a scheduled run's denial before the wake, settle the wait, then audit
 * the decision. Keeping one function keeps the two surfaces' side effects and audit shape the same.
 */

/** The scheduler side of a denial: a scheduled run then ends failed instead of succeeded. */
export interface QuotaScheduler {
	noteQuotaDenied(sessionId: string, reason: string): Promise<void>;
	clearQuotaDenied(sessionId: string): void;
}

/** The runtime side of the decision. */
export interface QuotaDecider {
	decideRootQuota(rootId: string, decision: "approve" | "deny", tokens?: number): Promise<string[]>;
}

/** Where a chat decision was made, recorded like the other chat decisions. */
export interface QuotaDecisionVia {
	channel: string;
	platform: string;
	threadId?: string;
}

export interface QuotaDecisionInput {
	rootId: string;
	decision: "approve" | "deny";
	/** The user's reason; a denial without one is the owner stopping the run. */
	reason?: string;
	tokens?: number;
	/** Set by the chat: the audit says which channel decided. */
	via?: QuotaDecisionVia;
	/** The scheduler, when the surface has one; a denial on a scheduled run is noted before the wake. */
	scheduler?: QuotaScheduler;
}

/**
 * Settles a root whose quota is used up and audits it. Returns the sessions the decision woke. A denial is
 * noted to the scheduler first: deciding wakes the wait, and a run that settles before the note is read
 * would be recorded as succeeded. A refused decision clears the note again.
 */
export async function decideQuota(
	audit: Audit,
	user: SessionUser,
	runtime: QuotaDecider,
	input: QuotaDecisionInput,
): Promise<string[]> {
	const denyReason = input.decision === "deny" ? (input.reason ?? "the owner stopped the run") : undefined;
	const noted = input.decision === "deny" && input.scheduler !== undefined && denyReason !== undefined;
	if (noted) await input.scheduler?.noteQuotaDenied(input.rootId, `quota denied: ${denyReason}`);
	let sessions: string[];
	try {
		sessions = await runtime.decideRootQuota(input.rootId, input.decision, input.tokens);
	} catch (err) {
		if (noted) input.scheduler?.clearQuotaDenied(input.rootId);
		throw err;
	}
	await audit.record({
		actor: userActor(user),
		action: input.decision === "deny" ? "quota.denied" : "quota.granted",
		target: { type: "session", id: input.rootId },
		detail: {
			level: input.rootId,
			sessions,
			...(input.reason ? { reason: input.reason } : {}),
			...(input.tokens ? { tokens: input.tokens } : {}),
			...(input.via
				? {
						channel: input.via.channel,
						via: input.via.platform,
						...(input.via.threadId ? { thread_id: input.via.threadId } : {}),
					}
				: {}),
		},
	});
	return sessions;
}
