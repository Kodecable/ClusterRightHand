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

// TaskExit is the task.exit event body. Result carries the task's structured result; it is nil for
// a kind that reports none (doc/protocol.md TaskResult). OutputLines is the line count of the
// merged stdout/stderr output, the same bytes the output file holds.
type TaskExit struct {
	_           struct{} `cbor:",toarray"`
	TaskID      string
	Outcome     Outcome
	TimedOut    bool
	Cancelled   bool
	StdoutEnd   Uint
	StderrEnd   Uint
	OutputFile  string
	OutputLines Uint
	Result      *TaskResult
}

// Facts is the facts event body. It is the protocol's one map-structured body: hostname is required,
// every other key is optional and its Go field is nil when the node did not report it
// (doc/protocol.md Facts). A peer may send text keys this implementation does not know; they are
// ignored, while a non-text key fails the whole Facts.
type Facts struct {
	Hostname string

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

// FileReadMaxBytes is the page cap of one file.read task: whole lines only, the node stops at the
// first line that would not fit (doc/protocol.md#任务).
const FileReadMaxBytes = 50 << 10

// FileListMaxBytes bounds the entries of one file.list result so that it fits the task.exit frame:
// the node stops listing at this many bytes of entry fields and reports the result as truncated
// (doc/protocol.md TaskResult).
const FileListMaxBytes = 32 << 10

// FileReadSpec is the TaskSpec body for the "file.read" kind: lineCount lines from startLine
// (1-based), at most FileReadMaxBytes.
type FileReadSpec struct {
	_         struct{} `cbor:",toarray"`
	Path      string
	StartLine Uint
	LineCount Uint
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

// FileReadResult is the TaskResult body for the "file.read" kind: the lines of the page the task
// kept and what it learned about the file (doc/protocol.md TaskResult). Total is the file's line
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

// TaskResult is the union of the structured results a task may report. Its tag is the task kind; a
// kind that reports nothing structured has no branch. A result travels in task.exit, never in the
// output streams (doc/protocol.md TaskResult).
type TaskResult struct {
	Kind TaskResultKind

	FileRead  *FileReadResult
	FileWrite *FileWriteResult
	FileEdit  *FileEditResult
	FileStat  *FileStatResult
	FileList  *FileListResult
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
	NodeStatusDisabled NodeStatusState = "disabled"
)

// nodeStatusStates is the node.status state enum.
var nodeStatusStates = newEnum("node status state",
	NodeStatusPending, NodeStatusActive, NodeStatusRejected, NodeStatusDisabled)

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

// Stream is the output stream enum.
type Stream string

const (
	StreamStdout Stream = "stdout"
	StreamStderr Stream = "stderr"
)

// streams is the output stream enum.
var streams = newEnum("stream", StreamStdout, StreamStderr)

// MarshalCBOR encodes the enum, rejecting values outside the schema.
func (s Stream) MarshalCBOR() ([]byte, error) { return streams.marshal(s) }

// UnmarshalCBOR decodes and validates the enum.
func (s *Stream) UnmarshalCBOR(data []byte) error { return streams.unmarshal(data, s) }

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

// TaskResultKind is a TaskResult union tag: the kind of the task that reported the result.
type TaskResultKind string

const (
	TaskResultFileRead  TaskResultKind = "file.read"
	TaskResultFileWrite TaskResultKind = "file.write"
	TaskResultFileEdit  TaskResultKind = "file.edit"
	TaskResultFileStat  TaskResultKind = "file.stat"
	TaskResultFileList  TaskResultKind = "file.list"
)

// taskSpecUnion is the TaskSpec union: one branch per task kind.
var taskSpecUnion = newUnion("task spec",
	unionPtr[TaskSpec]("exec", func(s *TaskSpec) **ExecSpec { return &s.Exec }),
	unionPtr[TaskSpec]("file.read", func(s *TaskSpec) **FileReadSpec { return &s.FileRead }),
	unionPtr[TaskSpec]("file.write", func(s *TaskSpec) **FileWriteSpec { return &s.FileWrite }),
	unionPtr[TaskSpec]("file.edit", func(s *TaskSpec) **FileEditSpec { return &s.FileEdit }),
	unionPtr[TaskSpec]("file.stat", func(s *TaskSpec) **FileStatSpec { return &s.FileStat }),
	unionPtr[TaskSpec]("file.list", func(s *TaskSpec) **FileListSpec { return &s.FileList }),
)

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
