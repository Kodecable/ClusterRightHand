/** Builds summary.md from the collected samples and the child's final counters. */
import { resolve } from "node:path";
import type { RuntimeStats } from "./ipc.ts";
import type { WarningSummary } from "./outcome.ts";
import type { SoakParams } from "./params.ts";
import type { PprofCapture } from "./pprof.ts";
import type { SampleRow } from "./sample.ts";

export interface SummaryInput {
	params: SoakParams;
	samples: SampleRow[];
	stats: RuntimeStats | undefined;
	nodes: { nodeId: string; container: string }[];
	startedAt: string;
	errors: string[];
	warnings: WarningSummary[];
	interrupted: boolean;
	/** PPROF=1 only: the configured points, what was captured, and the short-lived socket root. */
	pprof?: { points: number[]; captures: PprofCapture[]; socketDir?: string };
}

const round = (value: number, digits = 0): number => {
	const factor = 10 ** digits;
	return Math.round(value * factor) / factor;
};

const mb = (kb: number): string => `${round(kb / 1024, 1)} MiB`;
const mib = (bytes: number): string => `${round(bytes / 1024 ** 2, 2)} MiB`;

function peakFinal(samples: SampleRow[], value: (sample: SampleRow) => number): { peak: number; final: number } {
	let peak = 0;
	for (const sample of samples) {
		const current = value(sample);
		if (current > peak) peak = current;
	}
	return { peak, final: samples.length > 0 ? value(samples[samples.length - 1] as SampleRow) : 0 };
}

/**
 * Ordinary least squares of RSS (KiB) on turns done over the last half of the run, expressed as MiB per 1000
 * turns. `null` when there are fewer than three samples or no turn progress in the window.
 */
function slopePer1000Turns(samples: SampleRow[], value: (sample: SampleRow) => number): number | null {
	// Two points are not a trend: with only the initial and final sample the slope would report the whole jump.
	if (samples.length < 3) return null;
	const lastElapsed = samples.at(-1)?.elapsedS ?? 0;
	const half = samples.filter((sample) => sample.elapsedS >= lastElapsed / 2);
	if (half.length < 2) return null;
	const xs = half.map((sample) => sample.turnsDone);
	const ys = half.map((sample) => value(sample));
	const meanX = xs.reduce((a, b) => a + b, 0) / xs.length;
	const meanY = ys.reduce((a, b) => a + b, 0) / ys.length;
	let covariance = 0;
	let variance = 0;
	for (let index = 0; index < xs.length; index++) {
		const dx = (xs[index] as number) - meanX;
		covariance += dx * ((ys[index] as number) - meanY);
		variance += dx * dx;
	}
	if (variance === 0) return null;
	// KiB/turn -> MiB/1000 turns.
	return ((covariance / variance) * 1000) / 1024;
}

const yes = (value: boolean): string => (value ? "yes" : "no");
const pct = (point: number): string => `${Math.round(point * 100)}%`;

/** Single-quotes a path for a shell command line. */
const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

/** Absolute path of one capture file; the names match pprof.ts. */
function pprofFile(outDir: string, nodeIndex: number, process: "run" | "priv", point: number, ext: string): string {
	return resolve(outDir, "pprof", `node-${nodeIndex + 1}`, `${process}-heap-${Math.round(point * 100)}.${ext}`);
}

export function buildSummary(input: SummaryInput): string {
	const { params, samples, stats, nodes, startedAt, errors, warnings, interrupted } = input;
	const warningTotal = warnings.reduce((sum, warning) => sum + warning.count, 0);
	const last = samples.at(-1);
	const durationMs = stats?.durationMs ?? (last ? last.elapsedS * 1000 : 0);
	const durationS = durationMs / 1000;
	const turnsDone = stats?.turnsDone ?? last?.turnsDone ?? 0;
	const toolCallsDone = stats?.toolCallsDone ?? last?.toolCallsDone ?? 0;
	const totals = {
		turns: params.sessions * params.turns,
		toolCalls: params.sessions * params.turns * params.toolsPerTurn,
	};
	const lines: string[] = [];
	const push = (line = ""): void => {
		lines.push(line);
	};

	push(`# Soak run ${startedAt}`);
	push();
	if (interrupted) push("> Run was interrupted; the numbers are partial.");
	if (errors.length > 0) push(`> ${errors.length} orchestration error(s); see Failures.`);
	if (warningTotal > 0) {
		push(
			`> ${warningTotal} warning(s) in ${warnings.length} kind(s); see Warnings. Warnings never change the exit code.`,
		);
	}
	push();
	push("## Parameters");
	push();
	push("| Parameter | Value |");
	push("|---|---|");
	push(`| sessions | ${params.sessions} (${params.concurrency} concurrent) |`);
	push(`| turns per session | ${params.turns} |`);
	push(`| tool calls per turn | ${params.toolsPerTurn} |`);
	push(`| nodes | ${params.nodes} (forward mode) |`);
	push(`| privileged share | ${params.privRatio} |`);
	push(`| normal output bytes | ${params.outputBytes} |`);
	push(`| > 50 KB output share | ${params.bigOutputRatio} |`);
	push(`| sample interval | ${params.sampleSeconds} s |`);
	push(`| faux context window | ${params.contextWindow} tokens |`);
	push(
		`| pprof heap capture | ${params.pprof ? `on (${params.pprofPoints.map(pct).join(", ")} of tool calls)` : "off"} |`,
	);
	push(`| OUT_DIR | \`${params.outDir}\` |`);
	push();

	push("## Totals");
	push();
	push("| Metric | Value |");
	push("|---|---|");
	push(`| duration | ${(durationS / 60).toFixed(1)} min (${round(durationS, 1)} s) |`);
	push(`| session rows created | ${stats?.sessions ?? params.sessions} / ${params.sessions} |`);
	push(`| turns completed | ${turnsDone} / ${totals.turns} |`);
	push(`| tool calls completed | ${toolCallsDone} / ${totals.toolCalls} |`);
	push(`| tasks failed | ${stats?.tasksFailed ?? last?.tasksFailed ?? 0} |`);
	push(`| compactions | ${stats?.compactions ?? last?.compactions ?? 0} |`);
	push(`| samples | ${samples.length} |`);
	push();

	push("## Throughput");
	push();
	push("| Metric | Value |");
	push("|---|---|");
	push(`| turns/s | ${durationS > 0 ? round(turnsDone / durationS, 2) : "n/a"} |`);
	push(`| tool calls/s | ${durationS > 0 ? round(toolCallsDone / durationS, 2) : "n/a"} |`);
	if (stats?.turnP50Ms !== null && stats?.turnP50Ms !== undefined) {
		push(`| per-turn latency p50 / p95 | ${round(stats.turnP50Ms, 1)} ms / ${round(stats.turnP95Ms ?? 0, 1)} ms |`);
	}
	push();

	push("## Memory (RSS)");
	push();
	push("| Process | Peak | Final | Slope, last half (MiB / 1000 turns) |");
	push("|---|---:|---:|---:|");
	const crhs = peakFinal(samples, (sample) => sample.crhsRssKb);
	push(
		`| crhs child (runtime + driver) | ${mb(crhs.peak)} | ${mb(crhs.final)} | ${slopeText(
			slopePer1000Turns(samples, (sample) => sample.crhsRssKb),
		)} |`,
	);
	for (let index = 0; index < params.nodes; index++) {
		const run = peakFinal(samples, (sample) => sample.nodes[index]?.rssRunKb ?? 0);
		const priv = peakFinal(samples, (sample) => sample.nodes[index]?.rssPrivKb ?? 0);
		push(
			`| node ${index + 1} \`crha run\` | ${mb(run.peak)} | ${mb(run.final)} | ${slopeText(
				slopePer1000Turns(samples, (sample) => sample.nodes[index]?.rssRunKb ?? 0),
			)} |`,
		);
		push(
			`| node ${index + 1} \`crha privileged run\` | ${mb(priv.peak)} | ${mb(priv.final)} | ${slopeText(
				slopePer1000Turns(samples, (sample) => sample.nodes[index]?.rssPrivKb ?? 0),
			)} |`,
		);
	}
	push();
	push("The crhs RSS includes the workload driver in the same process (the caveat in the README).");
	push();

	if (input.pprof) {
		const { points, captures } = input.pprof;
		const ordered = [...captures].sort((a, b) => a.point - b.point);
		push("## pprof");
		push();
		push(
			`Debug crha build (\`-tags pprof\`). Heap profiles were requested at ${points
				.map(pct)
				.join(", ")} of the ${totals.toolCalls} tool calls; each point stores a binary profile ` +
				"(`{run,priv}-heap-<pct>.pb.gz`, for `go tool pprof -base`) and the `?debug=1` text " +
				"(`...-<pct>.txt`, whose tail is runtime.MemStats).",
		);
		push();
		if (input.pprof.socketDir) {
			push(
				`The debug sockets are kept in the short per-run directory \`${input.pprof.socketDir}\` (one ` +
					"`node-N` subdirectory per node, bind-mounted at `/pprof`) so the host socket path stays below " +
					"the unix `sun_path` limit; the heap profiles themselves are under `OUT_DIR/pprof/node-N`. " +
					"The harness removes this directory at teardown (best effort; a failure is a warning).",
			);
			push();
		}
		if (ordered.length === 0) {
			push("No heap capture succeeded; see Failures.");
			push();
		} else {
			push("| Point | Tool calls | Node | Process | HeapAlloc | HeapInuse | HeapReleased | Sys | RSS |");
			push("|---|---:|---:|---|---:|---:|---:|---:|---:|");
			for (const capture of ordered) {
				for (const node of [...capture.nodes].sort((a, b) => a.nodeIndex - b.nodeIndex)) {
					push(
						`| ${pct(capture.point)} | ${capture.toolCallsDone} | ${node.nodeIndex + 1} | \`crha run\` | ` +
							`${mb(node.run.allocKb)} | ${mb(node.run.inuseKb)} | ${mb(node.run.releasedKb)} | ` +
							`${mb(node.run.sysKb)} | ${mb(node.rssRunKb)} |`,
					);
					push(
						`| ${pct(capture.point)} | ${capture.toolCallsDone} | ${node.nodeIndex + 1} | ` +
							`\`crha privileged run\` | ${mb(node.priv.allocKb)} | ${mb(node.priv.inuseKb)} | ` +
							`${mb(node.priv.releasedKb)} | ${mb(node.priv.sysKb)} | ${mb(node.rssPrivKb)} |`,
					);
				}
			}
			push();

			push("### pprof files");
			push();
			push("| Point | Node | Process | Binary profile | Text profile |");
			push("|---|---:|---|---|---|");
			for (const capture of ordered) {
				for (const node of [...capture.nodes].sort((a, b) => a.nodeIndex - b.nodeIndex)) {
					for (const process of ["run", "priv"] as const) {
						const base = `pprof/node-${node.nodeIndex + 1}/${process}-heap-${Math.round(capture.point * 100)}`;
						push(
							`| ${pct(capture.point)} | ${node.nodeIndex + 1} | \`crha ${
								process === "run" ? "run" : "privileged run"
							}\` | \`${base}.pb.gz\` | \`${base}.txt\` |`,
						);
					}
				}
			}
			push();

			const commands: string[] = [];
			const nodeIndexes = [...new Set(ordered.flatMap((capture) => capture.nodes.map((node) => node.nodeIndex)))].sort(
				(a, b) => a - b,
			);
			for (const nodeIndex of nodeIndexes) {
				for (const process of ["run", "priv"] as const) {
					const withNode = ordered.filter((capture) => capture.nodes.some((node) => node.nodeIndex === nodeIndex));
					const first = withNode[0];
					const last = withNode.at(-1);
					if (!first || !last || first.point === last.point) continue;
					commands.push(
						`go tool pprof -top -base ${shellQuote(
							pprofFile(params.outDir, nodeIndex, process, first.point, "pb.gz"),
						)} ${shellQuote(pprofFile(params.outDir, nodeIndex, process, last.point, "pb.gz"))}`,
					);
				}
			}
			if (commands.length > 0) {
				push("Compare the first and last capture (absolute paths, `-base` subtracts the first):");
				push();
				push("```sh");
				for (const command of commands) push(command);
				push("```");
				push();
			} else {
				push("At least two capture points are needed before `go tool pprof -top -base` can compare them.");
				push();
			}
		}
	}

	push("## Disk");
	push();
	push("| Item | Final size | Bytes per completed tool call |");
	push("|---|---:|---:|");
	const crhsDb = last?.crhsDbBytes ?? 0;
	const crhsWal = last?.crhsDbWalBytes ?? 0;
	const durable = last?.durableDirBytes ?? 0;
	const perCall = (bytes: number): string => (toolCallsDone > 0 ? `${round(bytes / toolCallsDone, 1)} B` : "n/a");
	push(`| crhs SQLite db | ${mib(crhsDb)} | ${perCall(crhsDb)} |`);
	push(`| crhs SQLite WAL | ${mib(crhsWal)} | ${perCall(crhsWal)} |`);
	push(`| crhs db + WAL | ${mib(crhsDb + crhsWal)} | ${perCall(crhsDb + crhsWal)} |`);
	push(`| durable agent storage dir | ${mib(durable)} | ${perCall(durable)} |`);
	push();

	push(
		"| Node | Container | State dir (incl. output) | Output dir | /var/log/crha | used lines | Bytes per tool call |",
	);
	push("|---|---|---:|---:|---:|---:|---:|");
	for (let index = 0; index < params.nodes; index++) {
		const node = last?.nodes[index];
		const stateBytes = (node?.stateKb ?? 0) * 1024;
		const logBytes = (node?.logKb ?? 0) * 1024;
		push(
			`| ${index + 1} | \`${nodes[index]?.container ?? "?"}\` | ${mib(stateBytes)} | ${mib(
				(node?.outputKb ?? 0) * 1024,
			)} | ${mib(logBytes)} | ${node?.usedLines ?? 0} | ${perCall(stateBytes + logBytes)} |`,
		);
	}
	push();
	push(
		"The node state dir already contains the output directory; bytes per tool call counts the state dir plus logs once.",
	);
	push();

	push("## Tool call execution");
	push();
	const parallelism = stats?.parallelism;
	if (parallelism && parallelism.roundsObserved > 0) {
		push(
			`Observed ${parallelism.roundsObserved} turn(s): ${parallelism.parallelRounds} parallel, ` +
				`${parallelism.sequentialRounds} sequential; max concurrent tasks in one round ${parallelism.maxConcurrency}.`,
		);
		push("Measured from the tasks' created/dispatched/finished timestamps in crhs's database.");
	} else {
		push("No tool round was observed before the run ended.");
	}
	push();

	push("## Warnings");
	push();
	if (warnings.length === 0) {
		push("None.");
	} else {
		push("Transient sampling or teardown problems: the affected sample (or node columns) was skipped, or a");
		push("container could not be removed. The run continued; warnings never change the exit code.");
		push();
		push("| Kind | Count |");
		push("|---|---:|");
		for (const warning of warnings) push(`| ${warning.kind} | ${warning.count} |`);
		push();
		push("First messages per kind:");
		push();
		for (const warning of warnings) {
			push(`- **${warning.kind}** (${warning.count}):`);
			for (const message of warning.first) push(`  - ${message}`);
		}
	}
	push();

	push("## Failures");
	push();
	const failures = [...(stats?.failures ?? []), ...errors];
	if (failures.length === 0 && (stats?.tasksFailed ?? 0) === 0) {
		push("None.");
	} else {
		for (const failure of errors) push(`- orchestration: ${failure}`);
		for (const failure of stats?.failures ?? []) {
			push(`- session ${failure.sessionIndex} turn ${failure.turn} (${failure.at}): ${failure.message}`);
		}
		if ((stats?.tasksFailed ?? 0) > 0)
			push(`- ${stats?.tasksFailed} task(s) in the database failed or exited non-zero`);
	}
	push();
	push(`CSV: [samples.csv](./samples.csv). Interrupted: ${yes(interrupted)}.`);
	return `${lines.join("\n")}\n`;
}

function slopeText(slope: number | null): string {
	return slope === null ? "n/a" : slope.toFixed(3);
}
