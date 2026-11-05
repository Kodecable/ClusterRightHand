package protocol

import (
	"bytes"
	"encoding/hex"
	"reflect"
	"strings"
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
		OSID:            ptr("ubuntu"),
		OSVersionID:     ptr("24.04"),
		OSPrettyName:    ptr("Ubuntu 24.04 LTS"),
		Kernel:          ptr("6.8.0"),
		Arch:            ptr("amd64"),
		InitSystem:      ptr("systemd"),
		PackageManagers: []string{"apt"},
		PrivilegeTools:  []string{"sudo"},
		NotesPath:       ptr("/var/lib/crha/notes"),
		ClockOffsetMS:   ptr(Int(12)),
		Shells:          &Shells{Sh: "/bin/sh", Bash: ptr("/usr/bin/bash")},
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
			checkRoundTrip(t, "", Welcome{Acks: []OutputAck{{TaskID: "t", Offset: 1}}})
		}},
		{"OutputAck", "82617401", func(t *testing.T) {
			checkRoundTrip(t, "82617401", OutputAck{TaskID: "t", Offset: 1})
		}},
		{"TaskStatus", "8361746772756e6e696e6701", func(t *testing.T) {
			checkRoundTrip(t, "8361746772756e6e696e6701",
				TaskStatus{TaskID: "t", State: TaskRunning, OutputEnd: 1})
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
				TaskID:      "t",
				Outcome:     Outcome{Kind: OutcomeCode, Code: 1},
				TimedOut:    true,
				Cancelled:   false,
				OutputEnd:   3,
				OutputFile:  "/tmp/out.log",
				OutputLines: 5,
			})
		}},
		{"TaskExit with a result", "", func(t *testing.T) {
			checkRoundTrip(t, "", TaskExit{
				TaskID:  "t",
				Outcome: Outcome{Kind: OutcomeCode, Code: 0},
				Result: &TaskResult{Kind: TaskResultFileRead, FileRead: &FileReadResult{
					From: 1, To: 2, EOF: true, Total: ptr(Uint(3)),
				}},
			})
		}},
		{"FileReadResult", "", func(t *testing.T) {
			checkRoundTrip(t, "", FileReadResult{From: 1, To: 2, EOF: false, TooLong: true})
		}},
		{"FileStatResult", "", func(t *testing.T) {
			checkRoundTrip(t, "", FileStatResult{
				Path: "/tmp/x", Type: "file", Size: 7, Mode: "0644", UID: 1000, GID: 1000,
				Owner: "alice", Group: "alice", MTime: "2026-01-01T00:00:00Z", LinkTarget: ptr("/tmp/y"),
			})
		}},
		{"FileListResult", "", func(t *testing.T) {
			checkRoundTrip(t, "", FileListResult{
				Entries: []FileListEntry{{Name: "f.txt", Type: "file", Size: 7, Mode: "0644", MTime: "2026-01-01T00:00:00Z"}},
			})
		}},
		{"FileWriteResult", "", func(t *testing.T) {
			checkRoundTrip(t, "", FileWriteResult{Bytes: 3, Created: true})
		}},
		{"FileEditResult", "", func(t *testing.T) {
			checkRoundTrip(t, "", FileEditResult{Replacements: 2})
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
			checkRoundTrip(t, "", TaskOutput{TaskID: "t", Offset: 9, Data: []byte("abc")})
		}},
		{"TaskExitAck", "816174", func(t *testing.T) { checkRoundTrip(t, "816174", TaskExitAck{TaskID: "t"}) }},
		{"ExecSpec", "", func(t *testing.T) { checkRoundTrip(t, "", sampleExecSpec()) }},
		{"InputRef", "", func(t *testing.T) { checkRoundTrip(t, "", InputRef{Size: 3, SHA256: hash}) }},
		{"FileReadSpec", "", func(t *testing.T) {
			checkRoundTrip(t, "", FileReadSpec{Path: "/etc/hosts", StartLine: 2, LineCount: 3})
		}},
		{"FileWriteSpec", "", func(t *testing.T) {
			checkRoundTrip(t, "", FileWriteSpec{
				Path: "/tmp/x", Content: InputRef{Size: 1, SHA256: hash}, Overwrite: true,
				Mode: 0o600, Owner: "root", Group: "root", CreateParentDirs: true,
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
		{"file.read", "", TaskSpec{Kind: TaskSpecFileRead, FileRead: &FileReadSpec{Path: "/etc/hosts", StartLine: 1, LineCount: 3}}},
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

	results := []struct {
		name   string
		hex    string
		result TaskResult
	}{
		{"file.read", "", TaskResult{Kind: TaskResultFileRead, FileRead: &FileReadResult{
			From: 1, To: 2, EOF: true, Total: ptr(Uint(3)),
		}}},
		{"file.write", "", TaskResult{Kind: TaskResultFileWrite, FileWrite: &FileWriteResult{Bytes: 3, Created: true}}},
		{"file.edit", "", TaskResult{Kind: TaskResultFileEdit, FileEdit: &FileEditResult{Replacements: 2}}},
		{"file.stat", "", TaskResult{Kind: TaskResultFileStat, FileStat: &FileStatResult{Path: "/x", Type: "file"}}},
		{"file.list", "", TaskResult{Kind: TaskResultFileList, FileList: &FileListResult{Entries: []FileListEntry{}}}},
	}
	for _, test := range results {
		t.Run("result/"+test.name, func(t *testing.T) { checkRoundTrip(t, test.hex, test.result) })
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
		{"task exit short", "8761748264636f646500f4f4000060", &TaskExit{}},
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
		{"task result", []any{"bogus", []any{}}, &TaskResult{}},
		{"task result wrong body", []any{"file.read", []any{uint64(1)}}, &TaskResult{}},
		{"task result for a kind without one", []any{"exec", []any{}}, &TaskResult{}},
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
		{"task state", []any{"t", "bogus", uint64(0)}, &TaskStatus{}},
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

// TestUnselectedUnionBranchIsNotValidated covers the union encoding rule: only the selected
// branch reaches the wire, so text carried by another branch must not be rejected.
func TestUnselectedUnionBranchIsNotValidated(t *testing.T) {
	argv := Command{Kind: CommandArgv, Argv: []string{"true"}, Shell: "bad\xff"}
	if _, err := Marshal(argv); err != nil {
		t.Fatalf("Marshal(argv command with an unused shell): %v", err)
	}
	shell := Command{Kind: CommandShell, Shell: "bad\xff"}
	if _, err := Marshal(shell); err == nil {
		t.Fatal("Marshal accepted invalid UTF-8 in the selected shell command")
	}
	// The same applies one level up: an exec task whose shell command is unused.
	spec := TaskSpec{Kind: TaskSpecFileRead, FileRead: &FileReadSpec{Path: "/x"},
		Exec: &ExecSpec{Command: shell}}
	if _, err := Marshal(spec); err != nil {
		t.Fatalf("Marshal(file.read task spec with an unused exec branch): %v", err)
	}
}

func TestEnumEncodingRejectsUnknown(t *testing.T) {
	if _, err := Marshal(TaskStatus{State: "bogus"}); err == nil {
		t.Fatal("Marshal accepted an unknown task state")
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

// TestFactsMapKeys pins the wire form of Facts: the protocol's one text-keyed map, in canonical
// key order, with an absent optional value omitted rather than encoded as null (doc/protocol.md).
func TestFactsMapKeys(t *testing.T) {
	f := sampleFacts()
	data, err := Marshal(f)
	if err != nil {
		t.Fatal(err)
	}
	var raw map[string]any
	if err := Unmarshal(data, &raw); err != nil {
		t.Fatal(err)
	}
	want := []string{
		"arch", "clock_offset_ms", "hostname", "init_system", "kernel", "notes_path",
		"os_id", "os_pretty_name", "os_version_id", "package_managers", "privilege_tools", "shells",
	}
	if len(raw) != len(want) {
		t.Fatalf("Facts has %d keys, want %d: %v", len(raw), len(want), raw)
	}
	for _, key := range want {
		if _, ok := raw[key]; !ok {
			t.Fatalf("Facts has no %q: %v", key, raw)
		}
	}
	shells, ok := raw["shells"].(map[any]any)
	if !ok || len(shells) != 2 || shells["sh"] != "/bin/sh" || shells["bash"] != "/usr/bin/bash" {
		t.Fatalf("shells = %#v, want {sh: /bin/sh, bash: /usr/bin/bash}", raw["shells"])
	}
	if raw["clock_offset_ms"] != uint64(12) {
		t.Fatalf("clock_offset_ms = %#v", raw["clock_offset_ms"])
	}

	// An absent optional value is omitted, not encoded as null.
	minimal := Facts{Hostname: "node-1"}
	data, err = Marshal(minimal)
	if err != nil {
		t.Fatal(err)
	}
	var keys map[string]any
	if err := Unmarshal(data, &keys); err != nil {
		t.Fatal(err)
	}
	if len(keys) != 1 || keys["hostname"] != "node-1" {
		t.Fatalf("minimal facts = %#v", keys)
	}
}

// TestFactsUnknownKeys pins that a fact this implementation does not know is accepted: the strict
// comparison is on the generic CBOR value, which keeps the unknown key (doc/protocol.md Facts).
func TestFactsUnknownKeys(t *testing.T) {
	// {"groups": ["wheel"], "hostname": "node-1", "future_fact": "x"}: groups is an old fact that
	// protocol 3.0 dropped, so it is just another unknown text key now.
	data := mustHex(t, "a36667726f7570738165776865656c68686f73746e616d65666e6f64652d316b6675747572655f6661637461"+
		"78")
	var f Facts
	if err := Unmarshal(data, &f); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if f.Hostname != "node-1" {
		t.Fatalf("decoded %#v", f)
	}
	// Re-encoding the schema value drops the unknown keys; only the profile comparison keeps them.
	again, err := Marshal(f)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(again, data) {
		t.Fatalf("re-encoding kept the unknown key: %x", again)
	}
}

// TestFactsNonTextKey pins that a non-text key fails the whole Facts, also inside shells, while an
// unknown text key is ignored (doc/protocol.md Facts).
func TestFactsNonTextKey(t *testing.T) {
	for name, data := range map[string]string{
		// {1: "x", "groups": ["sudo"], "hostname": "node-1"}
		"facts key": "a30161786667726f75707381647375646f68686f73746e616d65666e6f64652d31",
		// {"groups": ["sudo"], "shells": {1: "x", "sh": "/bin/sh"}, "hostname": "node-1"}
		"shells key": "a36667726f75707381647375646f667368656c6c73a2016178627368672f62696e2f736868686f7374" +
			"6e616d65666e6f64652d31",
	} {
		t.Run(name, func(t *testing.T) {
			var f Facts
			err := Unmarshal(mustHex(t, data), &f)
			if err == nil {
				t.Fatalf("decoded %#v with a non-text key", f)
			}
			if !strings.Contains(err.Error(), "not text") {
				t.Fatalf("error does not name the non-text key: %v", err)
			}
		})
	}
}

func TestFactsRequiredKeys(t *testing.T) {
	for name, data := range map[string]string{
		// {"groups": ["wheel"]}: groups is an unknown text key now, but hostname is still missing.
		"no hostname": "a16667726f7570738165776865656c",
	} {
		t.Run(name, func(t *testing.T) {
			var f Facts
			if err := Unmarshal(mustHex(t, data), &f); err == nil {
				t.Fatalf("decoded %#v without a required key", f)
			}
		})
	}
}

func TestFactsWrongType(t *testing.T) {
	// hostname is text and clock_offset_ms is int; an unknown text key (groups) is ignored.
	for name, data := range map[string]string{
		"uint hostname": "a26667726f7570738165776865656c68686f73746e616d6500",
		"text offset":   "a36667726f7570738165776865656c68686f73746e616d65666e6f64652d316f636c6f636b5f6f66667365745f6d736130",
	} {
		t.Run(name, func(t *testing.T) {
			var f Facts
			if err := Unmarshal(mustHex(t, data), &f); err == nil {
				t.Fatalf("decoded %#v with a wrong type", f)
			}
		})
	}
}

func TestShellsMap(t *testing.T) {
	// sh without bash: bash is omitted, not null.
	data, err := Marshal(Shells{Sh: "/bin/sh"})
	if err != nil {
		t.Fatal(err)
	}
	if want := "a1627368672f62696e2f7368"; hex.EncodeToString(data) != want {
		t.Fatalf("encoded as %x, want %s", data, want)
	}
	var back Shells
	if err := Unmarshal(data, &back); err != nil {
		t.Fatal(err)
	}
	if back.Sh != "/bin/sh" || back.Bash != nil {
		t.Fatalf("round trip = %#v", back)
	}
	// bash null is accepted on decode (protocol.md allows text or null).
	if err := Unmarshal(mustHex(t, "a2627368672f62696e2f73686462617368f6"), &back); err != nil {
		t.Fatalf("Unmarshal bash null: %v", err)
	}
	if back.Bash != nil {
		t.Fatalf("bash = %q, want nil", *back.Bash)
	}
	// A shells map without sh is rejected.
	if err := Unmarshal(mustHex(t, "a164626173686d2f7573722f62696e2f62617368"), &back); err == nil {
		t.Fatal("decoded shells without sh")
	}
	// Unknown inner keys are ignored.
	unknown := mustHex(t, "a2627368672f62696e2f7368637a73686c2f7573722f62696e2f7a7368")
	if err := Unmarshal(unknown, &back); err != nil || back.Sh != "/bin/sh" {
		t.Fatalf("unknown inner key: %#v, %v", back, err)
	}
}
