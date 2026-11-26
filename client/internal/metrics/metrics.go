// Package metrics reads the host metrics crha answers metrics.collect with
// (doc/design/metrics.md "crha nodes"). It reads /proc files under a root directory so tests can use
// fixture trees, and it takes the filesystem call as an option so a test can make statfs fail or
// block. A source that cannot be read is an absent field, never an error: the command answers with
// whatever it could read. The only state the collector keeps between samples is the set of paths
// whose statfs call is still blocked, so a hung mount cannot leak a goroutine and an OS thread per
// sample.
package metrics

import (
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
	"golang.org/x/sys/unix"
)

// DefaultStatfsTimeout bounds one statfs call. A hung network mount is abandoned after it and
// reported as that filesystem's error, so it cannot time out the whole sample
// (doc/design/metrics.md "crha nodes").
const DefaultStatfsTimeout = 2 * time.Second

// Disk is one configured filesystem (crha.toml [metrics].disks).
type Disk struct {
	Name string
	Path string
}

// Stats is what a statfs call reports: the filesystem's size and the bytes in use.
type Stats struct {
	TotalBytes uint64
	UsedBytes  uint64
}

// Options configure a Collector.
type Options struct {
	// Root is the directory the proc sources are read under; "" and "/" mean the host.
	Root string
	// Disks are the configured filesystems, in the order they are reported. At most
	// protocol.MaxMetricsDisks are collected.
	Disks []Disk
	// Interfaces are the selected interface names. Empty selects every interface except loopback,
	// tunnels and host-local virtual and bridge interfaces. At most protocol.MaxMetricsInterfaces
	// are collected.
	Interfaces []string
	// Statfs reads one filesystem. nil uses unix.Statfs; tests inject a fake.
	Statfs func(path string) (Stats, error)
	// StatfsTimeout bounds every statfs call; 0 means DefaultStatfsTimeout.
	StatfsTimeout time.Duration
}

// Collector reads one node's raw metrics. It keeps one piece of state between samples: the paths
// whose statfs call is still blocked, with the time each call started (doc/design/metrics.md
// "crha nodes").
type Collector struct {
	root       string
	disks      []Disk
	interfaces []string
	dropped    []DroppedTarget // configured entries New discarded as invalid or over a limit
	statfs     func(path string) (Stats, error)
	timeout    time.Duration

	mu       sync.Mutex
	inflight map[string]time.Time // path -> when its blocked statfs call started
}

// Targets is what a collector will collect, so crha can log it at startup and a misconfiguration is
// visible in the log (doc/design/metrics.md "crha nodes").
type Targets struct {
	// Disks are the filesystems that are collected, in configuration order.
	Disks []Disk
	// Interfaces are the configured interface names that are collected, in order. It is empty when
	// the configuration is empty (see AutoInterfaces) or keeps no valid name.
	Interfaces []string
	// AutoInterfaces reports whether interfaces are selected from /proc/net/dev because none are
	// configured.
	AutoInterfaces bool
	// AutoNow are the interface names the automatic selection picks right now, in /proc/net/dev
	// order. It is empty when AutoInterfaces is false or the file could not be read.
	AutoNow []string
	// AutoErr is why /proc/net/dev could not be read for AutoNow; nil otherwise.
	AutoErr error
	// Dropped lists the configured disks and interface names that are not collected.
	Dropped []DroppedTarget
}

// DroppedTarget is one configured disk or interface that a collector does not collect.
type DroppedTarget struct {
	// Kind is "disk" or "interface".
	Kind string
	// Name is the configured name.
	Name string
	// Reason is why it is not collected: "invalid name" or "over the limit of <n>".
	Reason string
}

// New returns a Collector for opts.
func New(opts Options) *Collector {
	root := opts.Root
	if root == "" {
		root = "/"
	}
	statfs := opts.Statfs
	if statfs == nil {
		statfs = statfsPath
	}
	timeout := opts.StatfsTimeout
	if timeout <= 0 {
		timeout = DefaultStatfsTimeout
	}
	// The configuration validates disk names, but a name outside the protocol's form must never reach the
	// wire; skip it here too (doc/design/metrics.md "Limits"). What is skipped is kept so Targets can
	// report it at startup.
	disks := make([]Disk, 0, len(opts.Disks))
	var dropped []DroppedTarget
	for _, disk := range opts.Disks {
		if protocol.ValidMetricsDiskName(disk.Name) {
			disks = append(disks, disk)
		} else {
			dropped = append(dropped, DroppedTarget{
				Kind: "disk", Name: disk.Name, Reason: "invalid name",
			})
		}
	}
	if len(disks) > protocol.MaxMetricsDisks {
		for _, disk := range disks[protocol.MaxMetricsDisks:] {
			dropped = append(dropped, DroppedTarget{
				Kind:   "disk",
				Name:   disk.Name,
				Reason: fmt.Sprintf("over the limit of %d", protocol.MaxMetricsDisks),
			})
		}
		disks = disks[:protocol.MaxMetricsDisks]
	}
	interfaces := opts.Interfaces
	if len(interfaces) > protocol.MaxMetricsInterfaces {
		for _, name := range interfaces[protocol.MaxMetricsInterfaces:] {
			dropped = append(dropped, DroppedTarget{
				Kind:   "interface",
				Name:   name,
				Reason: fmt.Sprintf("over the limit of %d", protocol.MaxMetricsInterfaces),
			})
		}
		interfaces = interfaces[:protocol.MaxMetricsInterfaces]
	}
	return &Collector{
		root:       root,
		disks:      disks,
		interfaces: interfaces,
		dropped:    dropped,
		statfs:     statfs,
		timeout:    timeout,
		inflight:   make(map[string]time.Time),
	}
}

// Targets reports what the collector collects: the kept disks and configured interfaces, or the
// automatic interface selection and what it would pick now. Configured interface names outside the
// protocol's form are reported as dropped, as Collect skips them. It is for the startup log, before
// sampling starts.
func (c *Collector) Targets() Targets {
	targets := Targets{
		Disks:   append([]Disk(nil), c.disks...),
		Dropped: append([]DroppedTarget(nil), c.dropped...),
	}
	if len(c.interfaces) == 0 {
		targets.AutoInterfaces = true
		targets.AutoNow, targets.AutoErr = c.autoInterfaceNames()
		return targets
	}
	for _, name := range c.interfaces {
		if !protocol.ValidMetricsInterfaceName(name) {
			targets.Dropped = append(targets.Dropped, DroppedTarget{
				Kind: "interface", Name: name, Reason: "invalid name",
			})
			continue
		}
		targets.Interfaces = append(targets.Interfaces, name)
	}
	return targets
}

// Collect reads every configured source once and returns the metrics.collect body. A source that
// fails leaves its field absent; a disk whose statfs fails carries its error in the entry instead.
func (c *Collector) Collect() protocol.MetricsSnapshot {
	var snapshot protocol.MetricsSnapshot
	if bootID, err := readBootID(c.root); err == nil {
		snapshot.BootID = &bootID
	}
	if uptime, err := readUptime(c.root); err == nil {
		snapshot.UptimeSec = &uptime
	}
	if cpu, err := readCPU(c.root); err == nil {
		snapshot.CPU = cpu
	}
	if loads, err := readLoads(c.root); err == nil {
		snapshot.Loads = loads
	}
	if memory, swap, err := readMemory(c.root); err == nil {
		snapshot.Memory, snapshot.Swap = memory, swap
	}
	snapshot.Disks = c.disksValue()
	if interfaces, err := c.interfacesValue(); err == nil {
		snapshot.Interfaces = interfaces
	}
	return snapshot
}

// disksValue runs at most one statfs per configured filesystem, concurrently and with one shared
// deadline. The result is always present: an empty configuration is an empty list, and a filesystem
// that failed is an error entry.
//
// A statfs that outlives the deadline cannot be cancelled and pins its goroutine and an OS thread
// until it returns, so the collector marks the path in flight and starts no second call for it: a
// later sample reports the disk as still blocked, with the time the call started, until the call
// returns and clears the mark (its late result is discarded). Disks configured twice on the same
// path share one call and one mark.
func (c *Collector) disksValue() []protocol.MetricsDisk {
	type statfsResult struct {
		stats Stats
		err   error
	}
	type pathSample struct {
		ch       chan statfsResult // nil when the path is still blocked from an earlier sample
		since    time.Time         // when that blocked call started
		answer   *statfsResult     // this sample's result, once it arrived
		answered bool
	}
	paths := make(map[string]*pathSample, len(c.disks))
	samples := make([]*pathSample, len(c.disks))
	for i, disk := range c.disks {
		sample, seen := paths[disk.Path]
		if !seen {
			sample = &pathSample{}
			paths[disk.Path] = sample
			if started, ok := c.beginStatfs(disk.Path); ok {
				sample.ch = make(chan statfsResult, 1)
				go func(path string, ch chan statfsResult) {
					stats, err := c.statfs(path)
					// Clear the mark before delivering the result: a sample that starts after the
					// call returned must see that the path is no longer in flight.
					c.endStatfs(path)
					ch <- statfsResult{stats: stats, err: err}
				}(disk.Path, sample.ch)
			} else {
				sample.since = started
			}
		}
		samples[i] = sample
	}
	out := make([]protocol.MetricsDisk, len(c.disks))
	deadline := time.Now().Add(c.timeout)
	for i, disk := range c.disks {
		sample := samples[i]
		entry := protocol.MetricsDisk{
			Name: protocol.CleanText(disk.Name),
			Path: protocol.CleanText(disk.Path),
		}
		if sample.ch == nil {
			message := fmt.Sprintf("statfs still blocked since %s", sample.since.Format(time.RFC3339))
			entry.Error = &message
			out[i] = entry
			continue
		}
		if !sample.answered {
			sample.answered = true
			// Prefer a result that already arrived: a filesystem behind a hung one must not be
			// reported as timed out only because the wait for the hung one consumed the shared
			// deadline.
			select {
			case r := <-sample.ch:
				sample.answer = &r
			default:
				select {
				case r := <-sample.ch:
					sample.answer = &r
				case <-time.After(time.Until(deadline)):
				}
			}
		}
		switch {
		case sample.answer == nil:
			message := "statfs timed out"
			entry.Error = &message
		case sample.answer.err != nil:
			message := protocol.ErrorMessage(sample.answer.err.Error())
			entry.Error = &message
		default:
			entry.TotalBytes = protocol.Uint64(sample.answer.stats.TotalBytes)
			entry.UsedBytes = protocol.Uint64(sample.answer.stats.UsedBytes)
		}
		out[i] = entry
	}
	return out
}

// beginStatfs marks path as having a statfs call in flight and returns when that call started. When
// a previous call for the path is still running, it returns that call's start time and false.
func (c *Collector) beginStatfs(path string) (time.Time, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if started, blocked := c.inflight[path]; blocked {
		return started, false
	}
	started := time.Now().UTC()
	if c.inflight == nil {
		c.inflight = make(map[string]time.Time)
	}
	c.inflight[path] = started
	return started, true
}

// endStatfs clears path's in-flight mark when its statfs call returns. A call that outlived its
// sample delivers its result to nobody and is discarded.
func (c *Collector) endStatfs(path string) {
	c.mu.Lock()
	delete(c.inflight, path)
	c.mu.Unlock()
}

// statfsPath is the real statfs.
func statfsPath(path string) (Stats, error) {
	var st unix.Statfs_t
	if err := unix.Statfs(path, &st); err != nil {
		return Stats{}, err
	}
	return statsFromStatfs(st)
}

// statsFromStatfs is statfs's arithmetic: total = Blocks * Bsize, used = (Blocks - Bfree) * Bsize.
func statsFromStatfs(st unix.Statfs_t) (Stats, error) {
	if st.Bsize <= 0 {
		return Stats{}, errors.New("statfs reported a non-positive block size")
	}
	blockSize := uint64(st.Bsize)
	total := st.Blocks * blockSize
	var used uint64
	if st.Blocks > st.Bfree {
		used = (st.Blocks - st.Bfree) * blockSize
	}
	return Stats{TotalBytes: total, UsedBytes: used}, nil
}
