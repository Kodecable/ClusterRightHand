package agent

import (
	"fmt"
	"sync"

	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
)

// maxBufferedRelayEvents bounds the events the relay buffers for one task before its handlers
// exist. The window is the time between the privileged peer writing an accepted task.start
// response and this side registering the task, so a handful of events; the bound only exists so
// a misbehaving peer cannot grow the buffer without limit.
const maxBufferedRelayEvents = 256

// relayRouter routes the task events of one multiplexed privileged peer to the task they
// belong to. The peer starts a task as soon as it wrote the task.start response, and that
// response can reach the read loop before the caller of the relayed request has registered the
// task here, so events of a task without handlers are buffered and replayed in order by attach.
// The read loop of the peer is the only router, so the per-task ordering of its events is kept.
type relayRouter struct {
	mu       sync.Mutex
	handlers map[string]*relayHandlers
	pending  map[string][]relayEvent
}

// relayHandlers is the pair of events a relayed task receives.
type relayHandlers struct {
	output func(*protocol.TaskOutput) error
	exit   func(*protocol.TaskExit) error
}

// relayEvent is one event waiting for its task's handlers; exactly one field is set.
type relayEvent struct {
	output *protocol.TaskOutput
	exit   *protocol.TaskExit
}

// handle delivers the event to the task's handlers.
func (e relayEvent) handle(h *relayHandlers) error {
	switch {
	case e.output != nil:
		return h.output(e.output)
	case e.exit != nil:
		return h.exit(e.exit)
	default:
		return nil
	}
}

func newRelayRouter() *relayRouter {
	return &relayRouter{
		handlers: make(map[string]*relayHandlers),
		pending:  make(map[string][]relayEvent),
	}
}

// route delivers an event to the task's handlers, or buffers it until attach. The handlers run
// under the router's lock so an event that arrives during attach cannot overtake the replay.
func (r *relayRouter) route(taskID string, event relayEvent) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if h := r.handlers[taskID]; h != nil {
		return event.handle(h)
	}
	if len(r.pending[taskID]) >= maxBufferedRelayEvents {
		return fmt.Errorf("crh-priv: more than %d events for unregistered task %q", maxBufferedRelayEvents, taskID)
	}
	r.pending[taskID] = append(r.pending[taskID], event)
	return nil
}

// attach installs the handlers of a task and replays the events buffered for it.
func (r *relayRouter) attach(taskID string, handlers *relayHandlers) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.handlers[taskID] = handlers
	pending := r.pending[taskID]
	delete(r.pending, taskID)
	for _, event := range pending {
		if err := event.handle(handlers); err != nil {
			return err
		}
	}
	return nil
}

// discard forgets a task and anything buffered for it.
func (r *relayRouter) discard(taskID string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.handlers, taskID)
	delete(r.pending, taskID)
}

// relayOutput records one task.output chunk of a task that runs in a privileged peer (the
// native helper or the privileged mode) into the agent's own output spool, so the spill file,
// resume after a reconnect and acknowledgements work unchanged.
func (a *Agent) relayOutput(t *task, out *protocol.TaskOutput) error {
	if a.taskDone(t) {
		// An ordered stream cannot deliver output after task.exit; drop it rather than write
		// into a closed spool.
		return nil
	}
	if end := t.output.End(out.Stream); uint64(out.Offset) != end {
		return fmt.Errorf("relayed %s output at offset %d, want %d", out.Stream, out.Offset, end)
	}
	_, _ = t.output.Writer(out.Stream).Write(out.Data)
	return nil
}

// finishRelayed completes a task that executes in a privileged peer. The peer's task.exit ends
// it; closing the output here makes the pump send every byte the exit reports before task.exit,
// exactly like the local executor. The first outcome wins: a forwarded task can be finished by
// the peer's task.exit and by its connection breaking at the same time.
func (a *Agent) finishRelayed(t *task, exit *protocol.TaskExit) {
	t.finishOnce.Do(func() {
		t.output.Close()
		exit.StdoutEnd = protocol.Uint(t.output.End(protocol.StreamStdout))
		exit.StderrEnd = protocol.Uint(t.output.End(protocol.StreamStderr))
		exit.OutputFile = protocol.CleanText(t.output.Path())

		a.mu.Lock()
		if t.inputErr != nil {
			// The input, not the process, decided this task (see execute).
			exit.Outcome = protocol.Outcome{
				Kind:  protocol.OutcomeError,
				Error: &protocol.Error{Code: t.inputErr.Code, Message: protocol.ErrorMessage(t.inputErr.Message)},
			}
			exit.Cancelled = false
		}
		t.done, t.result = true, exit
		a.mu.Unlock()

		if t.native != nil {
			t.native.inputs.close()
			t.native.signalDone()
		}
		a.wake()
	})
}

// helperLostExit is the task.exit of a task whose privileged peer disappeared before it reported
// an outcome. The task may still be running there, so it is never retried (doc/protocol.md
// crh-priv 断开).
func helperLostExit(taskID, message string) *protocol.TaskExit {
	return &protocol.TaskExit{
		TaskID: taskID,
		Outcome: protocol.Outcome{
			Kind:  protocol.OutcomeError,
			Error: &protocol.Error{Code: "helper_lost", Message: protocol.ErrorMessage(message)},
		},
	}
}
