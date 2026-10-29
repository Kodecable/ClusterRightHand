package protocol

import (
	"bytes"
	"encoding/hex"
	"reflect"
	"testing"
)

func mustMarshalHex(t *testing.T, v any) string {
	t.Helper()
	raw, err := Marshal(v)
	if err != nil {
		t.Fatalf("Marshal(%T): %v", v, err)
	}
	return hex.EncodeToString(raw)
}

func checkRoundTrip[T any](t *testing.T, wantHex string, v T) {
	t.Helper()
	encoded, err := Marshal(v)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	if wantHex != "" {
		if got := hex.EncodeToString(encoded); got != wantHex {
			t.Fatalf("encoded as %s, want %s", got, wantHex)
		}
	}
	var back T
	if err := Unmarshal(encoded, &back); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if !reflect.DeepEqual(v, back) {
		t.Fatalf("round trip mismatch:\n got %#v\nwant %#v", back, v)
	}
	again, err := Marshal(back)
	if err != nil {
		t.Fatalf("re-Marshal: %v", err)
	}
	if !bytes.Equal(encoded, again) {
		t.Fatalf("not stable: %x -> %x", encoded, again)
	}
}

func sampleFacts() Facts {
	return Facts{
		Hostname:        "node-1",
		OSID:            "ubuntu",
		OSVersionID:     "24.04",
		OSPrettyName:    "Ubuntu 24.04 LTS",
		Kernel:          "6.8.0",
		Arch:            "amd64",
		InitSystem:      "systemd",
		PackageManagers: []string{"apt"},
		PrivilegeTools:  []string{"sudo"},
		NotesPath:       "/var/lib/crha/notes",
		Groups:          []string{"wheel"},
		ClockOffsetMS:   Int(12),
	}
}

func sampleExecSpec() ExecSpec {
	return ExecSpec{
		Command: Command{Kind: CommandArgv, Argv: []string{"echo", "hi"}},
		Env:     map[string]string{"LANG": "C.UTF-8"},
		Cwd:     "/tmp",
		Stdin:   &InputRef{Size: 3, SHA256: Hash{1, 2, 3}},
	}
}

func TestRoundTripAllTypes(t *testing.T) {
	hash := Hash{0xaa, 0xbb}
	tests := []struct {
		name string
		hex  string
		run  func(t *testing.T)
	}{
		{"Empty", "80", func(t *testing.T) { checkRoundTrip(t, "80", Empty{}) }},
		{"HandshakeInit", "", func(t *testing.T) {
			checkRoundTrip(t, "", HandshakeInit{
				ProtocolMajor: ProtocolMajor,
				ProtocolMinor: ProtocolMinor,
				Commands:      []string{CmdHello, CmdPing},
				CRHAVersion:   "1.2.3",
				ClientTimeMS:  Int(1700000000000),
				Enroll:        &Enrollment{TokenSecret: "secret", Hostname: "node-1", Facts: sampleFacts()},
			})
		}},
		{"Enrollment", "", func(t *testing.T) {
			checkRoundTrip(t, "", Enrollment{TokenSecret: "secret", Hostname: "node-1", Facts: sampleFacts()})
		}},
		{"HandshakeResponse", "", func(t *testing.T) {
			checkRoundTrip(t, "", HandshakeResponse{
				ProtocolMajor: ProtocolMajor,
				ProtocolMinor: ProtocolMinor,
				Commands:      []string{CmdHello},
				ConnectionID:  "conn",
				ServerTimeMS:  Int(1700000000001),
				NodeState:     NodeActive,
				NodeID:        "node-1",
			})
		}},
		{"Hello", "8300808060", func(t *testing.T) {
			checkRoundTrip(t, "83808060", Hello{
				Tasks:          []TaskStatus{},
				TaskKinds:      []string{},
				PrivilegedMode: "",
			})
		}},
		{"Welcome", "", func(t *testing.T) {
			checkRoundTrip(t, "", Welcome{Acks: []OutputAck{{TaskID: "t", StdoutOffset: 1, StderrOffset: 2}}})
		}},
		{"OutputAck", "8361740102", func(t *testing.T) {
			checkRoundTrip(t, "8361740102", OutputAck{TaskID: "t", StdoutOffset: 1, StderrOffset: 2})
		}},
		{"TaskStatus", "8461746772756e6e696e670102", func(t *testing.T) {
			checkRoundTrip(t, "8461746772756e6e696e670102",
				TaskStatus{TaskID: "t", State: TaskRunning, StdoutEnd: 1, StderrEnd: 2})
		}},
		{"TaskStart", "", func(t *testing.T) {
			checkRoundTrip(t, "", TaskStart{
				TaskID:         "t",
				Attempt:        2,
				Spec:           TaskSpec{Kind: TaskSpecExec, Exec: ptr(sampleExecSpec())},
				Privileged:     true,
				Authorizations: [][]byte{{1, 2}, {}},
				TimeoutMS:      1000,
				KillGraceMS:    100,
				Output:         OutputMode{Kind: OutputFull, SpillBytes: 10, SpillLines: 20},
			})
		}},
		{"TaskExit", "", func(t *testing.T) {
			checkRoundTrip(t, "", TaskExit{
				TaskID:     "t",
				Outcome:    Outcome{Kind: OutcomeCode, Code: 1},
				TimedOut:   true,
				Cancelled:  false,
				StdoutEnd:  3,
				StderrEnd:  4,
				OutputFile: "/tmp/out.log",
			})
		}},
		{"Facts", "", func(t *testing.T) { checkRoundTrip(t, "", sampleFacts()) }},
		{"Error", "8261786179", func(t *testing.T) {
			checkRoundTrip(t, "8261786179", Error{Code: "x", Message: "y"})
		}},
		{"NodeStatus", "83616e66616374697665616d", func(t *testing.T) {
			checkRoundTrip(t, "83616e66616374697665616d",
				NodeStatus{NodeID: "n", State: NodeStatusActive, Message: "m"})
		}},
		{"Ping", "8101", func(t *testing.T) { checkRoundTrip(t, "8101", Ping{Seq: 1}) }},
		{"TaskInput", "836174004200ff", func(t *testing.T) {
			checkRoundTrip(t, "836174004200ff", TaskInput{TaskID: "t", Offset: 0, Data: []byte{0, 0xff}})
		}},
		{"TaskCancel", "816174", func(t *testing.T) { checkRoundTrip(t, "816174", TaskCancel{TaskID: "t"}) }},
		{"TaskQuery", "816174", func(t *testing.T) { checkRoundTrip(t, "816174", TaskQuery{TaskID: "t"}) }},
		{"TaskOutput", "", func(t *testing.T) {
			checkRoundTrip(t, "", TaskOutput{TaskID: "t", Stream: StreamStderr, Offset: 9, Data: []byte("abc")})
		}},
		{"TaskExitAck", "816174", func(t *testing.T) { checkRoundTrip(t, "816174", TaskExitAck{TaskID: "t"}) }},
		{"ExecSpec", "", func(t *testing.T) { checkRoundTrip(t, "", sampleExecSpec()) }},
		{"InputRef", "", func(t *testing.T) { checkRoundTrip(t, "", InputRef{Size: 3, SHA256: hash}) }},
		{"FileReadSpec", "", func(t *testing.T) {
			checkRoundTrip(t, "", FileReadSpec{Path: "/etc/hosts", Offset: 2, Limit: 3})
		}},
		{"FileWriteSpec", "", func(t *testing.T) {
			checkRoundTrip(t, "", FileWriteSpec{
				Path: "/tmp/x", Content: InputRef{Size: 1, SHA256: hash}, Overwrite: true,
				Mode: 0o600, Owner: "root", Group: "root",
			})
		}},
		{"FileEditSpec", "", func(t *testing.T) {
			checkRoundTrip(t, "", FileEditSpec{Path: "/tmp/x", Edits: []Edit{{OldText: "a", NewText: "b"}}})
		}},
		{"Edit", "", func(t *testing.T) { checkRoundTrip(t, "", Edit{OldText: "a", NewText: "b"}) }},
		{"FileStatSpec", "", func(t *testing.T) { checkRoundTrip(t, "", FileStatSpec{Path: "/tmp/x"}) }},
		{"FileListSpec", "", func(t *testing.T) { checkRoundTrip(t, "", FileListSpec{Path: "/tmp", Limit: 5}) }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) { test.run(t) })
	}
}

func ptr[T any](v T) *T { return &v }

func TestRoundTripUnions(t *testing.T) {
	specs := []struct {
		name string
		hex  string
		spec TaskSpec
	}{
		{"exec", "", TaskSpec{Kind: TaskSpecExec, Exec: ptr(sampleExecSpec())}},
		{"file.read", "", TaskSpec{Kind: TaskSpecFileRead, FileRead: &FileReadSpec{Path: "/etc/hosts"}}},
		{"file.write", "", TaskSpec{Kind: TaskSpecFileWrite, FileWrite: &FileWriteSpec{
			Path: "/tmp/x", Content: InputRef{Size: 1, SHA256: Hash{1}},
		}}},
		{"file.edit", "", TaskSpec{Kind: TaskSpecFileEdit, FileEdit: &FileEditSpec{
			Path: "/tmp/x", Edits: []Edit{{OldText: "a", NewText: "b"}},
		}}},
		{"file.stat", "826966696c652e7374617481622f78", TaskSpec{Kind: TaskSpecFileStat, FileStat: &FileStatSpec{Path: "/x"}}},
		{"file.list", "", TaskSpec{Kind: TaskSpecFileList, FileList: &FileListSpec{Path: "/tmp"}}},
	}
	for _, test := range specs {
		t.Run(test.name, func(t *testing.T) { checkRoundTrip(t, test.hex, test.spec) })
	}

	commands := []struct {
		name string
		hex  string
		cmd  Command
	}{
		{"argv", "", Command{Kind: CommandArgv, Argv: []string{"ls", "-l"}}},
		{"shell", "82657368656c6c626c73", Command{Kind: CommandShell, Shell: "ls"}},
	}
	for _, test := range commands {
		t.Run("command/"+test.name, func(t *testing.T) { checkRoundTrip(t, test.hex, test.cmd) })
	}

	modes := []struct {
		name string
		hex  string
		mode OutputMode
	}{
		{"full", "", OutputMode{Kind: OutputFull, SpillBytes: 1, SpillLines: 2}},
		{"text", "82647465787480", OutputMode{Kind: OutputText}},
		{"status", "", OutputMode{Kind: OutputStatus}},
	}
	for _, test := range modes {
		t.Run("output/"+test.name, func(t *testing.T) { checkRoundTrip(t, test.hex, test.mode) })
	}

	outcomes := []struct {
		name    string
		hex     string
		outcome Outcome
	}{
		{"code", "8264636f646507", Outcome{Kind: OutcomeCode, Code: 7}},
		{"signal", "82667369676e616c645445524d", Outcome{Kind: OutcomeSignal, Signal: "TERM"}},
		{"error", "", Outcome{Kind: OutcomeError, Error: &Error{Code: "x", Message: "y"}}},
	}
	for _, test := range outcomes {
		t.Run("outcome/"+test.name, func(t *testing.T) { checkRoundTrip(t, test.hex, test.outcome) })
	}
}

func TestEmptyCollectionsEncodeAsEmpty(t *testing.T) {
	tests := []struct {
		name string
		hex  string
		v    any
	}{
		{"hello", "83808060", Hello{}},
		{"exec", "8482646172677680a060f6", ExecSpec{Command: Command{Kind: CommandArgv}}},
		{"task input", "8361740040", TaskInput{TaskID: "t"}},
		{"task start authorizations", "886000826966696c652e7374617481622f78f480000082647465787480", TaskStart{
			Spec:   TaskSpec{Kind: TaskSpecFileStat, FileStat: &FileStatSpec{Path: "/x"}},
			Output: OutputMode{Kind: OutputText},
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := mustMarshalHex(t, test.v); got != test.hex {
				t.Fatalf("encoded as %s, want %s", got, test.hex)
			}
		})
	}
}

func TestWrongTupleLength(t *testing.T) {
	tests := []struct {
		name string
		hex  string
		v    any
	}{
		{"hello extra", "840080806000", &Hello{}},
		{"hello short", "820080", &Hello{}},
		{"ping extra", "820101", &Ping{}},
		{"ping short", "80", &Ping{}},
		{"error extra", "836178617900", &Error{}},
		{"error short", "816178", &Error{}},
		{"handshake init extra", "87010080617600f600", &HandshakeInit{}},
		{"handshake init short", "85010080617600", &HandshakeInit{}},
		{"hello as map", "a0", &Hello{}},
		{"error as map", "a0", &Error{}},
		{"input ref extra", "82015820" + repeatHex("00", HashSize) + "00", &InputRef{}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if err := Unmarshal(mustHex(t, test.hex), test.v); err == nil {
				t.Fatalf("accepted %s", test.hex)
			}
		})
	}
}

func TestUnknownUnionTag(t *testing.T) {
	tests := []struct {
		name string
		raw  []any
		v    any
	}{
		{"task spec", []any{"bogus", []any{}}, &TaskSpec{}},
		{"command", []any{"bogus", "x"}, &Command{}},
		{"output mode", []any{"bogus", []any{}}, &OutputMode{}},
		{"outcome", []any{"bogus", int64(0)}, &Outcome{}},
		{"task spec wrong body", []any{"file.read", []any{"/x"}}, &TaskSpec{}},
		{"command wrong body", []any{"shell", []any{}}, &Command{}},
		{"output mode wrong body", []any{"text", []any{uint64(1)}}, &OutputMode{}},
		{"outcome wrong body", []any{"code", "x"}, &Outcome{}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			raw, err := Marshal(test.raw)
			if err != nil {
				t.Fatalf("Marshal: %v", err)
			}
			if err := Unmarshal(raw, test.v); err == nil {
				t.Fatalf("accepted %s", hex.EncodeToString(raw))
			}
		})
	}
}

func TestUnknownEnum(t *testing.T) {
	tests := []struct {
		name string
		raw  []any
		v    any
	}{
		{"stream", []any{"t", "bogus", uint64(0), []byte{}}, &TaskOutput{}},
		{"task state", []any{"t", "bogus", uint64(0), uint64(0)}, &TaskStatus{}},
		{"node state", []any{uint64(1), uint64(0), []string{}, "conn", int64(0), "bogus", "n"}, &HandshakeResponse{}},
		{"node status state", []any{"n", "bogus", "m"}, &NodeStatus{}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			raw, err := Marshal(test.raw)
			if err != nil {
				t.Fatalf("Marshal: %v", err)
			}
			if err := Unmarshal(raw, test.v); err == nil {
				t.Fatalf("accepted %s", hex.EncodeToString(raw))
			}
		})
	}
}

func TestSchemaIntegerAndFloatChecks(t *testing.T) {
	tests := []struct {
		name string
		raw  []any
		v    any
	}{
		{"float in uint", []any{"t", "running", 1.5, uint64(0)}, &TaskStatus{}},
		{"float integer value in uint", []any{"t", "running", 1.0, uint64(0)}, &TaskStatus{}},
		{"over 2^53-1 in uint", []any{"t", "running", uint64(1 << 53), uint64(0)}, &TaskStatus{}},
		{"over 2^53-1 in int", []any{uint64(1), uint64(0), []string{}, "conn", uint64(1 << 53), "active", "n"}, &HandshakeResponse{}},
		{"negative in uint", []any{int64(-1)}, &Ping{}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			raw, err := Marshal(test.raw)
			if err != nil {
				t.Fatalf("Marshal: %v", err)
			}
			if err := Unmarshal(raw, test.v); err == nil {
				t.Fatalf("accepted %s", hex.EncodeToString(raw))
			}
		})
	}
}

func TestStrictRejections(t *testing.T) {
	validHello, err := Marshal(Hello{})
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}

	// ExecSpec with argv ["x"], duplicate env keys "A", cwd "", stdin null.
	duplicateEnv := mustHex(t, "84826461726776816178a2614161316141613260f6")
	// Same ExecSpec with env encoded in non-canonical key order (b before a).
	nonCanonicalEnv := mustHex(t, "84826461726776816178a2616261326161613160f6")

	tests := []struct {
		name string
		raw  []byte
		v    any
	}{
		{"trailing bytes", append(append([]byte(nil), validHello...), 0x00), &Hello{}},
		{"tag", mustHex(t, "c100"), new(Uint)},
		{"indefinite array", mustHex(t, "9f808060ff"), &Hello{}},
		{"duplicate env key", duplicateEnv, &ExecSpec{}},
		{"non-canonical env order", nonCanonicalEnv, &ExecSpec{}},
		{"non-minimal offset", mustHex(t, "83617418004200ff"), &TaskInput{}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if err := Unmarshal(test.raw, test.v); err == nil {
				t.Fatalf("accepted %s", hex.EncodeToString(test.raw))
			}
		})
	}
}

func TestEnumEncodingRejectsUnknown(t *testing.T) {
	if _, err := Marshal(TaskStatus{State: "bogus"}); err == nil {
		t.Fatal("Marshal accepted an unknown task state")
	}
	if _, err := Marshal(TaskOutput{Stream: "bogus"}); err == nil {
		t.Fatal("Marshal accepted an unknown stream")
	}
	if _, err := Marshal(NodeStatus{State: "bogus"}); err == nil {
		t.Fatal("Marshal accepted an unknown node status state")
	}
	if _, err := Marshal(HandshakeResponse{NodeState: "bogus"}); err == nil {
		t.Fatal("Marshal accepted an unknown node state")
	}
}

func TestUnionEncodingRejectsIncomplete(t *testing.T) {
	if _, err := Marshal(TaskSpec{Kind: TaskSpecExec}); err == nil {
		t.Fatal("Marshal accepted an exec spec without a body")
	}
	if _, err := Marshal(Outcome{Kind: OutcomeError}); err == nil {
		t.Fatal("Marshal accepted an error outcome without a body")
	}
	if _, err := Marshal(TaskSpec{Kind: "bogus"}); err == nil {
		t.Fatal("Marshal accepted an unknown task spec kind")
	}
	if _, err := Marshal(Command{Kind: "bogus"}); err == nil {
		t.Fatal("Marshal accepted an unknown command kind")
	}
	if _, err := Marshal(OutputMode{Kind: "bogus"}); err == nil {
		t.Fatal("Marshal accepted an unknown output mode")
	}
	if _, err := Marshal(Outcome{Kind: "bogus"}); err == nil {
		t.Fatal("Marshal accepted an unknown outcome kind")
	}
}
