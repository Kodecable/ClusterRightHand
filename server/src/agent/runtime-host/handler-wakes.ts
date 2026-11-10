/**
 * Follow-up inputs held for a running handler (wakes.ts, doc/design/agent-runtime.md "Handling subagent requests"), and the handlers
 * with an idle observer attached, so a held wake is flushed once when the handler goes idle.
 */
export class HandlerWakes {
	readonly #pending = new Map<string, Map<string, string>>();
	readonly #idleWatchers = new Set<string>();

	/** Holds a wake until the handler is idle; a repeated request id replaces its content. */
	queue(handlerId: string, requestId: string, content: string): void {
		let wakes = this.#pending.get(handlerId);
		if (!wakes) {
			wakes = new Map();
			this.#pending.set(handlerId, wakes);
		}
		wakes.set(requestId, content);
	}

	/** Drops one queued wake. */
	drop(handlerId: string, requestId: string): void {
		const wakes = this.#pending.get(handlerId);
		if (!wakes) return;
		wakes.delete(requestId);
		if (wakes.size === 0) this.#pending.delete(handlerId);
	}

	/** Drops every queued wake whose request id starts with `prefix`. */
	dropPrefix(handlerId: string, prefix: string): void {
		const wakes = this.#pending.get(handlerId);
		if (!wakes) return;
		for (const requestId of wakes.keys()) if (requestId.startsWith(prefix)) wakes.delete(requestId);
		if (wakes.size === 0) this.#pending.delete(handlerId);
	}

	/** The handler's queued wakes, when any. */
	pending(handlerId: string): ReadonlyMap<string, string> | undefined {
		return this.#pending.get(handlerId);
	}

	/** Drops every queued wake of the handler, leaving its idle observer alone. */
	dropAll(handlerId: string): void {
		this.#pending.delete(handlerId);
	}

	/** Whether an idle observer is already attached for the handler. */
	isWatching(handlerId: string): boolean {
		return this.#idleWatchers.has(handlerId);
	}

	watch(handlerId: string): void {
		this.#idleWatchers.add(handlerId);
	}

	unwatch(handlerId: string): void {
		this.#idleWatchers.delete(handlerId);
	}

	/** Forgets a removed session's queued wakes and idle observer. */
	forget(handlerId: string): void {
		this.#pending.delete(handlerId);
		this.#idleWatchers.delete(handlerId);
	}
}
