import type { AgentRequestView } from "../runtime-core.ts";

/** Requests waiting for one handler's agent, loaded from the database and invalidated on approval changes. */
export interface Inbox {
	requests: Map<string, AgentRequestView>;
	loaded: boolean;
	/** Resolved when the pending set may have changed; `waitSubagent` uses this instead of polling. */
	waiters: Set<() => void>;
}

/** The per-handler request caches (runtime-requests.ts): created on first use, dropped when approvals change. */
export class Inboxes {
	readonly #byHandler = new Map<string, Inbox>();

	/** The handler's inbox, created empty when it does not exist yet. */
	inbox(handlerId: string): Inbox {
		let inbox = this.#byHandler.get(handlerId);
		if (!inbox) {
			inbox = { requests: new Map(), loaded: false, waiters: new Set() };
			this.#byHandler.set(handlerId, inbox);
		}
		return inbox;
	}

	/** The handler's inbox when one is cached, without creating it. */
	current(handlerId: string): Inbox | undefined {
		return this.#byHandler.get(handlerId);
	}

	/** Stores a freshly loaded request list in the inbox. */
	load(inbox: Inbox, requests: Map<string, AgentRequestView>): void {
		inbox.requests = requests;
		inbox.loaded = true;
	}

	/** Registers a `waitSubagent`-style waiter for a change of the inbox. */
	addWaiter(inbox: Inbox, wake: () => void): void {
		inbox.waiters.add(wake);
	}

	removeWaiter(inbox: Inbox, wake: () => void): void {
		inbox.waiters.delete(wake);
	}

	/** Wakes the inbox's waiters and drops it; the next read loads it again. */
	forget(handlerId: string): void {
		const inbox = this.#byHandler.get(handlerId);
		if (!inbox) return;
		for (const wake of inbox.waiters) wake();
		inbox.waiters.clear();
		this.#byHandler.delete(handlerId);
	}

	/** Drops every inbox: any approval change may alter any handler's list. */
	clear(): void {
		for (const handlerId of [...this.#byHandler.keys()]) this.forget(handlerId);
	}
}
