/** Sampling: cheap disk reads from the host, one `podman exec` per node, and the CSV row shape. */
import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { podman } from "../system/privileged/harness.ts";

/** runtime.MemStats fields from a heap?debug=1 capture, in KiB. */
export interface HeapStats {
	allocKb: number;
	inuseKb: number;
	releasedKb: number;
	sysKb: number;
}

export interface NodeSample {
	rssRunKb: number;
	rssPrivKb: number;
	stateKb: number;
	outputKb: number;
	logKb: number;
	usedLines: number;
	/** PPROF=1 only: the latest debug=1 MemStats of `crha run`. */
	heapRun?: HeapStats;
	/** PPROF=1 only: the latest debug=1 MemStats of `crha privileged run`. */
	heapPriv?: HeapStats;
}

export interface SampleRow {
	time: string;
	elapsedS: number;
	turnsDone: number;
	toolCallsDone: number;
	tasksFailed: number;
	crhsRssKb: number;
	crhsHeapUsedKb: number;
	crhsDbBytes: number;
	crhsDbWalBytes: number;
	durableDirBytes: number;
	sessionsCount: number;
	tasksCount: number;
	auditEventsCount: number;
	piEntriesCount: number;
	compactions: number;
	turnP50Ms: number | null;
	turnP95Ms: number | null;
	/** One entry per configured node; `undefined` means that node's sample failed and its columns stay empty. */
	nodes: (NodeSample | undefined)[];
}

/** Reads VmRSS from /proc; 0 when the process is gone. */
export async function readVmRssKb(pid: number): Promise<number> {
	try {
		const text = await readFile(`/proc/${pid}/status`, "utf8");
		const match = /^VmRSS:\s+(\d+)\s+kB/m.exec(text);
		return match?.[1] ? Number(match[1]) : 0;
	} catch {
		return 0;
	}
}

async function fileSize(path: string): Promise<number> {
	try {
		return (await stat(path)).size;
	} catch {
		return 0;
	}
}

async function directorySize(path: string): Promise<number> {
	let total = 0;
	let entries: Dirent[];
	try {
		entries = await readdir(path, { withFileTypes: true });
	} catch {
		return 0;
	}
	for (const entry of entries) {
		const full = join(path, entry.name);
		if (entry.isDirectory()) total += await directorySize(full);
		else total += await fileSize(full);
	}
	return total;
}

export interface CrhsDisk {
	dbBytes: number;
	walBytes: number;
	durableDirBytes: number;
}

export async function readCrhsDisk(dbPath: string, durableDir: string): Promise<CrhsDisk> {
	return {
		dbBytes: await fileSize(dbPath),
		walBytes: await fileSize(`${dbPath}-wal`),
		durableDirBytes: await directorySize(durableDir),
	};
}

/** One shell script per node, so a sample costs one `podman exec` per container. */
const NODE_SCRIPT = `set +e
rss_run=0
rss_priv=0
pid_run=$(cat /run/priv/crha.pid 2>/dev/null)
pid_priv=$(cat /run/priv/priv.pid 2>/dev/null)
if [ -n "$pid_run" ] && kill -0 "$pid_run" 2>/dev/null; then
	rss_run=$(ps -o rss= -p "$pid_run" 2>/dev/null | tr -d ' ')
fi
if [ -n "$pid_priv" ] && kill -0 "$pid_priv" 2>/dev/null; then
	rss_priv=$(ps -o rss= -p "$pid_priv" 2>/dev/null | tr -d ' ')
fi
state_kb=$(du -sk /var/lib/crha 2>/dev/null | cut -f1)
output_kb=$(du -sk /var/lib/crha/output 2>/dev/null | cut -f1)
log_kb=$(du -sk /var/log/crha 2>/dev/null | cut -f1)
used_lines=0
if [ -f /var/lib/crha/privileged/used ]; then
	used_lines=$(wc -l < /var/lib/crha/privileged/used 2>/dev/null | tr -d ' ')
fi
printf 'rss_run=%s\\n' "\${rss_run:-0}"
printf 'rss_priv=%s\\n' "\${rss_priv:-0}"
printf 'state_kb=%s\\n' "\${state_kb:-0}"
printf 'output_kb=%s\\n' "\${output_kb:-0}"
printf 'log_kb=%s\\n' "\${log_kb:-0}"
printf 'used_lines=%s\\n' "\${used_lines:-0}"
`;

export async function sampleNode(container: string): Promise<NodeSample> {
	const result = await podman(["exec", container, "sh", "-c", NODE_SCRIPT], { timeout: 30_000 });
	if (result.code !== 0) {
		throw new Error(
			`podman exec ${container} failed (${result.code}): ${result.stderr.trim() || result.stdout.trim()}`,
		);
	}
	const values: Record<string, number> = {};
	for (const line of result.stdout.split("\n")) {
		const match = /^([a-z_]+)=(\d+)$/.exec(line.trim());
		if (match?.[1] && match[2]) values[match[1]] = Number(match[2]);
	}
	return {
		rssRunKb: values.rss_run ?? 0,
		rssPrivKb: values.rss_priv ?? 0,
		stateKb: values.state_kb ?? 0,
		outputKb: values.output_kb ?? 0,
		logKb: values.log_kb ?? 0,
		usedLines: values.used_lines ?? 0,
	};
}

const BASE_COLUMNS = [
	"time",
	"elapsed_s",
	"turns_done",
	"tool_calls_done",
	"tasks_failed",
	"crhs_rss_kb",
	"crhs_heap_used_kb",
	"crhs_db_bytes",
	"crhs_db_wal_bytes",
	"durable_dir_bytes",
	"sessions_count",
	"tasks_count",
	"audit_events_count",
	"pi_entries_count",
	"compactions",
	"turn_p50_ms",
	"turn_p95_ms",
] as const;

const NODE_COLUMNS = ["rss_run_kb", "rss_priv_kb", "state_kb", "output_kb", "log_kb", "used_lines"] as const;

/** Extra per-node columns with PPROF=1; the process name (run/priv) is part of each column. */
const PPROF_NODE_COLUMNS = [
	"run_heap_alloc_kb",
	"run_heap_inuse_kb",
	"run_heap_released_kb",
	"run_sys_kb",
	"priv_heap_alloc_kb",
	"priv_heap_inuse_kb",
	"priv_heap_released_kb",
	"priv_sys_kb",
] as const;

export function csvHeader(nodes: number, pprof = false): string {
	const columns: string[] = [...BASE_COLUMNS];
	for (let index = 1; index <= nodes; index++) {
		for (const column of NODE_COLUMNS) columns.push(`node_${index}_${column}`);
		if (pprof) for (const column of PPROF_NODE_COLUMNS) columns.push(`node_${index}_${column}`);
	}
	return `${columns.join(",")}\n`;
}

function csvValue(value: number | string | null): string {
	if (value === null) return "";
	const text = String(value);
	return text.includes(",") || text.includes('"') || text.includes("\n") ? `"${text.replaceAll('"', '""')}"` : text;
}

export function csvRow(sample: SampleRow, pprof = false): string {
	const values: (number | string | null)[] = [
		sample.time,
		sample.elapsedS.toFixed(1),
		sample.turnsDone,
		sample.toolCallsDone,
		sample.tasksFailed,
		sample.crhsRssKb,
		sample.crhsHeapUsedKb,
		sample.crhsDbBytes,
		sample.crhsDbWalBytes,
		sample.durableDirBytes,
		sample.sessionsCount,
		sample.tasksCount,
		sample.auditEventsCount,
		sample.piEntriesCount,
		sample.compactions,
		sample.turnP50Ms,
		sample.turnP95Ms,
	];
	for (const node of sample.nodes) {
		if (!node) {
			for (let index = 0; index < NODE_COLUMNS.length; index++) values.push(null);
			if (pprof) for (let index = 0; index < PPROF_NODE_COLUMNS.length; index++) values.push(null);
			continue;
		}
		values.push(node.rssRunKb, node.rssPrivKb, node.stateKb, node.outputKb, node.logKb, node.usedLines);
		if (!pprof) continue;
		const run = node.heapRun;
		const priv = node.heapPriv;
		values.push(
			run?.allocKb ?? null,
			run?.inuseKb ?? null,
			run?.releasedKb ?? null,
			run?.sysKb ?? null,
			priv?.allocKb ?? null,
			priv?.inuseKb ?? null,
			priv?.releasedKb ?? null,
			priv?.sysKb ?? null,
		);
	}
	return `${values.map(csvValue).join(",")}\n`;
}

export function emptySample(time: string, elapsedS: number, nodes: number): SampleRow {
	return {
		time,
		elapsedS,
		turnsDone: 0,
		toolCallsDone: 0,
		tasksFailed: 0,
		crhsRssKb: 0,
		crhsHeapUsedKb: 0,
		crhsDbBytes: 0,
		crhsDbWalBytes: 0,
		durableDirBytes: 0,
		sessionsCount: 0,
		tasksCount: 0,
		auditEventsCount: 0,
		piEntriesCount: 0,
		compactions: 0,
		turnP50Ms: null,
		turnP95Ms: null,
		nodes: Array.from({ length: nodes }, () => ({
			rssRunKb: 0,
			rssPrivKb: 0,
			stateKb: 0,
			outputKb: 0,
			logKb: 0,
			usedLines: 0,
		})),
	};
}
