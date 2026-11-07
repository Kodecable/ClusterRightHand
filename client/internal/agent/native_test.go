package agent

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Kodecable/ClusterRightHand/client/internal/config"
	"github.com/Kodecable/ClusterRightHand/client/internal/noise"
	"github.com/Kodecable/ClusterRightHand/client/internal/privileged/helper"
	"github.com/Kodecable/ClusterRightHand/client/internal/privileged/wire"
	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
	"github.com/Kodecable/ClusterRightHand/client/internal/version"
	"github.com/fxamacker/cbor/v2"
)

// TestMain lets the test binary act as `crha privileged stdio`. The native tests start the helper
// the way production does, only without an escalation tool: the helper is this very binary, re-run
// with the helper's arguments, so no sudo or doas is needed (doc/privilege.md, native). The
// fake-helper mode is a stand-in helper for the lost task.start response tests.
func TestMain(m *testing.M) {
	// The helper stages task stdin below a privileged state directory. The test process is not
	// root, so point it at a temporary directory that the helper process inherits; in the helper
	// process itself the same variable points at its own temporary directory.
	spool, spoolErr := os.MkdirTemp("", "crh-test-stdin-")
	if spoolErr == nil {
		os.Setenv(helper.SpoolRootEnv, spool)
	}
	cleanup := func() {
		if spoolErr == nil {
			_ = os.RemoveAll(spool)
		}
	}
	if len(os.Args) >= 3 && os.Args[1] == "privileged" && os.Args[2] == "stdio" {
		err := helper.Stdio(context.Background(), os.Stdin, os.Stdout, os.Stderr, version.Version)
		cleanup()
		if err != nil {
			fmt.Fprintln(os.Stderr, "crha privileged stdio:", err)
			os.Exit(1)
		}
		os.Exit(0)
	}
	if len(os.Args) >= 3 && os.Args[1] == "fake-helper" {
		err := runFakeHelper(os.Args[2])
		cleanup()
		if err != nil {
			fmt.Fprintln(os.Stderr, "fake helper:", err)
			os.Exit(1)
		}
		os.Exit(0)
	}
	code := m.Run()
	cleanup()
	os.Exit(code)
}

// runFakeHelper is the helper side of the lost task.start response tests. It speaks the crh-priv
// handshake and accepts one task.start, but answers it only after the agent's native timeout:
// "delayed" then reports the task's output and exit, "silent" exits without answering at all.
func runFakeHelper(mode string) error {
	_, negotiated, err := wire.ServerHandshake(os.Stdin, os.Stdout, wire.ServerOptions{
		Role:        wire.RoleNative,
		CRHAVersion: version.Version,
	})
	if err != nil {
		return err
	}
	stream := wire.NewStreamFor(os.Stdin, os.Stdout, negotiated, wire.RoleNative)
	peer := stream.Peer()
	peer.HandleRequest(protocol.CmdTaskStart, func(_ context.Context, body cbor.RawMessage) (any, error) {
		var ts protocol.TaskStart
		if err := protocol.Unmarshal(body, &ts); err != nil {
			return nil, err
		}
		if mode == "silent" {
			time.Sleep(400 * time.Millisecond)
			os.Exit(0)
		}
		go func() {
			time.Sleep(600 * time.Millisecond)
			_ = peer.Emit(protocol.EventTaskOutput, protocol.TaskOutput{
				TaskID: ts.TaskID, Offset: 0, Data: []byte("ran"),
			})
			_ = peer.Emit(protocol.EventTaskExit, protocol.TaskExit{
				TaskID:    ts.TaskID,
				Outcome:   protocol.Outcome{Kind: protocol.OutcomeCode, Code: 0},
				OutputEnd: 3,
			})
		}()
		time.Sleep(800 * time.Millisecond)
		return protocol.Empty{}, nil
	})
	return stream.Run()
}

// nativeWatch records what a fake crhs received from the agent.
type nativeWatch struct {
	outputs chan protocol.TaskOutput
	exit    chan protocol.TaskExit
	started chan error
	frames  *frameLog
}

func newNativeWatch() *nativeWatch {
	return &nativeWatch{
		outputs: make(chan protocol.TaskOutput, 64),
		exit:    make(chan protocol.TaskExit, 1),
		started: make(chan error, 1),
		frames:  &frameLog{},
	}
}

// serveNative starts a fake crhs connection whose script runs after the facts event, e.g. to send a
// task.start and follow-up requests.
func serveNative(t *testing.T, a *Agent, w *nativeWatch, script func(context.Context, *protocol.Peer) error) {
	t.Helper()
	serverKey, err := noise.GenerateKeypair()
	if err != nil {
		t.Fatal(err)
	}
	factsReady := make(chan struct{})
	srv := startFake(t, serverKey, fakeConfig{
		log: w.frames,
		setup: func(p *protocol.Peer) {
			p.HandleEvent(protocol.EventFacts, func(body cbor.RawMessage) error {
				var f protocol.Facts
				if err := protocol.Unmarshal(body, &f); err != nil {
					return err
				}
				signal(factsReady)
				return nil
			})
			p.HandleEvent(protocol.EventTaskOutput, func(body cbor.RawMessage) error {
				var out protocol.TaskOutput
				if err := protocol.Unmarshal(body, &out); err != nil {
					return err
				}
				w.outputs <- out
				return nil
			})
			p.HandleEvent(protocol.EventTaskExit, func(body cbor.RawMessage) error {
				var exit protocol.TaskExit
				if err := protocol.Unmarshal(body, &exit); err != nil {
					return err
				}
				select {
				case w.exit <- exit:
				default:
				}
				return nil
			})
		},
		run: func(ctx context.Context, p *protocol.Peer) {
			<-factsReady
			if err := script(ctx, p); err != nil {
				t.Errorf("fake crhs: %v", err)
			}
		},
	})
	startSession(t, a, dialTo(t, srv, serverKey))
}

// waitNativeExit collects the task's output until task.exit arrives.
func waitNativeExit(t *testing.T, w *nativeWatch) (output string, exit protocol.TaskExit) {
	t.Helper()
	for {
		select {
		case out := <-w.outputs:
			output += string(out.Data)
		case exit = <-w.exit:
			for {
				select {
				case out := <-w.outputs:
					output += string(out.Data)
				default:
					return output, exit
				}
			}
		case <-time.After(20 * time.Second):
			t.Fatal("timed out waiting for the native task's exit")
		}
	}
}

// privilegedTask is an exec task with privileged = true.
func privilegedTask(id, shell string) protocol.TaskStart {
	ts := execTask(id, shell)
	ts.Privileged = true
	return ts
}

// sendStart sends ts and reports the response on w.started.
func sendStart(w *nativeWatch, ts protocol.TaskStart) func(context.Context, *protocol.Peer) error {
	return func(ctx context.Context, p *protocol.Peer) error {
		var empty protocol.Empty
		w.started <- p.Request(ctx, protocol.CmdTaskStart, ts, &empty)
		return nil
	}
}

func nativeAgent(t *testing.T, opts Options) *Agent {
	t.Helper()
	if opts.PrivilegedMode == "" {
		opts.PrivilegedMode = config.ModeNative
	}
	return newTestAgent(t, opts)
}

func TestPrivilegedNativeExec(t *testing.T) {
	w := newNativeWatch()
	a := nativeAgent(t, Options{})
	serveNative(t, a, w, sendStart(w, privilegedTask("native-1", "printf out; printf oops >&2; exit 3")))

	if err := waitCh(t, w.started, "task.start response"); err != nil {
		t.Fatalf("task.start: %v", err)
	}
	output, exit := waitNativeExit(t, w)
	if output != "outoops" {
		t.Fatalf("output %q, want stdout and stderr in write order", output)
	}
	if exit.TaskID != "native-1" || exit.Outcome.Kind != protocol.OutcomeCode || exit.Outcome.Code != 3 {
		t.Fatalf("task.exit = %+v", exit)
	}
	if exit.OutputEnd != 7 {
		t.Fatalf("output_end = %d, want 7", exit.OutputEnd)
	}
	if exit.OutputLines != 1 {
		t.Fatalf("output_lines = %d, want 1 for the merged \"out\"/\"oops\"", exit.OutputLines)
	}
	if exit.OutputFile != "" {
		t.Fatalf("output_file = %q, want the agent's own (empty for in-memory output)", exit.OutputFile)
	}
	frames := w.frames.snapshot()
	start := indexOf(frames, "response task.start ok=true")
	outputAt := indexOf(frames, "event task.output")
	if start < 0 || outputAt < 0 || start > outputAt {
		t.Fatalf("task.output did not follow the accepted response: %v", frames)
	}
}

func TestPrivilegedNativeFileRead(t *testing.T) {
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "f")
	if err := os.WriteFile(path, []byte("content from disk"), 0o640); err != nil {
		t.Fatal(err)
	}
	ts := protocol.TaskStart{
		TaskID: "native-read", Attempt: 1, Privileged: true,
		Spec:   protocol.TaskSpec{Kind: protocol.TaskSpecFileRead, FileRead: &protocol.FileReadSpec{Path: path, StartLine: 1, LineCount: 10}},
		Output: protocol.OutputMode{Kind: protocol.OutputFull, SpillBytes: 1 << 20, SpillLines: 2000},
	}
	w := newNativeWatch()
	a := nativeAgent(t, Options{})
	serveNative(t, a, w, sendStart(w, ts))

	if err := waitCh(t, w.started, "task.start response"); err != nil {
		t.Fatalf("task.start: %v", err)
	}
	output, exit := waitNativeExit(t, w)
	if output != "content from disk" {
		t.Fatalf("output %q", output)
	}
	if exit.Outcome.Kind != protocol.OutcomeCode || exit.Outcome.Code != 0 {
		t.Fatalf("task.exit = %+v", exit)
	}
}

func TestPrivilegedNativeInput(t *testing.T) {
	data := []byte("input for the helper")
	sum := sha256.Sum256(data)
	ts := privilegedTask("native-input", "cat")
	ts.Spec.Exec.Stdin = &protocol.InputRef{Size: protocol.Uint(len(data)), SHA256: protocol.Hash(sum)}

	w := newNativeWatch()
	a := nativeAgent(t, Options{})
	serveNative(t, a, w, func(ctx context.Context, p *protocol.Peer) error {
		var empty protocol.Empty
		if err := p.Request(ctx, protocol.CmdTaskStart, ts, &empty); err != nil {
			w.started <- err
			return nil
		}
		w.started <- nil
		if err := p.Request(ctx, protocol.CmdTaskInput, protocol.TaskInput{
			TaskID: ts.TaskID, Offset: 0, Data: data[:6],
		}, &empty); err != nil {
			return err
		}
		return p.Request(ctx, protocol.CmdTaskInput, protocol.TaskInput{
			TaskID: ts.TaskID, Offset: 6, Data: data[6:],
		}, &empty)
	})

	if err := waitCh(t, w.started, "task.start response"); err != nil {
		t.Fatalf("task.start: %v", err)
	}
	output, exit := waitNativeExit(t, w)
	if output != string(data) {
		t.Fatalf("output %q, want %q", output, data)
	}
	if exit.Outcome.Kind != protocol.OutcomeCode || exit.Outcome.Code != 0 {
		t.Fatalf("task.exit = %+v", exit)
	}
}

// TestPrivilegedNativeOutputSpill covers the agent's own output file and stream ends for a native
// task: the helper's output lands in executor.Output, so spill, resume and acknowledgements keep
// working unchanged.
func TestPrivilegedNativeOutputSpill(t *testing.T) {
	dir := t.TempDir()
	ts := privilegedTask("native-spill", "seq 1 2000")
	ts.Output = protocol.OutputMode{Kind: protocol.OutputFull, SpillBytes: 1024, SpillLines: 100}
	w := newNativeWatch()
	a := nativeAgent(t, Options{OutputDir: dir})
	serveNative(t, a, w, sendStart(w, ts))

	if err := waitCh(t, w.started, "task.start response"); err != nil {
		t.Fatalf("task.start: %v", err)
	}
	output, exit := waitNativeExit(t, w)
	if !strings.HasSuffix(output, "2000\n") || !strings.HasPrefix(output, "1\n2\n") {
		t.Fatalf("output does not contain the whole range: %d bytes", len(output))
	}
	wantPath := filepath.Join(dir, "native-spill.log")
	if exit.OutputFile != wantPath {
		t.Fatalf("output_file = %q, want %q", exit.OutputFile, wantPath)
	}
	data, err := os.ReadFile(wantPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != output {
		t.Fatalf("output file is %d bytes, the stream had %d", len(data), len(output))
	}
	if uint64(exit.OutputEnd) != uint64(len(output)) {
		t.Fatalf("output_end = %d, want %d", exit.OutputEnd, len(output))
	}
	if exit.OutputLines != 2000 {
		t.Fatalf("output_lines = %d, want 2000", exit.OutputLines)
	}
}

func TestPrivilegedNativeCancel(t *testing.T) {
	w := newNativeWatch()
	a := nativeAgent(t, Options{})
	serveNative(t, a, w, func(ctx context.Context, p *protocol.Peer) error {
		var empty protocol.Empty
		if err := p.Request(ctx, protocol.CmdTaskStart, privilegedTask("native-cancel", "sleep 30"), &empty); err != nil {
			w.started <- err
			return nil
		}
		w.started <- nil
		return p.Request(ctx, protocol.CmdTaskCancel, protocol.TaskCancel{TaskID: "native-cancel"}, &empty)
	})

	if err := waitCh(t, w.started, "task.start response"); err != nil {
		t.Fatalf("task.start: %v", err)
	}
	_, exit := waitNativeExit(t, w)
	if !exit.Cancelled || exit.Outcome.Kind != protocol.OutcomeSignal || exit.Outcome.Signal != "TERM" {
		t.Fatalf("task.exit = %+v, want a cancelled task", exit)
	}
}

func TestPrivilegedNativeTimeout(t *testing.T) {
	ts := privilegedTask("native-timeout", "sleep 30")
	ts.TimeoutMS = 300
	w := newNativeWatch()
	a := nativeAgent(t, Options{})
	serveNative(t, a, w, sendStart(w, ts))

	if err := waitCh(t, w.started, "task.start response"); err != nil {
		t.Fatalf("task.start: %v", err)
	}
	start := time.Now()
	_, exit := waitNativeExit(t, w)
	if !exit.TimedOut || exit.Outcome.Kind != protocol.OutcomeSignal || exit.Outcome.Signal != "TERM" {
		t.Fatalf("task.exit = %+v, want a timed-out task", exit)
	}
	if time.Since(start) > 10*time.Second {
		t.Fatalf("the timeout took %v", time.Since(start))
	}
}

// TestPrivilegedNativeToolFailure covers an escalation tool that refuses the helper, for example
// because a password would be required. The task must be privileged_unsupported with the tool's
// stderr in the message, never executed unprivileged.
func TestPrivilegedNativeToolFailure(t *testing.T) {
	dir := t.TempDir()
	tool := filepath.Join(dir, "fake-sudo")
	script := "#!/bin/sh\necho 'sudo: a password is required' >&2\nexit 1\n"
	if err := os.WriteFile(tool, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	w := newNativeWatch()
	a := nativeAgent(t, Options{NativePrefix: []string{tool}})
	serveNative(t, a, w, sendStart(w, privilegedTask("native-denied", "true")))

	err := waitCh(t, w.started, "task.start response")
	var remote *protocol.RemoteError
	if !errors.As(err, &remote) || remote.Code != "privileged_unsupported" || !strings.Contains(remote.Message, "a password is required") {
		t.Fatalf("task.start = %v, want privileged_unsupported with the tool's stderr", err)
	}
	a.mu.Lock()
	_, accepted := a.accepted["native-denied"]
	_, present := a.tasks["native-denied"]
	a.mu.Unlock()
	if accepted || present {
		t.Fatal("a task the helper refused was accepted")
	}
}

// TestPrivilegedNativeHelperLost covers a helper that dies after accepting the task.
func TestPrivilegedNativeHelperLost(t *testing.T) {
	dir := t.TempDir()
	tool := filepath.Join(dir, "flaky-tool")
	script := "#!/bin/sh\n(sleep 0.3; kill -9 $$) &\nexec \"$@\"\n"
	if err := os.WriteFile(tool, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	w := newNativeWatch()
	a := nativeAgent(t, Options{NativePrefix: []string{tool}})
	serveNative(t, a, w, sendStart(w, privilegedTask("native-lost", "sleep 0.5; printf late")))

	if err := waitCh(t, w.started, "task.start response"); err != nil {
		t.Fatalf("task.start: %v", err)
	}
	_, exit := waitNativeExit(t, w)
	if exit.Outcome.Kind != protocol.OutcomeError || exit.Outcome.Error == nil || exit.Outcome.Error.Code != "helper_lost" {
		t.Fatalf("task.exit = %+v, want helper_lost", exit)
	}
}

// TestPrivilegedIgnore covers mode = ignore: the privileged flag is ignored and the task runs as
// crha's own user, exactly like a normal task.
func TestPrivilegedIgnore(t *testing.T) {
	w := newNativeWatch()
	a := newTestAgent(t, Options{PrivilegedMode: config.ModeIgnore})
	serveNative(t, a, w, sendStart(w, privilegedTask("ignore-1", "printf normal")))

	if err := waitCh(t, w.started, "task.start response"); err != nil {
		t.Fatalf("task.start: %v", err)
	}
	output, exit := waitNativeExit(t, w)
	if output != "normal" {
		t.Fatalf("output %q", output)
	}
	if exit.Outcome.Kind != protocol.OutcomeCode || exit.Outcome.Code != 0 {
		t.Fatalf("task.exit = %+v", exit)
	}
}

// TestPrivilegedModeRejections covers mode = reject and an unset mode, which behaves like reject.
// forward mode is covered by the tests in forward_test.go.
func TestPrivilegedModeRejections(t *testing.T) {
	for _, tc := range []struct {
		mode  string
		want  string
		match string
	}{
		{config.ModeReject, "privileged_unsupported", "privileged tasks are not supported"},
		{"", "privileged_unsupported", "privileged tasks are not supported"},
	} {
		t.Run(tc.mode, func(t *testing.T) {
			w := newNativeWatch()
			a := newTestAgent(t, Options{PrivilegedMode: tc.mode})
			serveNative(t, a, w, sendStart(w, privilegedTask("mode-1", "true")))
			err := waitCh(t, w.started, "task.start response")
			var remote *protocol.RemoteError
			if !errors.As(err, &remote) || remote.Code != tc.want || !strings.Contains(remote.Message, tc.match) {
				t.Fatalf("task.start = %v, want %s containing %q", err, tc.want, tc.match)
			}
		})
	}
}

// fakeHelperAgent runs the test binary in fake-helper mode as the native helper, with a short
// native timeout so the lost task.start response is reached quickly.
func fakeHelperAgent(t *testing.T, mode string) *Agent {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	if exe, err = filepath.EvalSymlinks(exe); err != nil {
		t.Fatal(err)
	}
	return nativeAgent(t, Options{
		NativePrefix:  []string{exe, "fake-helper", mode},
		NativeTimeout: 200 * time.Millisecond,
	})
}

// TestPrivilegedNativeLostStartResponse covers a helper that accepted the task but whose response
// did not arrive within the native timeout: the task must be reported accepted (crhs would retry
// otherwise) and its events must still end it normally.
func TestPrivilegedNativeLostStartResponse(t *testing.T) {
	w := newNativeWatch()
	a := fakeHelperAgent(t, "delayed")
	serveNative(t, a, w, sendStart(w, privilegedTask("native-lost-response", "true")))

	if err := waitCh(t, w.started, "task.start response"); err != nil {
		t.Fatalf("task.start = %v, want it accepted: the helper may have run the task", err)
	}
	output, exit := waitNativeExit(t, w)
	if output != "ran" {
		t.Fatalf("output = %q", output)
	}
	if exit.Outcome.Kind != protocol.OutcomeCode || exit.Outcome.Code != 0 {
		t.Fatalf("task.exit = %+v", exit)
	}
}

// TestPrivilegedNativeSilentHelperLost covers a helper that accepted the task, never answered and
// then died: the task is accepted and ends with helper_lost, never as a refusal.
func TestPrivilegedNativeSilentHelperLost(t *testing.T) {
	w := newNativeWatch()
	a := fakeHelperAgent(t, "silent")
	serveNative(t, a, w, sendStart(w, privilegedTask("native-silent-helper", "true")))

	if err := waitCh(t, w.started, "task.start response"); err != nil {
		t.Fatalf("task.start = %v, want it accepted", err)
	}
	_, exit := waitNativeExit(t, w)
	if exit.Outcome.Kind != protocol.OutcomeError || exit.Outcome.Error == nil || exit.Outcome.Error.Code != "helper_lost" {
		t.Fatalf("task.exit = %+v, want helper_lost", exit)
	}
}
