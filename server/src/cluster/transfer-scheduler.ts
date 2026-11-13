/**
 * The file plane's transfer slots (doc/design/library.md "Data connections"): per crha node one
 * running and four queued, per crhs sixteen running and 256 queued. A task that finds the queue full
 * fails at once with `busy` instead of waiting. Queueing lives here because "queued" means not yet
 * dispatched; when a slot frees, the oldest waiter that fits is promoted.
 */
export interface TransferLimits {
	runningPerNode: number;
	queuedPerNode: number;
	runningTotal: number;
	queuedTotal: number;
}

export const TRANSFER_LIMITS: TransferLimits = {
	runningPerNode: 1,
	queuedPerNode: 4,
	runningTotal: 16,
	queuedTotal: 256,
};

/** Thrown by acquire when both the running and the queued capacity of the node or crhs are full. */
export class TransferBusyError extends Error {
	override name = "TransferBusyError";
}

interface Waiter {
	taskId: string;
	nodeId: string;
	resolve: () => void;
}

export class TransferScheduler {
	readonly #limits: TransferLimits;
	readonly #runningByNode = new Map<string, number>();
	readonly #queuedByNode = new Map<string, number>();
	/** The task id of every slot holder, with the node it runs on. */
	readonly #held = new Map<string, string>();
	#running = 0;
	#queued = 0;
	#waiters: Waiter[] = [];

	constructor(limits: Partial<TransferLimits> = {}) {
		this.#limits = { ...TRANSFER_LIMITS, ...limits };
	}

	/** Whether the task already holds a slot. */
	holds(taskId: string): boolean {
		return this.#held.has(taskId);
	}

	/**
	 * Takes a slot for taskId on nodeId, waiting while the node's running slot is busy but its queue
	 * has room. Rejects with TransferBusyError when no room is left in either queue.
	 */
	acquire(taskId: string, nodeId: string): Promise<void> {
		if (this.#held.has(taskId)) return Promise.resolve();
		if (this.#canRun(nodeId)) {
			this.#takeRunning(taskId, nodeId);
			return Promise.resolve();
		}
		if (!this.#canQueue(nodeId)) return Promise.reject(new TransferBusyError("the transfer queue is full"));
		this.#queued++;
		this.#queuedByNode.set(nodeId, (this.#queuedByNode.get(nodeId) ?? 0) + 1);
		return new Promise<void>((resolve) => {
			this.#waiters.push({ taskId, nodeId, resolve });
		});
	}

	/** Frees the task's slot and promotes queued waiters while capacity allows. */
	release(taskId: string): void {
		const queued = this.#waiters.findIndex((waiter) => waiter.taskId === taskId);
		if (queued >= 0) {
			const [waiter] = this.#waiters.splice(queued, 1);
			if (waiter) {
				this.#queued--;
				this.#queuedByNode.set(waiter.nodeId, (this.#queuedByNode.get(waiter.nodeId) ?? 1) - 1);
				waiter.resolve();
			}
		}
		const nodeId = this.#held.get(taskId);
		if (nodeId === undefined) return;
		this.#held.delete(taskId);
		this.#running--;
		this.#runningByNode.set(nodeId, (this.#runningByNode.get(nodeId) ?? 1) - 1);
		this.#promote();
	}

	#promote(): void {
		let changed = true;
		while (changed) {
			changed = false;
			for (let i = 0; i < this.#waiters.length; i++) {
				const waiter = this.#waiters[i];
				if (!waiter || !this.#canRun(waiter.nodeId)) continue;
				this.#waiters.splice(i, 1);
				this.#queued--;
				this.#queuedByNode.set(waiter.nodeId, (this.#queuedByNode.get(waiter.nodeId) ?? 1) - 1);
				this.#takeRunning(waiter.taskId, waiter.nodeId);
				waiter.resolve();
				changed = true;
				break;
			}
		}
	}

	#canRun(nodeId: string): boolean {
		return (
			(this.#runningByNode.get(nodeId) ?? 0) < this.#limits.runningPerNode && this.#running < this.#limits.runningTotal
		);
	}

	#canQueue(nodeId: string): boolean {
		return (
			(this.#queuedByNode.get(nodeId) ?? 0) < this.#limits.queuedPerNode && this.#queued < this.#limits.queuedTotal
		);
	}

	#takeRunning(taskId: string, nodeId: string): void {
		this.#held.set(taskId, nodeId);
		this.#running++;
		this.#runningByNode.set(nodeId, (this.#runningByNode.get(nodeId) ?? 0) + 1);
	}
}
