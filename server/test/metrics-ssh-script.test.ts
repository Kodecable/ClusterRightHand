import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { parseSshMetricsScript, SSH_METRICS_SCRIPT, sshMetricsScriptComplete } from "../src/metrics/ssh-script.ts";

/**
 * The fixed SSH metrics script and its parser (doc/design/metrics.md "SSH nodes"): the root filesystem
 * as `root`, the default route's interface, GNU and busybox df layouts, and missing sections as absent
 * fields rather than zeros.
 */

const GNU_OUTPUT = `crh-metrics:boot_id
11111111-2222-3333-4444-555555555555
crh-metrics:uptime
12345.67 99999.00
crh-metrics:stat
cpu  100 2 30 400 5 6 7 8 0 0
cpu0 50 1 15 200 2 3 4 5 0 0
cpu1 50 1 15 200 3 3 3 3 0 0
intr 12345
ctxt 67890
crh-metrics:loadavg
1.23 0.50 0.25 2/123 4567
crh-metrics:meminfo
MemTotal:       16384000 kB
MemFree:         1000000 kB
MemAvailable:    8000000 kB
Buffers:          100000 kB
Cached:          2000000 kB
SwapTotal:       4096000 kB
SwapFree:        4000000 kB
crh-metrics:df
Filesystem     1B-blocks         Used    Available Capacity Mounted on
/dev/sda1    107374182400  42949672960 64424509440      40% /
crh-metrics:route
Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT
eth0\t00000000\t0100A8C0\t0003\t0\t0\t0\t00000000\t0\t0\t0
eth1\t0000A8C0\t00000000\t0001\t0\t0\t0\t00FFFFFF\t0\t0\t0
crh-metrics:netdev
Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 1000 10 0 0 0 0 0 0 1000 10 0 0 0 0 0 0
  eth0: 123456789 1000 0 0 0 0 0 0 987654321 900 0 0 0 0 0 0
crh-metrics:end
`;

const BUSYBOX_DF = `crh-metrics:boot_id
busybox-boot
crh-metrics:df
Filesystem           1B-blocks      Used Available Use% Mounted on
/dev/mapper/root
                     107374182400 42949672960 64424509440 40% /
crh-metrics:end
`;

describe("SSH metrics script", () => {
	it("is a POSIX sh script that uses only cat, df and shell builtins", () => {
		expect(() => execFileSync("/bin/sh", ["-n"], { input: SSH_METRICS_SCRIPT })).not.toThrow();
		expect(SSH_METRICS_SCRIPT).toContain("df -P -B1 /");
		expect(SSH_METRICS_SCRIPT).toContain("/proc/sys/kernel/random/boot_id");
		expect(SSH_METRICS_SCRIPT).toContain("/proc/net/route");
		expect(SSH_METRICS_SCRIPT).toContain("/proc/net/dev");
		// No external text tools: no awk, sed, grep, head, cut, sort, wc or similar.
		expect(SSH_METRICS_SCRIPT).not.toMatch(/\b(awk|sed|grep|egrep|head|tail|cut|tr|sort|uniq|wc)\b/);
		expect(SSH_METRICS_SCRIPT.trimEnd().endsWith("exit 0")).toBe(true);
	});

	it("parses a GNU host's complete output", () => {
		expect(sshMetricsScriptComplete(GNU_OUTPUT)).toBe(true);
		const snapshot = parseSshMetricsScript(GNU_OUTPUT);
		expect(snapshot.bootId).toBe("11111111-2222-3333-4444-555555555555");
		expect(snapshot.uptimeSec).toBe(12345);
		expect(snapshot.cpu).toEqual({
			total: { busy: 153n, total: 558n },
			cores: [
				{ index: 0, busy: 78n, total: 280n },
				{ index: 1, busy: 75n, total: 278n },
			],
		});
		expect(snapshot.loads).toEqual({ l1: 1230, l5: 500, l15: 250 });
		expect(snapshot.memory).toEqual({
			totalBytes: 16_777_216_000n,
			availableBytes: 8_192_000_000n,
			cachedBytes: 2_048_000_000n,
			freeBytes: 1_024_000_000n,
		});
		expect(snapshot.swap).toEqual({ totalBytes: 4_194_304_000n, freeBytes: 4_096_000_000n });
		expect(snapshot.disks).toEqual([
			{ kind: "ok", name: "root", path: "/", totalBytes: 107_374_182_400n, usedBytes: 42_949_672_960n },
		]);
		expect(snapshot.interfaces).toEqual([
			{ name: "eth0", rxBytes: 123_456_789n, rxPackets: 1_000n, txBytes: 987_654_321n, txPackets: 900n },
		]);
	});

	it("parses busybox df output whose long device name wrapped the numbers onto the next line", () => {
		expect(sshMetricsScriptComplete(BUSYBOX_DF)).toBe(true);
		const snapshot = parseSshMetricsScript(BUSYBOX_DF);
		expect(snapshot.bootId).toBe("busybox-boot");
		expect(snapshot.disks).toEqual([
			{ kind: "ok", name: "root", path: "/", totalBytes: 107_374_182_400n, usedBytes: 42_949_672_960n },
		]);
		// Missing sections are absent fields, never zeros.
		expect(snapshot.uptimeSec).toBeUndefined();
		expect(snapshot.cpu).toBeUndefined();
		expect(snapshot.memory).toBeUndefined();
		expect(snapshot.interfaces).toBeUndefined();
	});

	it("leaves interfaces absent when there is no default route", () => {
		const output = `crh-metrics:boot_id
b
crh-metrics:route
Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT
eth1\t0000A8C0\t00000000\t0001\t0\t0\t0\t00FFFFFF\t0\t0\t0
crh-metrics:netdev
  eth1: 10 1 0 0 0 0 0 0 20 2 0 0 0 0 0 0
crh-metrics:end
`;
		const snapshot = parseSshMetricsScript(output);
		expect(snapshot.interfaces).toBeUndefined();
		expect(snapshot.bootId).toBe("b");
	});

	it("skips a loopback default route and takes the next one", () => {
		const output = `crh-metrics:route
Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT
lo\t00000000\t00000000\t0001\t0\t0\t0\t00000000\t0\t0\t0
eth0\t00000000\t0100A8C0\t0003\t0\t0\t0\t00000000\t0\t0\t0
crh-metrics:netdev
  lo: 1 1 0 0 0 0 0 0 1 1 0 0 0 0 0 0
  eth0: 10 2 0 0 0 0 0 0 20 3 0 0 0 0 0 0
crh-metrics:end
`;
		const snapshot = parseSshMetricsScript(output);
		expect(snapshot.interfaces).toEqual([{ name: "eth0", rxBytes: 10n, rxPackets: 2n, txBytes: 20n, txPackets: 3n }]);
	});

	it("reports a default-route interface whose name only the byte form allows", () => {
		// `+`, `#` and non-ASCII are real Linux names that the old `[A-Za-z0-9_.:@-]` form dropped.
		for (const name of ["wg+0", "eth0#1", "网卡0"]) {
			const output = `crh-metrics:route
Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT
lo\t00000000\t00000000\t0001\t0\t0\t0\t00000000\t0\t0\t0
${name}\t00000000\t0100A8C0\t0003\t0\t0\t0\t00000000\t0\t0\t0
crh-metrics:netdev
  ${name}: 10 2 0 0 0 0 0 0 20 3 0 0 0 0 0 0
crh-metrics:end
`;
			const snapshot = parseSshMetricsScript(output);
			expect(snapshot.interfaces, name).toEqual([{ name, rxBytes: 10n, rxPackets: 2n, txBytes: 20n, txPackets: 3n }]);
		}
	});

	it("treats missing and malformed sections as absent fields", () => {
		const output = `crh-metrics:stat
cpu this is not a counter
cpu0 1 2 3 4
crh-metrics:meminfo
MemTotal: 1000 kB
MemFree: 500 kB
SwapTotal: 2000 kB
SwapFree: 1000 kB
crh-metrics:end
`;
		const snapshot = parseSshMetricsScript(output);
		expect(snapshot.cpu).toBeUndefined();
		expect(snapshot.memory).toBeUndefined();
		expect(snapshot.swap).toEqual({ totalBytes: 2_048_000n, freeBytes: 1_024_000n });
		expect(snapshot.disks).toBeUndefined();
		expect(snapshot.interfaces).toBeUndefined();
	});

	it("keeps swap total zero as a value", () => {
		const output = `crh-metrics:meminfo
SwapTotal: 0 kB
SwapFree: 0 kB
crh-metrics:end
`;
		expect(parseSshMetricsScript(output).swap).toEqual({ totalBytes: 0n, freeBytes: 0n });
	});

	it("treats an output without the end marker as incomplete", () => {
		expect(sshMetricsScriptComplete(GNU_OUTPUT)).toBe(true);
		expect(sshMetricsScriptComplete(GNU_OUTPUT.replace("crh-metrics:end\n", ""))).toBe(false);
		expect(sshMetricsScriptComplete("")).toBe(false);
	});

	it("drops a default-route interface name or core index outside the protocol's form", () => {
		for (const name of ["weird/name", "a".repeat(16), "a\u0007b", ".."]) {
			const snapshot = parseSshMetricsScript(`crh-metrics:stat
cpu  1 2 3 4
cpu0 1 2 3 4
cpu1024 1 2 3 4
crh-metrics:route
${name}\t00000000\t0100A8C0\t0003\t0\t0\t0\t00000000\t0\t0\t0
crh-metrics:netdev
  ${name}: 1 2 0 0 0 0 0 0 3 4 0 0 0 0 0 0
crh-metrics:end
`);
			// The invalid interface is not reported, and the core above the protocol's limit is skipped.
			expect(snapshot.interfaces, name).toBeUndefined();
			expect(snapshot.cpu?.cores).toEqual([{ index: 0, busy: 6n, total: 10n }]);
		}
	});
});
