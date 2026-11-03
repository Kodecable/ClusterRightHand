/**
 * The crhs side of the soak, in one child process: the real AgentRuntime (plus the HTTP/WS server real crha nodes
 * connect to) and the workload driver. Keeping them together makes the parent's RSS measurement
 * "crhs + a thin driver" instead of "crhs + a driver + the orchestrator".
 */
import { performance } from "node:perf_hooks";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { parseChildParams } from "./child-params.ts";
import { openSoakCrhs } from "./crhs.ts";
import type { ChildMessage, ParentMessage, RuntimeStats, SoakNode } from "./ipc.ts";
import {
	createSoakSessions,
	installFauxModel,
	newProgress,
	percentile,
	runWorkload,
	type WorkloadProgress,
} from "./workload.ts";

function send(message: ChildMessage): void {
	try {
		process.send?.(message);
	} catch {
		// The parent may already be gone; the process is on its way out.
	}
}

function log(message: string): void {
	send({ type: "log", message });
}

function emptyStats(progress: WorkloadProgress): RuntimeStats {
	return {
		heapUsedBytes: process.memoryUsage().heapUsed,
		heapTotalBytes: process.memoryUsage().heapTotal,
		rssBytes: process.memoryUsage().rss,
		tasks: 0,
		auditEvents: 0,
		sessions: 0,
		piEntries: 0,
		compactions: 0,
		tasksFailed: 0,
		turnsDone: progress.turnsDone,
		toolCallsDone: progress.toolCallsDone,
		turnP50Ms: percentile(progress.latenciesMs, 0.5),
		turnP95Ms: percentile(progress.latenciesMs, 0.95),
		durationMs: 0,
		failures: [...progress.failures],
		parallelism: { ...progress.parallelism },
	};
}

async function main(): Promise<void> {
	const params = parseChildParams();
	const progress = newProgress();
	const faux = fauxProvider({ models: [{ id: "soak-1", contextWindow: params.contextWindow }] });
	const crhs = await openSoakCrhs(params, faux);
	log(`crhs listening on ${crhs.url} (db ${crhs.paths.db}, durable ${crhs.paths.durableDb})`);
	send({ type: "ready", url: crhs.url, cookie: crhs.cookie });

	let nodes: SoakNode[] = [];
	let stopModel: (() => void) | undefined;
	let stopped = false;

	const shutdown = async (code: number): Promise<void> => {
		if (stopped) return;
		stopped = true;
		stopModel?.();
		try {
			await crhs.close();
		} catch (err) {
			log(`crhs close failed: ${(err as Error).message}`);
		}
		send({ type: "stopped" });
		// Give the IPC pipe a moment to deliver `stopped` before the process goes away.
		await new Promise((resolve) => setTimeout(resolve, 50));
		process.exit(code);
	};

	const replyStats = async (id: number): Promise<void> => {
		const stats = nodes.length === 0 ? emptyStats(progress) : await crhs.stats(progress);
		send({ type: "stats", id, stats });
	};

	process.on("message", (message: ParentMessage) => {
		void (async () => {
			if (message.type === "stats") {
				await replyStats(message.id);
				return;
			}
			if (message.type === "nodes") {
				nodes = message.nodes;
				if (nodes.length === 0) throw new Error("the parent created no nodes");
				stopModel = installFauxModel(faux, nodes, params, log);
				log(`creating ${params.sessions} sessions`);
				const sessions = await createSoakSessions(crhs.runtime, crhs.owner, params, crhs.model);
				const totalTurns = params.sessions * params.turns;
				const totalToolCalls = totalTurns * params.toolsPerTurn;
				send({ type: "started", sessions: params.sessions, turns: totalTurns, toolCalls: totalToolCalls });
				log(
					`workload start: ${params.sessions} sessions, concurrency ${params.concurrency}, ${params.turns} turns each`,
				);
				progress.startedAt = performance.now();
				await runWorkload({
					runtime: crhs.runtime,
					db: crhs.db,
					owner: crhs.owner,
					sessions,
					params,
					progress,
					runId: `soak-${process.pid}-${Date.now()}`,
				});
				const stats = await crhs.stats(progress);
				log(
					`workload done: ${stats.turnsDone} turns, ${stats.toolCallsDone} tool calls, ` +
						`${stats.failures.length} failure(s), ${stats.durationMs.toFixed(0)} ms`,
				);
				send({ type: "finished", stats, durationMs: stats.durationMs });
				return;
			}
			if (message.type === "shutdown" || message.type === "abort") {
				await shutdown(message.type === "abort" ? 130 : 0);
			}
		})().catch((err: unknown) => {
			send({ type: "error", message: (err as Error).message, stack: (err as Error).stack });
			void shutdown(1);
		});
	});

	process.on("disconnect", () => {
		void shutdown(0);
	});
	process.on("SIGINT", () => {
		void shutdown(130);
	});
	process.on("SIGTERM", () => {
		void shutdown(0);
	});
}

main().catch((err: unknown) => {
	send({ type: "error", message: (err as Error).message, stack: (err as Error).stack });
	process.exit(1);
});
