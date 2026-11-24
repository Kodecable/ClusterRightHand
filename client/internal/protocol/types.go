package protocol

import (
	"errors"
	"fmt"
	"regexp"
	"slices"

	"github.com/fxamacker/cbor/v2"
)

// HandshakeInit is the payload of Noise handshake message 1 (crha -> crhs).
type HandshakeInit struct {
	_             struct{} `cbor:",toarray"`
	ProtocolMajor Uint
	ProtocolMinor Uint
	Commands      []string
	CRHAVersion   string
	ClientTimeMS  Int
	Enroll        *Enrollment
}

// Enrollment registers an unknown node key with a one-time token.
type Enrollment struct {
	_           struct{} `cbor:",toarray"`
	TokenSecret string
	Hostname    string
	Facts       Facts
}

// HandshakeResponse is the payload of Noise handshake message 2 (crhs -> crha).
type HandshakeResponse struct {
	_             struct{} `cbor:",toarray"`
	ProtocolMajor Uint
	ProtocolMinor Uint
	Commands      []string
	ConnectionID  string
	ServerTimeMS  Int
	NodeState     NodeState
	NodeID        string
}

// Hello is the first command after the handshake; it reports tasks still running from a
// previous connection.
type Hello struct {
	_              struct{} `cbor:",toarray"`
	Tasks          []TaskStatus
	TaskKinds      []string
	PrivilegedMode string
}

// Welcome acknowledges the offsets crha may resume from.
type Welcome struct {
	_    struct{} `cbor:",toarray"`
	Acks []OutputAck
}

// OutputAck acknowledges the received output offset of one task.
type OutputAck struct {
	_      struct{} `cbor:",toarray"`
	TaskID string
	Offset Uint
}

// TaskStatus is the state of one task in Hello and task.query.
type TaskStatus struct {
	_         struct{} `cbor:",toarray"`
	TaskID    string
	State     TaskState
	OutputEnd Uint
}

// TaskStart is the task.start request body.
type TaskStart struct {
	_              struct{} `cbor:",toarray"`
	TaskID         string
	Attempt        Uint
	Spec           TaskSpec
	Privileged     bool
	Authorizations [][]byte
	// Cosign is CBOR(CosignTicket) confirming this use of the authorization, or nil
	// (doc/design/protocol.md "Cosign ticket").
	Cosign      *[]byte
	TimeoutMS   Uint
	KillGraceMS Uint
	Output      OutputMode
}

// TaskExit is the task.exit event body. Result carries the task's structured result; it is nil for
// a kind that reports none (doc/design/protocol.md "Task results"). OutputEnd is the end offset of the output crha
// can still deliver (a lost tail is omitted), OutputLines counts the whole stream, and OutputFile is
// empty when no complete output file exists. OutputLost says crha lost buffered output, so OutputEnd
// ends before the loss and the output is incomplete.
type TaskExit struct {
	_           struct{} `cbor:",toarray"`
	TaskID      string
	Outcome     Outcome
	TimedOut    bool
	Cancelled   bool
	OutputEnd   Uint
	OutputFile  string
	OutputLines Uint
	OutputLost  bool
	Result      *TaskResult
}

// Facts is the facts event body. It is one of the protocol's map bodies: hostname is required,
// every other key is optional and its Go field is nil when the node did not report it
// (doc/design/protocol.md "Events"). A peer may send text keys this implementation does not know; they are
// ignored, while a non-text key fails the whole Facts.
type Facts struct {
	Hostname string

	// Platform is one line for people and models, such as "linux, amd64, Ubuntu 24.04.4 LTS". It is not
	// meant to be parsed: nothing may branch on it.
	Platform *string
	// Hints are short sentences about the system for people and models ("Found apt."), at most
	// MaxHintLines lines and MaxHintBytes bytes. Not meant to be parsed either.
	Hints         *string
	NotesPath     *string
	ClockOffsetMS *Int
	Shells        *Shells
	// SelfUpgrade says whether crhs may upgrade the node, and why not
	// (doc/design/distribution.md "Who can self-upgrade").
	SelfUpgrade *SelfUpgrade
	// UpgradeLogPath is the upgrade log crhs reads with file.read (doc/design/distribution.md "Upgrade log").
	UpgradeLogPath *string
}

// SelfUpgrade is the self_upgrade fact. Reasons are open names, so a reason a newer node reports
// decodes here too.
type SelfUpgrade struct {
	Available bool
	Reasons   []string
	// Arch is the architecture of the binary the node needs (GOARCH); empty when not reported.
	Arch string
}

// MarshalCBOR encodes SelfUpgrade as a text-keyed map with both keys.
func (u SelfUpgrade) MarshalCBOR() ([]byte, error) {
	reasons := make([]any, 0, len(u.Reasons))
	for _, reason := range u.Reasons {
		if !openNamePattern.MatchString(reason) {
			return nil, fmt.Errorf("facts: invalid self_upgrade reason %q", reason)
		}
		reasons = append(reasons, reason)
	}
	m := profileMap{
		{key: "available", value: u.Available},
		{key: "reasons", value: reasons},
	}
	if u.Arch != "" {
		if !openNamePattern.MatchString(u.Arch) {
			return nil, fmt.Errorf("facts: invalid self_upgrade arch %q", u.Arch)
		}
		m = append(m, profileMapEntry{key: "arch", value: u.Arch})
	}
	return m.MarshalCBOR()
}

// selfUpgradeFromProfile reads a SelfUpgrade value from its decoded CBOR map: both keys are
// required, every reason must be an open name, and unknown inner text keys are ignored.
func selfUpgradeFromProfile(value any) (SelfUpgrade, error) {
	m, ok := value.(profileMap)
	if !ok {
		return SelfUpgrade{}, errors.New("facts: self_upgrade is not a map")
	}
	var out SelfUpgrade
	var available, reasons bool
	for _, entry := range m {
		key, ok := entry.key.(string)
		if !ok {
			return SelfUpgrade{}, fmt.Errorf("facts: self_upgrade map key %v is not text", entry.key)
		}
		switch key {
		case "available":
			b, ok := entry.value.(bool)
			if !ok {
				return SelfUpgrade{}, errors.New("facts: self_upgrade.available is not a boolean")
			}
			out.Available, available = b, true
		case "reasons":
			list, ok := entry.value.([]any)
			if !ok {
				return SelfUpgrade{}, errors.New("facts: self_upgrade.reasons is not an array")
			}
			out.Reasons = make([]string, 0, len(list))
			for _, item := range list {
				reason, ok := item.(string)
				if !ok || !openNamePattern.MatchString(reason) {
					return SelfUpgrade{}, fmt.Errorf("facts: invalid self_upgrade reason %v", item)
				}
				out.Reasons = append(out.Reasons, reason)
			}
			reasons = true
		case "arch":
			arch, ok := entry.value.(string)
			if !ok || !openNamePattern.MatchString(arch) {
				return SelfUpgrade{}, fmt.Errorf("facts: invalid self_upgrade arch %v", entry.value)
			}
			out.Arch = arch
		}
	}
	if !available || !reasons {
		return SelfUpgrade{}, errors.New("facts: self_upgrade needs available and reasons")
	}
	return out, nil
}

// The bounds of Facts.Hints: the node truncates to them, and crhs truncates again.
const (
	MaxHintLines = 16
	MaxHintBytes = 1024
)

// Shells is the shells a node discovered when crha started (doc/design/execution.md "The exec environment").
// Sh is always present. Bash is nil when the node has none and is then omitted from the map: an
// absent optional value is omitted, not encoded as null (doc/design/protocol.md "Events").
type Shells struct {
	Sh   string
	Bash *string
}

// MarshalCBOR encodes Facts as the protocol's text-keyed map (doc/design/protocol.md "Events"). Only keys
// with a known value are emitted: an absent optional value is omitted rather than encoded as null,
// and so is shells.bash when the node has no bash.
func (f Facts) MarshalCBOR() ([]byte, error) {
	m := profileMap{
		{key: "hostname", value: f.Hostname},
	}
	text := func(key string, value *string) {
		if value != nil {
			m = append(m, profileMapEntry{key: key, value: *value})
		}
	}
	text("platform", f.Platform)
	text("hints", f.Hints)
	text("notes_path", f.NotesPath)
	if f.ClockOffsetMS != nil {
		m = append(m, profileMapEntry{key: "clock_offset_ms", value: *f.ClockOffsetMS})
	}
	if f.Shells != nil {
		m = append(m, profileMapEntry{key: "shells", value: *f.Shells})
	}
	if f.SelfUpgrade != nil {
		m = append(m, profileMapEntry{key: "self_upgrade", value: *f.SelfUpgrade})
	}
	text("upgrade_log_path", f.UpgradeLogPath)
	return m.MarshalCBOR()
}

// UnmarshalCBOR decodes the facts map strictly: a non-text key, a missing required key or a known
// key of the wrong type fails the whole Facts, while unknown text keys are ignored
// (doc/design/protocol.md "Events").
func (f *Facts) UnmarshalCBOR(data []byte) error {
	value, err := decodeAny(data)
	if err != nil {
		return err
	}
	m, ok := value.(profileMap)
	if !ok {
		return errors.New("facts: not a map")
	}
	var out Facts
	var hostname bool
	for _, entry := range m {
		key, ok := entry.key.(string)
		if !ok {
			return fmt.Errorf("facts: map key %v is not text", entry.key)
		}
		switch key {
		case "hostname":
			out.Hostname, err = factText(entry.value, key)
			hostname = true
		case "platform":
			out.Platform, err = factTextPtr(entry.value, key)
		case "hints":
			out.Hints, err = factTextPtr(entry.value, key)
		case "notes_path":
			out.NotesPath, err = factTextPtr(entry.value, key)
		case "clock_offset_ms":
			out.ClockOffsetMS, err = factIntPtr(entry.value, key)
		case "shells":
			var shells Shells
			if shells, err = shellsFromProfile(entry.value); err == nil {
				out.Shells = &shells
			}
		case "self_upgrade":
			var upgrade SelfUpgrade
			if upgrade, err = selfUpgradeFromProfile(entry.value); err == nil {
				out.SelfUpgrade = &upgrade
			}
		case "upgrade_log_path":
			out.UpgradeLogPath, err = factTextPtr(entry.value, key)
		}
		if err != nil {
			return err
		}
	}
	if !hostname {
		return errors.New("facts: missing hostname")
	}
	*f = out
	return nil
}

// MarshalCBOR encodes a Shells fact as a text-keyed map: sh always, bash only when there is one.
func (s Shells) MarshalCBOR() ([]byte, error) {
	m := profileMap{{key: "sh", value: s.Sh}}
	if s.Bash != nil {
		m = append(m, profileMapEntry{key: "bash", value: *s.Bash})
	}
	return m.MarshalCBOR()
}

// UnmarshalCBOR decodes a Shells fact: sh is required, bash is text, null or absent, unknown inner
// text keys are ignored, and a non-text inner key fails the whole Facts (doc/design/protocol.md "Events").
func (s *Shells) UnmarshalCBOR(data []byte) error {
	value, err := decodeAny(data)
	if err != nil {
		return err
	}
	shells, err := shellsFromProfile(value)
	if err != nil {
		return err
	}
	*s = shells
	return nil
}

// factText reads a text fact value.
func factText(value any, key string) (string, error) {
	s, ok := value.(string)
	if !ok {
		return "", fmt.Errorf("facts: %s is not text", key)
	}
	return s, nil
}

// factTextPtr reads an optional text fact value.
func factTextPtr(value any, key string) (*string, error) {
	s, err := factText(value, key)
	if err != nil {
		return nil, err
	}
	return &s, nil
}

// factInt reads an int fact value.
func factInt(value any, key string) (Int, error) {
	switch n := value.(type) {
	case uint64:
		if n > MaxSafeInteger {
			return 0, fmt.Errorf("facts: %s exceeds 2^53-1", key)
		}
		return Int(n), nil
	case int64:
		if n > MaxSafeInteger || n < -MaxSafeInteger {
			return 0, fmt.Errorf("facts: %s exceeds 2^53-1 in magnitude", key)
		}
		return Int(n), nil
	default:
		return 0, fmt.Errorf("facts: %s is not an integer", key)
	}
}

// factIntPtr reads an optional int fact value.
func factIntPtr(value any, key string) (*Int, error) {
	n, err := factInt(value, key)
	if err != nil {
		return nil, err
	}
	return &n, nil
}

// shellsFromProfile reads a Shells value from its decoded CBOR map.
func shellsFromProfile(value any) (Shells, error) {
	m, ok := value.(profileMap)
	if !ok {
		return Shells{}, errors.New("facts: shells is not a map")
	}
	var shells Shells
	var sh bool
	for _, entry := range m {
		key, ok := entry.key.(string)
		if !ok {
			return Shells{}, fmt.Errorf("facts: shells map key %v is not text", entry.key)
		}
		switch key {
		case "sh":
			text, err := factText(entry.value, "shells.sh")
			if err != nil {
				return Shells{}, err
			}
			shells.Sh, sh = text, true
		case "bash":
			if entry.value == nil {
				continue // null means the node has no bash
			}
			text, err := factText(entry.value, "shells.bash")
			if err != nil {
				return Shells{}, err
			}
			shells.Bash = &text
		}
	}
	if !sh {
		return Shells{}, errors.New("facts: shells has no sh")
	}
	return shells, nil
}

// Error is the body of an error response and of Outcome's "error" branch.
type Error struct {
	_       struct{} `cbor:",toarray"`
	Code    string
	Message string
}

// NodeStatus is the node.status event body.
type NodeStatus struct {
	_       struct{} `cbor:",toarray"`
	NodeID  string
	State   NodeStatusState
	Message string
}

// Ping is the ping request and response body.
type Ping struct {
	_   struct{} `cbor:",toarray"`
	Seq Uint
}

// TaskInput is the task.input request body.
type TaskInput struct {
	_      struct{} `cbor:",toarray"`
	TaskID string
	Offset Uint
	Data   []byte
}

// TaskCancel is the task.cancel request body.
type TaskCancel struct {
	_      struct{} `cbor:",toarray"`
	TaskID string
}

// TaskQuery is the task.query request body.
type TaskQuery struct {
	_      struct{} `cbor:",toarray"`
	TaskID string
}

// TaskOutput is the task.output event body: one chunk of the task's single output stream.
type TaskOutput struct {
	_      struct{} `cbor:",toarray"`
	TaskID string
	Offset Uint
	Data   []byte
}

// TaskExitAck is the task.exit.ack event body.
type TaskExitAck struct {
	_      struct{} `cbor:",toarray"`
	TaskID string
}

// PTYOpen is the pty.open request body: the terminal id crhs chose, its argv (empty means the
// identity's login shell), its initial size, its privileged flag and the size of the scrollback ring
// buffer. A privileged terminal also carries its authorization exactly as task.start does: Attempt,
// the Authorizations (CBOR authorization objects) and crhs's Cosign ticket, or nil. An unprivileged
// one carries 0, an empty list and nil.
type PTYOpen struct {
	_               struct{} `cbor:",toarray"`
	PTYID           string
	Argv            []string
	Rows            Uint
	Cols            Uint
	Privileged      bool
	ScrollbackBytes Uint
	Attempt         Uint
	Authorizations  [][]byte
	Cosign          *[]byte
}

// PTYResize is the pty.resize request body.
type PTYResize struct {
	_     struct{} `cbor:",toarray"`
	PTYID string
	Rows  Uint
	Cols  Uint
}

// PTYClose is the pty.close request body: the reason is one of doc/design/pty.md "Lifecycle".
type PTYClose struct {
	_      struct{} `cbor:",toarray"`
	PTYID  string
	Reason string
}

// The reasons a pty.exited event can name: the process ended by itself, or a privileged terminal
// lost its privileged mode (doc/design/pty.md "Lifecycle").
const (
	PTYExitReasonExited     = "exited"
	PTYExitReasonHelperLost = "helper_lost"
)

// PTYStreamLost is the abort code of a terminal data connection whose byte stream cannot continue
// without a gap or a repeat (doc/design/pty.md "crha").
const PTYStreamLost = "stream_lost"

// PTYExited is the pty.exited event body: the exit code is signed, so a killed process can report -1,
// and Reason is one of PTYExitReasonExited and PTYExitReasonHelperLost.
type PTYExited struct {
	_        struct{} `cbor:",toarray"`
	PTYID    string
	ExitCode Int
	Reason   string
}

// PTYStatus is one terminal of the pty.list event: its id, whether its process has exited, and its
// exit code (0 while it runs). crhs only reconciles its memory-only copy against it, so the entry
// carries nothing else (doc/design/pty.md "Reconnect").
type PTYStatus struct {
	_        struct{} `cbor:",toarray"`
	PTYID    string
	Exited   bool
	ExitCode Int
}

// PTYList is the pty.list event body: a one-element tuple holding every active terminal, sent after
// hello on reconnect (doc/design/pty.md "Reconnect"). Each PTYStatus carries its own id, so there is
// no outer terminal id.
type PTYList struct {
	_         struct{} `cbor:",toarray"`
	Terminals []PTYStatus
}

// The limits of one metrics sample (doc/design/metrics.md "Limits"): crha truncates before sending,
// and the decoder rejects a body beyond them.
const (
	MaxMetricsCores      = 1024
	MaxMetricsDisks      = 64
	MaxMetricsInterfaces = 256
)

// MetricsSnapshot is the metrics.collect response body (doc/design/metrics.md "crha nodes"). It is
// the protocol's second text-keyed map: every field is optional, and a field crha could not read is
// absent rather than zero. Unknown text keys are ignored, like Facts, so a field added later does
// not break an older crhs.
type MetricsSnapshot struct {
	BootID     *string
	UptimeSec  *Uint
	CPU        *MetricsCPU
	Loads      *MetricsLoads
	Memory     *MetricsMemory
	Swap       *MetricsSwap
	Disks      []MetricsDisk
	Interfaces []MetricsInterface
}

// isProfileValue marks MetricsSnapshot as a map body: its schema decode drops unknown keys, so the
// strict decode compares the generic value instead of re-encoding the struct (doc/design/protocol.md
// "Events", cbor.go profileValue).
func (*MetricsSnapshot) isProfileValue() {}

// MarshalCBOR encodes a MetricsSnapshot as the optional-field map. An absent pointer or a nil list
// is omitted; a present empty list is encoded as an empty array.
func (m MetricsSnapshot) MarshalCBOR() ([]byte, error) {
	entries := profileMap{}
	if m.BootID != nil {
		entries = append(entries, profileMapEntry{key: "boot_id", value: *m.BootID})
	}
	if m.UptimeSec != nil {
		entries = append(entries, profileMapEntry{key: "uptime_sec", value: *m.UptimeSec})
	}
	if m.CPU != nil {
		entries = append(entries, profileMapEntry{key: "cpu", value: *m.CPU})
	}
	if m.Loads != nil {
		entries = append(entries, profileMapEntry{key: "loads", value: *m.Loads})
	}
	if m.Memory != nil {
		entries = append(entries, profileMapEntry{key: "memory", value: *m.Memory})
	}
	if m.Swap != nil {
		entries = append(entries, profileMapEntry{key: "swap", value: *m.Swap})
	}
	if m.Disks != nil {
		if len(m.Disks) > MaxMetricsDisks {
			return nil, fmt.Errorf("protocol: %d metrics disks exceeds %d", len(m.Disks), MaxMetricsDisks)
		}
		entries = append(entries, profileMapEntry{key: "disks", value: m.Disks})
	}
	if m.Interfaces != nil {
		if len(m.Interfaces) > MaxMetricsInterfaces {
			return nil, fmt.Errorf("protocol: %d metrics interfaces exceeds %d", len(m.Interfaces), MaxMetricsInterfaces)
		}
		entries = append(entries, profileMapEntry{key: "interfaces", value: m.Interfaces})
	}
	return entries.MarshalCBOR()
}

// UnmarshalCBOR decodes the optional-field map strictly: a non-text key, a null or mistyped known
// value, or a list beyond a limit fails the whole body, while unknown text keys are ignored.
func (m *MetricsSnapshot) UnmarshalCBOR(data []byte) error {
	// A null would decode into a nil map without an error; the body must be a map.
	if len(data) == 0 || data[0]>>5 != 5 {
		return errors.New("protocol: metrics is not a map")
	}
	var entries map[string]cbor.RawMessage
	if err := decMode.Unmarshal(data, &entries); err != nil {
		return err
	}
	var out MetricsSnapshot
	for key, raw := range entries {
		switch key {
		case "boot_id":
			if err := rejectNull(raw, key); err != nil {
				return err
			}
			var v string
			if err := decMode.Unmarshal(raw, &v); err != nil {
				return err
			}
			out.BootID = &v
		case "uptime_sec":
			if err := rejectNull(raw, key); err != nil {
				return err
			}
			var v Uint
			if err := decMode.Unmarshal(raw, &v); err != nil {
				return err
			}
			out.UptimeSec = &v
		case "cpu":
			if err := rejectNull(raw, key); err != nil {
				return err
			}
			var v MetricsCPU
			if err := decMode.Unmarshal(raw, &v); err != nil {
				return err
			}
			out.CPU = &v
		case "loads":
			if err := rejectNull(raw, key); err != nil {
				return err
			}
			var v MetricsLoads
			if err := decMode.Unmarshal(raw, &v); err != nil {
				return err
			}
			out.Loads = &v
		case "memory":
			if err := rejectNull(raw, key); err != nil {
				return err
			}
			var v MetricsMemory
			if err := decMode.Unmarshal(raw, &v); err != nil {
				return err
			}
			out.Memory = &v
		case "swap":
			if err := rejectNull(raw, key); err != nil {
				return err
			}
			var v MetricsSwap
			if err := decMode.Unmarshal(raw, &v); err != nil {
				return err
			}
			out.Swap = &v
		case "disks":
			if err := rejectNull(raw, key); err != nil {
				return err
			}
			var v []MetricsDisk
			if err := decMode.Unmarshal(raw, &v); err != nil {
				return err
			}
			if v == nil {
				v = []MetricsDisk{}
			}
			if len(v) > MaxMetricsDisks {
				return fmt.Errorf("protocol: %d metrics disks exceeds %d", len(v), MaxMetricsDisks)
			}
			out.Disks = v
		case "interfaces":
			if err := rejectNull(raw, key); err != nil {
				return err
			}
			var v []MetricsInterface
			if err := decMode.Unmarshal(raw, &v); err != nil {
				return err
			}
			if v == nil {
				v = []MetricsInterface{}
			}
			if len(v) > MaxMetricsInterfaces {
				return fmt.Errorf("protocol: %d metrics interfaces exceeds %d", len(v), MaxMetricsInterfaces)
			}
			out.Interfaces = v
		}
	}
	*m = out
	return nil
}

// rejectNull refuses a null value of a known optional key: absent and null are different, and the
// TypeScript codec rejects null too.
func rejectNull(raw cbor.RawMessage, key string) error {
	if len(raw) == 1 && raw[0] == 0xf6 {
		return fmt.Errorf("protocol: metrics %s is null", key)
	}
	return nil
}

// MetricsCPU is the cpu field: the cpu line's counters and every online core's. Offline cores are
// absent.
type MetricsCPU struct {
	Total MetricsCPUTotal
	Cores []MetricsCore
}

// metricsCPUWire is the [total, cores] array MetricsCPU encodes.
type metricsCPUWire struct {
	_     struct{} `cbor:",toarray"`
	Total MetricsCPUTotal
	Cores []MetricsCore
}

// MarshalCBOR encodes the cpu field as [total, cores], refusing more than MaxMetricsCores.
func (c MetricsCPU) MarshalCBOR() ([]byte, error) {
	if len(c.Cores) > MaxMetricsCores {
		return nil, fmt.Errorf("protocol: %d cpu cores exceeds %d", len(c.Cores), MaxMetricsCores)
	}
	return encMode.Marshal(metricsCPUWire{Total: c.Total, Cores: c.Cores})
}

// UnmarshalCBOR decodes [total, cores] and refuses more than MaxMetricsCores.
func (c *MetricsCPU) UnmarshalCBOR(data []byte) error {
	var wire metricsCPUWire
	if err := decMode.Unmarshal(data, &wire); err != nil {
		return err
	}
	if len(wire.Cores) > MaxMetricsCores {
		return fmt.Errorf("protocol: %d cpu cores exceeds %d", len(wire.Cores), MaxMetricsCores)
	}
	if wire.Cores == nil {
		wire.Cores = []MetricsCore{}
	}
	*c = MetricsCPU{Total: wire.Total, Cores: wire.Cores}
	return nil
}

// MetricsCPUTotal is the busy and total jiffy counters of one cpu line.
type MetricsCPUTotal struct {
	_     struct{} `cbor:",toarray"`
	Busy  Uint64
	Total Uint64
}

// MetricsCore is one online core's cpu<n> line: its index and the same two counters.
type MetricsCore struct {
	_     struct{} `cbor:",toarray"`
	Index Uint
	Busy  Uint64
	Total Uint64
}

// MetricsLoads is the three load averages in thousandths (1.23 is 1230); the CBOR profile has no
// floats and /proc/loadavg prints two decimals, so the integer is exact.
type MetricsLoads struct {
	_   struct{} `cbor:",toarray"`
	L1  Uint
	L5  Uint
	L15 Uint
}

// MetricsMemory is /proc/meminfo's MemTotal, MemAvailable, Cached and MemFree in bytes.
type MetricsMemory struct {
	_              struct{} `cbor:",toarray"`
	TotalBytes     Uint64
	AvailableBytes Uint64
	CachedBytes    Uint64
	FreeBytes      Uint64
}

// MetricsSwap is /proc/meminfo's SwapTotal and SwapFree in bytes.
type MetricsSwap struct {
	_          struct{} `cbor:",toarray"`
	TotalBytes Uint64
	FreeBytes  Uint64
}

// MetricsDisk is one configured filesystem. Error is nil for a successful statfs and holds the
// reason otherwise; the wire encodes ["ok", [name, path, total_bytes, used_bytes]] or
// ["error", [name, path, error]] (doc/design/metrics.md "crha nodes").
type MetricsDisk struct {
	Name       string
	Path       string
	TotalBytes Uint64
	UsedBytes  Uint64
	Error      *string
}

// metricsDiskOK is the success body of a MetricsDisk.
type metricsDiskOK struct {
	_          struct{} `cbor:",toarray"`
	Name       string
	Path       string
	TotalBytes Uint64
	UsedBytes  Uint64
}

// metricsDiskError is the error body of a MetricsDisk.
type metricsDiskError struct {
	_     struct{} `cbor:",toarray"`
	Name  string
	Path  string
	Error string
}

// metricsDiskUnion is the MetricsDisk union: a successful statfs or the reason it failed.
var metricsDiskUnion = newUnion("metrics disk",
	unionBranch[MetricsDisk]{
		tag: "ok",
		body: func(d MetricsDisk) (any, bool) {
			if d.Error != nil {
				return nil, false
			}
			return metricsDiskOK{
				Name: d.Name, Path: d.Path, TotalBytes: d.TotalBytes, UsedBytes: d.UsedBytes,
			}, true
		},
		decode: func(d *MetricsDisk, body cbor.RawMessage) error {
			var ok metricsDiskOK
			if err := decMode.Unmarshal(body, &ok); err != nil {
				return err
			}
			*d = MetricsDisk{Name: ok.Name, Path: ok.Path, TotalBytes: ok.TotalBytes, UsedBytes: ok.UsedBytes}
			return nil
		},
	},
	unionBranch[MetricsDisk]{
		tag: "error",
		body: func(d MetricsDisk) (any, bool) {
			if d.Error == nil {
				return nil, false
			}
			return metricsDiskError{Name: d.Name, Path: d.Path, Error: *d.Error}, true
		},
		decode: func(d *MetricsDisk, body cbor.RawMessage) error {
			var failure metricsDiskError
			if err := decMode.Unmarshal(body, &failure); err != nil {
				return err
			}
			message := failure.Error
			*d = MetricsDisk{Name: failure.Name, Path: failure.Path, Error: &message}
			return nil
		},
	},
)

// MarshalCBOR encodes a MetricsDisk as [tag, body].
func (d MetricsDisk) MarshalCBOR() ([]byte, error) {
	if d.Error != nil {
		return metricsDiskUnion.marshal(d, "error")
	}
	return metricsDiskUnion.marshal(d, "ok")
}

// UnmarshalCBOR decodes [tag, body] into the matching MetricsDisk branch.
func (d *MetricsDisk) UnmarshalCBOR(data []byte) error {
	_, err := metricsDiskUnion.unmarshal(data, d)
	return err
}

// MetricsInterface is one selected interface's /proc/net/dev counters.
type MetricsInterface struct {
	_         struct{} `cbor:",toarray"`
	Name      string
	RXBytes   Uint64
	TXBytes   Uint64
	RXPackets Uint64
	TXPackets Uint64
}

// DataConnectionInit is the client payload of a data connection's Noise IK handshake: the protocol
// major, the task id and the transfer id (doc/design/protocol.md "Data connections").
type DataConnectionInit struct {
	_             struct{} `cbor:",toarray"`
	ProtocolMajor Uint
	TaskID        string
	TransferID    string
}

// DataConnectionResponse is the server payload of a data connection's handshake: the protocol major.
type DataConnectionResponse struct {
	_             struct{} `cbor:",toarray"`
	ProtocolMajor Uint
}

// PTYConnectionInit is the client payload of a terminal's data connection's Noise IK handshake: the
// protocol major, the terminal id crhs checks against the terminal it tracks, and how many input
// bytes crha has received. crhs continues the input stream from that byte (doc/design/pty.md
// "crha").
type PTYConnectionInit struct {
	_             struct{} `cbor:",toarray"`
	ProtocolMajor Uint
	PTYID         string
	InputReceived Uint
}

// PTYConnectionResponse is the server payload of a terminal's data connection's handshake: the
// protocol major and how many output bytes crhs has received. crha continues the output stream from
// that byte (doc/design/pty.md "crha").
type PTYConnectionResponse struct {
	_              struct{} `cbor:",toarray"`
	ProtocolMajor  Uint
	OutputReceived Uint
}

// DataFrame is one CBOR frame on a data connection after its handshake: a chunk of bytes, the end of
// the transfer, or an abort with the error code that ended it.
type DataFrame struct {
	Kind  DataFrameKind
	Bytes []byte
	Code  string
}

// DataFrameKind is a DataFrame union tag.
type DataFrameKind string

const (
	DataFrameData  DataFrameKind = "data"
	DataFrameEnd   DataFrameKind = "end"
	DataFrameAbort DataFrameKind = "abort"
)

// dataFrameUnion is the DataFrame union.
var dataFrameUnion = newBareUnion("data frame",
	unionValue("data", func(f DataFrame) []byte { return f.Bytes }, func(f *DataFrame, b []byte) { f.Bytes = b }),
	unionEmpty[DataFrame]("end"),
	unionValue("abort", func(f DataFrame) string { return f.Code }, func(f *DataFrame, code string) { f.Code = code }),
)

// MarshalCBOR encodes a DataFrame as [tag, body].
func (f DataFrame) MarshalCBOR() ([]byte, error) { return dataFrameUnion.marshal(f, string(f.Kind)) }

// UnmarshalCBOR decodes [tag, body] into the matching DataFrame branch.
func (f *DataFrame) UnmarshalCBOR(data []byte) error {
	tag, err := dataFrameUnion.unmarshal(data, f)
	if err != nil {
		return err
	}
	f.Kind = DataFrameKind(tag)
	return nil
}

// Empty is the empty tuple body of commands and responses that carry no fields.
type Empty struct {
	_ struct{} `cbor:",toarray"`
}

// ExecSpec is the TaskSpec body for the "exec" kind.
type ExecSpec struct {
	_       struct{} `cbor:",toarray"`
	Command Command
	Env     map[string]string
	Cwd     string
	Stdin   *InputRef
}

// InputRef identifies input data by size and SHA-256 digest.
type InputRef struct {
	_      struct{} `cbor:",toarray"`
	Size   Uint
	SHA256 Hash
}

// FileReadMaxBytes is the page cap of one file.read task: whole lines only, the node stops at the
// first line that would not fit (doc/design/execution.md "Task types").
const FileReadMaxBytes = 50 << 10

// FileListMaxBytes bounds the entries of one file.list result so that it fits the task.exit frame:
// the node stops listing at this many bytes of entry fields and reports the result as truncated
// (doc/design/protocol.md "Task results").
const FileListMaxBytes = 32 << 10

// FileReadSpec is the TaskSpec body for the "file.read" kind: lineCount lines from startLine
// (1-based), at most FileReadMaxBytes.
type FileReadSpec struct {
	_         struct{} `cbor:",toarray"`
	Path      string
	StartLine Uint
	LineCount Uint
}

// FileWriteSpec is the TaskSpec body for the "file.write" kind. CreateParentDirs makes the node
// create missing parent directories like mkdir -p before writing.
type FileWriteSpec struct {
	_                struct{} `cbor:",toarray"`
	Path             string
	Content          InputRef
	Overwrite        bool
	Mode             Uint
	Owner            string
	Group            string
	CreateParentDirs bool
}

// TransferEndpoint is the union that names the crhs-side end of a file.push or file.pull transfer
// (doc/design/protocol.md "Data connections"). Today it has one branch: the node opens a data
// connection to crhs for TransferID.
type TransferEndpoint struct {
	Kind       TransferEndpointKind
	TransferID string
}

// TransferEndpointKind is a TransferEndpoint union tag.
type TransferEndpointKind string

const (
	TransferEndpointCRHS TransferEndpointKind = "crhs"
)

// transferEndpointUnion is the TransferEndpoint union.
var transferEndpointUnion = newUnion("transfer endpoint",
	unionValue("crhs",
		func(t TransferEndpoint) string { return t.TransferID },
		func(t *TransferEndpoint, id string) { t.TransferID = id }),
)

// MarshalCBOR encodes a TransferEndpoint as [tag, body].
func (t TransferEndpoint) MarshalCBOR() ([]byte, error) {
	return transferEndpointUnion.marshal(t, string(t.Kind))
}

// UnmarshalCBOR decodes [tag, body] into the matching TransferEndpoint branch.
func (t *TransferEndpoint) UnmarshalCBOR(data []byte) error {
	tag, err := transferEndpointUnion.unmarshal(data, t)
	if err != nil {
		return err
	}
	t.Kind = TransferEndpointKind(tag)
	return nil
}

// FilePushSpec is the TaskSpec body for the "file.push" kind: the bytes of a whole file arrive on a
// data connection and are written atomically with file.write's semantics. Size and SHA256 bind the
// content to an exact authorization or an approval (doc/design/library.md "File plane").
// CreateParentDirs makes the node create missing parent directories like mkdir -p before writing.
type FilePushSpec struct {
	_                struct{} `cbor:",toarray"`
	Path             string
	Size             Uint
	SHA256           Hash
	Overwrite        bool
	Mode             Uint
	Owner            string
	Group            string
	CreateParentDirs bool
	Endpoint         TransferEndpoint
}

// NodeUpgradeSpec is the TaskSpec body for the "node.upgrade" kind: crha Version for Arch, whose
// binary (Size, SHA256) arrives on a data connection (doc/design/distribution.md "The upgrade task").
// It is always privileged; crhs sends it only to a node whose hello lists the kind.
// upgradeVersionPattern bounds the version a node.upgrade names: it becomes a directory name and the
// first word of the authorization target, so it has no space and no "/".
var upgradeVersionPattern = regexp.MustCompile(`^[0-9][0-9A-Za-z.+-]{0,63}$`)

// ValidUpgradeVersion reports whether v may be the Version of a NodeUpgradeSpec. The node checks it
// before it renders the authorization target, so a version cannot make the target say something else.
func ValidUpgradeVersion(v string) bool { return upgradeVersionPattern.MatchString(v) }

type NodeUpgradeSpec struct {
	_        struct{} `cbor:",toarray"`
	Version  string
	Arch     string
	Size     Uint
	SHA256   Hash
	Endpoint TransferEndpoint
}

// PtyCreateSpec is the TaskSpec body for the "pty.create" kind: the argv a privileged terminal runs,
// empty for the privileged identity's login shell. Size and scrollback are not part of the spec, so
// resizing never invalidates an authorization (doc/design/pty.md "Privilege").
type PtyCreateSpec struct {
	_    struct{} `cbor:",toarray"`
	Argv []string
}

// FilePullSpec is the TaskSpec body for the "file.pull" kind: a whole regular file is sent to crhs
// on a data connection. MaxBytes is the most the destination accepts.
type FilePullSpec struct {
	_        struct{} `cbor:",toarray"`
	Path     string
	MaxBytes Uint
	Endpoint TransferEndpoint
}

// FileEditSpec is the TaskSpec body for the "file.edit" kind.
type FileEditSpec struct {
	_     struct{} `cbor:",toarray"`
	Path  string
	Edits []Edit
}

// Edit is one old-text/new-text replacement in a FileEditSpec.
type Edit struct {
	_       struct{} `cbor:",toarray"`
	OldText string
	NewText string
}

// FileStatSpec is the TaskSpec body for the "file.stat" kind.
type FileStatSpec struct {
	_    struct{} `cbor:",toarray"`
	Path string
}

// FileListSpec is the TaskSpec body for the "file.list" kind.
type FileListSpec struct {
	_     struct{} `cbor:",toarray"`
	Path  string
	Limit Uint
}

// FileReadResult is the TaskResult body for the "file.read" kind: the lines of the page the task
// kept and what it learned about the file (doc/design/protocol.md "Task results"). Total is the file's line
// count and is set only when the scan reached the end of the file.
type FileReadResult struct {
	_       struct{} `cbor:",toarray"`
	From    Uint
	To      Uint
	EOF     bool
	Total   *Uint
	TooLong bool
}

// FileStatResult is the TaskResult body for the "file.stat" kind. LinkTarget is set only when the
// path is a symbolic link.
type FileStatResult struct {
	_          struct{} `cbor:",toarray"`
	Path       string
	Type       string
	Size       Int
	Mode       string
	UID        Int
	GID        Int
	Owner      string
	Group      string
	MTime      string
	LinkTarget *string
}

// FileListEntry is one directory entry of a FileListResult.
type FileListEntry struct {
	_     struct{} `cbor:",toarray"`
	Name  string
	Type  string
	Size  Int
	Mode  string
	MTime string
}

// FileListResult is the TaskResult body for the "file.list" kind: the entries the task listed (at
// most the task's limit) and whether the limit cut the directory short.
type FileListResult struct {
	_         struct{} `cbor:",toarray"`
	Entries   []FileListEntry
	Truncated bool
}

// FileWriteResult is the TaskResult body for the "file.write" kind.
type FileWriteResult struct {
	_       struct{} `cbor:",toarray"`
	Bytes   Uint
	Created bool
}

// FileEditResult is the TaskResult body for the "file.edit" kind.
type FileEditResult struct {
	_            struct{} `cbor:",toarray"`
	Replacements Uint
}

// FilePullResult is the TaskResult body for the "file.pull" kind: the size and SHA-256 of the bytes
// the node sent. crhs checks the received bytes against them (doc/design/library.md "File plane").
type FilePullResult struct {
	_      struct{} `cbor:",toarray"`
	Size   Uint
	SHA256 Hash
}

// TaskResult is the union of the structured results a task may report. Its tag is the task kind; a
// kind that reports nothing structured has no branch. A result travels in task.exit, never in the
// output streams (doc/design/protocol.md "Task results").
type TaskResult struct {
	Kind TaskResultKind

	FileRead  *FileReadResult
	FileWrite *FileWriteResult
	FileEdit  *FileEditResult
	FileStat  *FileStatResult
	FileList  *FileListResult
	FilePull  *FilePullResult
}

// OutputMode selects how task output is delivered. "full" carries spill limits in its
// body; "text" and "status" carry an empty array.
type OutputMode struct {
	Kind       OutputModeKind
	SpillBytes Uint
	SpillLines Uint
}

// TaskSpec is the union of execution and file task specifications.
type TaskSpec struct {
	Kind TaskSpecKind

	Exec      *ExecSpec
	FileRead  *FileReadSpec
	FileWrite *FileWriteSpec
	FilePush  *FilePushSpec
	FilePull  *FilePullSpec
	FileEdit  *FileEditSpec
	FileStat  *FileStatSpec
	FileList  *FileListSpec

	NodeUpgrade *NodeUpgradeSpec

	// PtyCreate is the spec of a privileged terminal's authorization; it is never a task
	// (doc/design/pty.md "Privilege").
	PtyCreate *PtyCreateSpec
}

// Command is the union of argv and shell command forms.
type Command struct {
	Kind  CommandKind
	Argv  []string
	Shell string
}

// Outcome is the union of exit code, terminating signal and execution error.
type Outcome struct {
	Kind   OutcomeKind
	Code   Int
	Signal string
	Error  *Error
}

// NodeState is the node_state enum of HandshakeResponse.
type NodeState string

const (
	NodeActive  NodeState = "active"
	NodePending NodeState = "pending"
)

// nodeStates is the node_state enum.
var nodeStates = newEnum("node state", NodeActive, NodePending)

// MarshalCBOR encodes the enum, rejecting values outside the schema.
func (s NodeState) MarshalCBOR() ([]byte, error) { return nodeStates.marshal(s) }

// UnmarshalCBOR decodes and validates the enum.
func (s *NodeState) UnmarshalCBOR(data []byte) error { return nodeStates.unmarshal(data, s) }

// NodeStatusState is the state enum of the node.status event.
type NodeStatusState string

const (
	NodeStatusPending  NodeStatusState = "pending"
	NodeStatusActive   NodeStatusState = "active"
	NodeStatusRejected NodeStatusState = "rejected"
)

// nodeStatusStates is the node.status state enum.
var nodeStatusStates = newEnum("node status state",
	NodeStatusPending, NodeStatusActive, NodeStatusRejected)

// MarshalCBOR encodes the enum, rejecting values outside the schema.
func (s NodeStatusState) MarshalCBOR() ([]byte, error) { return nodeStatusStates.marshal(s) }

// UnmarshalCBOR decodes and validates the enum.
func (s *NodeStatusState) UnmarshalCBOR(data []byte) error {
	return nodeStatusStates.unmarshal(data, s)
}

// TaskState is the task state enum.
type TaskState string

const (
	TaskRunning TaskState = "running"
	TaskExited  TaskState = "exited"
	TaskUnknown TaskState = "unknown"
)

// taskStates is the task state enum.
var taskStates = newEnum("task state", TaskRunning, TaskExited, TaskUnknown)

// MarshalCBOR encodes the enum, rejecting values outside the schema.
func (s TaskState) MarshalCBOR() ([]byte, error) { return taskStates.marshal(s) }

// UnmarshalCBOR decodes and validates the enum.
func (s *TaskState) UnmarshalCBOR(data []byte) error { return taskStates.unmarshal(data, s) }

// TaskSpecKind is a TaskSpec union tag.
type TaskSpecKind string

const (
	TaskSpecExec      TaskSpecKind = "exec"
	TaskSpecFileRead  TaskSpecKind = "file.read"
	TaskSpecFileWrite TaskSpecKind = "file.write"
	TaskSpecFilePush  TaskSpecKind = "file.push"
	TaskSpecFilePull  TaskSpecKind = "file.pull"
	TaskSpecFileEdit  TaskSpecKind = "file.edit"
	TaskSpecFileStat  TaskSpecKind = "file.stat"
	TaskSpecFileList  TaskSpecKind = "file.list"
	// TaskSpecNodeUpgrade installs a new crha binary (doc/design/distribution.md "crha self-upgrade").
	TaskSpecNodeUpgrade TaskSpecKind = "node.upgrade"
	// TaskSpecPtyCreate is the spec of a privileged terminal's authorization: its argv only. It is
	// never a task (doc/design/pty.md "Privilege").
	TaskSpecPtyCreate TaskSpecKind = "pty.create"
)

// CommandKind is a Command union tag.
type CommandKind string

const (
	CommandArgv  CommandKind = "argv"
	CommandShell CommandKind = "shell"
)

// OutputModeKind is an OutputMode union tag.
type OutputModeKind string

const (
	OutputFull   OutputModeKind = "full"
	OutputText   OutputModeKind = "text"
	OutputStatus OutputModeKind = "status"
)

// OutcomeKind is an Outcome union tag.
type OutcomeKind string

const (
	OutcomeCode   OutcomeKind = "code"
	OutcomeSignal OutcomeKind = "signal"
	OutcomeError  OutcomeKind = "error"
)

// TaskResultKind is a TaskResult union tag: the kind of the task that reported the result.
type TaskResultKind string

const (
	TaskResultFileRead  TaskResultKind = "file.read"
	TaskResultFileWrite TaskResultKind = "file.write"
	TaskResultFileEdit  TaskResultKind = "file.edit"
	TaskResultFileStat  TaskResultKind = "file.stat"
	TaskResultFileList  TaskResultKind = "file.list"
	TaskResultFilePull  TaskResultKind = "file.pull"
)

// taskSpecUnion is the TaskSpec union: one branch per task kind.
var taskSpecUnion = newUnion("task spec",
	unionPtr[TaskSpec]("exec", func(s *TaskSpec) **ExecSpec { return &s.Exec }),
	unionPtr[TaskSpec]("file.read", func(s *TaskSpec) **FileReadSpec { return &s.FileRead }),
	unionPtr[TaskSpec]("file.write", func(s *TaskSpec) **FileWriteSpec { return &s.FileWrite }),
	unionPtr[TaskSpec]("file.push", func(s *TaskSpec) **FilePushSpec { return &s.FilePush }),
	unionPtr[TaskSpec]("file.pull", func(s *TaskSpec) **FilePullSpec { return &s.FilePull }),
	unionPtr[TaskSpec]("file.edit", func(s *TaskSpec) **FileEditSpec { return &s.FileEdit }),
	unionPtr[TaskSpec]("file.stat", func(s *TaskSpec) **FileStatSpec { return &s.FileStat }),
	unionPtr[TaskSpec]("file.list", func(s *TaskSpec) **FileListSpec { return &s.FileList }),
	unionPtr[TaskSpec]("node.upgrade", func(s *TaskSpec) **NodeUpgradeSpec { return &s.NodeUpgrade }),
	unionPtr[TaskSpec]("pty.create", func(s *TaskSpec) **PtyCreateSpec { return &s.PtyCreate }),
)

// TaskSpecKinds lists every task kind this version decodes, in the union's order. It is the list
// test/interop/known_names.json compares with TASK_SPEC_KINDS in packages/protocol, not the list a
// node advertises: pty.create is decoded for authorizations but never runs as a task, so hello omits
// it (see HelloTaskKinds).
func TaskSpecKinds() []string { return taskSpecUnion.tags() }

// HelloTaskKinds lists the kinds crha accepts in task.start, for hello's taskKinds: every decoded kind
// but pty.create, which is never a task (doc/design/pty.md "Privilege"). crhs sends a node only the
// kinds it lists (doc/design/protocol.md "Version negotiation").
func HelloTaskKinds() []string {
	kinds := TaskSpecKinds()
	return slices.DeleteFunc(kinds, func(kind string) bool { return kind == string(TaskSpecPtyCreate) })
}

// MarshalCBOR encodes a TaskSpec as [tag, body].
func (s TaskSpec) MarshalCBOR() ([]byte, error) { return taskSpecUnion.marshal(s, string(s.Kind)) }

// UnmarshalCBOR decodes [tag, body] into the matching TaskSpec branch.
func (s *TaskSpec) UnmarshalCBOR(data []byte) error {
	tag, err := taskSpecUnion.unmarshal(data, s)
	if err != nil {
		return err
	}
	s.Kind = TaskSpecKind(tag)
	return nil
}

// commandUnion is the Command union: argv or shell.
var commandUnion = newUnion("command",
	unionValue("argv", func(c Command) []string { return c.Argv }, func(c *Command, argv []string) { c.Argv = argv }),
	unionValue("shell", func(c Command) string { return c.Shell }, func(c *Command, shell string) { c.Shell = shell }),
)

// MarshalCBOR encodes a Command as [tag, body].
func (c Command) MarshalCBOR() ([]byte, error) { return commandUnion.marshal(c, string(c.Kind)) }

// UnmarshalCBOR decodes [tag, body] into the matching Command branch.
func (c *Command) UnmarshalCBOR(data []byte) error {
	tag, err := commandUnion.unmarshal(data, c)
	if err != nil {
		return err
	}
	c.Kind = CommandKind(tag)
	return nil
}

// spillLimits is the body of OutputMode's "full" branch.
type spillLimits struct {
	_     struct{} `cbor:",toarray"`
	Bytes Uint
	Lines Uint
}

// outputModeUnion is the OutputMode union: "full" carries the spill limits, "text" and "status" an
// empty body.
var outputModeUnion = newBareUnion("output mode",
	unionBranch[OutputMode]{
		tag: "full",
		body: func(m OutputMode) (any, bool) {
			return spillLimits{Bytes: m.SpillBytes, Lines: m.SpillLines}, true
		},
		decode: func(m *OutputMode, body cbor.RawMessage) error {
			var limits spillLimits
			if err := decMode.Unmarshal(body, &limits); err != nil {
				return err
			}
			m.SpillBytes, m.SpillLines = limits.Bytes, limits.Lines
			return nil
		},
	},
	unionEmpty[OutputMode]("text"),
	unionEmpty[OutputMode]("status"),
)

// MarshalCBOR encodes an OutputMode as [tag, body].
func (m OutputMode) MarshalCBOR() ([]byte, error) { return outputModeUnion.marshal(m, string(m.Kind)) }

// UnmarshalCBOR decodes [tag, body] into the matching OutputMode branch.
func (m *OutputMode) UnmarshalCBOR(data []byte) error {
	tag, err := outputModeUnion.unmarshal(data, m)
	if err != nil {
		return err
	}
	m.Kind = OutputModeKind(tag)
	return nil
}

// outcomeUnion is the Outcome union: exit code, terminating signal or execution error.
var outcomeUnion = newUnion("outcome",
	unionValue("code", func(o Outcome) Int { return o.Code }, func(o *Outcome, code Int) { o.Code = code }),
	unionValue("signal", func(o Outcome) string { return o.Signal }, func(o *Outcome, signal string) { o.Signal = signal }),
	unionPtr[Outcome]("error", func(o *Outcome) **Error { return &o.Error }),
)

// MarshalCBOR encodes an Outcome as [tag, body].
func (o Outcome) MarshalCBOR() ([]byte, error) { return outcomeUnion.marshal(o, string(o.Kind)) }

// UnmarshalCBOR decodes [tag, body] into the matching Outcome branch.
func (o *Outcome) UnmarshalCBOR(data []byte) error {
	tag, err := outcomeUnion.unmarshal(data, o)
	if err != nil {
		return err
	}
	o.Kind = OutcomeKind(tag)
	return nil
}

// taskResultUnion is the TaskResult union: one branch per task kind that reports a result. Its
// missing-body errors name the "result" that is absent.
var taskResultUnion = unionDef[TaskResult]{
	name:       "task result",
	bodyName:   "result",
	kindSuffix: " kind",
	branches: []unionBranch[TaskResult]{
		unionPtr[TaskResult]("file.read", func(r *TaskResult) **FileReadResult { return &r.FileRead }),
		unionPtr[TaskResult]("file.write", func(r *TaskResult) **FileWriteResult { return &r.FileWrite }),
		unionPtr[TaskResult]("file.edit", func(r *TaskResult) **FileEditResult { return &r.FileEdit }),
		unionPtr[TaskResult]("file.stat", func(r *TaskResult) **FileStatResult { return &r.FileStat }),
		unionPtr[TaskResult]("file.list", func(r *TaskResult) **FileListResult { return &r.FileList }),
		unionPtr[TaskResult]("file.pull", func(r *TaskResult) **FilePullResult { return &r.FilePull }),
	},
}

// MarshalCBOR encodes a TaskResult as [tag, body].
func (r TaskResult) MarshalCBOR() ([]byte, error) { return taskResultUnion.marshal(r, string(r.Kind)) }

// UnmarshalCBOR decodes [tag, body] into the matching TaskResult branch.
func (r *TaskResult) UnmarshalCBOR(data []byte) error {
	tag, err := taskResultUnion.unmarshal(data, r)
	if err != nil {
		return err
	}
	r.Kind = TaskResultKind(tag)
	return nil
}

// encodeUnion encodes a union's [tag, body] pair, rejecting invalid UTF-8 in either part
// so a union cannot bypass the text check Marshal applies to its containing value.
func encodeUnion(tag string, body any) ([]byte, error) {
	if err := validateTextValue(tag); err != nil {
		return nil, err
	}
	if err := validateTextValue(body); err != nil {
		return nil, err
	}
	return encMode.Marshal([]any{tag, body})
}

// decodeUnion splits a union's [tag, body] pair.
func decodeUnion(data []byte) (tag string, body cbor.RawMessage, err error) {
	var elems []cbor.RawMessage
	if err := decMode.Unmarshal(data, &elems); err != nil {
		return "", nil, err
	}
	if len(elems) != 2 {
		return "", nil, fmt.Errorf("protocol: union is a %d-element array, want 2", len(elems))
	}
	if err := decMode.Unmarshal(elems[0], &tag); err != nil {
		return "", nil, fmt.Errorf("protocol: union tag: %w", err)
	}
	return tag, elems[1], nil
}
