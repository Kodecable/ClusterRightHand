/**
 * The synthetic workload: a faux model that decides its answer from the request context (never from a shared
 * script position, so concurrent sessions cannot consume each other's responses) and a small worker pool that
 * drives real AgentRuntime sessions, each turn running real node exec tool calls.
 */
import { performance } from "node:perf_hooks";
import type { Message, ToolCall, TranscriptContext } from "@earendil-works/pi-ai";
import {
	type FauxProviderHandle,
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { AgentRuntime } from "../../src/agent/runtime.ts";
import type { SessionUser } from "../../src/auth/sessions.ts";
import type { Db } from "../../src/storage/db.ts";
import type { FailureRecord, ParallelismObservation, SoakNode } from "./ipc.ts";
import type { SoakParams } from "./params.ts";

export type Session = Awaited<ReturnType<AgentRuntime["createSession"]>>;

export interface WorkloadProgress {
	turnsDone: number;
	toolCallsDone: number;
	latenciesMs: number[];
	failures: FailureRecord[];
	parallelism: ParallelismObservation;
	/** Performance clock at the first turn. */
	startedAt: number;
	/** Performance clock after the last turn (0 while running). */
	endedAt: number;
}

export function newProgress(): WorkloadProgress {
	return {
		turnsDone: 0,
		toolCallsDone: 0,
		latenciesMs: [],
		failures: [],
		parallelism: { roundsObserved: 0, parallelRounds: 0, sequentialRounds: 0, maxConcurrency: 0 },
		startedAt: 0,
		endedAt: 0,
	};
}

export function percentile(values: number[], fraction: number): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
	return sorted[index] ?? null;
}

interface ModelTarget {
	provider: string;
	modelId: string;
}

/** Creates the sessions; they stay idle until a worker takes one. */
export async function createSoakSessions(
	runtime: AgentRuntime,
	owner: SessionUser,
	params: SoakParams,
	model: ModelTarget,
): Promise<Session[]> {
	const sessions: Session[] = [];
	for (let index = 0; index < params.sessions; index++) {
		sessions.push(
			await runtime.createSession(owner, {
				title: `soak session ${index + 1}`,
				model,
				rulePreset: "yolo",
			}),
		);
	}
	return sessions;
}

// ---------------------------------------------------------------------------
// The faux model
// ---------------------------------------------------------------------------

/** 32-bit integer hash, so privileged / big picks are stable per (session, turn, call). */
function hash32(a: number, b: number, c: number): number {
	let h = 0x811c9dc5;
	for (const value of [a, b, c]) {
		h ^= value;
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}

function hit(seed: number, ratio: number): boolean {
	return (seed % 1_000_000) / 1_000_000 < ratio;
}

function blockText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			if (block === null || typeof block !== "object") return "";
			const value = block as { type?: string; text?: string; thinking?: string };
			return value.type === "text" ? (value.text ?? "") : value.type === "thinking" ? (value.thinking ?? "") : "";
		})
		.join("\n");
}

function messageText(message: Message): string {
	return blockText(message.content);
}

function isCompactionRequest(context: TranscriptContext): boolean {
	for (const message of context.messages) {
		if (message.role === "system" && /context summarization assistant/i.test(messageText(message))) return true;
	}
	const last = context.messages.at(-1);
	return last?.role === "user" && /conversation to summarize|structured context checkpoint/i.test(messageText(last));
}

/** The (session, turn) a user input belongs to, from the fixed text the driver submits. */
function turnOf(context: TranscriptContext): { session: number; turn: number } | undefined {
	const last = context.messages.at(-1);
	if (last?.role !== "user") return undefined;
	const match = /soak session (\d+) turn (\d+)/.exec(messageText(last));
	if (!match) return undefined;
	return { session: Number(match[1]), turn: Number(match[2]) };
}

/** True when the last assistant tool round already has one result for every call. */
function toolRoundFinished(context: TranscriptContext): boolean {
	let assistantIndex = -1;
	for (let index = context.messages.length - 1; index >= 0; index--) {
		const message = context.messages[index];
		if (message?.role === "assistant" && message.content.some((block) => block.type === "toolCall")) {
			assistantIndex = index;
			break;
		}
	}
	if (assistantIndex < 0) return false;
	const assistant = context.messages[assistantIndex];
	if (assistant?.role !== "assistant") return false;
	const calls = assistant.content.flatMap((block) => (block.type === "toolCall" ? [block.id] : []));
	const results = new Set<string>();
	for (let index = assistantIndex + 1; index < context.messages.length; index++) {
		const message = context.messages[index];
		if (message?.role === "toolResult") results.add(message.toolCallId);
	}
	return calls.length > 0 && calls.every((id) => results.has(id));
}

function toolCallBatch(session: number, turn: number, nodes: SoakNode[], params: SoakParams): ToolCall[] {
	const calls: ToolCall[] = [];
	for (let index = 0; index < params.toolsPerTurn; index++) {
		const seed = hash32(session, turn, index);
		const callIndex = (session * params.turns + turn) * params.toolsPerTurn + index;
		const node = nodes[callIndex % nodes.length];
		if (!node) throw new Error("the soak has no node to target");
		const privileged = hit(seed, params.privRatio);
		const big = hit(hash32(seed, 0x51a7, 3), params.bigOutputRatio);
		const bytes = big ? Math.max(params.outputBytes, 64 * 1024) : params.outputBytes;
		calls.push(
			fauxToolCall(
				"exec",
				{
					targets: [node.nodeId],
					cmd: `head -c ${bytes} /dev/zero | tr '\\0' x`,
					privileged,
					wait: 300,
				},
				{ id: `soak-${session}-${turn}-${index}` },
			),
		);
	}
	return calls;
}

/**
 * Installs the context-deciding response factory.
 *
 * Every queued step is the same factory, so whichever concurrent request pops it gets an answer for its own
 * transcript: a tool batch for a new user input, a short answer once that batch's results are all present, and a
 * summary for pi-durable's compaction request. The queue is kept topped up while the workload runs.
 */
export function installFauxModel(
	faux: FauxProviderHandle,
	nodes: SoakNode[],
	params: SoakParams,
	log: (message: string) => void,
): () => void {
	let summaryCalls = 0;
	const factory = (context: TranscriptContext): ReturnType<typeof fauxAssistantMessage> => {
		if (isCompactionRequest(context)) {
			summaryCalls++;
			return fauxAssistantMessage(
				fauxText(
					"## Goal\nContinue the synthetic ClusterRightHand soak workload.\n\n" +
						"## Progress\n### Done\n- Earlier turns ran real node commands; their output and results were compacted.\n\n" +
						"## Next Steps\n1. Continue the remaining turns with the same tool-call pattern.",
				),
			);
		}
		const turn = turnOf(context);
		if (turn) {
			return fauxAssistantMessage(toolCallBatch(turn.session, turn.turn, nodes, params), { stopReason: "toolUse" });
		}
		if (toolRoundFinished(context)) return fauxAssistantMessage(fauxText("soak turn complete"));
		// A request this driver did not script (a wake, a retry without its user input): answer briefly instead of
		// inventing more tool calls, so the session can settle.
		return fauxAssistantMessage(fauxText("soak: nothing to do"));
	};

	const refill = (): void => {
		if (faux.getPendingResponseCount() < 256) faux.appendResponses(Array.from({ length: 1024 }, () => factory));
	};
	faux.setResponses(Array.from({ length: 1024 }, () => factory));
	const timer = setInterval(refill, 1000);
	timer.unref();
	const stop = (): void => {
		clearInterval(timer);
		log(`faux model: ${summaryCalls} compaction summarization request(s)`);
	};
	refill();
	return stop;
}

// ---------------------------------------------------------------------------
// Driving the turns
// ---------------------------------------------------------------------------

/** Waits for a submission; on timeout the run is aborted so the session can move on. */
async function settleTurn(
	runtime: AgentRuntime,
	owner: SessionUser,
	sessionId: string,
	submissionId: string,
	timeoutMs: number,
): Promise<{ status: "done" } | { status: "unanswered"; reason: string }> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	let settled: { status: "done" } | { status: "unanswered"; reason: string };
	try {
		settled = await runtime.waitForSubmission(submissionId, controller.signal);
	} catch (err) {
		settled = { status: "unanswered", reason: (err as Error).message };
	} finally {
		clearTimeout(timer);
	}
	// A plain abort of the wait does not stop the run: abort the session too, so a timed-out turn cannot keep
	// using the node after the worker has moved on.
	if (settled.status !== "done") await runtime.abort(sessionId, owner).catch(() => {});
	return settled;
}

/**
 * Looks at the tasks a turn created. With parallel tool execution every call's task row exists before the first
 * task finishes; with sequential execution only the first does. Task timestamps are the measurement.
 */
async function observeParallelism(
	db: Db,
	sessionId: string,
	turnStartedAt: number,
	progress: WorkloadProgress,
): Promise<void> {
	if (progress.parallelism.roundsObserved >= 60) return;
	const tasks = await db
		.selectFrom("tasks")
		.select(["created_at", "dispatched_at", "finished_at"])
		.where("actor_type", "=", "session")
		.where("actor_id", "=", sessionId)
		.where("created_at", ">=", new Date(turnStartedAt).toISOString())
		.execute();
	if (tasks.length === 0) return;
	progress.parallelism.roundsObserved++;
	const created = tasks.map((task) => Date.parse(task.created_at)).sort((a, b) => a - b);
	const finished = tasks.flatMap((task) => (task.finished_at === null ? [] : [Date.parse(task.finished_at)]));
	const firstFinished = finished.length > 0 ? Math.min(...finished) : Number.POSITIVE_INFINITY;
	const createdBeforeFirstFinish = created.filter((time) => time <= firstFinished).length;
	const intervals = tasks.map((task) => ({
		start: Date.parse(task.dispatched_at ?? task.created_at),
		end: task.finished_at === null ? Number.POSITIVE_INFINITY : Date.parse(task.finished_at),
	}));
	const events = intervals.flatMap((interval) => [
		{ at: interval.start, delta: 1 },
		{ at: interval.end, delta: -1 },
	]);
	events.sort((a, b) => a.at - b.at || a.delta - b.delta);
	let concurrent = 0;
	let maxConcurrent = 0;
	for (const event of events) {
		concurrent += event.delta;
		if (concurrent > maxConcurrent) maxConcurrent = concurrent;
	}
	if (maxConcurrent > progress.parallelism.maxConcurrency) progress.parallelism.maxConcurrency = maxConcurrent;
	if (tasks.length > 1 && createdBeforeFirstFinish > 1) progress.parallelism.parallelRounds++;
	else progress.parallelism.sequentialRounds++;
}

/** Runs `sessions` with at most `concurrency` in flight; each session's turns run one after another. */
export async function runWorkload(opts: {
	runtime: AgentRuntime;
	db: Db;
	owner: SessionUser;
	sessions: Session[];
	params: SoakParams;
	progress: WorkloadProgress;
	runId: string;
}): Promise<void> {
	const { runtime, db, owner, sessions, params, progress, runId } = opts;
	let nextSession = 0;

	const runSession = async (sessionIndex: number, session: Session): Promise<void> => {
		for (let turn = 0; turn < params.turns; turn++) {
			const startedAt = Date.now();
			const startedPerf = performance.now();
			let settled: { status: "done" } | { status: "unanswered"; reason: string };
			try {
				const submissionId = await runtime.submit(
					session.id,
					owner,
					`soak session ${sessionIndex} turn ${turn} (${runId})`,
					`${runId}-s${sessionIndex}-t${turn}`,
				);
				settled = await settleTurn(runtime, owner, session.id, submissionId, params.turnTimeoutMs);
			} catch (err) {
				settled = { status: "unanswered", reason: (err as Error).message };
			}
			if (settled.status !== "done") {
				progress.failures.push({
					sessionIndex,
					turn,
					message: `session ${sessionIndex} turn ${turn}: ${settled.reason}`,
					at: new Date().toISOString(),
				});
				return;
			}
			const elapsed = performance.now() - startedPerf;
			progress.turnsDone++;
			progress.toolCallsDone += params.toolsPerTurn;
			progress.latenciesMs.push(elapsed);
			if (turn < 2 || turn % 10 === 0) await observeParallelism(db, session.id, startedAt, progress).catch(() => {});
		}
	};

	const worker = async (): Promise<void> => {
		for (;;) {
			const index = nextSession++;
			if (index >= sessions.length) return;
			const session = sessions[index];
			if (!session) return;
			await runSession(index, session);
		}
	};
	await Promise.all(Array.from({ length: Math.min(params.concurrency, sessions.length) }, () => worker()));
	await runtime.waitForIdle();
	progress.endedAt = performance.now();
}
