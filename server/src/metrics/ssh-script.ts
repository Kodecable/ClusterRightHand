/**
 * The fixed read-only script crhs runs on an SSH node for one host-metrics sample, and the parser that
 * turns its output into the same raw shape `metrics.collect` returns (doc/design/metrics.md "SSH nodes").
 *
 * The script uses only `cat`, `df -P -B1 /` and POSIX shell builtins, so it runs on dash and busybox ash.
 * Every section starts with a marker line; a section that could not be read is empty and its parser
 * returns nothing, so a missing value stays absent rather than becoming zero.
 */
import {
	MAX_METRICS_CORES,
	type MetricsCore,
	type MetricsCPU,
	type MetricsCPUTotal,
	type MetricsDisk,
	type MetricsInterface,
	type MetricsLoads,
	type MetricsMemory,
	type MetricsSnapshot,
	type MetricsSwap,
} from "@crh/protocol";

/** The marker prefix of one section; the section name follows it. */
const SECTION_PREFIX = "crh-metrics:";

/**
 * The script itself. Each source is preceded by its marker so the parser does not depend on the order
 * or completeness of the files. A source that cannot be read prints nothing after its marker. The
 * final marker tells the collector that the script ran to the end; a channel that closed early is a
 * failed sample, not a sample with every field missing.
 */
export const SSH_METRICS_SCRIPT = [
	"printf 'crh-metrics:boot_id\\n'",
	"cat /proc/sys/kernel/random/boot_id 2>/dev/null",
	"printf 'crh-metrics:uptime\\n'",
	"cat /proc/uptime 2>/dev/null",
	"printf 'crh-metrics:stat\\n'",
	"while IFS= read -r crh_line; do",
	"case $crh_line in",
	"cpu*) printf '%s\\n' \"$crh_line\" ;;",
	"esac",
	"done < /proc/stat 2>/dev/null",
	"printf 'crh-metrics:loadavg\\n'",
	"cat /proc/loadavg 2>/dev/null",
	"printf 'crh-metrics:meminfo\\n'",
	"cat /proc/meminfo 2>/dev/null",
	"printf 'crh-metrics:df\\n'",
	"df -P -B1 / 2>/dev/null",
	"printf 'crh-metrics:route\\n'",
	"cat /proc/net/route 2>/dev/null",
	"printf 'crh-metrics:netdev\\n'",
	"cat /proc/net/dev 2>/dev/null",
	"printf 'crh-metrics:end\\n'",
	"exit 0",
].join("\n");

const MAX_UINT64 = (1n << 64n) - 1n;

/** Whether the script printed its final marker, so the output is a whole answer rather than a fragment. */
export function sshMetricsScriptComplete(output: string): boolean {
	return splitSections(output).has("end");
}

/**
 * Parses the script output into the raw sample shape. Missing or malformed sections become absent
 * fields; the caller only checks {@link sshMetricsScriptComplete} to tell a complete answer from a
 * channel that closed early.
 */
export function parseSshMetricsScript(output: string): MetricsSnapshot {
	const sections = splitSections(output);
	const snapshot: MetricsSnapshot = {};

	const bootId = textSection(sections, "boot_id").trim();
	if (bootId !== "") snapshot.bootId = bootId;

	const uptime = parseUptime(textSection(sections, "uptime"));
	if (uptime !== undefined) snapshot.uptimeSec = uptime;

	const cpu = parseStat(textSection(sections, "stat"));
	if (cpu !== undefined) snapshot.cpu = cpu;

	const loads = parseLoads(textSection(sections, "loadavg"));
	if (loads !== undefined) snapshot.loads = loads;

	const meminfo = parseMeminfo(textSection(sections, "meminfo"));
	const memory = memoryOf(meminfo);
	if (memory !== undefined) snapshot.memory = memory;
	const swap = swapOf(meminfo);
	if (swap !== undefined) snapshot.swap = swap;

	const disk = parseRootFilesystem(textSection(sections, "df"));
	if (disk !== undefined) snapshot.disks = [disk];

	// The script reports the root filesystem and the default route's interface; there is no crha.toml
	// on an SSH node (doc/design/metrics.md "SSH nodes").
	const interfaceName = defaultRouteInterface(textSection(sections, "route"));
	if (interfaceName !== undefined) {
		const iface = parseNetDevInterface(textSection(sections, "netdev"), interfaceName);
		if (iface !== undefined) snapshot.interfaces = [iface];
	}

	return snapshot;
}

/** Splits the output into sections by marker line; lines before the first marker are ignored. */
function splitSections(output: string): Map<string, string> {
	const sections = new Map<string, string>();
	let current: string | undefined;
	let lines: string[] = [];
	const flush = (): void => {
		if (current === undefined) return;
		const previous = sections.get(current);
		sections.set(current, previous === undefined ? lines.join("\n") : `${previous}\n${lines.join("\n")}`);
	};
	for (const rawLine of output.split("\n")) {
		const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
		if (line.startsWith(SECTION_PREFIX)) {
			const name = line.slice(SECTION_PREFIX.length).trim();
			if (/^[a-z_]+$/.test(name)) {
				flush();
				current = name;
				lines = [];
				continue;
			}
		}
		if (current !== undefined) lines.push(line);
	}
	flush();
	return sections;
}

function textSection(sections: ReadonlyMap<string, string>, name: string): string {
	return sections.get(name) ?? "";
}

function firstLine(text: string): string {
	return text.split("\n")[0] ?? "";
}

/** `/proc/uptime`'s first field, truncated to whole seconds like crha does. */
function parseUptime(text: string): number | undefined {
	const field = firstLine(text).trim().split(/\s+/)[0] ?? "";
	// An absent section must not become Number("") === 0.
	if (!/^\d+(?:\.\d+)?$/.test(field)) return undefined;
	const value = Number(field);
	if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) return undefined;
	return Math.trunc(value);
}

/** The `cpu` and `cpu<n>` lines of /proc/stat (doc/design/metrics.md "crha nodes"). */
function parseStat(text: string): MetricsCPU | undefined {
	let total: MetricsCPUTotal | undefined;
	const cores: MetricsCore[] = [];
	for (const rawLine of text.split("\n")) {
		const fields = rawLine.trim().split(/\s+/);
		const label = fields[0];
		if (label === undefined || label === "") continue;
		if (label === "cpu") {
			const counters = parseCPULine(fields.slice(1));
			if (counters === undefined) return undefined;
			total = counters;
			continue;
		}
		if (!/^cpu\d+$/.test(label)) continue;
		// The first MAX_METRICS_CORES cores are kept, and a malformed line beyond them is ignored like
		// crha ignores it (doc/design/metrics.md "Limits").
		if (cores.length >= MAX_METRICS_CORES) continue;
		const index = Number(label.slice(3));
		if (!Number.isSafeInteger(index)) return undefined;
		const counters = parseCPULine(fields.slice(1));
		if (counters === undefined) return undefined;
		cores.push({ index, busy: counters.busy, total: counters.total });
	}
	if (total === undefined) return undefined;
	return { total, cores };
}

/**
 * One /proc/stat CPU line: the first eight counters are user, nice, system, idle, iowait, irq, softirq
 * and steal; guest and guest_nice are already counted in user and nice. Busy is total minus idle and
 * iowait, as crha computes it (doc/design/metrics.md "crha nodes").
 */
function parseCPULine(fields: readonly string[]): MetricsCPUTotal | undefined {
	if (fields.length < 4) return undefined;
	let total = 0n;
	let idle = 0n;
	let iowait = 0n;
	for (let i = 0; i < fields.length && i < 8; i++) {
		const field = fields[i] as string;
		if (!/^\d+$/.test(field)) return undefined;
		const value = BigInt(field);
		if (value > MAX_UINT64) return undefined;
		if (i === 3) idle = value;
		if (i === 4) iowait = value;
		total += value;
	}
	if (idle + iowait > total || total > MAX_UINT64) return undefined;
	return { busy: total - idle - iowait, total };
}

/** /proc/loadavg's three values in thousandths, exactly as /proc prints them with two decimals. */
function parseLoads(text: string): MetricsLoads | undefined {
	const fields = firstLine(text).trim().split(/\s+/);
	if (fields.length < 3) return undefined;
	const loads: number[] = [];
	for (let i = 0; i < 3; i++) {
		const value = Number(fields[i]);
		if (!Number.isFinite(value) || value < 0) return undefined;
		const thousandths = Math.round(value * 1000);
		if (!Number.isSafeInteger(thousandths)) return undefined;
		loads.push(thousandths);
	}
	const [l1, l5, l15] = loads;
	if (l1 === undefined || l5 === undefined || l15 === undefined) return undefined;
	return { l1, l5, l15 };
}

/** /proc/meminfo's `Key: N kB` lines in bytes. A malformed line provides none of its keys. */
function parseMeminfo(text: string): Map<string, bigint> {
	const values = new Map<string, bigint>();
	for (const line of text.split("\n")) {
		const colon = line.indexOf(":");
		if (colon < 0) continue;
		const key = line.slice(0, colon).trim();
		const field = line
			.slice(colon + 1)
			.trim()
			.split(/\s+/)[0];
		if (key === "" || field === undefined || !/^\d+$/.test(field)) continue;
		const amount = BigInt(field);
		if (amount > MAX_UINT64 / 1024n) continue;
		values.set(key, amount * 1024n);
	}
	return values;
}

/** Memory needs all four values; a missing one makes the group absent, not zero. */
function memoryOf(values: ReadonlyMap<string, bigint>): MetricsMemory | undefined {
	const total = values.get("MemTotal");
	const available = values.get("MemAvailable");
	const cached = values.get("Cached");
	const free = values.get("MemFree");
	if (total === undefined || available === undefined || cached === undefined || free === undefined) {
		return undefined;
	}
	return { totalBytes: total, availableBytes: available, cachedBytes: cached, freeBytes: free };
}

/** Swap needs both values, so a kernel without swap still reports total 0 and free 0. */
function swapOf(values: ReadonlyMap<string, bigint>): MetricsSwap | undefined {
	const total = values.get("SwapTotal");
	const free = values.get("SwapFree");
	if (total === undefined || free === undefined) return undefined;
	return { totalBytes: total, freeBytes: free };
}

/**
 * The root filesystem from `df -P -B1 /`, as the series identity `root`
 * (doc/design/metrics.md "SSH nodes"). The parser accepts GNU and busybox layouts: the numbers may
 * follow the device on the same line, or begin the next line when a long device name wraps.
 */
function parseRootFilesystem(text: string): MetricsDisk | undefined {
	const lines = text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "");
	for (let i = lines.length - 1; i >= 0; i--) {
		const numbers: bigint[] = [];
		for (const field of (lines[i] as string).split(/\s+/)) {
			if (/^\d+$/.test(field)) numbers.push(BigInt(field));
			if (numbers.length === 2) break;
		}
		if (numbers.length === 2) {
			const [totalBytes, usedBytes] = numbers;
			if (totalBytes === undefined || usedBytes === undefined) return undefined;
			return { kind: "ok", name: "root", path: "/", totalBytes, usedBytes };
		}
	}
	return undefined;
}

/** The first default route's interface, skipping loopback (doc/design/metrics.md "SSH nodes"). */
function defaultRouteInterface(text: string): string | undefined {
	for (const line of text.split("\n")) {
		const fields = line.trim().split(/\s+/);
		if (fields.length < 2) continue;
		if ((fields[1] as string).toLowerCase() !== "00000000") continue;
		const name = fields[0] as string;
		if (/^lo\d*$/.test(name)) continue;
		return name;
	}
	return undefined;
}

/** One interface's line from /proc/net/dev: rx bytes and packets, then tx bytes and packets. */
function parseNetDevInterface(text: string, name: string): MetricsInterface | undefined {
	for (const rawLine of text.split("\n")) {
		const line = rawLine.trim();
		if (line === "" || line.includes("|")) continue;
		const colon = line.indexOf(":");
		if (colon < 0) continue;
		if (line.slice(0, colon).trim() !== name) continue;
		const fields = line
			.slice(colon + 1)
			.trim()
			.split(/\s+/);
		if (fields.length < 10) return undefined;
		const indexes = [0, 1, 8, 9];
		const numbers: bigint[] = [];
		for (const index of indexes) {
			const field = fields[index] as string;
			if (!/^\d+$/.test(field)) return undefined;
			const value = BigInt(field);
			if (value > MAX_UINT64) return undefined;
			numbers.push(value);
		}
		const [rxBytes, rxPackets, txBytes, txPackets] = numbers;
		if (rxBytes === undefined || rxPackets === undefined || txBytes === undefined || txPackets === undefined) {
			return undefined;
		}
		return { name, rxBytes, rxPackets, txBytes, txPackets };
	}
	return undefined;
}
