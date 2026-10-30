package protocol

import (
	"errors"
	"fmt"

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

// OutputAck acknowledges received output offsets for one task.
type OutputAck struct {
	_            struct{} `cbor:",toarray"`
	TaskID       string
	StdoutOffset Uint
	StderrOffset Uint
}

// TaskStatus is the state of one task in Hello and task.query.
type TaskStatus struct {
	_         struct{} `cbor:",toarray"`
	TaskID    string
	State     TaskState
	StdoutEnd Uint
	StderrEnd Uint
}

// TaskStart is the task.start request body.
type TaskStart struct {
	_              struct{} `cbor:",toarray"`
	TaskID         string
	Attempt        Uint
	Spec           TaskSpec
	Privileged     bool
	Authorizations [][]byte
	TimeoutMS      Uint
	KillGraceMS    Uint
	Output         OutputMode
}

// TaskExit is the task.exit event body.
type TaskExit struct {
	_          struct{} `cbor:",toarray"`
	TaskID     string
	Outcome    Outcome
	TimedOut   bool
	Cancelled  bool
	StdoutEnd  Uint
	StderrEnd  Uint
	OutputFile string
}

// Facts is the facts event body. It is the protocol's one map-structured body: hostname and groups
// are required, every other key is optional and its Go field is nil when the node did not report it
// (doc/protocol.md Facts). A peer may send text keys this implementation does not know; they are
// ignored, while a non-text key fails the whole Facts.
type Facts struct {
	Hostname string
	Groups   []string

	OSID            *string
	OSVersionID     *string
	OSPrettyName    *string
	Kernel          *string
	Arch            *string
	InitSystem      *string
	PackageManagers []string
	PrivilegeTools  []string
	NotesPath       *string
	ClockOffsetMS   *Int
	Shells          *Shells
}

// Shells is the shells a node discovered when crha started (doc/execution-plane.md#exec-的执行环境).
// Sh is always present. Bash is nil when the node has none and is then omitted from the map: an
// absent optional value is omitted, not encoded as null (doc/protocol.md Facts).
type Shells struct {
	Sh   string
	Bash *string
}

// MarshalCBOR encodes Facts as the protocol's text-keyed map (doc/protocol.md Facts). Only keys
// with a known value are emitted: an absent optional value is omitted rather than encoded as null,
// and so is shells.bash when the node has no bash.
func (f Facts) MarshalCBOR() ([]byte, error) {
	m := profileMap{
		{key: "hostname", value: f.Hostname},
		{key: "groups", value: f.Groups},
	}
	text := func(key string, value *string) {
		if value != nil {
			m = append(m, profileMapEntry{key: key, value: *value})
		}
	}
	text("os_id", f.OSID)
	text("os_version_id", f.OSVersionID)
	text("os_pretty_name", f.OSPrettyName)
	text("kernel", f.Kernel)
	text("arch", f.Arch)
	text("init_system", f.InitSystem)
	if f.PackageManagers != nil {
		m = append(m, profileMapEntry{key: "package_managers", value: f.PackageManagers})
	}
	if f.PrivilegeTools != nil {
		m = append(m, profileMapEntry{key: "privilege_tools", value: f.PrivilegeTools})
	}
	text("notes_path", f.NotesPath)
	if f.ClockOffsetMS != nil {
		m = append(m, profileMapEntry{key: "clock_offset_ms", value: *f.ClockOffsetMS})
	}
	if f.Shells != nil {
		m = append(m, profileMapEntry{key: "shells", value: *f.Shells})
	}
	return m.MarshalCBOR()
}

// UnmarshalCBOR decodes the facts map strictly: a non-text key, a missing required key or a known
// key of the wrong type fails the whole Facts, while unknown text keys are ignored
// (doc/protocol.md Facts).
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
	var hostname, groups bool
	for _, entry := range m {
		key, ok := entry.key.(string)
		if !ok {
			return fmt.Errorf("facts: map key %v is not text", entry.key)
		}
		switch key {
		case "hostname":
			out.Hostname, err = factText(entry.value, key)
			hostname = true
		case "groups":
			out.Groups, err = factTexts(entry.value, key)
			groups = true
		case "os_id":
			out.OSID, err = factTextPtr(entry.value, key)
		case "os_version_id":
			out.OSVersionID, err = factTextPtr(entry.value, key)
		case "os_pretty_name":
			out.OSPrettyName, err = factTextPtr(entry.value, key)
		case "kernel":
			out.Kernel, err = factTextPtr(entry.value, key)
		case "arch":
			out.Arch, err = factTextPtr(entry.value, key)
		case "init_system":
			out.InitSystem, err = factTextPtr(entry.value, key)
		case "package_managers":
			out.PackageManagers, err = factTexts(entry.value, key)
		case "privilege_tools":
			out.PrivilegeTools, err = factTexts(entry.value, key)
		case "notes_path":
			out.NotesPath, err = factTextPtr(entry.value, key)
		case "clock_offset_ms":
			out.ClockOffsetMS, err = factIntPtr(entry.value, key)
		case "shells":
			var shells Shells
			if shells, err = shellsFromProfile(entry.value); err == nil {
				out.Shells = &shells
			}
		}
		if err != nil {
			return err
		}
	}
	if !hostname {
		return errors.New("facts: missing hostname")
	}
	if !groups {
		return errors.New("facts: missing groups")
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
// text keys are ignored, and a non-text inner key fails the whole Facts (doc/protocol.md Facts).
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

// factTexts reads a [text] fact value.
func factTexts(value any, key string) ([]string, error) {
	items, ok := value.([]any)
	if !ok {
		return nil, fmt.Errorf("facts: %s is not an array", key)
	}
	out := make([]string, len(items))
	for i, item := range items {
		s, ok := item.(string)
		if !ok {
			return nil, fmt.Errorf("facts: %s[%d] is not text", key, i)
		}
		out[i] = s
	}
	return out, nil
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

// TaskOutput is the task.output event body.
type TaskOutput struct {
	_      struct{} `cbor:",toarray"`
	TaskID string
	Stream Stream
	Offset Uint
	Data   []byte
}

// TaskExitAck is the task.exit.ack event body.
type TaskExitAck struct {
	_      struct{} `cbor:",toarray"`
	TaskID string
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

// FileReadSpec is the TaskSpec body for the "file.read" kind.
type FileReadSpec struct {
	_      struct{} `cbor:",toarray"`
	Path   string
	Offset Uint
	Limit  Uint
}

// FileWriteSpec is the TaskSpec body for the "file.write" kind.
type FileWriteSpec struct {
	_         struct{} `cbor:",toarray"`
	Path      string
	Content   InputRef
	Overwrite bool
	Mode      Uint
	Owner     string
	Group     string
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
	FileEdit  *FileEditSpec
	FileStat  *FileStatSpec
	FileList  *FileListSpec
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

func (s NodeState) valid() bool { return s == NodeActive || s == NodePending }

// MarshalCBOR encodes the enum, rejecting values outside the schema.
func (s NodeState) MarshalCBOR() ([]byte, error) {
	return marshalEnum("node state", s, NodeState.valid)
}

// UnmarshalCBOR decodes and validates the enum.
func (s *NodeState) UnmarshalCBOR(data []byte) error {
	return unmarshalEnum("node state", data, s, NodeState.valid)
}

// NodeStatusState is the state enum of the node.status event.
type NodeStatusState string

const (
	NodeStatusPending  NodeStatusState = "pending"
	NodeStatusActive   NodeStatusState = "active"
	NodeStatusRejected NodeStatusState = "rejected"
	NodeStatusDisabled NodeStatusState = "disabled"
)

func (s NodeStatusState) valid() bool {
	switch s {
	case NodeStatusPending, NodeStatusActive, NodeStatusRejected, NodeStatusDisabled:
		return true
	default:
		return false
	}
}

// MarshalCBOR encodes the enum, rejecting values outside the schema.
func (s NodeStatusState) MarshalCBOR() ([]byte, error) {
	return marshalEnum("node status state", s, NodeStatusState.valid)
}

// UnmarshalCBOR decodes and validates the enum.
func (s *NodeStatusState) UnmarshalCBOR(data []byte) error {
	return unmarshalEnum("node status state", data, s, NodeStatusState.valid)
}

// TaskState is the task state enum.
type TaskState string

const (
	TaskRunning TaskState = "running"
	TaskExited  TaskState = "exited"
	TaskUnknown TaskState = "unknown"
)

func (s TaskState) valid() bool {
	switch s {
	case TaskRunning, TaskExited, TaskUnknown:
		return true
	default:
		return false
	}
}

// MarshalCBOR encodes the enum, rejecting values outside the schema.
func (s TaskState) MarshalCBOR() ([]byte, error) {
	return marshalEnum("task state", s, TaskState.valid)
}

// UnmarshalCBOR decodes and validates the enum.
func (s *TaskState) UnmarshalCBOR(data []byte) error {
	return unmarshalEnum("task state", data, s, TaskState.valid)
}

// Stream is the output stream enum.
type Stream string

const (
	StreamStdout Stream = "stdout"
	StreamStderr Stream = "stderr"
)

func (s Stream) valid() bool { return s == StreamStdout || s == StreamStderr }

// MarshalCBOR encodes the enum, rejecting values outside the schema.
func (s Stream) MarshalCBOR() ([]byte, error) {
	return marshalEnum("stream", s, Stream.valid)
}

// UnmarshalCBOR decodes and validates the enum.
func (s *Stream) UnmarshalCBOR(data []byte) error {
	return unmarshalEnum("stream", data, s, Stream.valid)
}

// TaskSpecKind is a TaskSpec union tag.
type TaskSpecKind string

const (
	TaskSpecExec      TaskSpecKind = "exec"
	TaskSpecFileRead  TaskSpecKind = "file.read"
	TaskSpecFileWrite TaskSpecKind = "file.write"
	TaskSpecFileEdit  TaskSpecKind = "file.edit"
	TaskSpecFileStat  TaskSpecKind = "file.stat"
	TaskSpecFileList  TaskSpecKind = "file.list"
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

// MarshalCBOR encodes a TaskSpec as [tag, body].
func (s TaskSpec) MarshalCBOR() ([]byte, error) {
	switch s.Kind {
	case TaskSpecExec:
		if s.Exec == nil {
			return nil, errors.New("protocol: exec task spec has no body")
		}
		return encodeUnion(string(s.Kind), s.Exec)
	case TaskSpecFileRead:
		if s.FileRead == nil {
			return nil, errors.New("protocol: file.read task spec has no body")
		}
		return encodeUnion(string(s.Kind), s.FileRead)
	case TaskSpecFileWrite:
		if s.FileWrite == nil {
			return nil, errors.New("protocol: file.write task spec has no body")
		}
		return encodeUnion(string(s.Kind), s.FileWrite)
	case TaskSpecFileEdit:
		if s.FileEdit == nil {
			return nil, errors.New("protocol: file.edit task spec has no body")
		}
		return encodeUnion(string(s.Kind), s.FileEdit)
	case TaskSpecFileStat:
		if s.FileStat == nil {
			return nil, errors.New("protocol: file.stat task spec has no body")
		}
		return encodeUnion(string(s.Kind), s.FileStat)
	case TaskSpecFileList:
		if s.FileList == nil {
			return nil, errors.New("protocol: file.list task spec has no body")
		}
		return encodeUnion(string(s.Kind), s.FileList)
	default:
		return nil, fmt.Errorf("protocol: unknown task spec kind %q", string(s.Kind))
	}
}

// UnmarshalCBOR decodes [tag, body] into the matching TaskSpec branch.
func (s *TaskSpec) UnmarshalCBOR(data []byte) error {
	tag, body, err := decodeUnion(data)
	if err != nil {
		return err
	}
	spec := TaskSpec{Kind: TaskSpecKind(tag)}
	switch spec.Kind {
	case TaskSpecExec:
		var v ExecSpec
		if err := decMode.Unmarshal(body, &v); err != nil {
			return err
		}
		spec.Exec = &v
	case TaskSpecFileRead:
		var v FileReadSpec
		if err := decMode.Unmarshal(body, &v); err != nil {
			return err
		}
		spec.FileRead = &v
	case TaskSpecFileWrite:
		var v FileWriteSpec
		if err := decMode.Unmarshal(body, &v); err != nil {
			return err
		}
		spec.FileWrite = &v
	case TaskSpecFileEdit:
		var v FileEditSpec
		if err := decMode.Unmarshal(body, &v); err != nil {
			return err
		}
		spec.FileEdit = &v
	case TaskSpecFileStat:
		var v FileStatSpec
		if err := decMode.Unmarshal(body, &v); err != nil {
			return err
		}
		spec.FileStat = &v
	case TaskSpecFileList:
		var v FileListSpec
		if err := decMode.Unmarshal(body, &v); err != nil {
			return err
		}
		spec.FileList = &v
	default:
		return fmt.Errorf("protocol: unknown task spec tag %q", tag)
	}
	*s = spec
	return nil
}

// MarshalCBOR encodes a Command as [tag, body].
func (c Command) MarshalCBOR() ([]byte, error) {
	switch c.Kind {
	case CommandArgv:
		return encodeUnion(string(c.Kind), c.Argv)
	case CommandShell:
		return encodeUnion(string(c.Kind), c.Shell)
	default:
		return nil, fmt.Errorf("protocol: unknown command kind %q", string(c.Kind))
	}
}

// UnmarshalCBOR decodes [tag, body] into the matching Command branch.
func (c *Command) UnmarshalCBOR(data []byte) error {
	tag, body, err := decodeUnion(data)
	if err != nil {
		return err
	}
	cmd := Command{Kind: CommandKind(tag)}
	switch cmd.Kind {
	case CommandArgv:
		if err := decMode.Unmarshal(body, &cmd.Argv); err != nil {
			return err
		}
	case CommandShell:
		if err := decMode.Unmarshal(body, &cmd.Shell); err != nil {
			return err
		}
	default:
		return fmt.Errorf("protocol: unknown command tag %q", tag)
	}
	*c = cmd
	return nil
}

// spillLimits is the body of OutputMode's "full" branch.
type spillLimits struct {
	_     struct{} `cbor:",toarray"`
	Bytes Uint
	Lines Uint
}

// MarshalCBOR encodes an OutputMode as [tag, body].
func (m OutputMode) MarshalCBOR() ([]byte, error) {
	switch m.Kind {
	case OutputFull:
		return encodeUnion(string(m.Kind), spillLimits{Bytes: m.SpillBytes, Lines: m.SpillLines})
	case OutputText, OutputStatus:
		return encodeUnion(string(m.Kind), Empty{})
	default:
		return nil, fmt.Errorf("protocol: unknown output mode %q", string(m.Kind))
	}
}

// UnmarshalCBOR decodes [tag, body] into the matching OutputMode branch.
func (m *OutputMode) UnmarshalCBOR(data []byte) error {
	tag, body, err := decodeUnion(data)
	if err != nil {
		return err
	}
	mode := OutputMode{Kind: OutputModeKind(tag)}
	switch mode.Kind {
	case OutputFull:
		var limits spillLimits
		if err := decMode.Unmarshal(body, &limits); err != nil {
			return err
		}
		mode.SpillBytes = limits.Bytes
		mode.SpillLines = limits.Lines
	case OutputText, OutputStatus:
		var empty Empty
		if err := decMode.Unmarshal(body, &empty); err != nil {
			return err
		}
	default:
		return fmt.Errorf("protocol: unknown output mode tag %q", tag)
	}
	*m = mode
	return nil
}

// MarshalCBOR encodes an Outcome as [tag, body].
func (o Outcome) MarshalCBOR() ([]byte, error) {
	switch o.Kind {
	case OutcomeCode:
		return encodeUnion(string(o.Kind), o.Code)
	case OutcomeSignal:
		return encodeUnion(string(o.Kind), o.Signal)
	case OutcomeError:
		if o.Error == nil {
			return nil, errors.New("protocol: error outcome has no body")
		}
		return encodeUnion(string(o.Kind), o.Error)
	default:
		return nil, fmt.Errorf("protocol: unknown outcome kind %q", string(o.Kind))
	}
}

// UnmarshalCBOR decodes [tag, body] into the matching Outcome branch.
func (o *Outcome) UnmarshalCBOR(data []byte) error {
	tag, body, err := decodeUnion(data)
	if err != nil {
		return err
	}
	outcome := Outcome{Kind: OutcomeKind(tag)}
	switch outcome.Kind {
	case OutcomeCode:
		if err := decMode.Unmarshal(body, &outcome.Code); err != nil {
			return err
		}
	case OutcomeSignal:
		if err := decMode.Unmarshal(body, &outcome.Signal); err != nil {
			return err
		}
	case OutcomeError:
		var wireErr Error
		if err := decMode.Unmarshal(body, &wireErr); err != nil {
			return err
		}
		outcome.Error = &wireErr
	default:
		return fmt.Errorf("protocol: unknown outcome tag %q", tag)
	}
	*o = outcome
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
