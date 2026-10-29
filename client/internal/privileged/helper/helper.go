// Package helper implements `crha privileged stdio`, the native helper of doc/privilege.md: crha's
// non-privileged mode starts it through sudo/doas (or run0) and it executes exactly one privileged
// task over crh-priv on its stdin and stdout. It is not a security boundary: whoever may run the
// helper non-interactively may submit any task. See doc/protocol.md "crh-priv" and
// doc/privilege.md "非特权模式如何处理特权任务".
package helper

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"hash"
	"io"
	"os"
	"strconv"
	"sync"
	"time"

	"golang.org/x/sys/unix"

	"github.com/Kodecable/ClusterRightHand/client/internal/executor"
	"github.com/Kodecable/ClusterRightHand/client/internal/privileged/wire"
	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
	"github.com/fxamacker/cbor/v2"
)

// outputChunk bounds one task.output event: a 64 KiB read from the executor would not fit a crh-priv
// frame.
const outputChunk = 32 << 10

// emptyInputHash is the SHA-256 of empty input, which an InputRef of size 0 must declare.
var emptyInputHash = protocol.Hash(sha256.Sum256(nil))

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
	return h.task != nil && h.task.finished
}

// helper is one native helper session. The task is set once and never replaced.
type helper struct {
	stream *wire.Stream
	log    io.Writer
	done   chan struct{}

	mu   sync.Mutex
	task *task

	logMu sync.Mutex
}

// task is the one task this helper executes, with the input accounting the crh-priv task.input
// chunks need. Fields under the helper's mu.
type task struct {
	id     string
	start  protocol.TaskStart
	sink   *streamSink
	in     *executor.Input
	ctx    context.Context
	cancel context.CancelFunc

	inputOff  uint64
	inputSize uint64
	inputHash protocol.Hash
	hasher    hash.Hash
	inputErr  *protocol.Error
	finished  bool

	// startOnce makes the execution start exactly once: normally from Deferred.After, or from Run
	// when the task.start response could not be sent.
	startOnce sync.Once
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
	if ts.TaskID == "" {
		return nil, &protocol.RemoteError{Code: "invalid_spec", Message: "task id must not be empty"}
	}
	ctx, cancel := context.WithCancel(context.Background())
	t := &task{id: ts.TaskID, start: ts, ctx: ctx, cancel: cancel}
	t.sink = newStreamSink(func(stream protocol.Stream, off uint64, data []byte) error {
		return h.stream.Peer().Emit(protocol.EventTaskOutput, protocol.TaskOutput{
			TaskID: ts.TaskID, Stream: stream, Offset: protocol.Uint(off), Data: data,
		})
	})
	if ref := inputRef(&ts.Spec); ref != nil {
		// A zero-size input still commits crhs to the SHA-256 of empty input; a different hash can
		// never match, so refuse it before the task is accepted.
		if ref.Size == 0 && ref.SHA256 != emptyInputHash {
			cancel()
			return nil, &protocol.RemoteError{Code: "invalid_spec", Message: "input size 0 requires the sha256 of empty input"}
		}
		t.in = executor.NewInput()
		t.inputSize, t.inputHash, t.hasher = uint64(ref.Size), ref.SHA256, sha256.New()
		if ref.Size == 0 {
			t.in.Close()
		}
	}
	h.task = t
	return protocol.Deferred{Body: protocol.Empty{}, After: func() { h.launch(t) }}, nil
}

// launch starts the accepted task's execution exactly once. Peer calls Deferred.After only after the
// task.start success response went out; when that send fails, the acceptance already stands and the
// task must still run, with its outcome recorded in the local log.
func (h *helper) launch(t *task) {
	t.startOnce.Do(func() { go h.execute(t) })
}

// launchAccepted launches the accepted task if Deferred.After never ran because the response could
// not be sent.
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
	defer h.mu.Unlock()
	t := h.task
	if t == nil || in.TaskID != t.id {
		return nil, &protocol.RemoteError{Code: "unknown_task", Message: "unknown task " + in.TaskID}
	}
	tooLarge := func(size uint64) (any, error) {
		return nil, &protocol.RemoteError{
			Code:    "input_too_large",
			Message: fmt.Sprintf("task %s input exceeds the declared %d bytes", in.TaskID, size),
		}
	}
	if uint64(in.Offset) != t.inputOff {
		return nil, &protocol.RemoteError{
			Code:    "input_out_of_order",
			Message: fmt.Sprintf("task %s input offset %d, want %d", in.TaskID, in.Offset, t.inputOff),
		}
	}
	if t.in == nil || t.inputOff >= t.inputSize {
		if len(in.Data) == 0 {
			return protocol.Empty{}, nil
		}
		return tooLarge(t.inputSize)
	}
	if t.inputOff+uint64(len(in.Data)) > t.inputSize {
		t.inputOff += uint64(len(in.Data))
		h.failInputLocked(t, "input_mismatch",
			fmt.Sprintf("task %s input is longer than the declared %d bytes", in.TaskID, t.inputSize))
		return tooLarge(t.inputSize)
	}
	t.inputOff += uint64(len(in.Data))
	_, _ = t.hasher.Write(in.Data)
	if t.inputOff == t.inputSize && !bytes.Equal(t.hasher.Sum(nil), t.inputHash[:]) {
		h.failInputLocked(t, "input_mismatch",
			fmt.Sprintf("task %s input does not match the declared sha256", in.TaskID))
		return protocol.Empty{}, nil
	}
	t.in.Push(in.Data)
	if t.inputOff >= t.inputSize {
		t.in.Close()
	}
	return protocol.Empty{}, nil
}

func (h *helper) handleCancel(_ context.Context, body cbor.RawMessage) (any, error) {
	var c protocol.TaskCancel
	if err := protocol.Unmarshal(body, &c); err != nil {
		return nil, err
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if t := h.task; t != nil && t.id == c.TaskID && !t.finished {
		t.cancel()
		if t.in != nil {
			// A file.write blocked in its input read only notices the cancellation through the
			// reader, and the read error must not mask it: cancel first, then wake the reader.
			t.in.Fail(errors.New("task cancelled"))
		}
	}
	return protocol.Empty{}, nil
}

func (h *helper) handleQuery(_ context.Context, body cbor.RawMessage) (any, error) {
	var q protocol.TaskQuery
	if err := protocol.Unmarshal(body, &q); err != nil {
		return nil, err
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	t := h.task
	if t == nil || t.id != q.TaskID {
		return protocol.TaskStatus{TaskID: q.TaskID, State: protocol.TaskUnknown}, nil
	}
	state := protocol.TaskRunning
	if t.finished {
		state = protocol.TaskExited
	}
	return protocol.TaskStatus{
		TaskID:    t.id,
		State:     state,
		StdoutEnd: protocol.Uint(t.sink.End(protocol.StreamStdout)),
		StderrEnd: protocol.Uint(t.sink.End(protocol.StreamStderr)),
	}, nil
}

// execute runs the accepted task with the privileged executor and streams its outcome. It is started
// only after the task.start success response went out, so no task event can precede it.
func (h *helper) execute(t *task) {
	started := time.Now()
	h.logStart(t)
	res := executor.RunTask(t.ctx, &t.start.Spec, t.reader(), t.sink, executor.TaskOptions{
		Timeout:    time.Duration(t.start.TimeoutMS) * time.Millisecond,
		KillGrace:  time.Duration(t.start.KillGraceMS) * time.Millisecond,
		Privileged: true,
	})
	t.sink.Close()
	exit := &protocol.TaskExit{
		TaskID:    t.id,
		Outcome:   res.Outcome(),
		TimedOut:  res.TimedOut,
		Cancelled: res.Cancelled,
		StdoutEnd: protocol.Uint(t.sink.End(protocol.StreamStdout)),
		StderrEnd: protocol.Uint(t.sink.End(protocol.StreamStderr)),
	}
	h.mu.Lock()
	if t.inputErr != nil {
		// The input, not the process, decided this task (a truncated stdin may look successful).
		exit.Outcome = protocol.Outcome{
			Kind:  protocol.OutcomeError,
			Error: &protocol.Error{Code: t.inputErr.Code, Message: protocol.ErrorMessage(t.inputErr.Message)},
		}
		exit.Cancelled = false
	}
	t.finished = true
	h.mu.Unlock()

	h.logExit(t, exit, time.Since(started))
	if err := h.stream.Peer().Emit(protocol.EventTaskExit, exit); err != nil {
		// The parent is gone. The task itself has finished and is recorded in the local log; there is
		// nobody left to tell.
		h.logLine(logRecord{Event: "task.exit.undelivered", TaskID: t.id, Detail: err.Error()})
	}
	close(h.done)
}

// reader returns the task's stdin/content reader, or nil when the task declares no input.
func (t *task) reader() io.Reader {
	if t.in == nil {
		return nil
	}
	return t.in
}

// endInput fails an input that can no longer be completed because the stream ended; the task cannot
// read the rest, and leaving the reader blocked would keep the helper alive forever.
func (h *helper) endInput() {
	h.mu.Lock()
	defer h.mu.Unlock()
	t := h.task
	if t == nil || t.finished || t.in == nil || t.inputOff >= t.inputSize {
		return
	}
	h.failInputLocked(t, "input_incomplete", "the crh-priv stream ended before the task input was complete")
}

// abort cancels the running task, e.g. when the helper itself is asked to stop.
func (h *helper) abort() {
	h.mu.Lock()
	t := h.task
	h.mu.Unlock()
	if t == nil {
		return
	}
	t.cancel()
	if t.in != nil {
		t.in.Fail(errors.New("the native helper is stopping"))
	}
}

// failInputLocked records why a task's input failed and cancels the task so a running process stops
// and a blocked reader returns. The first input error wins. h.mu must be held.
func (h *helper) failInputLocked(t *task, code, message string) {
	if t.inputErr == nil {
		t.inputErr = &protocol.Error{Code: code, Message: message}
	}
	if t.in != nil {
		t.in.Fail(errors.New(message))
	}
	t.cancel()
}

func inputRef(spec *protocol.TaskSpec) *protocol.InputRef {
	switch spec.Kind {
	case protocol.TaskSpecExec:
		if spec.Exec != nil {
			return spec.Exec.Stdin
		}
	case protocol.TaskSpecFileWrite:
		if spec.FileWrite != nil {
			return &spec.FileWrite.Content
		}
	}
	return nil
}

// streamSink turns task output into task.output events as it is produced. Unlike executor.Output it
// keeps nothing: the non-privileged mode owns the output file and the replay after a reconnect, and
// crh-priv task.output has no acknowledgement.
type streamSink struct {
	mu     sync.Mutex
	emit   func(protocol.Stream, uint64, []byte) error
	offs   [executor.StreamSlots]uint64
	closed bool
}

func newStreamSink(emit func(protocol.Stream, uint64, []byte) error) *streamSink {
	return &streamSink{emit: emit}
}

// Writer implements executor.Sink.
func (s *streamSink) Writer(stream protocol.Stream) io.Writer { return sinkWriter{s, stream} }

type sinkWriter struct {
	s      *streamSink
	stream protocol.Stream
}

func (w sinkWriter) Write(p []byte) (int, error) {
	w.s.write(w.stream, p)
	return len(p), nil
}

func (s *streamSink) write(stream protocol.Stream, p []byte) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed || len(p) == 0 {
		return
	}
	idx := executor.StreamIndex(stream)
	for len(p) > 0 {
		n := min(len(p), outputChunk)
		off := s.offs[idx]
		if err := s.emit(stream, off, p[:n]); err != nil {
			// Nobody is left to receive the output. Stop emitting and let the task run to its end;
			// the local log still records the outcome.
			s.closed = true
			return
		}
		s.offs[idx] += uint64(n)
		p = p[n:]
	}
}

// Close stops emitting. Output that arrives afterwards is dropped, so task.exit is always the last
// frame of the stream.
func (s *streamSink) Close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.closed = true
}

// End returns how many bytes of a stream were emitted.
func (s *streamSink) End(stream protocol.Stream) uint64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.offs[executor.StreamIndex(stream)]
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

func (h *helper) logStart(t *task) {
	spec := t.start.Spec
	h.logLine(logRecord{
		Event:      "task.start",
		Time:       time.Now().UTC().Format(time.RFC3339Nano),
		TaskID:     t.id,
		Attempt:    t.start.Attempt,
		Privileged: t.start.Privileged,
		Spec:       &spec,
	})
}

func (h *helper) logExit(t *task, exit *protocol.TaskExit, took time.Duration) {
	h.logLine(logRecord{
		Event:      "task.exit",
		Time:       time.Now().UTC().Format(time.RFC3339Nano),
		TaskID:     t.id,
		Attempt:    t.start.Attempt,
		Privileged: t.start.Privileged,
		Outcome:    outcomeText(exit.Outcome),
		TimedOut:   exit.TimedOut,
		Cancelled:  exit.Cancelled,
		StdoutEnd:  exit.StdoutEnd,
		StderrEnd:  exit.StderrEnd,
		DurationMS: took.Milliseconds(),
	})
}

func outcomeText(o protocol.Outcome) string {
	switch o.Kind {
	case protocol.OutcomeCode:
		return "exit " + strconv.FormatInt(int64(o.Code), 10)
	case protocol.OutcomeSignal:
		return "signal " + o.Signal
	case protocol.OutcomeError:
		if o.Error == nil {
			return "error"
		}
		return "error " + o.Error.Code + ": " + o.Error.Message
	default:
		return "unknown"
	}
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
