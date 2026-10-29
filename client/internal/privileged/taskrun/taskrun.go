// Package taskrun is the one-task execution machinery shared by the native helper
// (`crha privileged stdio`, one task over stdio) and the privileged daemon (many tasks per
// connection after authorization). It owns the task's input accounting, the output stream and
// the privileged executor call; the callers own the wire, the authorization and the local
// log. See doc/privilege.md 执行环境 and doc/protocol.md crh-priv.
package taskrun

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"hash"
	"io"
	"strconv"
	"sync"
	"time"

	"github.com/Kodecable/ClusterRightHand/client/internal/executor"
	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
)

// OutputChunk bounds one task.output event: a 64 KiB read from the executor would not fit a
// crh-priv frame.
const OutputChunk = 32 << 10

// emptyInputHash is the SHA-256 of empty input, which an InputRef of size 0 must declare.
var emptyInputHash = protocol.Hash(sha256.Sum256(nil))

// Emit sends one task.output chunk. The offset is the stream offset of the first byte of
// data. An error means nobody is left to receive the output; the task keeps running and the
// caller records its outcome in the local log.
type Emit func(stream protocol.Stream, offset uint64, data []byte) error

// Task is one accepted privileged task. Its methods are safe for concurrent use.
type Task struct {
	id    string
	start protocol.TaskStart
	sink  *streamSink
	in    *executor.Input
	ctx   context.Context
	abort context.CancelFunc
	done  chan struct{}

	mu        sync.Mutex
	inputOff  uint64
	inputSize uint64
	inputHash protocol.Hash
	hasher    hash.Hash
	inputErr  *protocol.Error
	finished  bool

	startOnce sync.Once
}

// Validate checks the parts of task.start that are neither schema nor authorization: a
// non-empty task id and the empty-input hash sentinel. The returned error is a
// *protocol.RemoteError with code invalid_spec.
func Validate(ts protocol.TaskStart) error {
	if ts.TaskID == "" {
		return &protocol.RemoteError{Code: "invalid_spec", Message: "task id must not be empty"}
	}
	if ref := inputRef(&ts.Spec); ref != nil && ref.Size == 0 && ref.SHA256 != emptyInputHash {
		// A zero-size input still commits crhs to the SHA-256 of empty input; a different
		// hash can never match, so refuse it before the task is accepted.
		return &protocol.RemoteError{Code: "invalid_spec", Message: "input size 0 requires the sha256 of empty input"}
	}
	return nil
}

// New prepares a task. It validates task.start with Validate.
func New(ts protocol.TaskStart, emit Emit) (*Task, error) {
	if err := Validate(ts); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	t := &Task{id: ts.TaskID, start: ts, ctx: ctx, abort: cancel, done: make(chan struct{})}
	t.sink = newStreamSink(emit)
	if ref := inputRef(&ts.Spec); ref != nil {
		t.in = executor.NewInput()
		t.inputSize, t.inputHash, t.hasher = uint64(ref.Size), ref.SHA256, sha256.New()
		if ref.Size == 0 {
			t.in.Close()
		}
	}
	return t, nil
}

// ID returns the task id.
func (t *Task) ID() string { return t.id }

// TaskStart returns the task.start request the task was accepted with.
func (t *Task) TaskStart() protocol.TaskStart { return t.start }

// Start runs the task in a new goroutine, at most once for the task's lifetime. onStart runs on
// that goroutine before the executor starts; onExit runs after the task finished and received
// its exit. Both may be nil. Start returns immediately.
//
// Starting is separate from New so a request handler can return the success response first
// (protocol.Deferred.After) and still start an accepted task whose response could not be sent.
func (t *Task) Start(onStart func(), onExit func(*protocol.TaskExit)) {
	t.startOnce.Do(func() {
		go func() {
			if onStart != nil {
				onStart()
			}
			exit := t.execute()
			if onExit != nil {
				onExit(exit)
			}
			close(t.done)
		}()
	})
}

// Done is closed once the task finished and onExit returned.
func (t *Task) Done() <-chan struct{} { return t.done }

// execute runs the task with the privileged executor and streams its outcome. t.startOnce
// guarantees no task event can precede the task.start success response.
func (t *Task) execute() *protocol.TaskExit {
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
	t.mu.Lock()
	if t.inputErr != nil {
		// The input, not the process, decided this task (a truncated stdin may look successful).
		exit.Outcome = protocol.Outcome{
			Kind:  protocol.OutcomeError,
			Error: &protocol.Error{Code: t.inputErr.Code, Message: protocol.ErrorMessage(t.inputErr.Message)},
		}
		exit.Cancelled = false
	}
	t.finished = true
	t.mu.Unlock()
	return exit
}

// reader returns the task's stdin/content reader, or nil when the task declares no input.
func (t *Task) reader() io.Reader {
	if t.in == nil {
		return nil
	}
	return t.in
}

// Input applies one task.input chunk and returns the command's response body. The error codes
// are the crh-priv ones of doc/protocol.md task.input.
func (t *Task) Input(in protocol.TaskInput) (any, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if in.TaskID != t.id {
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
		t.failInputLocked("input_mismatch",
			fmt.Sprintf("task %s input is longer than the declared %d bytes", in.TaskID, t.inputSize))
		return tooLarge(t.inputSize)
	}
	t.inputOff += uint64(len(in.Data))
	_, _ = t.hasher.Write(in.Data)
	if t.inputOff == t.inputSize && !bytes.Equal(t.hasher.Sum(nil), t.inputHash[:]) {
		t.failInputLocked("input_mismatch",
			fmt.Sprintf("task %s input does not match the declared sha256", in.TaskID))
		return protocol.Empty{}, nil
	}
	t.in.Push(in.Data)
	if t.inputOff >= t.inputSize {
		t.in.Close()
	}
	return protocol.Empty{}, nil
}

// Cancel stops the task if id matches. Cancelling an unknown or finished task is a no-op, as
// task.cancel's contract requires.
func (t *Task) Cancel(id string) {
	if id != t.id {
		return
	}
	t.abortTask()
}

// Abort cancels the task regardless of its id, for example when the daemon is shutting down.
func (t *Task) Abort() { t.abortTask() }

func (t *Task) abortTask() {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.finished {
		return
	}
	t.abort()
	if t.in != nil {
		// A file.write blocked in its input read only notices the cancellation through the
		// reader, and the read error must not mask it: cancel first, then wake the reader.
		t.in.Fail(errors.New("task cancelled"))
	}
}

// EndInput fails an input that can no longer be completed because the stream ended; the task
// cannot read the rest, and leaving the reader blocked would keep the task alive forever.
func (t *Task) EndInput() {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.finished || t.in == nil || t.inputOff >= t.inputSize {
		return
	}
	t.failInputLocked("input_incomplete", "the crh-priv stream ended before the task input was complete")
}

// Status returns the task.query response for q. A query for another task is unknown.
func (t *Task) Status(q protocol.TaskQuery) protocol.TaskStatus {
	t.mu.Lock()
	defer t.mu.Unlock()
	if q.TaskID != t.id {
		return protocol.TaskStatus{TaskID: q.TaskID, State: protocol.TaskUnknown}
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
	}
}

// Finished reports whether the task's execution ended.
func (t *Task) Finished() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.finished
}

// failInputLocked records why a task's input failed and cancels the task so a running process
// stops and a blocked reader returns. The first input error wins. t.mu must be held.
func (t *Task) failInputLocked(code, message string) {
	if t.inputErr == nil {
		t.inputErr = &protocol.Error{Code: code, Message: message}
	}
	if t.in != nil {
		t.in.Fail(errors.New(message))
	}
	t.abort()
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

// OutcomeText renders a task.exit outcome for the local log.
func OutcomeText(o protocol.Outcome) string {
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

// streamSink turns task output into task.output events as it is produced. It keeps nothing: the
// non-privileged mode owns the output file and the replay after a reconnect, and crh-priv
// task.output has no acknowledgement.
type streamSink struct {
	mu     sync.Mutex
	emit   Emit
	offs   [executor.StreamSlots]uint64
	closed bool
}

func newStreamSink(emit Emit) *streamSink {
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
		n := min(len(p), OutputChunk)
		off := s.offs[idx]
		if err := s.emit(stream, off, p[:n]); err != nil {
			// Nobody is left to receive the output. Stop emitting and let the task run to its
			// end; the local log still records the outcome.
			s.closed = true
			return
		}
		s.offs[idx] += uint64(n)
		p = p[n:]
	}
}

// Close stops emitting. Output that arrives afterwards is dropped, so task.exit is always the
// last frame of the stream.
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
