package agent

import (
	"context"
	"errors"
	"io"
	"time"

	"github.com/Kodecable/ClusterRightHand/client/internal/executor"
	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
	"github.com/Kodecable/ClusterRightHand/client/internal/taskinput"
)

// localRun executes the task in this process with the executor. Every unprivileged task runs this
// way, and so does a privileged task whose agent ignores the privileged flag.
type localRun struct {
	// queue is the task's input stream, nil when the task declared no input.
	queue *executor.Input
}

// newLocalRun returns the local runner of ts, with its input stream ready for the receive loop.
func newLocalRun(ts *protocol.TaskStart) *localRun {
	r := &localRun{}
	if ref := taskinput.Ref(&ts.Spec); ref != nil {
		r.queue = executor.NewInput()
		if ref.Size == 0 {
			r.queue.Close()
		}
	}
	return r
}

// prepare does nothing: a local task needs no owner outside this process.
func (r *localRun) prepare(*Agent, context.Context, *task) error { return nil }

// registered does nothing: nobody else needs to know the task exists.
func (r *localRun) registered(*Agent, *task) {}

func (r *localRun) start(a *Agent, t *task) {
	// A task without input must pass a nil io.Reader, not a typed nil *executor.Input: the executor
	// would call Read on it.
	var in io.Reader
	if r.queue != nil {
		in = r.queue
	}
	go a.execute(t.runCtx, t, in)
}

// input queues the chunk for the executor's reader.
func (r *localRun) input(a *Agent, _ context.Context, t *task, in *protocol.TaskInput) (any, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	res := a.acceptInput(t, in)
	if res.Data != nil {
		r.queue.Push(in.Data)
		if res.Complete {
			r.queue.Close()
		}
	}
	if res.Refusal != nil {
		return nil, res.Refusal
	}
	return protocol.Empty{}, nil
}

func (r *localRun) inputComplete(*task) bool { return r.queue == nil || r.queue.Complete() }

// failInput wakes a blocked reader so the executor notices the cancellation, then cancels the task.
func (r *localRun) failInput(_ *Agent, t *task, message string) {
	if r.queue != nil {
		r.queue.Fail(errors.New(message))
	}
	t.cancel()
}

// cancel stops the task. A file.write blocked in its input read only notices the cancellation through
// the reader, and the read error must not mask it: cancel first, then wake the reader.
func (r *localRun) cancel(_ *Agent, _ context.Context, t *task) {
	t.cancel()
	if r.queue != nil {
		r.queue.Fail(errors.New("task cancelled"))
	}
}

// query cannot answer: the agent holds the task's state itself.
func (r *localRun) query(*Agent, context.Context, protocol.TaskQuery) (protocol.TaskStatus, bool) {
	return protocol.TaskStatus{}, false
}

// finished does nothing: execute records the task's exit itself.
func (r *localRun) finished(*task) {}

// execute runs a local task with the executor and records its exit.
func (a *Agent) execute(ctx context.Context, t *task, in io.Reader) {
	exit := &protocol.TaskExit{TaskID: t.id}
	res := executor.RunTask(ctx, &t.spec.Spec, in, t.output, executor.TaskOptions{
		Timeout:   time.Duration(t.spec.TimeoutMS) * time.Millisecond,
		KillGrace: time.Duration(t.spec.KillGraceMS) * time.Millisecond,
		Env:       a.opts.Env,
	})
	exit.TimedOut, exit.Cancelled, exit.Outcome = res.TimedOut, res.Cancelled, res.Outcome()
	exit.Result = res.TaskResult
	if q, ok := in.(*executor.Input); ok {
		q.Discard() // unblocks a reader the executor left behind
	}
	t.output.Close()
	exit.StdoutEnd = protocol.Uint(t.output.End(protocol.StreamStdout))
	exit.StderrEnd = protocol.Uint(t.output.End(protocol.StreamStderr))
	exit.OutputFile = protocol.CleanText(t.output.Path())

	a.mu.Lock()
	if t.inputErr != nil {
		// The input, not the process, decided this task: a process may have consumed a truncated
		// stdin and exited successfully, or a file.write may report the cancellation that only
		// accompanied the input failure.
		exit.Outcome = protocol.Outcome{
			Kind:  protocol.OutcomeError,
			Error: &protocol.Error{Code: t.inputErr.Code, Message: protocol.ErrorMessage(t.inputErr.Message)},
		}
		exit.Cancelled = false
		// The input decided this task: a result the executor produced would contradict the failure.
		exit.Result = nil
	}
	t.done, t.result = true, exit
	a.mu.Unlock()
	a.wake()
}
