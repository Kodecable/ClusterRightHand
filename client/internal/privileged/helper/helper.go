// Package helper implements `crha privileged stdio`, the native helper of doc/design/privilege.md: crha's
// non-privileged mode starts it through sudo/doas (or run0) and it executes exactly one privileged
// task or hosts exactly one privileged terminal over crh-priv on its stdin and stdout. It is not a
// security boundary: whoever may run the helper non-interactively may submit any task. See
// doc/design/protocol.md "crh-priv" and doc/design/privilege.md "Privilege modes".
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

	"github.com/Kodecable/ClusterRightHand/client/internal/execenv"
	"github.com/Kodecable/ClusterRightHand/client/internal/privileged/statedir"
	"github.com/Kodecable/ClusterRightHand/client/internal/privileged/taskrun"
	"github.com/Kodecable/ClusterRightHand/client/internal/privileged/termhost"
	"github.com/Kodecable/ClusterRightHand/client/internal/privileged/wire"
	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
	"github.com/Kodecable/ClusterRightHand/client/internal/term"
	"github.com/fxamacker/cbor/v2"
)

// Options configures Run.
type Options struct {
	// Version is this build's crha version. The native handshake accepts only a peer whose
	// crha_version equals it (doc/design/protocol.md "crh-priv" role).
	Version string
	// Log receives one JSON line per task start and finish. nil discards them.
	Log io.Writer
	// Env is the task environment the helper resolved when it started. nil resolves it per task,
	// which only tests do (doc/design/execution.md "The exec environment").
	Env *execenv.Environment
	// SpoolRoot is the privileged state directory whose stdin subdirectory stages a task's stdin
	// while its size and SHA-256 are verified. Empty refuses a task that declares input.
	SpoolRoot string
}

// DefaultSpoolRoot is the state directory the native helper stages stdin in when it has no
// privileged.toml (native mode). It is outside crha's state directory.
const DefaultSpoolRoot = statedir.DefaultDir

// StdioOptions configures Stdio. It is not read from the environment or the command line: the
// helper is started by crha through sudo/doas/run0, so its caller must not choose where a
// privileged task's stdin is staged. Tests set SpoolRoot to a temporary directory.
type StdioOptions struct {
	// SpoolRoot is the privileged state directory whose stdin subdirectory stages input. Empty
	// uses DefaultSpoolRoot.
	SpoolRoot string
}

// spoolRoot returns the privileged state directory for stdin staging.
func (o StdioOptions) spoolRoot() string {
	if o.SpoolRoot != "" {
		return o.SpoolRoot
	}
	return DefaultSpoolRoot
}

// resolveEnv resolves the helper's execution environment when it starts. It is a variable so tests
// can exercise a node without a shell, which must fail the handshake (and with it the node's
// privileged tasks) rather than run them with a guessed shell.
var resolveEnv = func() (*execenv.Environment, error) {
	return execenv.Resolve(execenv.Options{Privileged: true})
}

// Stdio runs the helper on the process's standard streams. stdin must be the crh-priv stream; a
// terminal is refused, because a person at a keyboard is not crha's non-privileged mode.
func Stdio(ctx context.Context, in *os.File, out, log io.Writer, crhaVersion string, opts StdioOptions) error {
	if term.IsTerminal(in) {
		return errors.New("refusing to run the native helper on a terminal: stdin must be the crh-priv stream from crha's non-privileged mode")
	}
	// The helper is root; it resolves its own environment each time it is started, and a failure
	// here fails the crh-priv handshake, so privileged tasks of the node fail with
	// privileged_unsupported while ordinary tasks keep working.
	env, err := resolveEnv()
	if err != nil {
		return err
	}
	return Run(ctx, in, out, Options{Version: crhaVersion, Log: log, Env: env, SpoolRoot: opts.spoolRoot()})
}

// Run serves one native helper session on in/out: the crh-priv handshake and then either exactly one
// task.start, with its input, output and exit, or exactly one privileged terminal for its whole life.
// It returns when the task ended and task.exit was emitted, when the terminal was closed, or when the
// stream failed. EOF on stdin before the task ends does not abort the task: it runs to its end and
// the outcome goes to the local log (doc/design/privilege.md "Native mode"). Once the task ended, Run closes in
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
	stream := wire.NewStreamFor(in, out, negotiated, wire.RoleNative)
	h := &helper{
		peer:      stream.Peer(),
		log:       logw,
		done:      make(chan struct{}),
		ptyClosed: make(chan struct{}),
	}
	h.session = taskrun.NewSession(stream.Peer(), taskrun.SessionOptions{
		Env:          opts.Env,
		SpoolRoot:    opts.SpoolRoot,
		Log:          h,
		OnExit:       func(*taskrun.Task) { close(h.done) },
		KeepFinished: true,
	})
	stream.Peer().HandleRequest(protocol.CmdTaskStart, h.handleStart)
	if negotiated.Has(wire.CmdPTYOpen) {
		// A helper from before privileged terminals offers no terminal names; such a helper still
		// serves tasks, and crha answers a privileged pty.open with privileged_unsupported.
		h.terms = termhost.New(termhost.Options{
			Env:       opts.Env,
			Recorder:  h,
			Single:    true,
			CloseWait: true,
		})
		h.terms.Register(stream.Peer(), termhost.Channel{
			Authorize: h.authorizeTerminal,
			Emit:      h.emitTerminal,
		})
	}
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
		if h.terms != nil {
			// The unprivileged mode went away: the terminal has no one to carry its bytes, so it is
			// closed and recorded, and the helper leaves.
			h.terms.CloseAll("the privileged channel ended")
		}
	case <-h.done:
		// A task.cancel or the last task.input can end the task while the receive loop is still
		// sending that request's response. Stop the loop only after it had its chance, so the peer
		// never waits for a response that was already produced.
		streamErr = stopReceive(in, errc)
	case <-h.ptyClosed:
		// pty.close was answered and the only terminal is gone: the helper's life ended with it.
		streamErr = stopReceive(in, errc)
	case <-ctx.Done():
		if h.accepted() {
			h.session.LaunchAll()
			h.session.Abort()
			<-h.done
		}
		if h.terms != nil {
			h.terms.CloseAll("the helper was stopped")
		}
		return ctx.Err()
	}
	if streamErr != nil && !errors.Is(streamErr, io.EOF) {
		var protocolErr *wire.ProtocolError
		if errors.As(streamErr, &protocolErr) || (!h.completed() && !h.hasTerminal()) {
			return fmt.Errorf("crh-priv stream: %w", streamErr)
		}
		// The parent went away while the task or terminal ran, so a response or a later frame could
		// not be sent. The run finished and its outcome is in the local log; nobody is left to care
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

// helper is one native helper session. It hosts either one task or one terminal, and never both:
// the helper of a privileged terminal lives exactly as long as that terminal, while a task helper
// ends with its task (doc/design/privilege.md "Native mode").
type helper struct {
	peer      *protocol.Peer
	session   *taskrun.Session
	terms     *termhost.Host
	log       io.Writer
	done      chan struct{}
	ptyClosed chan struct{}

	mu       sync.Mutex
	task     *taskrun.Task
	ptyClose sync.Once

	logMu sync.Mutex
}

func (h *helper) accepted() bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.task != nil
}

// hasTerminal reports whether this helper ever accepted a terminal.
func (h *helper) hasTerminal() bool {
	return h.terms != nil && h.terms.Used()
}

// markPTYClosed ends the helper after its only terminal was closed.
func (h *helper) markPTYClosed() { h.ptyClose.Do(func() { close(h.ptyClosed) }) }

func (h *helper) handleStart(_ context.Context, body cbor.RawMessage) (any, error) {
	var ts protocol.TaskStart
	if err := protocol.UnmarshalBody(body, &ts); err != nil {
		return nil, err
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.task != nil || h.hasTerminal() {
		return nil, &protocol.RemoteError{Code: protocol.CodeAlreadyAccepted, Message: "the native helper hosts exactly one task or terminal"}
	}
	t, err := h.session.Accept(ts)
	if err != nil {
		return nil, err
	}
	h.task = t
	return protocol.Deferred{Body: protocol.Empty{}, After: func() { h.session.Launch(t) }}, nil
}

// authorizeTerminal refuses the helper's one terminal while a task runs. Native mode has no
// authorization: the escalation tool already decided who may start the helper, exactly as for a
// native task (doc/design/privilege.md "Native mode"). The helper refuses a task.start once it
// hosts a terminal, and the termhost's Single option refuses a second pty.open.
func (h *helper) authorizeTerminal(context.Context, protocol.PTYOpen) error {
	h.mu.Lock()
	busy := h.task != nil
	h.mu.Unlock()
	if busy {
		return &termhost.Refused{
			Code:    protocol.CodeAlreadyAccepted,
			Message: "the native helper hosts exactly one task or terminal",
		}
	}
	return nil
}

// emitTerminal carries a terminal's events to crha over the helper's stdout. The terminal's reader
// waits on the write, so a slow parent applies backpressure to the PTY.
func (h *helper) emitTerminal(name string, body any) {
	_ = h.peer.Emit(name, body)
}

// Opened implements termhost.Recorder: the termhost accepted the helper's terminal. The pty.create
// spec with its argv is the record of what runs privileged.
func (h *helper) Opened(id string, _ protocol.Uint, spec protocol.TaskSpec) error {
	h.logLine(LogRecord{
		Event:      "terminal.opened",
		Time:       time.Now().UTC().Format(time.RFC3339Nano),
		PTYID:      id,
		Privileged: true,
		Spec:       &spec,
	})
	return nil
}

// Refused implements termhost.Recorder: a pty.open this helper did not accept.
func (h *helper) Refused(id string, _ protocol.Uint, refused termhost.Refused) {
	h.logLine(LogRecord{
		Event:  "terminal.refused",
		Time:   time.Now().UTC().Format(time.RFC3339Nano),
		PTYID:  id,
		Code:   refused.Code,
		Detail: refused.Message,
	})
}

// Exited implements termhost.Recorder: the terminal's process ended.
func (h *helper) Exited(id string, code int) {
	h.logLine(LogRecord{
		Event:    "terminal.exited",
		Time:     time.Now().UTC().Format(time.RFC3339Nano),
		PTYID:    id,
		ExitCode: &code,
	})
}

// Closed implements termhost.Recorder: the terminal was closed. The helper's life ends with its
// only terminal, so it leaves as soon as the close is recorded.
func (h *helper) Closed(id string, code *int, detail string) {
	h.logLine(LogRecord{
		Event:    "terminal.closed",
		Time:     time.Now().UTC().Format(time.RFC3339Nano),
		PTYID:    id,
		ExitCode: code,
		Detail:   detail,
	})
	h.markPTYClosed()
}

// LogRecord is one line of the helper's local audit log on stderr. The native helper is the only
// place that sees the full task specification: sudoers only knows "crha privileged stdio". The
// non-privileged parent parses these lines and relays them as human-readable log lines, spec
// included, because native mode has no privileged daemon and no audit file: the relayed line is the
// only record of what ran privileged (doc/design/privilege.md "Native mode"). The JSON on the pipe
// is the internal wire format; the parent's log is what a reader sees.
//
// A task's records carry task_id; a terminal's carry pty_id, the pty.create spec at open, and the
// exit code at exit and close. In native mode the terminal's lines relayed from stderr are its
// whole record.
type LogRecord struct {
	Event      string             `json:"event"`
	Time       string             `json:"time"`
	TaskID     string             `json:"task_id,omitempty"`
	PTYID      string             `json:"pty_id,omitempty"`
	Attempt    protocol.Uint      `json:"attempt,omitempty"`
	Privileged bool               `json:"privileged,omitempty"`
	Spec       *protocol.TaskSpec `json:"spec,omitempty"`
	Outcome    string             `json:"outcome,omitempty"`
	TimedOut   bool               `json:"timed_out,omitempty"`
	Cancelled  bool               `json:"cancelled,omitempty"`
	OutputEnd  protocol.Uint      `json:"output_end,omitempty"`
	DurationMS int64              `json:"duration_ms,omitempty"`
	ExitCode   *int               `json:"exit_code,omitempty"`
	Code       string             `json:"code,omitempty"`
	Detail     string             `json:"detail,omitempty"`
}

// TaskStarted implements taskrun.Log.
func (h *helper) TaskStarted(t *taskrun.Task) {
	ts := t.TaskStart()
	spec := ts.Spec
	h.logLine(LogRecord{
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
	h.logLine(LogRecord{
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
	h.logLine(LogRecord{Event: "task.exit.undelivered", TaskID: t.ID(), Detail: err.Error()})
}

// logLine writes one JSON line. A write failure is ignored: stderr may already be gone, and the task
// must not fail because its log entry could not be written.
func (h *helper) logLine(rec LogRecord) {
	data, err := json.Marshal(rec)
	if err != nil {
		return
	}
	data = append(data, '\n')
	h.logMu.Lock()
	defer h.logMu.Unlock()
	_, _ = h.log.Write(data)
}

// ParseLogRecord parses one line of the helper's local audit log, as the parent that relays the
// helper's stderr reads it. It reports false for a line that is not such a record: some other
// program's stderr, a partial line, or a JSON object with an unknown event or no task id.
func ParseLogRecord(line string) (LogRecord, bool) {
	var rec LogRecord
	if err := json.Unmarshal([]byte(line), &rec); err != nil {
		return LogRecord{}, false
	}
	switch rec.Event {
	case "task.start", "task.exit", "task.exit.undelivered":
		if rec.TaskID == "" {
			return LogRecord{}, false
		}
	case "terminal.opened", "terminal.exited", "terminal.closed", "terminal.refused":
		if rec.PTYID == "" {
			return LogRecord{}, false
		}
	default:
		return LogRecord{}, false
	}
	return rec, true
}
