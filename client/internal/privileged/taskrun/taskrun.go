// Package taskrun is the one-task execution machinery shared by the native helper
// (`crha privileged stdio`, one task over stdio) and the privileged daemon (many tasks per
// connection after authorization). It owns the task's input accounting, the output stream and
// the privileged executor call; the callers own the wire, the authorization and the local
// log. See doc/privilege.md 执行环境 and doc/protocol.md crh-priv.
package taskrun

import (
	"context"
	"errors"
	"io"
	"os"
	"strconv"
	"sync"
	"time"

	"github.com/Kodecable/ClusterRightHand/client/internal/execenv"
	"github.com/Kodecable/ClusterRightHand/client/internal/executor"
	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
	"github.com/Kodecable/ClusterRightHand/client/internal/taskinput"
)

// OutputChunk bounds one task.output event: a 64 KiB read from the executor would not fit a
// crh-priv frame.
const OutputChunk = 32 << 10

// Errors that end a task before its process starts.
var (
	errInputCancelled = errors.New("the task was cancelled before its input was complete")
	errInputTimeout   = errors.New("the task timed out before its input was complete")
)

// Emit sends one task.output chunk of the task's single output stream. The offset is the
// stream offset of the first byte of data. An error means nobody is left to receive the
// output; the task keeps running and the caller records its outcome in the local log.
type Emit func(offset uint64, data []byte) error

// Task is one accepted privileged task. Its methods are safe for concurrent use.
type Task struct {
	id    string
	start protocol.TaskStart
	env   *execenv.Environment
	sink  *streamSink
	// in is the streaming input of a file.write task, which the file task itself verifies
	// before publishing the file. It is nil for an exec task.
	in *executor.Input
	// spool is the private temporary file that collects the stdin of a privileged exec task.
	// The process only starts with it as stdin once the input matched its declared size and
	// SHA-256, so a compromised crhs cannot have a different chunk read by the process
	// (doc/privilege.md 执行环境).
	spool     *os.File
	spoolPath string
	// inputReady is closed once the declared input was received completely and verified.
	inputReady chan struct{}
	ctx        context.Context
	abort      context.CancelFunc
	done       chan struct{}

	mu       sync.Mutex
	input    taskinput.Input
	inputErr *protocol.Error
	finished bool

	startOnce sync.Once
}

// Validate checks the parts of task.start that are neither schema nor authorization: a
// non-empty task id and the empty-input hash sentinel. The returned error is a
// *protocol.RemoteError with code invalid_spec.
func Validate(ts protocol.TaskStart) error {
	if ts.TaskID == "" {
		return &protocol.RemoteError{Code: protocol.CodeInvalidSpec, Message: "task id must not be empty"}
	}
	// A zero-size input still commits crhs to the SHA-256 of empty input; a different hash can
	// never match, so it is refused before the task is accepted.
	if err := taskinput.ValidateRef(taskinput.Ref(&ts.Spec)); err != nil {
		return err
	}
	return nil
}

// New prepares a task. It validates task.start with Validate. env is the environment the privileged
// process resolved when it started (execenv.Resolve); nil resolves it per task, which only tests and
// programmatic callers do.
func New(ts protocol.TaskStart, emit Emit, env *execenv.Environment) (*Task, error) {
	if err := Validate(ts); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	t := &Task{id: ts.TaskID, start: ts, env: env, ctx: ctx, abort: cancel, done: make(chan struct{})}
	t.sink = newStreamSink(emit)
	if ref := taskinput.Ref(&ts.Spec); ref != nil {
		t.input = taskinput.New(ref)
		switch {
		case ts.Spec.Kind == protocol.TaskSpecFileWrite:
			t.in = executor.NewInput()
			if ref.Size == 0 {
				t.in.Close()
			}
		default:
			// os.CreateTemp creates the file with O_EXCL and mode 0600 in a private directory;
			// the contents are only ever read back through this fd. The file is removed once
			// the task ends, and a task whose input never completes never starts.
			spool, err := os.CreateTemp("", "crh-stdin-")
			if err != nil {
				cancel()
				return nil, &protocol.RemoteError{
					Code:    protocol.CodeInternalError,
					Message: "spool the task input: " + err.Error(),
				}
			}
			t.spool, t.spoolPath = spool, spool.Name()
			t.inputReady = make(chan struct{})
			if ref.Size == 0 {
				close(t.inputReady)
			}
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
	res := t.run()
	t.sink.Close()
	exit := &protocol.TaskExit{
		TaskID:    t.id,
		Outcome:   res.Outcome(),
		TimedOut:  res.TimedOut,
		Cancelled: res.Cancelled,
		OutputEnd: protocol.Uint(t.sink.End()),
		Result:    res.TaskResult,
	}
	t.mu.Lock()
	if t.inputErr != nil {
		// The input, not the process, decided this task (a truncated stdin may look successful).
		exit.Outcome = protocol.Outcome{
			Kind:  protocol.OutcomeError,
			Error: &protocol.Error{Code: t.inputErr.Code, Message: protocol.ErrorMessage(t.inputErr.Message)},
		}
		exit.Cancelled = false
		// The input decided this task: a result the executor produced would contradict the failure.
		exit.Result = nil
	}
	t.finished = true
	t.mu.Unlock()
	return exit
}

// run waits for the declared stdin of a privileged exec task and then runs the task. The
// process must not read the input before its size and SHA-256 were verified, so the chunks are
// spooled to a temporary file and the process only starts with that file as stdin.
func (t *Task) run() executor.Result {
	timeout := time.Duration(t.start.TimeoutMS) * time.Millisecond
	started := time.Now()
	var deadline <-chan time.Time
	if timeout > 0 {
		timer := time.NewTimer(timeout)
		defer timer.Stop()
		deadline = timer.C
	}
	if t.spool != nil {
		// The spool is removed however the task ends, including a cancel or timeout while the
		// input was still incomplete and a task whose process never started.
		defer func() {
			_ = t.spool.Close()
			_ = os.Remove(t.spoolPath)
		}()
		if err := t.awaitInput(deadline); err != nil {
			return t.beforeStart(err)
		}
		// The timeout covers waiting for the input too; hand the process what is left of it.
		if timeout > 0 {
			if timeout -= time.Since(started); timeout <= 0 {
				return t.beforeStart(errInputTimeout)
			}
		}
		if _, err := t.spool.Seek(0, io.SeekStart); err != nil {
			return executor.Result{Err: &executor.Error{Code: protocol.CodeIOError, Message: "rewind the task input: " + err.Error()}}
		}
	}
	return executor.RunTask(t.ctx, &t.start.Spec, t.reader(), t.sink, executor.TaskOptions{
		Timeout:    timeout,
		KillGrace:  time.Duration(t.start.KillGraceMS) * time.Millisecond,
		Privileged: true,
		Env:        t.env,
	})
}

// awaitInput blocks until the spooled input is complete and verified, the task is cancelled or
// the timeout expires. An input failure (input_mismatch, input_incomplete) stays in t.inputErr
// and is reported by execute; the sentinel errors cover a task that ended before its input.
func (t *Task) awaitInput(deadline <-chan time.Time) error {
	select {
	case <-t.inputReady:
		return nil
	default:
	}
	for {
		select {
		case <-t.inputReady:
			return nil
		case <-t.ctx.Done():
			t.mu.Lock()
			inputErr := t.inputErr
			t.mu.Unlock()
			if inputErr != nil {
				return errors.New(inputErr.Message)
			}
			return errInputCancelled
		case <-deadline:
			return errInputTimeout
		}
	}
}

// beforeStart builds the result of a task whose process must not start. An input failure keeps
// its error for execute to apply; a cancel or timeout is reported with its own outcome.
func (t *Task) beforeStart(err error) executor.Result {
	t.mu.Lock()
	failed := t.inputErr != nil
	t.mu.Unlock()
	if failed {
		return executor.Result{}
	}
	if errors.Is(err, errInputCancelled) {
		return executor.Result{
			Cancelled: true,
			Err:       &executor.Error{Code: protocol.CodeCancelled, Message: err.Error()},
		}
	}
	return executor.Result{
		TimedOut: true,
		Err:      &executor.Error{Code: protocol.CodeTimeout, Message: err.Error()},
	}
}

// reader returns the task's stdin/content reader: the spooled stdin of an exec task (already
// rewound) or the streaming content of a file.write task, and nil when the task has no input.
func (t *Task) reader() io.Reader {
	if t.in != nil {
		return t.in
	}
	if t.spool != nil {
		return t.spool
	}
	return nil
}

// Input applies one task.input chunk and returns the command's response body. The error codes
// are the crh-priv ones of doc/protocol.md task.input.
func (t *Task) Input(in protocol.TaskInput) (any, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if in.TaskID != t.id {
		return nil, &protocol.RemoteError{Code: protocol.CodeUnknownTask, Message: "unknown task " + in.TaskID}
	}
	res := t.input.Accept(t.id, &in)
	if res.Failure != nil {
		t.failInputLocked(res.Failure.Code, res.Failure.Message)
	}
	if res.Data != nil {
		if t.spool != nil {
			if _, err := t.spool.Write(res.Data); err != nil {
				// The spool is gone once the task ended or was aborted; a late chunk has nowhere to
				// go and must not replace the task's outcome.
				if !t.finished && t.inputErr == nil && t.ctx.Err() == nil {
					t.failInputLocked(protocol.CodeIOError, "spool the task input: "+err.Error())
				}
				return protocol.Empty{}, nil
			}
		} else if t.in != nil {
			t.in.Push(res.Data)
		}
	}
	if res.Refusal != nil {
		return nil, res.Refusal
	}
	if res.Complete {
		if t.in != nil {
			t.in.Close()
		}
		if t.inputReady != nil {
			// The input is complete and verified, so the spooled stdin may be handed to the
			// process. The accounting above keeps a second call from closing it again.
			close(t.inputReady)
		}
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
	if t.finished || t.input.Complete() {
		return
	}
	t.failInputLocked(protocol.CodeInputIncomplete, "the crh-priv stream ended before the task input was complete")
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
		OutputEnd: protocol.Uint(t.sink.End()),
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
	off    uint64
	closed bool
}

func newStreamSink(emit Emit) *streamSink {
	return &streamSink{emit: emit}
}

// Writer implements executor.Sink.
func (s *streamSink) Writer() io.Writer { return sinkWriter{s} }

type sinkWriter struct{ s *streamSink }

func (w sinkWriter) Write(p []byte) (int, error) {
	w.s.write(p)
	return len(p), nil
}

func (s *streamSink) write(p []byte) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed || len(p) == 0 {
		return
	}
	for len(p) > 0 {
		n := min(len(p), OutputChunk)
		off := s.off
		if err := s.emit(off, p[:n]); err != nil {
			// Nobody is left to receive the output. Stop emitting and let the task run to its
			// end; the local log still records the outcome.
			s.closed = true
			return
		}
		s.off += uint64(n)
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

// End returns how many bytes of the output were emitted.
func (s *streamSink) End() uint64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.off
}
