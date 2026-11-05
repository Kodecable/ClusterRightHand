package helper

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"golang.org/x/sys/unix"

	"github.com/Kodecable/ClusterRightHand/client/internal/execenv"
	"github.com/Kodecable/ClusterRightHand/client/internal/privileged/wire"
	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
	"github.com/fxamacker/cbor/v2"
)

const testVersion = "0.4.0-test"

// lockedBuffer is a log sink that the helper goroutine writes and the test reads.
type lockedBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *lockedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// session is a test client of one helper process, connected through separate stdin and stdout
// pipes like the real thing.
type session struct {
	t          *testing.T
	toHelper   *io.PipeWriter
	fromHelper *io.PipeReader
	stream     *wire.Stream
	outputs    chan protocol.TaskOutput
	exits      chan protocol.TaskExit
	streamErr  chan error
	runDone    chan struct{}
	runErr     error
	log        *lockedBuffer
}

func startSession(t *testing.T, version string) *session {
	t.Helper()
	inR, inW := io.Pipe()   // client -> helper (the helper's stdin)
	outR, outW := io.Pipe() // helper -> client (the helper's stdout)
	logBuf := &lockedBuffer{}
	runDone := make(chan struct{})
	s := &session{
		t:          t,
		toHelper:   inW,
		fromHelper: outR,
		outputs:    make(chan protocol.TaskOutput, 128),
		exits:      make(chan protocol.TaskExit, 1),
		streamErr:  make(chan error, 1),
		runDone:    runDone,
		log:        logBuf,
	}
	go func() {
		s.runErr = Run(context.Background(), inR, outW, Options{Version: version, Log: logBuf})
		inR.Close()
		outW.Close()
		close(runDone)
	}()

	_, negotiated, err := wire.ClientHandshake(outR, inW, wire.ClientOptions{
		Role: wire.RoleNative, CRHAVersion: version,
	})
	if err != nil {
		t.Fatalf("handshake: %v", err)
	}
	s.stream = wire.NewStream(outR, inW, negotiated)
	peer := s.stream.Peer()
	peer.HandleEvent(protocol.EventTaskOutput, func(body cbor.RawMessage) error {
		var out protocol.TaskOutput
		if err := protocol.Unmarshal(body, &out); err != nil {
			return err
		}
		s.outputs <- out
		return nil
	})
	peer.HandleEvent(protocol.EventTaskExit, func(body cbor.RawMessage) error {
		var exit protocol.TaskExit
		if err := protocol.Unmarshal(body, &exit); err != nil {
			return err
		}
		s.exits <- exit
		return nil
	})
	go func() { s.streamErr <- s.stream.Run() }()
	t.Cleanup(func() {
		inW.Close()
		outR.Close()
		select {
		case <-runDone:
			if s.runErr != nil {
				t.Errorf("helper returned %v", s.runErr)
			}
		case <-time.After(10 * time.Second):
			t.Error("helper did not stop")
		}
	})
	return s
}

func (s *session) start(ts protocol.TaskStart) error {
	s.t.Helper()
	var empty protocol.Empty
	return s.stream.Peer().Request(context.Background(), protocol.CmdTaskStart, ts, &empty)
}

func (s *session) request(cmd string, body, resp any) error {
	s.t.Helper()
	return s.stream.Peer().Request(context.Background(), cmd, body, resp)
}

// finish waits for task.exit and collects the output that arrived before it.
func (s *session) finish() (output []byte, exit protocol.TaskExit) {
	s.t.Helper()
	collect := func(out protocol.TaskOutput) {
		output = append(output, out.Data...)
	}
	for {
		select {
		case out := <-s.outputs:
			collect(out)
		case exit = <-s.exits:
			for {
				select {
				case out := <-s.outputs:
					collect(out)
				default:
					return output, exit
				}
			}
		case <-time.After(15 * time.Second):
			s.t.Fatal("timed out waiting for task.exit")
		}
	}
}

// waitRun waits for the helper to return and checks that it succeeded.
func (s *session) waitRun() {
	s.t.Helper()
	select {
	case <-s.runDone:
		if s.runErr != nil {
			s.t.Fatalf("helper returned %v", s.runErr)
		}
	case <-time.After(15 * time.Second):
		s.t.Fatal("helper did not stop after task.exit")
	}
}

func (s *session) logRecords() []map[string]any {
	s.t.Helper()
	var records []map[string]any
	for _, line := range strings.Split(strings.TrimSpace(s.log.String()), "\n") {
		if line == "" {
			continue
		}
		var rec map[string]any
		if err := json.Unmarshal([]byte(line), &rec); err != nil {
			s.t.Fatalf("log line %q: %v", line, err)
		}
		records = append(records, rec)
	}
	return records
}

func privateDir(t *testing.T) string {
	t.Helper()
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return dir
}

func execTask(id, shell string) protocol.TaskStart {
	return protocol.TaskStart{
		TaskID:  id,
		Attempt: 1,
		Spec: protocol.TaskSpec{Kind: protocol.TaskSpecExec, Exec: &protocol.ExecSpec{
			Command: protocol.Command{Kind: protocol.CommandShell, Shell: shell},
		}},
		Privileged: true,
		Output:     protocol.OutputMode{Kind: protocol.OutputFull, SpillBytes: 1 << 20, SpillLines: 2000},
	}
}

func TestRunExecTask(t *testing.T) {
	s := startSession(t, testVersion)
	if err := s.start(execTask("exec-1", "printf out; printf oops >&2; exit 3")); err != nil {
		t.Fatalf("task.start: %v", err)
	}
	output, exit := s.finish()
	if string(output) != "outoops" {
		t.Fatalf("output %q, want stdout and stderr in write order", output)
	}
	if exit.TaskID != "exec-1" || exit.Outcome.Kind != protocol.OutcomeCode || exit.Outcome.Code != 3 {
		t.Fatalf("task.exit = %+v", exit)
	}
	if exit.OutputEnd != 7 {
		t.Fatalf("output_end = %d, want 7", exit.OutputEnd)
	}
	if exit.OutputFile != "" {
		t.Fatalf("output_file = %q, want empty (the parent owns the output file)", exit.OutputFile)
	}
	s.waitRun()

	records := s.logRecords()
	if len(records) != 2 {
		t.Fatalf("log records = %v", records)
	}
	if records[0]["event"] != "task.start" || records[0]["task_id"] != "exec-1" || records[0]["privileged"] != true {
		t.Fatalf("task.start record = %v", records[0])
	}
	spec, ok := records[0]["spec"].(map[string]any)
	if !ok || spec["Kind"] != "exec" {
		t.Fatalf("task.start record has no full spec: %v", records[0])
	}
	if records[1]["event"] != "task.exit" || records[1]["outcome"] != "exit 3" {
		t.Fatalf("task.exit record = %v", records[1])
	}
}

func TestRunFileReadTask(t *testing.T) {
	dir := privateDir(t)
	p := filepath.Join(dir, "f")
	if err := os.WriteFile(p, []byte("file content"), 0o644); err != nil {
		t.Fatal(err)
	}
	s := startSession(t, testVersion)
	ts := protocol.TaskStart{
		TaskID: "read-1", Attempt: 1, Privileged: true,
		Spec:   protocol.TaskSpec{Kind: protocol.TaskSpecFileRead, FileRead: &protocol.FileReadSpec{Path: p, StartLine: 1, LineCount: 10}},
		Output: protocol.OutputMode{Kind: protocol.OutputStatus},
	}
	if err := s.start(ts); err != nil {
		t.Fatalf("task.start: %v", err)
	}
	output, exit := s.finish()
	if string(output) != "file content" {
		t.Fatalf("output %q", output)
	}
	if exit.Outcome.Kind != protocol.OutcomeCode || exit.Outcome.Code != 0 {
		t.Fatalf("task.exit = %+v", exit)
	}
	if exit.Result == nil || exit.Result.FileRead == nil {
		t.Fatalf("task.exit result = %+v", exit.Result)
	}
	if page := exit.Result.FileRead; page.From != 1 || page.To != 1 || !page.EOF ||
		page.Total == nil || *page.Total != 1 || page.TooLong {
		t.Fatalf("file.read result = %+v", page)
	}

	// The privileged executor refuses a symbolic link at any level.
	link := filepath.Join(dir, "link")
	if err := os.Symlink(p, link); err != nil {
		t.Fatal(err)
	}
	s = startSession(t, testVersion)
	ts = protocol.TaskStart{
		TaskID: "read-2", Attempt: 1, Privileged: true,
		Spec:   protocol.TaskSpec{Kind: protocol.TaskSpecFileRead, FileRead: &protocol.FileReadSpec{Path: link, StartLine: 1, LineCount: 10}},
		Output: protocol.OutputMode{Kind: protocol.OutputStatus},
	}
	if err := s.start(ts); err != nil {
		t.Fatalf("task.start: %v", err)
	}
	_, exit = s.finish()
	if exit.Outcome.Kind != protocol.OutcomeError || exit.Outcome.Error == nil || exit.Outcome.Error.Code != "symlink_not_allowed" {
		t.Fatalf("task.exit = %+v", exit)
	}
}

func TestRunInput(t *testing.T) {
	s := startSession(t, testVersion)
	data := []byte("hello input")
	sum := sha256.Sum256(data)
	ts := execTask("input-1", "cat")
	ts.Spec.Exec.Stdin = &protocol.InputRef{Size: protocol.Uint(len(data)), SHA256: protocol.Hash(sum)}
	if err := s.start(ts); err != nil {
		t.Fatalf("task.start: %v", err)
	}
	var empty protocol.Empty
	if err := s.request(protocol.CmdTaskInput, protocol.TaskInput{TaskID: "input-1", Offset: 0, Data: data[:5]}, &empty); err != nil {
		t.Fatalf("task.input: %v", err)
	}
	if err := s.request(protocol.CmdTaskInput, protocol.TaskInput{TaskID: "input-1", Offset: 5, Data: data[5:]}, &empty); err != nil {
		t.Fatalf("task.input: %v", err)
	}
	output, exit := s.finish()
	if string(output) != string(data) {
		t.Fatalf("output %q", output)
	}
	if exit.Outcome.Kind != protocol.OutcomeCode || exit.Outcome.Code != 0 {
		t.Fatalf("task.exit = %+v", exit)
	}

	// The input error codes mirror the non-privileged mode's.
	for _, tc := range []struct {
		name string
		in   protocol.TaskInput
		want string
	}{
		{"unknown task", protocol.TaskInput{TaskID: "nope"}, "unknown_task"},
		{"out of order", protocol.TaskInput{TaskID: "input-1", Offset: 3, Data: []byte("x")}, "input_out_of_order"},
		{"too large", protocol.TaskInput{TaskID: "input-1", Offset: 0, Data: []byte("xxxxxxxxxxxxxxxx")}, "input_too_large"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := startSession(t, testVersion)
			if err := s.start(ts); err != nil {
				t.Fatalf("task.start: %v", err)
			}
			err := s.request(protocol.CmdTaskInput, tc.in, &empty)
			var remote *protocol.RemoteError
			if !errors.As(err, &remote) || remote.Code != tc.want {
				t.Fatalf("task.input = %v, want %s", err, tc.want)
			}
		})
	}
}

func TestRunInputMismatch(t *testing.T) {
	s := startSession(t, testVersion)
	sum := sha256.Sum256([]byte("abcd"))
	ts := execTask("mismatch-1", "cat")
	ts.Spec.Exec.Stdin = &protocol.InputRef{Size: 4, SHA256: protocol.Hash(sum)}
	if err := s.start(ts); err != nil {
		t.Fatalf("task.start: %v", err)
	}
	var empty protocol.Empty
	if err := s.request(protocol.CmdTaskInput, protocol.TaskInput{TaskID: "mismatch-1", Offset: 0, Data: []byte("abce")}, &empty); err != nil {
		t.Fatalf("task.input: %v", err)
	}
	_, exit := s.finish()
	if exit.Outcome.Kind != protocol.OutcomeError || exit.Outcome.Error == nil || exit.Outcome.Error.Code != "input_mismatch" {
		t.Fatalf("task.exit = %+v", exit)
	}
}

// inputExecTask is an exec task with a declared stdin; argv runs as /bin/sh -c script with
// arg as $1.
func inputExecTask(id, script, arg string, size int, data string) protocol.TaskStart {
	sum := sha256.Sum256([]byte(data))
	ts := execTask(id, "")
	ts.Spec.Exec.Command = protocol.Command{
		Kind: protocol.CommandArgv,
		Argv: []string{"/bin/sh", "-c", script, "crha-test", arg},
	}
	ts.Spec.Exec.Stdin = &protocol.InputRef{Size: protocol.Uint(size), SHA256: protocol.Hash(sum)}
	return ts
}

// TestRunInputMismatchNeverStarts covers the spooled stdin of a privileged exec task: a chunk
// that differs from the declared hash must not reach a process, so the argv never runs
// (doc/privilege.md 执行环境). The process would create the marker file immediately.
func TestRunInputMismatchNeverStarts(t *testing.T) {
	dir := privateDir(t)
	marker := filepath.Join(dir, "started")
	s := startSession(t, testVersion)
	ts := inputExecTask("mismatch-start", `touch "$1"`, marker, 4, "abcd")
	if err := s.start(ts); err != nil {
		t.Fatalf("task.start: %v", err)
	}
	// Give a process the chance to start before the first chunk is even sent.
	time.Sleep(300 * time.Millisecond)
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatalf("the process started before its input was verified (marker %v)", err)
	}
	var empty protocol.Empty
	if err := s.request(protocol.CmdTaskInput, protocol.TaskInput{TaskID: ts.TaskID, Offset: 0, Data: []byte("abce")}, &empty); err != nil {
		t.Fatalf("task.input: %v", err)
	}
	_, exit := s.finish()
	if exit.Outcome.Kind != protocol.OutcomeError || exit.Outcome.Error == nil || exit.Outcome.Error.Code != "input_mismatch" {
		t.Fatalf("task.exit = %+v", exit)
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatalf("the process ran a mismatching input (marker %v)", err)
	}
	s.waitRun()
}

// TestRunInputWaitsForComplete covers a correct multi-chunk input: the process starts only once
// the whole input matched, then reads exactly that stdin.
func TestRunInputWaitsForComplete(t *testing.T) {
	dir := privateDir(t)
	marker := filepath.Join(dir, "started")
	data := []byte("hello input")
	s := startSession(t, testVersion)
	ts := inputExecTask("spool-1", `touch "$1"; cat`, marker, len(data), string(data))
	if err := s.start(ts); err != nil {
		t.Fatalf("task.start: %v", err)
	}
	var empty protocol.Empty
	if err := s.request(protocol.CmdTaskInput, protocol.TaskInput{
		TaskID: ts.TaskID, Offset: 0, Data: data[:5],
	}, &empty); err != nil {
		t.Fatalf("task.input: %v", err)
	}
	// The first chunk is correct but incomplete, so the process must still be waiting.
	time.Sleep(300 * time.Millisecond)
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatalf("the process started before the input was complete (marker %v)", err)
	}
	if err := s.request(protocol.CmdTaskInput, protocol.TaskInput{
		TaskID: ts.TaskID, Offset: 5, Data: data[5:],
	}, &empty); err != nil {
		t.Fatalf("task.input: %v", err)
	}
	output, exit := s.finish()
	if string(output) != string(data) {
		t.Fatalf("output %q, want %q", output, data)
	}
	if exit.Outcome.Kind != protocol.OutcomeCode || exit.Outcome.Code != 0 {
		t.Fatalf("task.exit = %+v", exit)
	}
	if _, err := os.Stat(marker); err != nil {
		t.Fatalf("the process did not run after a complete input: %v", err)
	}
	s.waitRun()
}

// TestRunCancelWhileWaitingForInput covers cancelling a task whose stdin never completes: the
// process is never started, and the task ends as cancelled.
func TestRunCancelWhileWaitingForInput(t *testing.T) {
	dir := privateDir(t)
	marker := filepath.Join(dir, "started")
	s := startSession(t, testVersion)
	ts := inputExecTask("spool-cancel", `touch "$1"; sleep 30`, marker, 10, "0123456789")
	if err := s.start(ts); err != nil {
		t.Fatalf("task.start: %v", err)
	}
	var empty protocol.Empty
	if err := s.request(protocol.CmdTaskInput, protocol.TaskInput{
		TaskID: ts.TaskID, Offset: 0, Data: []byte("012"),
	}, &empty); err != nil {
		t.Fatalf("task.input: %v", err)
	}
	time.Sleep(300 * time.Millisecond)
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatalf("the process started before its input was complete (marker %v)", err)
	}
	if err := s.request(protocol.CmdTaskCancel, protocol.TaskCancel{TaskID: ts.TaskID}, &empty); err != nil {
		t.Fatalf("task.cancel: %v", err)
	}
	_, exit := s.finish()
	if !exit.Cancelled || exit.Outcome.Kind != protocol.OutcomeError || exit.Outcome.Error == nil || exit.Outcome.Error.Code != "cancelled" {
		t.Fatalf("task.exit = %+v, want a cancelled task", exit)
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatalf("a cancelled task started its process (marker %v)", err)
	}
	s.waitRun()
}

// TestRunTimeoutWhileWaitingForInput covers the task timeout before a single chunk arrived: the
// task ends as timed out and the process is never started.
func TestRunTimeoutWhileWaitingForInput(t *testing.T) {
	dir := privateDir(t)
	marker := filepath.Join(dir, "started")
	s := startSession(t, testVersion)
	ts := inputExecTask("spool-timeout", `touch "$1"; sleep 30`, marker, 10, "0123456789")
	ts.TimeoutMS = 200
	ts.KillGraceMS = 5000
	start := time.Now()
	if err := s.start(ts); err != nil {
		t.Fatalf("task.start: %v", err)
	}
	_, exit := s.finish()
	if !exit.TimedOut {
		t.Fatalf("task.exit = %+v, want timed out", exit)
	}
	if exit.Outcome.Kind != protocol.OutcomeError || exit.Outcome.Error == nil || exit.Outcome.Error.Code != "timeout" {
		t.Fatalf("task.exit = %+v, want a timeout error", exit)
	}
	if time.Since(start) > 10*time.Second {
		t.Fatalf("the timeout took %v", time.Since(start))
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatalf("a timed-out task started its process (marker %v)", err)
	}
	s.waitRun()
}

func TestRunCancel(t *testing.T) {
	s := startSession(t, testVersion)
	if err := s.start(execTask("cancel-1", "sleep 30")); err != nil {
		t.Fatalf("task.start: %v", err)
	}
	var empty protocol.Empty
	if err := s.request(protocol.CmdTaskCancel, protocol.TaskCancel{TaskID: "cancel-1"}, &empty); err != nil {
		t.Fatalf("task.cancel: %v", err)
	}
	_, exit := s.finish()
	if !exit.Cancelled || exit.Outcome.Kind != protocol.OutcomeSignal || exit.Outcome.Signal != "TERM" {
		t.Fatalf("task.exit = %+v", exit)
	}
	s.waitRun()
}

func TestRunTimeout(t *testing.T) {
	s := startSession(t, testVersion)
	ts := execTask("timeout-1", "sleep 30")
	ts.TimeoutMS = 200
	ts.KillGraceMS = 5000
	start := time.Now()
	if err := s.start(ts); err != nil {
		t.Fatalf("task.start: %v", err)
	}
	_, exit := s.finish()
	if !exit.TimedOut || exit.Outcome.Kind != protocol.OutcomeSignal || exit.Outcome.Signal != "TERM" {
		t.Fatalf("task.exit = %+v", exit)
	}
	if time.Since(start) > 10*time.Second {
		t.Fatalf("timeout took %v", time.Since(start))
	}
}

func TestRunQuery(t *testing.T) {
	s := startSession(t, testVersion)
	var status protocol.TaskStatus
	if err := s.request(protocol.CmdTaskQuery, protocol.TaskQuery{TaskID: "nope"}, &status); err != nil {
		t.Fatalf("task.query: %v", err)
	}
	if status.TaskID != "nope" || status.State != protocol.TaskUnknown {
		t.Fatalf("unknown task status = %+v", status)
	}
	if err := s.start(execTask("query-1", "printf hi")); err != nil {
		t.Fatalf("task.start: %v", err)
	}
	if err := s.request(protocol.CmdTaskQuery, protocol.TaskQuery{TaskID: "query-1"}, &status); err != nil {
		t.Fatalf("task.query: %v", err)
	}
	if status.TaskID != "query-1" || (status.State != protocol.TaskRunning && status.State != protocol.TaskExited) {
		t.Fatalf("status = %+v", status)
	}
	_, _ = s.finish()
}

func TestRunSecondTaskRejected(t *testing.T) {
	s := startSession(t, testVersion)
	// Keep the first task running until the second request arrives: with an immediate task
	// the helper may exit after task.exit (it serves exactly one task) before the second
	// task.start is read, which would test a closed stream instead of the rejection.
	if err := s.start(execTask("one", "sleep 0.5; true")); err != nil {
		t.Fatalf("task.start: %v", err)
	}
	err := s.start(execTask("two", "true"))
	var remote *protocol.RemoteError
	if !errors.As(err, &remote) || remote.Code != "already_accepted" {
		t.Fatalf("second task.start = %v, want already_accepted", err)
	}
	_, _ = s.finish()
}

// TestRunStdinEOFLetsTaskFinish covers the disconnect rule: closing the helper's stdin before the
// task ends does not kill the task, and the helper exits after reporting the outcome.
func TestRunStdinEOFLetsTaskFinish(t *testing.T) {
	s := startSession(t, testVersion)
	if err := s.start(execTask("eof-1", "sleep 0.3; printf done")); err != nil {
		t.Fatalf("task.start: %v", err)
	}
	if err := s.toHelper.Close(); err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	output, exit := s.finish()
	if string(output) != "done" || exit.Outcome.Kind != protocol.OutcomeCode || exit.Outcome.Code != 0 {
		t.Fatalf("output %q exit %+v", output, exit)
	}
	if time.Since(start) < 250*time.Millisecond {
		t.Fatalf("the task was ended early (%v)", time.Since(start))
	}
	s.waitRun()
}

// TestRunEarlyStreamEndFailsTask covers a helper that is disconnected before the task begins: with
// no task there is nothing to wait for.
func TestRunEarlyStreamEnd(t *testing.T) {
	inR, inW := io.Pipe()
	outR, outW := io.Pipe()
	runDone := make(chan error, 1)
	go func() {
		err := Run(context.Background(), inR, outW, Options{Version: testVersion})
		inR.Close()
		outW.Close()
		runDone <- err
	}()
	if _, _, err := wire.ClientHandshake(outR, inW, wire.ClientOptions{Role: wire.RoleNative, CRHAVersion: testVersion}); err != nil {
		t.Fatalf("handshake: %v", err)
	}
	inW.Close()
	outR.Close()
	select {
	case err := <-runDone:
		if err != nil {
			t.Fatalf("helper returned %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("helper did not stop")
	}
}

// TestRunAcceptedTaskWithLostResponse covers a task.start whose response cannot be sent: the task is
// accepted, so the helper runs it anyway and records the outcome in its log (the parent reports
// helper_lost).
func TestRunAcceptedTaskWithLostResponse(t *testing.T) {
	s := startSession(t, testVersion)
	frame, err := protocol.EncodeRequest(1, protocol.CmdTaskStart, execTask("lost-1", "sleep 0.2; printf ran"))
	if err != nil {
		t.Fatal(err)
	}
	// The write completes once the helper consumed the frame; closing both directions then makes its
	// response fail.
	if err := wire.WriteFrame(s.toHelper, frame); err != nil {
		t.Fatalf("write task.start: %v", err)
	}
	if err := s.toHelper.Close(); err != nil {
		t.Fatal(err)
	}
	if err := s.fromHelper.Close(); err != nil {
		t.Fatal(err)
	}
	s.waitRun()
	records := s.logRecords()
	if len(records) < 2 || records[0]["event"] != "task.start" || records[0]["task_id"] != "lost-1" {
		t.Fatalf("log records = %v", records)
	}
	if records[1]["event"] != "task.exit" || records[1]["outcome"] != "exit 0" {
		t.Fatalf("task.exit record = %v", records[1])
	}
}

// TestRunIncompleteInputOnEOF covers a stream that ends in the middle of the input: the reader cannot
// finish, so the input fails instead of blocking the helper forever.
func TestRunIncompleteInputOnEOF(t *testing.T) {
	s := startSession(t, testVersion)
	sum := sha256.Sum256([]byte("0123456789"))
	ts := execTask("partial-1", "cat")
	ts.Spec.Exec.Stdin = &protocol.InputRef{Size: 10, SHA256: protocol.Hash(sum)}
	if err := s.start(ts); err != nil {
		t.Fatalf("task.start: %v", err)
	}
	var empty protocol.Empty
	if err := s.request(protocol.CmdTaskInput, protocol.TaskInput{TaskID: "partial-1", Offset: 0, Data: []byte("012")}, &empty); err != nil {
		t.Fatalf("task.input: %v", err)
	}
	if err := s.toHelper.Close(); err != nil {
		t.Fatal(err)
	}
	_, exit := s.finish()
	if exit.Outcome.Kind != protocol.OutcomeError || exit.Outcome.Error == nil || exit.Outcome.Error.Code != "input_incomplete" {
		t.Fatalf("task.exit = %+v, want input_incomplete", exit)
	}
	s.waitRun()
}

func TestRunVersionMismatch(t *testing.T) {
	inR, inW := io.Pipe()
	outR, outW := io.Pipe()
	runDone := make(chan error, 1)
	go func() {
		err := Run(context.Background(), inR, outW, Options{Version: testVersion})
		inR.Close()
		outW.Close()
		runDone <- err
	}()
	// The client reports another version; the helper closes the stream instead of accepting.
	_, _, err := wire.ClientHandshake(outR, inW, wire.ClientOptions{Role: wire.RoleNative, CRHAVersion: "0.3.0"})
	if err == nil {
		t.Fatal("the handshake with a different version succeeded")
	}
	select {
	case err := <-runDone:
		if err == nil || !strings.Contains(err.Error(), "crha version") {
			t.Fatalf("helper returned %v, want a version mismatch", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("helper did not stop")
	}
}

// TestStdioFailsWithoutShell: when the helper cannot resolve sh, it fails before the handshake, so
// the non-privileged mode reports privileged_unsupported for the node's privileged tasks.
func TestStdioFailsWithoutShell(t *testing.T) {
	old := resolveEnv
	resolveEnv = func() (*execenv.Environment, error) { return nil, errors.New("no sh to run tasks") }
	defer func() { resolveEnv = old }()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	defer w.Close()
	err = Stdio(context.Background(), r, io.Discard, io.Discard, testVersion)
	if err == nil || !strings.Contains(err.Error(), "no sh") {
		t.Fatalf("Stdio = %v, want the shell resolution failure", err)
	}
}

func TestStdioRefusesTerminal(t *testing.T) {
	master, err := os.OpenFile("/dev/ptmx", os.O_RDWR, 0)
	if err != nil {
		t.Skipf("no pty available: %v", err)
	}
	defer master.Close()
	n, err := unix.IoctlGetInt(int(master.Fd()), unix.TIOCGPTN)
	if err != nil {
		t.Skipf("no pty number: %v", err)
	}
	if err := unix.IoctlSetPointerInt(int(master.Fd()), unix.TIOCSPTLCK, 0); err != nil {
		t.Skipf("cannot unlock the pty: %v", err)
	}
	slavePath := fmt.Sprintf("/dev/pts/%d", n)
	slave, err := os.OpenFile(slavePath, os.O_RDWR|unix.O_NOCTTY, 0)
	if err != nil {
		t.Skipf("cannot open %s: %v", slavePath, err)
	}
	defer slave.Close()
	if !IsTerminal(slave) {
		t.Fatalf("%s is not reported as a terminal", slavePath)
	}
	if IsTerminal(os.Stdin) && os.Stdin != nil {
		// The test binary's stdin is not a terminal under `go test`, but do not fail if it is.
		t.Log("test stdin is a terminal")
	}
	if err := Stdio(context.Background(), slave, io.Discard, io.Discard, testVersion); err == nil || !strings.Contains(err.Error(), "terminal") {
		t.Fatalf("Stdio on a terminal = %v, want a refusal", err)
	}

	// A pipe is not a terminal, so Stdio starts the handshake and fails when the pipe closes.
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	w.Close()
	if err := Stdio(context.Background(), r, io.Discard, io.Discard, testVersion); err == nil {
		t.Fatal("expected a handshake error")
	}
}
