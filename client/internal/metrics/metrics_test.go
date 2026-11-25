package metrics

import (
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
	"golang.org/x/sys/unix"
)

// writeFiles creates a fixture tree under root.
func writeFiles(t *testing.T, root string, files map[string]string) {
	t.Helper()
	for name, content := range files {
		path := filepath.Join(root, name)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

// devLine builds one well-formed /proc/net/dev data line with the given receive and transmit bytes
// and packets; the other twelve counters are zero.
func devLine(name string, rxBytes, rxPackets, txBytes, txPackets uint64) string {
	counters := make([]uint64, 16)
	counters[0], counters[1], counters[8], counters[9] = rxBytes, rxPackets, txBytes, txPackets
	parts := make([]string, len(counters))
	for i, value := range counters {
		parts[i] = fmt.Sprint(value)
	}
	return fmt.Sprintf("%s: %s", name, strings.Join(parts, " "))
}

const netDevHeader = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
`

func TestCollect(t *testing.T) {
	root := t.TempDir()
	writeFiles(t, root, map[string]string{
		"proc/sys/kernel/random/boot_id": "6f1e2d3c-4b5a-4978-8a9b-0c1d2e3f4a5b\n",
		"proc/uptime":                    "12345.67 99999.00\n",
		"proc/loadavg":                   "0.15 0.10 0.05 1/234 5678\n",
		"proc/stat": `cpu  100 20 30 400 50 10 5 2 7 9
cpu0 60 10 15 200 25 5 2 1 3 4
cpu1 40 10 15 200 25 5 3 1 4 5
cpu3 0 0 0 0 0 0 0 0 0 0
intr 12345
ctxt 67890
btime 1700000000
`,
		"proc/meminfo": `MemTotal:       16384000 kB
MemFree:         1000000 kB
MemAvailable:    8000000 kB
Cached:          2000000 kB
SwapCached:       123456 kB
SwapTotal:       2097152 kB
SwapFree:        1048576 kB
`,
		"proc/net/dev": netDevHeader + devLine("lo", 1000, 1, 2000, 2) + "\n" +
			devLine("eth0", 111, 2, 333, 4) + "\n" +
			devLine("docker0", 1, 1, 1, 1) + "\n" +
			devLine("wlan0", 555, 6, 777, 8) + "\n",
	})
	stats := map[string]Stats{
		"/":     {TotalBytes: 1000, UsedBytes: 400},
		"/data": {TotalBytes: 2000, UsedBytes: 1500},
	}
	collector := New(Options{
		Root:       root,
		Disks:      []Disk{{Name: "root", Path: "/"}, {Name: "data", Path: "/data"}},
		Statfs:     func(path string) (Stats, error) { return stats[path], nil },
		Interfaces: nil,
	})
	got := collector.Collect()

	wantBoot := "6f1e2d3c-4b5a-4978-8a9b-0c1d2e3f4a5b"
	wantUptime := protocol.Uint(12345)
	want := protocol.MetricsSnapshot{
		BootID:    &wantBoot,
		UptimeSec: &wantUptime,
		CPU: &protocol.MetricsCPU{
			Total: protocol.MetricsCPUTotal{Busy: 167, Total: 617},
			Cores: []protocol.MetricsCore{
				{Index: 0, Busy: 93, Total: 318},
				{Index: 1, Busy: 74, Total: 299},
				{Index: 3, Busy: 0, Total: 0},
			},
		},
		Loads: &protocol.MetricsLoads{L1: 150, L5: 100, L15: 50},
		Memory: &protocol.MetricsMemory{
			TotalBytes:     16384000 * 1024,
			AvailableBytes: 8000000 * 1024,
			CachedBytes:    2000000 * 1024,
			FreeBytes:      1000000 * 1024,
		},
		Swap: &protocol.MetricsSwap{TotalBytes: 2097152 * 1024, FreeBytes: 1048576 * 1024},
		Disks: []protocol.MetricsDisk{
			{Name: "root", Path: "/", TotalBytes: 1000, UsedBytes: 400},
			{Name: "data", Path: "/data", TotalBytes: 2000, UsedBytes: 1500},
		},
		Interfaces: []protocol.MetricsInterface{
			{Name: "eth0", RXBytes: 111, TXBytes: 333, RXPackets: 2, TXPackets: 4},
			{Name: "wlan0", RXBytes: 555, TXBytes: 777, RXPackets: 6, TXPackets: 8},
		},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Collect:\n got %#v\nwant %#v", got, want)
	}
}

func TestCollectMissingSources(t *testing.T) {
	got := New(Options{Root: t.TempDir()}).Collect()
	if got.BootID != nil || got.UptimeSec != nil || got.CPU != nil || got.Loads != nil ||
		got.Memory != nil || got.Swap != nil || got.Interfaces != nil {
		t.Fatalf("missing sources produced %#v", got)
	}
	if got.Disks == nil || len(got.Disks) != 0 {
		t.Fatalf("an empty disk configuration is an empty list, got %#v", got.Disks)
	}
}

func TestCPU(t *testing.T) {
	t.Run("offline core is absent", func(t *testing.T) {
		cpu, err := parseCPU([]byte("cpu 1 2 3 4 5 6 7 8\ncpu0 1 2 3 4 5 6 7 8\ncpu2 1 2 3 4 5 6 7 8\n"))
		if err != nil {
			t.Fatal(err)
		}
		if len(cpu.Cores) != 2 || cpu.Cores[0].Index != 0 || cpu.Cores[1].Index != 2 {
			t.Fatalf("cores = %#v", cpu.Cores)
		}
	})
	t.Run("malformed line", func(t *testing.T) {
		if _, err := parseCPU([]byte("cpu 1 2 x 4\n")); err == nil {
			t.Fatal("accepted a malformed cpu counter")
		}
		if _, err := parseCPU([]byte("cpu 1 2 3\n")); err == nil {
			t.Fatal("accepted a cpu line with three counters")
		}
		if _, err := parseCPU([]byte("intr 1\n")); err == nil {
			t.Fatal("accepted a /proc/stat without a cpu line")
		}
	})
	t.Run("truncates to the core limit", func(t *testing.T) {
		var b strings.Builder
		b.WriteString("cpu 0 0 0 0 0 0 0 0\n")
		for i := 0; i <= protocol.MaxMetricsCores; i++ {
			fmt.Fprintf(&b, "cpu%d 0 0 0 0 0 0 0 0\n", i)
		}
		cpu, err := parseCPU([]byte(b.String()))
		if err != nil {
			t.Fatal(err)
		}
		if len(cpu.Cores) != protocol.MaxMetricsCores {
			t.Fatalf("%d cores, want %d", len(cpu.Cores), protocol.MaxMetricsCores)
		}
		if last := cpu.Cores[len(cpu.Cores)-1].Index; last != protocol.Uint(protocol.MaxMetricsCores-1) {
			t.Fatalf("last core = %d", last)
		}
	})
}

func TestUptime(t *testing.T) {
	for _, value := range []string{"0.00 0.00\n", "12345.67 99999.00\n"} {
		if _, err := parseUptime([]byte(value)); err != nil {
			t.Fatalf("%q: %v", value, err)
		}
	}
	for _, value := range []string{"", "x 1.0\n", "-1.0 0.0\n", "NaN 0.0\n"} {
		if _, err := parseUptime([]byte(value)); err == nil {
			t.Fatalf("accepted %q", value)
		}
	}
}

func TestLoads(t *testing.T) {
	loads, err := parseLoads([]byte("0.15 0.10 0.05 1/234 5678\n"))
	if err != nil {
		t.Fatal(err)
	}
	if *loads != (protocol.MetricsLoads{L1: 150, L5: 100, L15: 50}) {
		t.Fatalf("loads = %#v", loads)
	}
	if _, err := parseLoads([]byte("0.15 0.10\n")); err == nil {
		t.Fatal("accepted two load averages")
	}
	if _, err := parseLoads([]byte("x 0.10 0.05\n")); err == nil {
		t.Fatal("accepted a malformed load average")
	}
}

func TestBootID(t *testing.T) {
	id, err := parseBootID([]byte("6f1e2d3c-4b5a-4978-8a9b-0c1d2e3f4a5b\n"))
	if err != nil || id != "6f1e2d3c-4b5a-4978-8a9b-0c1d2e3f4a5b" {
		t.Fatalf("boot id = %q, %v", id, err)
	}
	if _, err := parseBootID([]byte(" \n")); err == nil {
		t.Fatal("accepted an empty boot id")
	}
}

func TestMemory(t *testing.T) {
	meminfo := `MemTotal:       16384000 kB
MemFree:         1000000 kB
MemAvailable:    8000000 kB
Cached:          2000000 kB
SwapCached:       123456 kB
SwapTotal:       2097152 kB
SwapFree:        1048576 kB
`
	memory, swap, err := readMemoryAt(t, meminfo)
	if err != nil {
		t.Fatal(err)
	}
	if memory.CachedBytes != 2000000*1024 {
		t.Fatalf("cached = %d, want Cached and not SwapCached", memory.CachedBytes)
	}
	if swap.TotalBytes != 2097152*1024 || swap.FreeBytes != 1048576*1024 {
		t.Fatalf("swap = %#v", swap)
	}

	memory, swap, err = readMemoryAt(t, "MemTotal: 1 kB\nMemFree: 1 kB\nCached: 1 kB\nSwapTotal: 2 kB\nSwapFree: 1 kB\n")
	if err != nil {
		t.Fatal(err)
	}
	if memory != nil {
		t.Fatalf("memory without MemAvailable = %#v", memory)
	}
	if swap == nil {
		t.Fatal("swap was lost with an incomplete memory block")
	}

	memory, swap, err = readMemoryAt(t, "MemTotal: many kB\n")
	if err != nil {
		t.Fatal(err)
	}
	if memory != nil || swap != nil {
		t.Fatalf("malformed meminfo = %#v / %#v", memory, swap)
	}

	empty := t.TempDir()
	memory, swap, err = readMemory(empty)
	if err == nil || memory != nil || swap != nil {
		t.Fatalf("missing meminfo = %#v / %#v / %v", memory, swap, err)
	}
}

// readMemoryAt runs readMemory over a fixture tree holding data as /proc/meminfo.
func readMemoryAt(t *testing.T, data string) (*protocol.MetricsMemory, *protocol.MetricsSwap, error) {
	t.Helper()
	root := t.TempDir()
	writeFiles(t, root, map[string]string{"proc/meminfo": data})
	return readMemory(root)
}

func TestInterfaceSelection(t *testing.T) {
	lines := []string{
		devLine("lo", 1, 1, 1, 1),
		devLine("lo0", 1, 1, 1, 1),
		devLine("tun0", 1, 1, 1, 1),
		devLine("tap0", 1, 1, 1, 1),
		devLine("wg0", 1, 1, 1, 1),
		devLine("wg+0", 1, 1, 1, 1),
		devLine("utun0", 1, 1, 1, 1),
		devLine("docker0", 1, 1, 1, 1),
		devLine("veth123", 1, 1, 1, 1),
		devLine("br-1234", 1, 1, 1, 1),
		devLine("virbr0", 1, 1, 1, 1),
		devLine("lxcbr0", 1, 1, 1, 1),
		devLine("cni0", 1, 1, 1, 1),
		devLine("flannel.1", 1, 1, 1, 1),
		devLine("cali123", 1, 1, 1, 1),
		devLine("vxlan.calico", 1, 1, 1, 1),
		devLine("kube-ipvs0", 1, 1, 1, 1),
		devLine("eth0", 101, 2, 303, 4),
		devLine("eth1", 505, 6, 707, 8),
		// Names Linux allows that the old [A-Za-z0-9_.:@-] form dropped.
		devLine("eth0#1", 909, 10, 111, 12),
		devLine("网卡0", 131, 14, 151, 16),
	}
	root := t.TempDir()
	writeFiles(t, root, map[string]string{"proc/net/dev": netDevHeader + strings.Join(lines, "\n") + "\n"})
	got := New(Options{Root: root}).Collect().Interfaces
	want := []protocol.MetricsInterface{
		{Name: "eth0", RXBytes: 101, TXBytes: 303, RXPackets: 2, TXPackets: 4},
		{Name: "eth1", RXBytes: 505, TXBytes: 707, RXPackets: 6, TXPackets: 8},
		{Name: "eth0#1", RXBytes: 909, TXBytes: 111, RXPackets: 10, TXPackets: 12},
		{Name: "网卡0", RXBytes: 131, TXBytes: 151, RXPackets: 14, TXPackets: 16},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("default selection = %#v, want %#v", got, want)
	}

	// A configured list overrides the default: it may name lo and a tunnel that the default leaves out,
	// and a missing name is skipped.
	got = New(Options{Root: root, Interfaces: []string{"lo", "eth1", "gone", "wg+0"}}).Collect().Interfaces
	want = []protocol.MetricsInterface{
		{Name: "lo", RXBytes: 1, TXBytes: 1, RXPackets: 1, TXPackets: 1},
		{Name: "eth1", RXBytes: 505, TXBytes: 707, RXPackets: 6, TXPackets: 8},
		{Name: "wg+0", RXBytes: 1, TXBytes: 1, RXPackets: 1, TXPackets: 1},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("configured selection = %#v, want %#v", got, want)
	}
}

func TestInterfaceErrorsAndLimit(t *testing.T) {
	root := t.TempDir()
	writeFiles(t, root, map[string]string{"proc/net/dev": netDevHeader + "eth0: 1 2 3\n"})
	got := New(Options{Root: root}).Collect().Interfaces
	if got != nil {
		t.Fatalf("malformed /proc/net/dev produced %#v", got)
	}

	var b strings.Builder
	b.WriteString(netDevHeader)
	for i := 0; i <= protocol.MaxMetricsInterfaces; i++ {
		fmt.Fprintf(&b, "eth%d: 1 1 1 1 0 0 0 0 1 1 0 0 0 0 0 0\n", i)
	}
	root = t.TempDir()
	writeFiles(t, root, map[string]string{"proc/net/dev": b.String()})
	got = New(Options{Root: root}).Collect().Interfaces
	if len(got) != protocol.MaxMetricsInterfaces {
		t.Fatalf("%d interfaces, want %d", len(got), protocol.MaxMetricsInterfaces)
	}
}

func TestDisks(t *testing.T) {
	timeout := "statfs timed out"
	t.Run("success and error", func(t *testing.T) {
		collector := New(Options{
			Disks: []Disk{{Name: "root", Path: "/"}, {Name: "data", Path: "/data"}},
			Statfs: func(path string) (Stats, error) {
				if path == "/data" {
					return Stats{}, os.ErrNotExist
				}
				return Stats{TotalBytes: 10, UsedBytes: 4}, nil
			},
		})
		got := collector.Collect().Disks
		if len(got) != 2 || got[0].TotalBytes != 10 || got[0].UsedBytes != 4 || got[0].Error != nil {
			t.Fatalf("disks = %#v", got)
		}
		if got[1].Error == nil || *got[1].Error == "" {
			t.Fatalf("failed disk = %#v", got[1])
		}
	})
	t.Run("timeout", func(t *testing.T) {
		block := make(chan struct{})
		defer close(block)
		collector := New(Options{
			Disks: []Disk{{Name: "hung", Path: "/hung"}, {Name: "root", Path: "/"}},
			Statfs: func(path string) (Stats, error) {
				if path == "/hung" {
					<-block
				}
				return Stats{TotalBytes: 10, UsedBytes: 4}, nil
			},
			StatfsTimeout: 20 * time.Millisecond,
		})
		got := collector.Collect().Disks
		if len(got) != 2 || got[0].Error == nil || *got[0].Error != timeout {
			t.Fatalf("timed out disk = %#v", got)
		}
		if got[1].Error != nil || got[1].TotalBytes != 10 {
			t.Fatalf("fast disk behind the hung one = %#v", got[1])
		}
	})
	t.Run("empty and bounded", func(t *testing.T) {
		got := New(Options{}).Collect().Disks
		if got == nil || len(got) != 0 {
			t.Fatalf("empty configuration = %#v", got)
		}
		disks := make([]Disk, protocol.MaxMetricsDisks+1)
		for i := range disks {
			disks[i] = Disk{Name: fmt.Sprintf("d%d", i), Path: "/"}
		}
		got = New(Options{Disks: disks, Statfs: func(string) (Stats, error) { return Stats{}, nil }}).Collect().Disks
		if len(got) != protocol.MaxMetricsDisks {
			t.Fatalf("%d disks, want %d", len(got), protocol.MaxMetricsDisks)
		}
	})
}

// blockingStatfs is an injected Statfs that blocks calls to one path until release is closed, counts
// the calls per path, and reports fixed stats.
type blockingStatfs struct {
	blocked string
	release chan struct{}
	stats   map[string]Stats

	mu    sync.Mutex
	calls map[string]int
}

func newBlockingStatfs(blocked string) *blockingStatfs {
	return &blockingStatfs{
		blocked: blocked,
		release: make(chan struct{}),
		stats: map[string]Stats{
			blocked: {TotalBytes: 20, UsedBytes: 8},
			"/":     {TotalBytes: 100, UsedBytes: 40},
		},
		calls: make(map[string]int),
	}
}

func (b *blockingStatfs) statfs(path string) (Stats, error) {
	b.mu.Lock()
	b.calls[path]++
	b.mu.Unlock()
	if path == b.blocked {
		<-b.release
	}
	return b.stats[path], nil
}

func (b *blockingStatfs) count(path string) int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.calls[path]
}

// statfsBlockedPrefix starts the error of a disk whose earlier statfs call is still blocked.
const statfsBlockedPrefix = "statfs still blocked since "

// diskError returns one disk entry's error message.
func diskError(t *testing.T, disks []protocol.MetricsDisk, i int) string {
	t.Helper()
	if i >= len(disks) || disks[i].Error == nil {
		t.Fatalf("disk %d has no error: %#v", i, disks)
	}
	return *disks[i].Error
}

// waitStatfsIdle waits until the collector holds no in-flight statfs mark; the goroutine clears it
// after the injected Statfs returns.
func waitStatfsIdle(t *testing.T, collector *Collector) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		collector.mu.Lock()
		blocked := len(collector.inflight)
		collector.mu.Unlock()
		if blocked == 0 {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("%d statfs calls still marked in flight", blocked)
		}
		time.Sleep(time.Millisecond)
	}
}

// TestDisksBlockedPath covers a statfs blocked past the sample deadline: the first sample times out,
// later samples report the blocked call without starting another one, and the path recovers once the
// call returns.
func TestDisksBlockedPath(t *testing.T) {
	t.Run("blocked path is reported and not retried", func(t *testing.T) {
		fake := newBlockingStatfs("/hung")
		defer close(fake.release)
		collector := New(Options{
			Disks:         []Disk{{Name: "hung", Path: "/hung"}, {Name: "root", Path: "/"}},
			Statfs:        fake.statfs,
			StatfsTimeout: 20 * time.Millisecond,
		})
		got := collector.Collect().Disks
		if len(got) != 2 || diskError(t, got, 0) != "statfs timed out" {
			t.Fatalf("first sample = %#v", got)
		}
		if got[1].Error != nil || got[1].TotalBytes != 100 || got[1].UsedBytes != 40 {
			t.Fatalf("fast disk on the first sample = %#v", got[1])
		}

		got = collector.Collect().Disks
		message := diskError(t, got, 0)
		if !strings.HasPrefix(message, statfsBlockedPrefix) {
			t.Fatalf("second sample error = %q", message)
		}
		started, err := time.Parse(time.RFC3339, strings.TrimPrefix(message, statfsBlockedPrefix))
		if err != nil {
			t.Fatalf("start time in %q: %v", message, err)
		}
		now := time.Now().UTC()
		if started.Location() != time.UTC || started.After(now) || now.Sub(started) > time.Minute {
			t.Fatalf("blocked since %s, want a recent UTC time (now %s)", started, now)
		}
		if got[1].Error != nil || got[1].TotalBytes != 100 {
			t.Fatalf("fast disk on the second sample = %#v", got[1])
		}
		if calls := fake.count("/hung"); calls != 1 {
			t.Fatalf("statfs /hung calls = %d, want 1 while the call is blocked", calls)
		}
		if calls := fake.count("/"); calls != 2 {
			t.Fatalf("statfs / calls = %d, want 2, one per sample", calls)
		}
	})

	t.Run("recovers after the blocked call returns", func(t *testing.T) {
		fake := newBlockingStatfs("/hung")
		collector := New(Options{
			Disks:         []Disk{{Name: "hung", Path: "/hung"}, {Name: "root", Path: "/"}},
			Statfs:        fake.statfs,
			StatfsTimeout: 20 * time.Millisecond,
		})
		if got := collector.Collect().Disks; diskError(t, got, 0) != "statfs timed out" {
			t.Fatalf("first sample = %#v", got)
		}
		close(fake.release)
		waitStatfsIdle(t, collector)
		got := collector.Collect().Disks
		if got[0].Error != nil || got[0].TotalBytes != 20 || got[0].UsedBytes != 8 {
			t.Fatalf("recovered disk = %#v", got[0])
		}
		if calls := fake.count("/hung"); calls != 2 {
			t.Fatalf("statfs /hung calls = %d, want 2 after the first call returned", calls)
		}
	})

	t.Run("same path shares one call and one mark", func(t *testing.T) {
		fake := newBlockingStatfs("/hung")
		defer close(fake.release)
		collector := New(Options{
			Disks:         []Disk{{Name: "a", Path: "/hung"}, {Name: "b", Path: "/hung"}},
			Statfs:        fake.statfs,
			StatfsTimeout: 20 * time.Millisecond,
		})
		got := collector.Collect().Disks
		if len(got) != 2 || diskError(t, got, 0) != "statfs timed out" ||
			diskError(t, got, 1) != "statfs timed out" {
			t.Fatalf("first sample = %#v", got)
		}
		if calls := fake.count("/hung"); calls != 1 {
			t.Fatalf("statfs /hung calls = %d, want one shared call", calls)
		}
		got = collector.Collect().Disks
		first, second := diskError(t, got, 0), diskError(t, got, 1)
		if first != second || !strings.HasPrefix(first, statfsBlockedPrefix) {
			t.Fatalf("second sample errors = %q and %q, want the same blocked message", first, second)
		}
		if calls := fake.count("/hung"); calls != 1 {
			t.Fatalf("statfs /hung calls = %d, want 1 while blocked", calls)
		}
	})

	t.Run("permanently blocked path does not leak", func(t *testing.T) {
		fake := newBlockingStatfs("/hung")
		defer close(fake.release)
		collector := New(Options{
			Disks:         []Disk{{Name: "hung", Path: "/hung"}, {Name: "root", Path: "/"}},
			Statfs:        fake.statfs,
			StatfsTimeout: 20 * time.Millisecond,
		})
		if got := collector.Collect().Disks; diskError(t, got, 0) != "statfs timed out" {
			t.Fatalf("first sample = %#v", got)
		}
		baseline := runtime.NumGoroutine()
		for sample := 2; sample <= 51; sample++ {
			got := collector.Collect().Disks
			message := diskError(t, got, 0)
			if !strings.HasPrefix(message, statfsBlockedPrefix) {
				t.Fatalf("sample %d error = %q", sample, message)
			}
			if got[1].Error != nil || got[1].TotalBytes != 100 {
				t.Fatalf("sample %d fast disk = %#v", sample, got[1])
			}
		}
		if calls := fake.count("/hung"); calls != 1 {
			t.Fatalf("statfs /hung calls = %d over 51 samples, want 1", calls)
		}
		if grown := runtime.NumGoroutine(); grown > baseline+2 {
			t.Fatalf("goroutines grew from %d to %d over 50 blocked samples", baseline, grown)
		}
	})
}

func TestStatfsPath(t *testing.T) {
	stats, err := statfsPath(t.TempDir())
	if err != nil {
		t.Fatalf("statfs: %v", err)
	}
	if stats.TotalBytes == 0 || stats.UsedBytes > stats.TotalBytes {
		t.Fatalf("statfs = %#v", stats)
	}
}

func TestStatsFromStatfs(t *testing.T) {
	stats, err := statsFromStatfs(unix.Statfs_t{Blocks: 10, Bfree: 4, Bsize: 4096})
	if err != nil {
		t.Fatal(err)
	}
	if stats != (Stats{TotalBytes: 10 * 4096, UsedBytes: 6 * 4096}) {
		t.Fatalf("stats = %#v", stats)
	}
	// A free count above the block count is clamped to zero used bytes instead of wrapping.
	stats, err = statsFromStatfs(unix.Statfs_t{Blocks: 4, Bfree: 10, Bsize: 4096})
	if err != nil {
		t.Fatal(err)
	}
	if stats.UsedBytes != 0 {
		t.Fatalf("used = %d", stats.UsedBytes)
	}
	if _, err := statsFromStatfs(unix.Statfs_t{Blocks: 1, Bsize: 0}); err == nil {
		t.Fatal("accepted a zero block size")
	}
}

func TestCollectSkipsNamesOutsideTheProtocolForm(t *testing.T) {
	root := t.TempDir()
	writeFiles(t, root, map[string]string{
		"proc/sys/kernel/random/boot_id": "boot-1\n",
		"proc/uptime":                    "1.0 1.0\n",
		"proc/loadavg":                   "0.0 0.0 0.0 1/1 1\n",
		"proc/stat": `cpu  1 2 3 4 5 6 7 8
cpu0 1 2 3 4 5 6 7 8
cpu1024 1 2 3 4 5 6 7 8
`,
		"proc/net/dev": netDevHeader +
			devLine("bad name", 1, 2, 3, 4) + "\n" +
			devLine("a/b", 1, 2, 3, 4) + "\n" +
			devLine(strings.Repeat("a", 16), 1, 2, 3, 4) + "\n" +
			devLine("a\x7fb", 1, 2, 3, 4) + "\n" +
			devLine("eth0#1", 5, 6, 7, 8) + "\n" +
			devLine("eth0", 9, 10, 11, 12) + "\n",
	})
	collector := New(Options{
		Root: root,
		Disks: []Disk{
			{Name: "bad name", Path: "/bad"},
			{Name: "root", Path: "/"},
		},
		Interfaces: []string{"bad name", "a/b", strings.Repeat("a", 16), "a\x7fb", "eth0#1", "eth0"},
		Statfs:     func(string) (Stats, error) { return Stats{TotalBytes: 1, UsedBytes: 1}, nil },
	})
	snapshot := collector.Collect()
	if len(snapshot.Disks) != 1 || snapshot.Disks[0].Name != "root" {
		t.Fatalf("disks = %#v, want only root", snapshot.Disks)
	}
	if len(snapshot.Interfaces) != 2 || snapshot.Interfaces[0].Name != "eth0#1" || snapshot.Interfaces[1].Name != "eth0" {
		t.Fatalf("interfaces = %#v, want only eth0#1 and eth0", snapshot.Interfaces)
	}
	if snapshot.CPU == nil || len(snapshot.CPU.Cores) != 1 || snapshot.CPU.Cores[0].Index != 0 {
		t.Fatalf("cpu = %#v, want only core 0", snapshot.CPU)
	}
}
