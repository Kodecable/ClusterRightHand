/** Messages between the soak parent (podman, sampling, reporting) and the crhs child (agent runtime + workload). */

export interface SoakNode {
	nodeId: string;
	/** The container name, for logs and the cleanup grep. */
	container: string;
}

export interface FailureRecord {
	sessionIndex: number;
	turn: number;
	message: string;
	at: string;
}

export interface ParallelismObservation {
	roundsObserved: number;
	parallelRounds: number;
	sequentialRounds: number;
	maxConcurrency: number;
}

export interface RuntimeStats {
	heapUsedBytes: number;
	heapTotalBytes: number;
	rssBytes: number;
	/** Rows in crhs's own tables. */
	tasks: number;
	auditEvents: number;
	sessions: number;
	/** Rows in the durable agent storage. */
	piEntries: number;
	compactions: number;
	/** Tasks whose state is failed, that timed out, or exited non-zero. */
	tasksFailed: number;
	turnsDone: number;
	toolCallsDone: number;
	turnP50Ms: number | null;
	turnP95Ms: number | null;
	durationMs: number;
	failures: FailureRecord[];
	parallelism: ParallelismObservation;
}

export type ParentMessage =
	| { type: "nodes"; nodes: SoakNode[] }
	| { type: "stats"; id: number }
	| { type: "shutdown" }
	| { type: "abort"; reason: string };

export type ChildMessage =
	| { type: "ready"; url: string; cookie: string }
	| { type: "started"; sessions: number; turns: number; toolCalls: number }
	| { type: "stats"; id: number; stats: RuntimeStats }
	| { type: "finished"; stats: RuntimeStats; durationMs: number }
	| { type: "stopped" }
	| { type: "log"; message: string }
	| { type: "error"; message: string; stack?: string };
