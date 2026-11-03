/**
 * The soak's outcome rule: which problems make a run fail, and which are only warnings.
 *
 * A warning is a transient orchestration hiccup: a periodic stats request that times out, a
 * `podman exec`/`du`/`ps` failure on one node, or a periodic pprof fetch that fails. The sample (or
 * that node's columns) is skipped, the run keeps going, and the warning is reported in summary.md
 * under `## Warnings`. Warnings are deliberately not an input to the exit-code decision.
 *
 * A failure is a result the run cannot report honestly: a workload failure or failed task, the
 * crhs child crashing or the workload not finishing, a final sample/stats request that still fails
 * after retries, a requested pprof point that still fails after retries, a container setup error,
 * or a summary that could not be written.
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Stable warning categories; summary.md groups the counts by these. */
export type WarningKind =
	| "stats sample"
	| "node sample"
	| "pprof sample"
	| "pprof capture"
	| "pprof socket cleanup"
	| "sample"
	| "container removal"
	| "leftover cleanup";

export interface WarningSummary {
	kind: WarningKind;
	count: number;
	/** The first few messages of this kind, whitespace-collapsed for one-line reporting. */
	first: string[];
}

interface WarningEntry {
	count: number;
	first: string[];
}

const MAX_EXAMPLES = 3;

/** Counts warnings per kind and keeps the first few messages of each kind. Never fails a run. */
export class WarningLog {
	private readonly entries = new Map<WarningKind, WarningEntry>();

	add(kind: WarningKind, message: string): void {
		const entry = this.entries.get(kind) ?? { count: 0, first: [] };
		entry.count += 1;
		// Keep a few distinct examples: a run with a hundred identical stats timeouts does not need a
		// hundred identical summary lines, but a different failure message should still be visible.
		if (entry.first.length < MAX_EXAMPLES) {
			const oneLine = message.replace(/\s+/g, " ").trim() || "(no message)";
			if (!entry.first.includes(oneLine)) entry.first.push(oneLine);
		}
		this.entries.set(kind, entry);
	}

	get total(): number {
		let total = 0;
		for (const entry of this.entries.values()) total += entry.count;
		return total;
	}

	snapshot(): WarningSummary[] {
		return [...this.entries].map(([kind, entry]) => ({
			kind,
			count: entry.count,
			first: [...entry.first],
		}));
	}
}

export interface ExitCodeInput {
	interrupted: boolean;
	/** Real failures only; warning text must never be added here. */
	errors: readonly string[];
	/** `stats.failures.length + stats.tasksFailed`. */
	workloadFailures: number;
	/** Reported for clarity and ignored on purpose: warnings never change the exit code. */
	warnings: number;
}

/** 130 for an interrupt, 1 when the run has real failures, 0 otherwise. Warnings are ignored. */
export function decideExitCode(input: ExitCodeInput): number {
	if (input.interrupted) return 130;
	return input.errors.length > 0 || input.workloadFailures > 0 ? 1 : 0;
}

/**
 * Tiny self-check, not part of the vitest suites: `node test/soak/outcome.ts` (from server/).
 * The interesting case is the one that mirrors the bug: warnings alone still exit 0.
 */
function selfCheck(): void {
	const cases: { name: string; input: ExitCodeInput; expected: number }[] = [
		{
			name: "clean run",
			input: { interrupted: false, errors: [], workloadFailures: 0, warnings: 0 },
			expected: 0,
		},
		{
			name: "warnings only (stats timeout, one node exec hiccup)",
			input: { interrupted: false, errors: [], workloadFailures: 0, warnings: 7 },
			expected: 0,
		},
		{
			name: "one real orchestration error",
			input: { interrupted: false, errors: ["final stats: stats request timed out"], workloadFailures: 0, warnings: 3 },
			expected: 1,
		},
		{
			name: "workload failures",
			input: { interrupted: false, errors: [], workloadFailures: 2, warnings: 0 },
			expected: 1,
		},
		{
			name: "interrupt wins over everything",
			input: { interrupted: true, errors: ["child exited"], workloadFailures: 1, warnings: 5 },
			expected: 130,
		},
	];
	let failed = 0;
	for (const test of cases) {
		const actual = decideExitCode(test.input);
		if (actual === test.expected) {
			console.log(`ok   ${test.name}: exit ${actual}`);
		} else {
			failed += 1;
			console.error(`FAIL ${test.name}: expected ${test.expected}, got ${actual}`);
		}
	}
	if (failed > 0) {
		process.exitCode = 1;
		return;
	}
	console.log(`outcome self-check: ${cases.length} case(s) passed`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	selfCheck();
}
