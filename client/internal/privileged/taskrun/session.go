package taskrun

import (
	"context"
	"sync"
	"time"

	"github.com/fxamacker/cbor/v2"

	"github.com/Kodecable/ClusterRightHand/client/internal/execenv"
	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
)

// Log records the life of a session's tasks in the caller's local log. Each caller keeps its
// own record format: the native helper writes JSON lines to stderr, the daemon its audit log.
type Log interface {
	// TaskStarted runs on the task's goroutine right before the executor starts.
	TaskStarted(t *Task)
	// TaskFinished runs once the task ended, before its task.exit is emitted.
	TaskFinished(t *Task, exit *protocol.TaskExit, took time.Duration)
	// ExitUndelivered runs when the task.exit event could not be sent.
	ExitUndelivered(t *Task, err error)
}

// SessionOptions configures NewSession.
type SessionOptions struct {
	// Env is the environment passed to New for every task.
	Env *execenv.Environment
	// SpoolRoot is the privileged state directory whose stdin subdirectory stages a task's stdin
	// while it is verified. It is required for a task that declares input.
	SpoolRoot string
	// Log records the tasks' start and outcome.
	Log Log
	// OnExit runs after a task's task.exit was emitted (or could not be). nil does nothing.
	OnExit func(*Task)
	// KeepFinished keeps a finished task in the session, so task.input, task.cancel and
	// task.query still reach it. Without it the task leaves the session after OnExit, so a
	// stream that lives for days does not retain every task it ever ran.
	KeepFinished bool
}

// Session is the set of accepted tasks of one crh-priv stream: the native helper's single task
// or the tasks of one daemon forward connection. It owns the tasks' output and exit events and
// the task.input, task.cancel and task.query handlers; the caller owns task.start (validation,
// authorization, acceptance) and the local log format. Its methods are safe for concurrent use.
type Session struct {
	peer *protocol.Peer
	opts SessionOptions

	mu    sync.Mutex
	tasks map[string]*Task
}

// NewSession returns an empty session emitting on peer.
func NewSession(peer *protocol.Peer, opts SessionOptions) *Session {
	return &Session{peer: peer, opts: opts, tasks: make(map[string]*Task)}
}

// HandleRequests installs the session's task.input, task.cancel and task.query handlers.
func (s *Session) HandleRequests() {
	s.peer.HandleRequest(protocol.CmdTaskInput, s.handleInput)
	s.peer.HandleRequest(protocol.CmdTaskCancel, s.handleCancel)
	s.peer.HandleRequest(protocol.CmdTaskQuery, s.handleQuery)
}

// Prepare creates a task and its staging without adding it to the session. Its output goes out as
// task.output events. A caller that must persist something before accepting the task (the daemon's
// used record) prepares first and adds it only after that succeeded, so a resource failure cannot
// burn a one-shot authorization; a task that is not added is released with Task.Discard.
func (s *Session) Prepare(ts protocol.TaskStart) (*Task, error) {
	return New(ts, s.outputEmitter(ts.TaskID), s.opts.Env, s.opts.SpoolRoot)
}

// Add adds a prepared task to the session. The task does not run until Launch.
func (s *Session) Add(t *Task) {
	s.mu.Lock()
	s.tasks[t.ID()] = t
	s.mu.Unlock()
}

// Accept prepares an accepted task with New and adds it to the session. Its output goes out as
// task.output events. The task does not run until Launch.
func (s *Session) Accept(ts protocol.TaskStart) (*Task, error) {
	t, err := s.Prepare(ts)
	if err != nil {
		return nil, err
	}
	s.Add(t)
	return t, nil
}

// outputEmitter turns the task's output into crh-priv task.output events.
func (s *Session) outputEmitter(taskID string) Emit {
	return func(off uint64, data []byte) error {
		return s.peer.Emit(protocol.EventTaskOutput, protocol.TaskOutput{
			TaskID: taskID, Offset: protocol.Uint(off), Data: data,
		})
	}
}

// Launch starts an accepted task's execution and records its outcome. Peer calls
// Deferred.After only after the task.start success response went out; when that send fails,
// the acceptance already stands and the task must still run, with its outcome recorded in the
// local log (LaunchAll). Task.Start runs the task at most once, so a racing call is a no-op.
func (s *Session) Launch(t *Task) {
	var started time.Time
	t.Start(
		func() {
			started = time.Now()
			s.opts.Log.TaskStarted(t)
		},
		func(exit *protocol.TaskExit) {
			s.opts.Log.TaskFinished(t, exit, time.Since(started))
			if err := s.peer.Emit(protocol.EventTaskExit, exit); err != nil {
				// The stream is gone. The task itself has finished and is recorded in the local
				// log; there is nobody left to tell.
				s.opts.Log.ExitUndelivered(t, err)
			}
			if s.opts.OnExit != nil {
				s.opts.OnExit(t)
			}
			if !s.opts.KeepFinished {
				s.forget(t)
			}
		},
	)
}

// forget drops a task whose execution ended from the session. Afterwards task.input for the id
// is unknown_task and task.cancel is the same no-op success as for any unknown task
// (doc/design/protocol.md "Commands").
func (s *Session) forget(t *Task) {
	s.mu.Lock()
	if s.tasks[t.ID()] == t {
		delete(s.tasks, t.ID())
	}
	s.mu.Unlock()
}

// task returns the session's task with id, or nil.
func (s *Session) task(id string) *Task {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.tasks[id]
}

// snapshot returns the session's tasks.
func (s *Session) snapshot() []*Task {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]*Task, 0, len(s.tasks))
	for _, t := range s.tasks {
		out = append(out, t)
	}
	return out
}

// Len returns how many tasks the session holds.
func (s *Session) Len() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.tasks)
}

// LaunchAll launches every accepted task whose Deferred.After never ran because the response
// could not be sent.
func (s *Session) LaunchAll() {
	for _, t := range s.snapshot() {
		s.Launch(t)
	}
}

// EndInput fails every input that can no longer be completed because the stream ended; a task
// reading it cannot read the rest, and leaving the reader blocked would keep it alive forever.
func (s *Session) EndInput() {
	for _, t := range s.snapshot() {
		t.EndInput()
	}
}

// Abort cancels every task of the session, e.g. when the process itself is asked to stop.
func (s *Session) Abort() {
	for _, t := range s.snapshot() {
		t.Abort()
	}
}

func (s *Session) handleInput(_ context.Context, body cbor.RawMessage) (any, error) {
	var in protocol.TaskInput
	if err := protocol.UnmarshalBody(body, &in); err != nil {
		return nil, err
	}
	t := s.task(in.TaskID)
	if t == nil {
		return nil, &protocol.RemoteError{Code: protocol.CodeUnknownTask, Message: "unknown task " + in.TaskID}
	}
	return t.Input(in)
}

func (s *Session) handleCancel(_ context.Context, body cbor.RawMessage) (any, error) {
	var c protocol.TaskCancel
	if err := protocol.UnmarshalBody(body, &c); err != nil {
		return nil, err
	}
	if t := s.task(c.TaskID); t != nil {
		t.Cancel(c.TaskID)
	}
	return protocol.Empty{}, nil
}

func (s *Session) handleQuery(_ context.Context, body cbor.RawMessage) (any, error) {
	var q protocol.TaskQuery
	if err := protocol.UnmarshalBody(body, &q); err != nil {
		return nil, err
	}
	if t := s.task(q.TaskID); t != nil {
		return t.Status(q), nil
	}
	return protocol.TaskStatus{TaskID: q.TaskID, State: protocol.TaskUnknown}, nil
}
