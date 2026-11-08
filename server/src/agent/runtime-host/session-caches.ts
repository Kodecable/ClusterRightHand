import type { SessionInfo } from "../runtime-core.ts";

/**
 * What the runtime remembers about a session outside the database: its conversation, whether it has subagents,
 * and the provider session ids learned from its conversation (doc/agent-runtime.md#自定义提供方, D92).
 */
export class SessionCaches {
	readonly #sessionsByConversation = new Map<string, SessionInfo>();
	readonly #subagentParents = new Set<string>();
	readonly #providerSessions = new Map<string, string>();
	/** The reverse of `#providerSessions`, so the per-session lookup is not a scan over every provider id. */
	readonly #providerSessionIds = new Map<string, string>();
	readonly #learnedProviders = new Set<string>();

	/** The session a conversation belongs to, when it was already looked up. */
	sessionFor(conversationId: string): SessionInfo | undefined {
		return this.#sessionsByConversation.get(conversationId);
	}

	/** Remembers the conversation-to-session mapping; it never changes while the row exists. */
	rememberSession(conversationId: string, session: SessionInfo): void {
		this.#sessionsByConversation.set(conversationId, session);
	}

	/** Whether the session is known to have subagents (checked once per session, then cheap). */
	hasSubagentParent(sessionId: string): boolean {
		return this.#subagentParents.has(sessionId);
	}

	rememberSubagentParent(sessionId: string): void {
		this.#subagentParents.add(sessionId);
	}

	/** The crh session id a provider session id maps to, for metering its compaction (D92). */
	providerSessionOf(providerSessionId: string): string | undefined {
		return this.#providerSessions.get(providerSessionId);
	}

	/** The provider session id of a crh session, for a custom provider's session id fields (D115). */
	providerSessionIdFor(sessionId: string): string | undefined {
		return this.#providerSessionIds.get(sessionId);
	}

	/** Whether the conversation's provider document was already read. */
	hasLearnedProvider(conversationId: string): boolean {
		return this.#learnedProviders.has(conversationId);
	}

	/** Remembers a provider session id learned from the conversation, and marks the conversation read. */
	rememberProviderSession(conversationId: string, providerSessionId: string, sessionId: string): void {
		const previous = this.#providerSessionIds.get(sessionId);
		if (previous !== undefined && previous !== providerSessionId) this.#providerSessions.delete(previous);
		this.#providerSessions.set(providerSessionId, sessionId);
		this.#providerSessionIds.set(sessionId, providerSessionId);
		this.#learnedProviders.add(conversationId);
	}

	/**
	 * Forgets everything held for a removed session: the conversation mapping and the provider-document read of
	 * `conversationId` (when known), the provider session ids learned from it, and the subagent marker.
	 */
	forgetSession(sessionId: string, conversationId?: string): void {
		if (conversationId !== undefined) {
			this.#sessionsByConversation.delete(conversationId);
			this.#learnedProviders.delete(conversationId);
		}
		const providerSessionId = this.#providerSessionIds.get(sessionId);
		if (providerSessionId !== undefined) this.#providerSessions.delete(providerSessionId);
		this.#providerSessionIds.delete(sessionId);
		this.#subagentParents.delete(sessionId);
	}
}
