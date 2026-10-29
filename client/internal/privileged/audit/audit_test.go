package audit

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
)

func TestLogWritesFileAndMirror(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "logs", "privileged.jsonl")
	var mirror bytes.Buffer
	now := time.UnixMilli(1_793_016_000_000)
	l, err := Open(path, Options{Mirror: &mirror, Now: func() time.Time { return now }})
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	uid := uint32(1000)
	records := []Record{
		{
			Event: "task.accepted", TaskID: "t1", Attempt: 1, Entry: "crhs",
			AuthorizationID: "ab", SpecSHA256: "cd",
			Spec: &protocol.TaskSpec{Kind: protocol.TaskSpecExec, Exec: &protocol.ExecSpec{
				Command: protocol.Command{Kind: protocol.CommandArgv, Argv: []string{"true"}},
			}},
		},
		{
			Event: "task.refused", TaskID: "t2", Code: "authorization_rejected", Step: 7,
			Message: "trust entry rules reject this task",
		},
		{
			Event: "task.finished", TaskID: "t1", Outcome: "exit 0", DurationMS: 12,
			StdoutEnd: 3, StderrEnd: 0,
		},
		{Event: "local.approve", TaskID: "t3", Attempt: 2, UID: &uid},
		{Event: "revocations.added", AuthorizationIDs: []string{"aa", "bb"}},
		{Event: "config.reloaded", Detail: "digest changed"},
	}
	for _, rec := range records {
		if err := l.Log(rec); err != nil {
			t.Fatalf("Log(%s): %v", rec.Event, err)
		}
	}
	if err := l.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if err := l.Log(Record{Event: "task.accepted"}); err == nil {
		t.Fatal("logged after Close")
	}

	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if mode := info.Mode().Perm(); mode != 0o600 {
		t.Fatalf("log mode = %04o, want 0600", mode)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(string(data)), "\n")
	if len(lines) != len(records) {
		t.Fatalf("%d lines, want %d:\n%s", len(lines), len(records), data)
	}
	for i, line := range lines {
		var got map[string]any
		if err := json.Unmarshal([]byte(line), &got); err != nil {
			t.Fatalf("line %d is not JSON: %v", i+1, err)
		}
		if got["event"] != records[i].Event {
			t.Fatalf("line %d event = %v, want %q", i+1, got["event"], records[i].Event)
		}
		if got["time"] != now.UTC().Format(time.RFC3339Nano) {
			t.Fatalf("line %d time = %v", i+1, got["time"])
		}
	}
	// The mirror carries the same bytes as the file.
	if mirror.String() != string(data) {
		t.Fatalf("mirror differs from file:\nmirror %q\nfile   %q", mirror.String(), data)
	}
	// The full spec is in the accepted line.
	var accepted map[string]any
	if err := json.Unmarshal([]byte(lines[0]), &accepted); err != nil {
		t.Fatal(err)
	}
	if accepted["spec"] == nil || accepted["authorization_id"] != "ab" {
		t.Fatalf("accepted record = %v", accepted)
	}
	var refused map[string]any
	if err := json.Unmarshal([]byte(lines[1]), &refused); err != nil {
		t.Fatal(err)
	}
	if refused["code"] != "authorization_rejected" || refused["step"] != float64(7) {
		t.Fatalf("refused record = %v", refused)
	}
}

func TestOpenErrors(t *testing.T) {
	if _, err := Open("", Options{}); err == nil {
		t.Fatal("empty path accepted")
	}
	if _, err := Open(t.TempDir(), Options{}); err == nil {
		t.Fatal("directory accepted as a log file")
	}
	if err := (&Logger{}).Log(Record{Event: "x"}); err == nil {
		t.Fatal("zero Logger accepted a record")
	}
}
