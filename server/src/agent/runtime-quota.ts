import type { Context } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import { ProviderDoc } from "@earendil-works/pi-durable";
import { NotFoundError, UserError } from "../util/errors.ts";
import { chargeCall, exhaustedLevel, grantQuota } from "./quota.ts";
import type { RuntimeHost } from "./runtime-core.ts";
import { refreshState } from "./runtime-state.ts";
import { parentOf } from "./session-chain.ts";
import { markSessionsIdle, type SessionWait, setSessionState } from "./session-state.ts";
import { type AccountedMessage, callTokens, estimateRequestTokens } from "./tokens.ts";
import { wakeQuota } from "./wakes.ts";

/**
 * Quota waits (doc/agent-runtime.md#配额): a tool call whose chain has an exhausted level pauses, asks the
 * level's direct parent (its agent) or, for a root level, the owner, and resumes when the whole chain is above
 * zero again. The runtime's list of waiters is in memory; the wait itself is the durable session state, so it
 * survives a restart. Compaction's summarization is metered to its conversation here as well (D92).
 */

/**
 * Pauses a tool call whose chain quota is used up (doc/agent-runtime.md#配额): asks the exhausted level's direct
 * parent (its agent), or, when that level is the root, the owner; waits until the whole chain is above zero or the
 * request is denied. A rerun after a restart finds the same request.
 */
export async function waitForQuota(host: RuntimeHost, sessionId: string, context: Context): Promise<"ok" | "denied"> {
	for (;;) {
		// The owner denied while this call was setting up or between waits: end it instead of waiting again.
		if (host.quotaWaits.takeDenied(sessionId)) return "denied";
		const waiter = quotaWaiter(host, sessionId, context.abortSignal);
		try {
			const level = await exhaustedLevel(host.db, sessionId);
			if (!level) {
				const write = await setSessionState(host.db, sessionId, "running", null, { onlyIfLive: true });
				host.sessionList.publishSession(sessionId);
				// The quota request is gone; drop it from the handler's cache before returning.
				host.inboxes.clear();
				// The run ended while this call waited: do not revive it or run the task.
				if (!write.applied) return "denied";
				return "ok";
			}
			const parent = await parentOf(host.db, level);
			const quotaWait: SessionWait = { kind: "quota", levelId: level };
			// A tool call pausing is a real transition of its run, not a recompute; only its resume checks the
			// row is still live (a run that ended while it waited must not be revived).
			const { since } = await setSessionState(host.db, sessionId, "awaiting", quotaWait);
			host.sessionList.publishSession(sessionId);
			// A root level has no parent to handle its wait: the owner sees it in the approvals API, and the
			// session paused on that level already carries the wait (doc/agent-runtime.md#配额).
			// A deny/abort could have landed between the check and the write; do not wake for an ended wait.
			if (host.quotaWaits.takeDenied(sessionId)) return "denied";
			// The handler's inbox cache must see the new quota request.
			host.inboxes.clear();
			if (parent) await wakeQuota(host, parent, sessionId, level, since);
			// Grant/deny/abort/quota edit resolves this; the next loop re-checks the durable state.
			await waiter.promise;
			if (context.abortSignal?.aborted) throw new Error("the quota wait was aborted");
		} finally {
			waiter.cancel();
		}
	}
}

/** Resolves when the quota wait may have changed (grant, deny, abort, or a quota edit). */
function quotaWaiter(
	host: RuntimeHost,
	sessionId: string,
	signal: AbortSignal | undefined,
): { promise: Promise<void>; cancel: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	const cancelWaiter = host.quotaWaits.wait(sessionId, resolve);
	const onAbort = () => resolve();
	if (signal) {
		if (signal.aborted) resolve();
		else signal.addEventListener("abort", onAbort, { once: true });
	}
	return {
		promise,
		cancel: () => {
			cancelWaiter();
			signal?.removeEventListener("abort", onAbort);
		},
	};
}

/**
 * The owner's answer to a root whose quota is used up (doc/agent-runtime.md#配额): add N tokens (additive, no
 * cap) or deny and stop the paused runs. The wait may belong to the root's own run or to a subagent paused on
 * the root level, so the paused sessions carry it (not the root row alone). Returns them, for the audit.
 */
export async function decideRootQuota(
	host: RuntimeHost,
	rootId: string,
	decision: "approve" | "deny",
	tokens?: number,
): Promise<string[]> {
	const root = await host.db.selectFrom("sessions").selectAll().where("id", "=", rootId).executeTakeFirst();
	if (!root) throw new NotFoundError("no such session");
	if (root.parent_session_id !== null) throw new UserError("only a root session's quota can be decided");
	const paused = await host.db
		.selectFrom("sessions")
		.select(["id", "state", "waiting_level_id"])
		.where("state", "=", "awaiting")
		.where("waiting_kind", "=", "quota")
		.where("waiting_level_id", "=", rootId)
		.execute();
	const exhausted = root.quota_tokens !== null && Number(root.quota_tokens) <= 0;
	if (paused.length === 0 || !exhausted) {
		throw new UserError("the session is not waiting for a token quota decision");
	}
	if (decision === "deny") {
		// The paused calls end like an agent's deny; a call waiting right now is told by the in-memory mark,
		// so it ends instead of waiting again.
		for (const row of paused) if (host.quotaWaits.hasWaiters(row.id)) host.quotaWaits.markDenied(row.id);
		await markSessionsIdle(
			host.db,
			paused.map((row) => row.id),
		);
	} else {
		if (tokens === undefined) throw new UserError("give the quota wait tokens to grant");
		await grantQuota(host.db, rootId, tokens);
	}
	host.quotaWaits.wakeAll();
	host.inboxes.clear();
	// On a deny every paused run already ended idle; on a grant each paused call resumes and writes `running`.
	if (decision === "deny") for (const row of paused) await refreshState(host, row.id);
	await refreshState(host, rootId);
	return paused.map((row) => row.id);
}

/** Remembers which session owns a conversation's provider session id, for metering its compaction (D92). */
export async function rememberProviderSession(host: RuntimeHost, conversationId: string): Promise<void> {
	if (host.sessionCaches.hasLearnedProvider(conversationId)) return;
	const provider = await host
		.harness()
		.snapshot(ProviderDoc, Number(conversationId) as unknown as ConversationId, host.context);
	const providerSessionId = provider?.sessionId;
	if (typeof providerSessionId !== "string") return;
	const row = await host.db
		.selectFrom("sessions")
		.select("id")
		.where("conversation_id", "=", conversationId)
		.executeTakeFirst();
	if (!row) return;
	host.sessionCaches.rememberProviderSession(conversationId, providerSessionId, row.id);
}

/**
 * Charges a compaction's summarization to the session it compacted (D92, D101); the next tool call pauses if it
 * emptied the quota. The input estimate is measured on `context`, the request given to `completeSimple`: system
 * prompt plus messages (D101). A compaction never moves the context fill: that is the last main-agent call's input.
 */
export async function chargeCompaction(
	host: RuntimeHost,
	providerSessionId: string,
	message: AccountedMessage,
	context: { readonly messages: readonly unknown[]; readonly systemPrompt?: string },
): Promise<void> {
	const sessionId = host.sessionCaches.providerSessionOf(providerSessionId);
	if (!sessionId) return;
	const tokens = callTokens(message, estimateRequestTokens(context));
	await chargeCall(host.db, sessionId, tokens);
	host.sessionList.publishSession(sessionId);
	const over = await exhaustedLevel(host.db, sessionId);
	if (over) {
		void host.audit?.record({
			actor: { type: "system", id: "quota" },
			action: "session.quota_exhausted",
			target: { type: "session", id: over },
		});
	}
}
