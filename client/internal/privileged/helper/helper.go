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
}

// Stdio runs the helper on the process's standard streams. stdin must be the crh-priv stream; a
// terminal is refused, because a person at a keyboard is not crha's non-privileged mode.
func Stdio(ctx context.Context, in *os.File, out, log io.Writer, crhaVersion string) error {
	if IsTerminal(in) {
		return errors.New("refusing to run the native helper on a terminal: stdin must be the crh-priv stream from crha's non-privileged mode")
	}
	return Run(ctx, in, out, Options{Version: crhaVersion, Log: log})
}

// IsTerminal reports whether f is a terminal.
func IsTerminal(f *os.File) bool {
	_, err := unix.IoctlGetTermios(int(f.Fd()), unix.TCGETS)
	return err == nil
}

// Run serves one native helper session on in/out: the crh-priv handshake, exactly one task.start,
// its input, output and exit. It returns when the task ended and task.exit was emitted, or when the
// stream failed. EOF on stdin before the task ends does not abort the task: it runs to its end and
// the outcome goes to the local log (doc/privilege.md, native).
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
	h := &helper{stream: stream, log: logw, done: make(chan struct{})}
	peer := stream.Peer()
	peer.HandleRequest(protocol.CmdTaskStart, h.handleStart)
	peer.HandleRequest(protocol.CmdTaskInput, h.handleInput)
	peer.HandleRequest(protocol.CmdTaskCancel, h.handleCancel)
	peer.HandleRequest(protocol.CmdTaskQuery, h.handleQuery)

	errc := make(chan error, 1)
	go func() { errc <- stream.Run() }()

	var streamErr error
	select {
	case streamErr = <-errc:
		if h.accepted() {
			// The task is accepted, so it runs even when the response could not be sent. No more
			// task.input can arrive either, so an incomplete input would wait forever; an input that
			// is complete or absent leaves the task alone.
			h.launchAccepted()
			h.endInput()
			<-h.done
		}
	case <-h.done:
	case <-ctx.Done():
		if h.accepted() {
			h.launchAccepted()
			h.abort()
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

// completed reports whether the task has finished.
func (h *helper) completed() bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.task != nil && h.task.Finished()
}

// helper is one native helper session. The task is set once and never replaced.
type helper struct {
	stream *wire.Stream
	log    io.Writer
	done   chan struct{}

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
	if err := protocol.Unmarshal(body, &ts); err != nil {
		return nil, err
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.task != nil {
		return nil, &protocol.RemoteError{Code: "already_accepted", Message: "the native helper executes exactly one task"}
	}
	t, err := taskrun.New(ts, func(stream protocol.Stream, off uint64, data []byte) error {
		return h.stream.Peer().Emit(protocol.EventTaskOutput, protocol.TaskOutput{
			TaskID: ts.TaskID, Stream: stream, Offset: protocol.Uint(off), Data: data,
		})
	})
	if err != nil {
		return nil, err
	}
	h.task = t
	return protocol.Deferred{Body: protocol.Empty{}, After: func() { h.launch(t) }}, nil
}

// launch starts the accepted task's execution exactly once. Peer calls Deferred.After only after the
// task.start success response went out; when that send fails, the acceptance already stands and the
// task must still run, with its outcome recorded in the local log.
func (h *helper) launch(t *taskrun.Task) {
	var started time.Time
	t.Start(
		func() {
			started = time.Now()
			h.logStart(t)
		},
		func(exit *protocol.TaskExit) {
			h.logExit(t, exit, time.Since(started))
			if err := h.stream.Peer().Emit(protocol.EventTaskExit, exit); err != nil {
				// The parent is gone. The task itself has finished and is recorded in the local log;
				// there is nobody left to tell.
				h.logLine(logRecord{Event: "task.exit.undelivered", TaskID: t.ID(), Detail: err.Error()})
			}
			close(h.done)
		},
	)
}

// launchAccepted launches the accepted task if Deferred.After never ran because the response could
// not be sent. taskrun.Task.Start runs the task at most once, so a racing Deferred.After is safe.
func (h *helper) launchAccepted() {
	h.mu.Lock()
	t := h.task
	h.mu.Unlock()
	if t != nil {
		h.launch(t)
	}
}

func (h *helper) handleInput(_ context.Context, body cbor.RawMessage) (any, error) {
	var in protocol.TaskInput
	if err := protocol.Unmarshal(body, &in); err != nil {
		return nil, err
	}
	h.mu.Lock()
	t := h.task
	h.mu.Unlock()
	if t == nil {
		return nil, &protocol.RemoteError{Code: "unknown_task", Message: "unknown task " + in.TaskID}
	}
	return t.Input(in)
}

func (h *helper) handleCancel(_ context.Context, body cbor.RawMessage) (any, error) {
	var c protocol.TaskCancel
	if err := protocol.Unmarshal(body, &c); err != nil {
		return nil, err
	}
	h.mu.Lock()
	t := h.task
	h.mu.Unlock()
	if t != nil {
		t.Cancel(c.TaskID)
	}
	return protocol.Empty{}, nil
}

func (h *helper) handleQuery(_ context.Context, body cbor.RawMessage) (any, error) {
	var q protocol.TaskQuery
	if err := protocol.Unmarshal(body, &q); err != nil {
		return nil, err
	}
	h.mu.Lock()
	t := h.task
	h.mu.Unlock()
	if t == nil {
		return protocol.TaskStatus{TaskID: q.TaskID, State: protocol.TaskUnknown}, nil
	}
	return t.Status(q), nil
}

// endInput fails an input that can no longer be completed because the stream ended; the task cannot
// read the rest, and leaving the reader blocked would keep the helper alive forever.
func (h *helper) endInput() {
	h.mu.Lock()
	t := h.task
	h.mu.Unlock()
	if t != nil {
		t.EndInput()
	}
}

// abort cancels the running task, e.g. when the helper itself is asked to stop.
func (h *helper) abort() {
	h.mu.Lock()
	t := h.task
	h.mu.Unlock()
	if t != nil {
		t.Abort()
	}
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
	StdoutEnd  protocol.Uint      `json:"stdout_end,omitempty"`
	StderrEnd  protocol.Uint      `json:"stderr_end,omitempty"`
	DurationMS int64              `json:"duration_ms,omitempty"`
	Detail     string             `json:"detail,omitempty"`
}

func (h *helper) logStart(t *taskrun.Task) {
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

func (h *helper) logExit(t *taskrun.Task, exit *protocol.TaskExit, took time.Duration) {
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
		StdoutEnd:  exit.StdoutEnd,
		StderrEnd:  exit.StderrEnd,
		DurationMS: took.Milliseconds(),
	})
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
