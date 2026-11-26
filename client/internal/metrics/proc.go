package metrics

import (
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
)

// readProc reads one file under the collector's root.
func readProc(root, name string) ([]byte, error) {
	return os.ReadFile(filepath.Join(root, name))
}

// readBootID reads /proc/sys/kernel/random/boot_id.
func readBootID(root string) (string, error) {
	data, err := readProc(root, "proc/sys/kernel/random/boot_id")
	if err != nil {
		return "", err
	}
	return parseBootID(data)
}

func parseBootID(data []byte) (string, error) {
	id := strings.TrimSpace(string(data))
	if id == "" {
		return "", errors.New("metrics: boot_id is empty")
	}
	return protocol.CleanText(id), nil
}

// readUptime reads the seconds of /proc/uptime. The second value (idle time) is not used.
func readUptime(root string) (protocol.Uint, error) {
	data, err := readProc(root, "proc/uptime")
	if err != nil {
		return 0, err
	}
	return parseUptime(data)
}

func parseUptime(data []byte) (protocol.Uint, error) {
	fields := strings.Fields(string(data))
	if len(fields) == 0 {
		return 0, errors.New("metrics: /proc/uptime is empty")
	}
	seconds, err := strconv.ParseFloat(fields[0], 64)
	if err != nil || math.IsNaN(seconds) || math.IsInf(seconds, 0) || seconds < 0 ||
		seconds > float64(protocol.MaxSafeInteger) {
		return 0, fmt.Errorf("metrics: invalid /proc/uptime value %q", fields[0])
	}
	return protocol.Uint(seconds), nil
}

// readCPU reads /proc/stat's cpu and cpu<n> lines.
func readCPU(root string) (*protocol.MetricsCPU, error) {
	data, err := readProc(root, "proc/stat")
	if err != nil {
		return nil, err
	}
	return parseCPU(data)
}

// parseCPU parses the cpu lines of /proc/stat. Offline cores have no line, so they are simply
// absent. The first protocol.MaxMetricsCores cores are kept.
func parseCPU(data []byte) (*protocol.MetricsCPU, error) {
	var total *protocol.MetricsCPUTotal
	cores := []protocol.MetricsCore{}
	for _, line := range strings.Split(string(data), "\n") {
		fields := strings.Fields(line)
		if len(fields) == 0 {
			continue
		}
		label := fields[0]
		if label == "cpu" {
			counters, err := parseCPULine(fields[1:])
			if err != nil {
				return nil, err
			}
			total = &counters
			continue
		}
		if !strings.HasPrefix(label, "cpu") {
			continue // intr, ctxt, btime, processes, procs_running, ...
		}
		index, err := strconv.ParseUint(label[3:], 10, 32)
		if err != nil {
			return nil, fmt.Errorf("metrics: /proc/stat cpu line %q has no core index", label)
		}
		if !protocol.ValidMetricsCoreIndex(protocol.Uint(index)) || len(cores) >= protocol.MaxMetricsCores {
			continue // crha drops before sending (doc/design/metrics.md "Limits")
		}
		counters, err := parseCPULine(fields[1:])
		if err != nil {
			return nil, err
		}
		cores = append(cores, protocol.MetricsCore{
			Index: protocol.Uint(index),
			Busy:  counters.Busy,
			Total: counters.Total,
		})
	}
	if total == nil {
		return nil, errors.New("metrics: /proc/stat has no cpu line")
	}
	return &protocol.MetricsCPU{Total: *total, Cores: cores}, nil
}

// parseCPULine turns the counters of one cpu line into busy and total jiffies. The first eight
// counters are user, nice, system, idle, iowait, irq, softirq and steal; guest and guest_nice are
// already counted in user and nice, so they are not added. busy is total minus idle and iowait.
func parseCPULine(fields []string) (protocol.MetricsCPUTotal, error) {
	if len(fields) < 4 {
		return protocol.MetricsCPUTotal{}, fmt.Errorf(
			"metrics: /proc/stat cpu line has %d counters, want at least 4", len(fields))
	}
	var values [8]uint64
	for i := 0; i < len(fields) && i < len(values); i++ {
		value, err := strconv.ParseUint(fields[i], 10, 64)
		if err != nil {
			return protocol.MetricsCPUTotal{}, fmt.Errorf("metrics: invalid /proc/stat cpu counter %q: %w", fields[i], err)
		}
		values[i] = value
	}
	var total uint64
	for _, value := range values {
		if value > math.MaxUint64-total {
			return protocol.MetricsCPUTotal{}, errors.New("metrics: /proc/stat cpu total overflows")
		}
		total += value
	}
	busy := total - values[3] - values[4]
	return protocol.MetricsCPUTotal{Busy: protocol.Uint64(busy), Total: protocol.Uint64(total)}, nil
}

// readLoads reads /proc/loadavg's three load averages.
func readLoads(root string) (*protocol.MetricsLoads, error) {
	data, err := readProc(root, "proc/loadavg")
	if err != nil {
		return nil, err
	}
	return parseLoads(data)
}

// parseLoads reads the three load averages as integer thousandths. The CBOR profile has no floats,
// and /proc/loadavg prints two decimals, so the integer is exact.
func parseLoads(data []byte) (*protocol.MetricsLoads, error) {
	fields := strings.Fields(string(data))
	if len(fields) < 3 {
		return nil, fmt.Errorf("metrics: /proc/loadavg has %d values, want 3", len(fields))
	}
	loads := protocol.MetricsLoads{}
	targets := []*protocol.Uint{&loads.L1, &loads.L5, &loads.L15}
	for i, target := range targets {
		value, err := strconv.ParseFloat(fields[i], 64)
		if err != nil || math.IsNaN(value) || math.IsInf(value, 0) || value < 0 ||
			value*1000 > float64(protocol.MaxSafeInteger) {
			return nil, fmt.Errorf("metrics: invalid /proc/loadavg value %q", fields[i])
		}
		*target = protocol.Uint(math.Round(value * 1000))
	}
	return &loads, nil
}

// readMemory reads the memory and swap fields of /proc/meminfo. A key that is missing makes its
// group absent: memory needs all four values, swap both.
func readMemory(root string) (*protocol.MetricsMemory, *protocol.MetricsSwap, error) {
	data, err := readProc(root, "proc/meminfo")
	if err != nil {
		return nil, nil, err
	}
	values := parseMeminfo(data)
	var memory *protocol.MetricsMemory
	if total, ok := values["MemTotal"]; ok {
		if available, ok := values["MemAvailable"]; ok {
			if cached, ok := values["Cached"]; ok {
				if free, ok := values["MemFree"]; ok {
					memory = &protocol.MetricsMemory{
						TotalBytes:     protocol.Uint64(total),
						AvailableBytes: protocol.Uint64(available),
						CachedBytes:    protocol.Uint64(cached),
						FreeBytes:      protocol.Uint64(free),
					}
				}
			}
		}
	}
	var swap *protocol.MetricsSwap
	if total, ok := values["SwapTotal"]; ok {
		if free, ok := values["SwapFree"]; ok {
			swap = &protocol.MetricsSwap{TotalBytes: protocol.Uint64(total), FreeBytes: protocol.Uint64(free)}
		}
	}
	return memory, swap, nil
}

// parseMeminfo parses the "Key: N kB" lines of /proc/meminfo into bytes. A malformed line is not a
// value: the keys it would have provided are absent.
func parseMeminfo(data []byte) map[string]uint64 {
	values := map[string]uint64{}
	for _, line := range strings.Split(string(data), "\n") {
		key, rest, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		fields := strings.Fields(rest)
		if len(fields) == 0 {
			continue
		}
		amount, err := strconv.ParseUint(fields[0], 10, 64)
		if err != nil || amount > math.MaxUint64/1024 {
			continue
		}
		values[strings.TrimSpace(key)] = amount * 1024
	}
	return values
}

// interfaceCounters is one line of /proc/net/dev.
type interfaceCounters struct {
	name      string
	rxBytes   uint64
	txBytes   uint64
	rxPackets uint64
	txPackets uint64
}

func (c interfaceCounters) value() protocol.MetricsInterface {
	return protocol.MetricsInterface{
		Name:      protocol.CleanText(c.name),
		RXBytes:   protocol.Uint64(c.rxBytes),
		TXBytes:   protocol.Uint64(c.txBytes),
		RXPackets: protocol.Uint64(c.rxPackets),
		TXPackets: protocol.Uint64(c.txPackets),
	}
}

// loopbackInterface matches lo and its aliases, lo0, lo1 and so on.
var loopbackInterface = regexp.MustCompile(`^lo[0-9]*$`)

// excludedInterfacePrefixes are the interface families a default selection leaves out
// (doc/design/metrics.md "crha nodes"). Traffic through a bridge is also counted on its veth or
// physical side, so including both would count it twice.
var excludedInterfacePrefixes = []string{
	"tun", "tap", "wg", "utun", "docker", "veth", "br-", "virbr", "lxc", "cni", "flannel", "cali",
	"vxlan", "kube-",
}

// excludedInterface reports whether a default selection leaves name out.
func excludedInterface(name string) bool {
	if loopbackInterface.MatchString(name) {
		return true
	}
	for _, prefix := range excludedInterfacePrefixes {
		if strings.HasPrefix(name, prefix) {
			return true
		}
	}
	return false
}

// interfacesValue reads /proc/net/dev and applies the selection. The result is present but empty when
// the file has no interface left; a file that cannot be read is absent.
func (c *Collector) interfacesValue() ([]protocol.MetricsInterface, error) {
	data, err := readProc(c.root, "proc/net/dev")
	if err != nil {
		return nil, err
	}
	all, err := parseNetDev(data)
	if err != nil {
		return nil, err
	}
	if len(c.interfaces) > 0 {
		out := make([]protocol.MetricsInterface, 0, min(len(all), protocol.MaxMetricsInterfaces))
		byName := make(map[string]interfaceCounters, len(all))
		for _, entry := range all {
			byName[entry.name] = entry
		}
		for _, name := range c.interfaces {
			if !protocol.ValidMetricsInterfaceName(name) {
				continue // a configured name outside the protocol's form is not reported
			}
			entry, ok := byName[name]
			if !ok {
				continue // a configured interface the kernel no longer has
			}
			out = append(out, entry.value())
			if len(out) == protocol.MaxMetricsInterfaces {
				break
			}
		}
		return out, nil
	}
	selected := selectAutoInterfaces(all)
	out := make([]protocol.MetricsInterface, len(selected))
	for i, entry := range selected {
		out[i] = entry.value()
	}
	return out, nil
}

// selectAutoInterfaces applies the default selection to the interfaces of /proc/net/dev: the first
// protocol.MaxMetricsInterfaces names that are neither excluded nor outside the protocol's form.
func selectAutoInterfaces(all []interfaceCounters) []interfaceCounters {
	out := make([]interfaceCounters, 0, min(len(all), protocol.MaxMetricsInterfaces))
	for _, entry := range all {
		if excludedInterface(entry.name) || !protocol.ValidMetricsInterfaceName(entry.name) {
			continue
		}
		out = append(out, entry)
		if len(out) == protocol.MaxMetricsInterfaces {
			break
		}
	}
	return out
}

// autoInterfaceNames returns what the default selection would pick right now, for Targets. A file
// that cannot be read is an error and no names.
func (c *Collector) autoInterfaceNames() ([]string, error) {
	data, err := readProc(c.root, "proc/net/dev")
	if err != nil {
		return nil, err
	}
	all, err := parseNetDev(data)
	if err != nil {
		return nil, err
	}
	selected := selectAutoInterfaces(all)
	names := make([]string, len(selected))
	for i, entry := range selected {
		names[i] = entry.name
	}
	return names, nil
}

// parseNetDev parses the data lines of /proc/net/dev: name, then sixteen counters, of which the
// first, second, ninth and tenth are receive bytes and packets and transmit bytes and packets.
func parseNetDev(data []byte) ([]interfaceCounters, error) {
	var out []interfaceCounters
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.Contains(line, "|") {
			continue // the two header lines
		}
		name, rest, ok := strings.Cut(line, ":")
		if !ok {
			return nil, fmt.Errorf("metrics: malformed /proc/net/dev line %q", line)
		}
		name = strings.TrimSpace(name)
		if name == "" {
			return nil, fmt.Errorf("metrics: /proc/net/dev line %q has no interface name", line)
		}
		fields := strings.Fields(rest)
		if len(fields) < 10 {
			return nil, fmt.Errorf(
				"metrics: /proc/net/dev line for %q has %d counters, want at least 10", name, len(fields))
		}
		var numbers [4]uint64
		for i, index := range []int{0, 1, 8, 9} {
			value, err := strconv.ParseUint(fields[index], 10, 64)
			if err != nil {
				return nil, fmt.Errorf(
					"metrics: invalid /proc/net/dev counter %q for %q: %w", fields[index], name, err)
			}
			numbers[i] = value
		}
		out = append(out, interfaceCounters{
			name:      name,
			rxBytes:   numbers[0],
			rxPackets: numbers[1],
			txBytes:   numbers[2],
			txPackets: numbers[3],
		})
	}
	return out, nil
}
