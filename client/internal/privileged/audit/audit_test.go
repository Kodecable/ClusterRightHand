package audit

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Kodecable/ClusterRightHand/client/internal/logging"
	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
)

func TestLogWritesFileAndMirror(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "logs", "privileged.jsonl")
	var mirror bytes.Buffer
	now := time.UnixMilli(1_793_016_000_000)
	l, err := Open(path, Options{Logger: logging.NewPlain(&mirror), Now: func() time.Time { return now }})
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
			OutputEnd: 3,
		},
		{Event: "window.opened", UID: &uid, UntilMS: 1_700_000_000_000},
		{Event: "config.reloaded", Detail: "digest changed"},
		{Event: "config.reload_failed", Detail: "bad file"},
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
	// The full spec is in the accepted file line.
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

	// The mirror is one human line per record, without the time and without the full spec.
	mirrorLines := strings.Split(strings.TrimSuffix(mirror.String(), "\n"), "\n")
	if len(mirrorLines) != len(records) {
		t.Fatalf("%d mirrored lines, want %d:\n%s", len(mirrorLines), len(records), mirror.String())
	}
	for i, line := range mirrorLines {
		if strings.Contains(line, "time=") || strings.Contains(line, " spec=") {
			t.Fatalf("mirrored line %d carries the time or the full spec: %q", i+1, line)
		}
		if !strings.Contains(line, " audit "+records[i].Event) {
			t.Fatalf("mirrored line %d = %q, want the audit event %q", i+1, line, records[i].Event)
		}
		wantLevel := " INFO  "
		if records[i].Event == "task.refused" || records[i].Event == "config.reload_failed" {
			wantLevel = " WARN  "
		}
		if !strings.Contains(line, wantLevel) {
			t.Fatalf("mirrored line %d = %q, want level %q", i+1, line, strings.TrimSpace(wantLevel))
		}
	}
	acceptedLine := mirrorLines[0]
	for _, want := range []string{
		"task_id=t1", "attempt=1", "entry=crhs", "authorization_id=ab", "spec_sha256=cd",
	} {
		if !strings.Contains(acceptedLine, want) {
			t.Errorf("mirrored accepted line = %q, want it to contain %q", acceptedLine, want)
		}
	}
	refusedLine := mirrorLines[1]
	for _, want := range []string{
		`task_id=t2`, `code=authorization_rejected`, `step=7`,
		`message="trust entry rules reject this task"`,
	} {
		if !strings.Contains(refusedLine, want) {
			t.Errorf("mirrored refused line = %q, want it to contain %q", refusedLine, want)
		}
	}
	if finished := mirrorLines[2]; !strings.Contains(finished, `outcome="exit 0"`) ||
		!strings.Contains(finished, "duration_ms=12") || !strings.Contains(finished, "output_end=3") {
		t.Errorf("mirrored finished line = %q", finished)
	}
	if window := mirrorLines[3]; !strings.Contains(window, "uid=1000") ||
		!strings.Contains(window, "until_ms=1700000000000") {
		t.Errorf("mirrored window line = %q", window)
	}
}

type fakeLogFile struct {
	writes  int
	syncs   int
	syncErr error
	closed  bool
}

func (f *fakeLogFile) Write(p []byte) (int, error) {
	f.writes++
	return len(p), nil
}

func (f *fakeLogFile) Sync() error {
	f.syncs++
	return f.syncErr
}

func (f *fakeLogFile) Close() error {
	f.closed = true
	return nil
}

func TestLogSyncsEveryRecord(t *testing.T) {
	file := &fakeLogFile{}
	logger := &Logger{file: file}
	for _, event := range []string{"task.accepted", "task.finished"} {
		if err := logger.Log(Record{Event: event}); err != nil {
			t.Fatalf("Log(%s): %v", event, err)
		}
	}
	if file.writes != 2 || file.syncs != 2 {
		t.Fatalf("writes = %d, syncs = %d; want 2 each", file.writes, file.syncs)
	}

	file.syncErr = errors.New("disk went away")
	if err := logger.Log(Record{Event: "task.refused"}); err == nil || !strings.Contains(err.Error(), "audit: sync:") {
		t.Fatalf("Log with a failed Sync = %v, want the sync error", err)
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
