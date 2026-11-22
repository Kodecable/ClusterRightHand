import type { JobNotice } from "@crh/api";

/**
 * Follow-up inputs held for a running handler (wakes.ts, doc/design/agent-runtime.md "Handling subagent
 * requests" and doc/design/jobs.md "Completion notices"), and the handlers with an idle observer attached, so a
 * held wake is flushed once when the handler goes idle.
 */

/**
 * The data of a `crh.notice` input (doc/design/jobs.md "Completion notices"): request wakes carry the request
 * the handler must settle, and a completion notice lists the finished jobs. Every display surface reads this
 * data and the entry kind, never the model-facing text.
 */
export type NoticeData =
	| { type: "jobs"; jobs: JobNotice[] }
	| { type: "agent_request"; kind: "task" | "task_group" | "external_call"; requestId: string }
	| { type: "quota_request"; sessionId: string; levelId: string };

/** One held wake: the model-facing text and the entry data it is placed with. */
export interface QueuedWake {
	content: string;
	data: NoticeData;
}

export class HandlerWakes {
	readonly #pending = new Map<string, Map<string, QueuedWake>>();
	readonly #idleWatchers = new Set<string>();

	/** Holds a wake until the handler is idle; a repeated request id replaces its content. */
	queue(handlerId: string, requestId: string, wake: QueuedWake): void {
		let wakes = this.#pending.get(handlerId);
		if (!wakes) {
			wakes = new Map();
			this.#pending.set(handlerId, wakes);
		}
		wakes.set(requestId, wake);
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
	pending(handlerId: string): ReadonlyMap<string, QueuedWake> | undefined {
		return this.#pending.get(handlerId);
	}

	/** Whether a wake with this request-id prefix waits for the handler (a completion notice, say). */
	hasPrefix(handlerId: string, prefix: string): boolean {
		const wakes = this.#pending.get(handlerId);
		if (!wakes) return false;
		for (const requestId of wakes.keys()) if (requestId.startsWith(prefix)) return true;
		return false;
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
