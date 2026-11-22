package agent

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"

	"github.com/Kodecable/ClusterRightHand/client/internal/logging"
	"github.com/Kodecable/ClusterRightHand/client/internal/privileged/helper"
	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
)

// relayLines returns the complete lines a nativeStderr wrote to its logger.
func relayLines(t *testing.T, buf *bytes.Buffer) []string {
	t.Helper()
	if buf.Len() == 0 {
		return nil
	}
	return strings.Split(strings.TrimSuffix(buf.String(), "\n"), "\n")
}

// helperJSON marshals one helper local-log record as the helper writes it to stderr.
func helperJSON(t *testing.T, rec helper.LogRecord) []byte {
	t.Helper()
	data, err := json.Marshal(rec)
	if err != nil {
		t.Fatalf("marshal helper record: %v", err)
	}
	return append(data, '\n')
}

// TestNativeRelayTaskStartKeepsFullSpec covers the audit trail native mode depends on: there is no
// privileged daemon and no audit file, so the relayed task.start line must keep the full spec,
// rendered as raw JSON and as the last attribute.
func TestNativeRelayTaskStartKeepsFullSpec(t *testing.T) {
	var buf bytes.Buffer
	w := &nativeStderr{log: logging.NewPlain(&buf)}
	spec := &protocol.TaskSpec{Kind: protocol.TaskSpecExec, Exec: &protocol.ExecSpec{
		Command: protocol.Command{Kind: protocol.CommandArgv, Argv: []string{"uname", "-a"}},
		Cwd:     "/srv",
	}}
	if _, err := w.Write(helperJSON(t, helper.LogRecord{
		Event: "task.start", TaskID: "t1", Attempt: 1, Privileged: true, Spec: spec,
	})); err != nil {
		t.Fatalf("Write: %v", err)
	}
	lines := relayLines(t, &buf)
	if len(lines) != 1 {
		t.Fatalf("%d lines, want 1:\n%s", len(lines), buf.String())
	}
	line := lines[0]
	if !strings.Contains(line, " INFO  native helper task.start ") {
		t.Fatalf("relayed line = %q, want an INFO record for task.start", line)
	}
	for _, want := range []string{"task_id=t1", "attempt=1", "privileged=true"} {
		if !strings.Contains(line, want) {
			t.Errorf("relayed line = %q, want it to contain %q", line, want)
		}
	}
	rawSpec, err := json.Marshal(spec)
	if err != nil {
		t.Fatalf("marshal spec: %v", err)
	}
	wantSpec := "spec=" + string(rawSpec)
	if !strings.HasSuffix(line, " "+wantSpec) {
		t.Fatalf("relayed line = %q, want it to end with %q", line, wantSpec)
	}
	if n := strings.Count(line, "spec="); n != 1 {
		t.Fatalf("relayed line = %q, has %d spec attributes, want 1", line, n)
	}
}

// TestNativeRelayHelperRecord covers that a helper record without a spec arrives in the parent's log
// as one human line: the event as the message, the fields as attributes, no time and no level keys.
func TestNativeRelayHelperRecord(t *testing.T) {
	var buf bytes.Buffer
	w := &nativeStderr{log: logging.NewPlain(&buf)}
	rec := helper.LogRecord{
		Event: "task.exit", Time: "2026-11-23T02:04:05Z", TaskID: "t1", Attempt: 1,
		Privileged: true, Outcome: "exit 1", OutputEnd: 3, DurationMS: 12,
	}
	if _, err := w.Write(helperJSON(t, rec)); err != nil {
		t.Fatalf("Write: %v", err)
	}
	lines := relayLines(t, &buf)
	if len(lines) != 1 {
		t.Fatalf("%d lines, want 1:\n%s", len(lines), buf.String())
	}
	line := lines[0]
	if !strings.Contains(line, " INFO  native helper task.exit ") {
		t.Fatalf("relayed line = %q, want an INFO record for task.exit", line)
	}
	for _, want := range []string{
		"task_id=t1", "attempt=1", "privileged=true", `outcome="exit 1"`,
		"output_end=3", "duration_ms=12",
	} {
		if !strings.Contains(line, want) {
			t.Errorf("relayed line = %q, want it to contain %q", line, want)
		}
	}
	for _, unwanted := range []string{"time=", "level=", "msg=", "spec="} {
		if strings.Contains(line, unwanted) {
			t.Errorf("relayed line = %q, must not contain %q", line, unwanted)
		}
	}
}

// TestNativeRelayFailureIsWarn covers the failure-like helper event and the raw passthrough of a
// line that is not a helper record.
func TestNativeRelayFailureIsWarn(t *testing.T) {
	var buf bytes.Buffer
	w := &nativeStderr{log: logging.NewPlain(&buf)}
	if _, err := w.Write(helperJSON(t, helper.LogRecord{
		Event: "task.exit.undelivered", TaskID: "t2", Detail: "connection closed",
	})); err != nil {
		t.Fatal(err)
	}
	_, _ = w.Write([]byte("sudo: a password is required\n"))
	lines := relayLines(t, &buf)
	if len(lines) != 2 {
		t.Fatalf("%d lines, want 2:\n%s", len(lines), buf.String())
	}
	if !strings.Contains(lines[0], " WARN  native helper task.exit.undelivered ") ||
		!strings.Contains(lines[0], "task_id=t2") ||
		!strings.Contains(lines[0], `detail="connection closed"`) {
		t.Fatalf("undelivered line = %q", lines[0])
	}
	if !strings.Contains(lines[1], " WARN  native helper stderr ") ||
		!strings.Contains(lines[1], `stderr="sudo: a password is required"`) {
		t.Fatalf("raw line = %q", lines[1])
	}
	if strings.Contains(lines[1], "INFO") {
		t.Fatalf("raw line was logged at Info: %q", lines[1])
	}
}

// TestNativeRelayUnknownJSONIsRaw covers that JSON which is not a helper record is passed through
// as the raw text, not parsed into attributes.
func TestNativeRelayUnknownJSONIsRaw(t *testing.T) {
	var buf bytes.Buffer
	w := &nativeStderr{log: logging.NewPlain(&buf)}
	_, _ = w.Write([]byte(`{"event":"something.else","task_id":"t1"}` + "\n"))
	lines := relayLines(t, &buf)
	if len(lines) != 1 || !strings.Contains(lines[0], "WARN  native helper stderr ") {
		t.Fatalf("relayed line = %q, want a raw WARN record", lines)
	}
	if !strings.Contains(lines[0], `stderr="{\"event\":\"something.else\",\"task_id\":\"t1\"}"`) {
		t.Fatalf("raw JSON line = %q, want the raw text as the attribute", lines[0])
	}
}

// TestNativeRelayPartialLine covers that a helper record split across writes is logged once, when
// its newline arrives.
func TestNativeRelayPartialLine(t *testing.T) {
	var buf bytes.Buffer
	w := &nativeStderr{log: logging.NewPlain(&buf)}
	data := helperJSON(t, helper.LogRecord{Event: "task.start", TaskID: "t1", Privileged: true})
	half := len(data) / 2
	if _, err := w.Write(data[:half]); err != nil {
		t.Fatal(err)
	}
	if buf.Len() != 0 {
		t.Fatalf("a partial line was logged: %q", buf.String())
	}
	if _, err := w.Write(data[half:]); err != nil {
		t.Fatal(err)
	}
	lines := relayLines(t, &buf)
	if len(lines) != 1 || !strings.Contains(lines[0], "native helper task.start") {
		t.Fatalf("lines = %q, want one relayed start record", lines)
	}
}

// TestNativeStderrTailUnchanged covers that the failure-message tail keeps the helper's raw lines,
// independent of how they are relayed.
func TestNativeStderrTailUnchanged(t *testing.T) {
	var buf bytes.Buffer
	w := &nativeStderr{log: logging.NewPlain(&buf)}
	record := helperJSON(t, helper.LogRecord{Event: "task.start", TaskID: "t1", Privileged: true})
	_, _ = w.Write(record)
	_, _ = w.Write([]byte("sudo: a password is required\n"))
	if got, want := w.lastLine(), "sudo: a password is required"; got != want {
		t.Fatalf("lastLine() = %q, want %q", got, want)
	}
	_, _ = w.Write([]byte("no trailing newline"))
	if got, want := w.lastLine(), "no trailing newline"; got != want {
		t.Fatalf("lastLine() without newline = %q, want %q", got, want)
	}
}
