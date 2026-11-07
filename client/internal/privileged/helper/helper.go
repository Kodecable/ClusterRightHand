// Package helper implements `crha privileged stdio`, the native helper of doc/privilege.md: crha's
// non-privileged mode starts it through sudo/doas (or run0) and it executes exactly one privileged
// task over crh-priv on its stdin and stdout. It is not a security boundary: whoever may run the
// helper non-interactively may submit any task. See doc/protocol.md "crh-priv" and
// doc/privilege.md "非特权模式如何处理特权任务".
package helper

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"sync"
	"time"

	"golang.org/x/sys/unix"

	"github.com/Kodecable/ClusterRightHand/client/internal/execenv"
	"github.com/Kodecable/ClusterRightHand/client/internal/privileged/taskrun"
	"github.com/Kodecable/ClusterRightHand/client/internal/privileged/wire"
	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
	"github.com/fxamacker/cbor/v2"
)

// Options configures Run.
type Options struct {
	// Version is this build's crha version. The native handshake accepts only a peer whose
	// crha_version equals it (doc/protocol.md, crh-priv role).
	Version string
	// Log receives one JSON line per task start and finish. nil discards them.
	Log io.Writer
	// Env is the task environment the helper resolved when it started. nil resolves it per task,
	// which only tests do (doc/execution-plane.md#exec-的执行环境).
	Env *execenv.Environment
	// SpoolRoot is the privileged state directory whose stdin subdirectory stages a task's stdin
	// while its size and SHA-256 are verified. Empty refuses a task that declares input.
	SpoolRoot string
}

// DefaultSpoolRoot is the state directory the native helper stages stdin in when it has no
// privileged.toml (native mode). SpoolRootEnv overrides it.
const DefaultSpoolRoot = "/var/lib/crha/privileged"

// SpoolRootEnv names the environment variable that overrides DefaultSpoolRoot, for a helper whose
// state directory is not the default one.
const SpoolRootEnv = "CRHA_PRIVILEGED_STDIN_DIR"

// resolveEnv resolves the helper's execution environment when it starts. It is a variable so tests
// can exercise a node without a shell, which must fail the handshake (and with it the node's
// privileged tasks) rather than run them with a guessed shell.
var resolveEnv = func() (*execenv.Environment, error) {
	return execenv.Resolve(execenv.Options{Privileged: true})
}

// spoolRoot returns the privileged state directory for stdin staging.
func spoolRoot() string {
	if dir := os.Getenv(SpoolRootEnv); dir != "" {
		return dir
	}
	return DefaultSpoolRoot
}

// Stdio runs the helper on the process's standard streams. stdin must be the crh-priv stream; a
// terminal is refused, because a person at a keyboard is not crha's non-privileged mode.
func Stdio(ctx context.Context, in *os.File, out, log io.Writer, crhaVersion string) error {
	if IsTerminal(in) {
		return errors.New("refusing to run the native helper on a terminal: stdin must be the crh-priv stream from crha's non-privileged mode")
	}
	// The helper is root; it resolves its own environment each time it is started, and a failure
	// here fails the crh-priv handshake, so privileged tasks of the node fail with
	// privileged_unsupported while ordinary tasks keep working.
	env, err := resolveEnv()
	if err != nil {
		return err
	}
	return Run(ctx, in, out, Options{Version: crhaVersion, Log: log, Env: env, SpoolRoot: spoolRoot()})
}

// IsTerminal reports whether f is a terminal.
func IsTerminal(f *os.File) bool {
	_, err := unix.IoctlGetTermios(int(f.Fd()), unix.TCGETS)
	return err == nil
}

// Run serves one native helper session on in/out: the crh-priv handshake, exactly one task.start,
// its input, output and exit. It returns when the task ended and task.exit was emitted, or when the
// stream failed. EOF on stdin before the task ends does not abort the task: it runs to its end and
// the outcome goes to the local log (doc/privilege.md, native). Once the task ended, Run closes in
// when it is an io.Closer, so the receive loop can stop and a response it is still sending is not
// cut off by closing the output.
func Run(ctx context.Context, in io.Reader, out io.Writer, opts Options) error {
	logw := io.Discard
	if opts.Log != nil {
		logw = opts.Log
	}
	_, negotiated, err := wire.ServerHandshake(in, out, wire.ServerOptions{
		Role:        wire.RoleNative,
		CRHAVersion: opts.Version,
	})
	if err != nil {
		return err
	}
	stream := wire.NewStream(in, out, negotiated)
	h := &helper{log: logw, done: make(chan struct{})}
	h.session = taskrun.NewSession(stream.Peer(), taskrun.SessionOptions{
		Env:          opts.Env,
		SpoolRoot:    opts.SpoolRoot,
		Log:          h,
		OnExit:       func(*taskrun.Task) { close(h.done) },
		KeepFinished: true,
	})
	stream.Peer().HandleRequest(protocol.CmdTaskStart, h.handleStart)
	h.session.HandleRequests()

	errc := make(chan error, 1)
	go func() { errc <- stream.Run() }()

	var streamErr error
	select {
	case streamErr = <-errc:
		if h.accepted() {
			// The task is accepted, so it runs even when the response could not be sent. No more
			// task.input can arrive either, so an incomplete input would wait forever; an input that
			// is complete or absent leaves the task alone.
			h.session.LaunchAll()
			h.session.EndInput()
			<-h.done
		}
	case <-h.done:
		// A task.cancel or the last task.input can end the task while the receive loop is still
		// sending that request's response. Stop the loop only after it had its chance, so the peer
		// never waits for a response that was already produced.
		streamErr = stopReceive(in, errc)
	case <-ctx.Done():
		if h.accepted() {
			h.session.LaunchAll()
			h.session.Abort()
			<-h.done
		}
		return ctx.Err()
	}
	if streamErr != nil && !errors.Is(streamErr, io.EOF) {
		var protocolErr *wire.ProtocolError
		if errors.As(streamErr, &protocolErr) || !h.completed() {
			return fmt.Errorf("crh-priv stream: %w", streamErr)
		}
		// The parent went away while the task ran, so the task.start response or a later frame could
		// not be sent. The task finished and its outcome is in the local log; nobody is left to care
		// about the exit status.
		return nil
	}
	return nil
}

// stopReceive ends the stream's receive loop once the task ended and waits for it to return. The
// loop may still be sending the response of the request that ended the task; closing in makes its
// next read stop, but only after that send finished. A reader that cannot be closed leaves the loop
// running, so Run does not wait for it. A read that fails because Run closed in is not a protocol
// violation.
func stopReceive(in io.Reader, errc <-chan error) error {
	closer, ok := in.(io.Closer)
	if !ok {
		return nil
	}
	select {
	case err := <-errc:
		_ = closer.Close()
		return err
	default:
	}
	_ = closer.Close()
	err := <-errc
	if errors.Is(err, io.ErrClosedPipe) || errors.Is(err, os.ErrClosed) {
		return nil
	}
	return err
}

// completed reports whether the task has finished.
func (h *helper) completed() bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.task != nil && h.task.Finished()
}

// helper is one native helper session. The task is set once and never replaced.
type helper struct {
	session *taskrun.Session
	log     io.Writer
	done    chan struct{}

	mu   sync.Mutex
	task *taskrun.Task

	logMu sync.Mutex
}

func (h *helper) accepted() bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.task != nil
}

func (h *helper) handleStart(_ context.Context, body cbor.RawMessage) (any, error) {
	var ts protocol.TaskStart
	if err := protocol.UnmarshalBody(body, &ts); err != nil {
		return nil, err
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.task != nil {
		return nil, &protocol.RemoteError{Code: protocol.CodeAlreadyAccepted, Message: "the native helper executes exactly one task"}
	}
	t, err := h.session.Accept(ts)
	if err != nil {
		return nil, err
	}
	h.task = t
	return protocol.Deferred{Body: protocol.Empty{}, After: func() { h.session.Launch(t) }}, nil
}

// logRecord is one line of the helper's local audit log on stderr. The native helper is the only
// place that sees the full task specification: sudoers only knows "crha privileged stdio", and the
// non-privileged mode relays the helper's stderr into its own log and journald
// (doc/privilege.md, native).
type logRecord struct {
	Event      string             `json:"event"`
	Time       string             `json:"time"`
	TaskID     string             `json:"task_id"`
	Attempt    protocol.Uint      `json:"attempt"`
	Privileged bool               `json:"privileged"`
	Spec       *protocol.TaskSpec `json:"spec,omitempty"`
	Outcome    string             `json:"outcome,omitempty"`
	TimedOut   bool               `json:"timed_out,omitempty"`
	Cancelled  bool               `json:"cancelled,omitempty"`
	OutputEnd  protocol.Uint      `json:"output_end,omitempty"`
	DurationMS int64              `json:"duration_ms,omitempty"`
	Detail     string             `json:"detail,omitempty"`
}

// TaskStarted implements taskrun.Log.
func (h *helper) TaskStarted(t *taskrun.Task) {
	ts := t.TaskStart()
	spec := ts.Spec
	h.logLine(logRecord{
		Event:      "task.start",
		Time:       time.Now().UTC().Format(time.RFC3339Nano),
		TaskID:     ts.TaskID,
		Attempt:    ts.Attempt,
		Privileged: ts.Privileged,
		Spec:       &spec,
	})
}

// TaskFinished implements taskrun.Log.
func (h *helper) TaskFinished(t *taskrun.Task, exit *protocol.TaskExit, took time.Duration) {
	ts := t.TaskStart()
	h.logLine(logRecord{
		Event:      "task.exit",
		Time:       time.Now().UTC().Format(time.RFC3339Nano),
		TaskID:     ts.TaskID,
		Attempt:    ts.Attempt,
		Privileged: ts.Privileged,
		Outcome:    taskrun.OutcomeText(exit.Outcome),
		TimedOut:   exit.TimedOut,
		Cancelled:  exit.Cancelled,
		OutputEnd:  exit.OutputEnd,
		DurationMS: took.Milliseconds(),
	})
}

// ExitUndelivered implements taskrun.Log: the parent is gone. The task itself has finished and is
// recorded in the local log; there is nobody left to tell.
func (h *helper) ExitUndelivered(t *taskrun.Task, err error) {
	h.logLine(logRecord{Event: "task.exit.undelivered", TaskID: t.ID(), Detail: err.Error()})
}

// logLine writes one JSON line. A write failure is ignored: stderr may already be gone, and the task
// must not fail because its log entry could not be written.
func (h *helper) logLine(rec logRecord) {
	data, err := json.Marshal(rec)
	if err != nil {
		return
	}
	data = append(data, '\n')
	h.logMu.Lock()
	defer h.logMu.Unlock()
	_, _ = h.log.Write(data)
}
