package agent

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/Kodecable/ClusterRightHand/client/internal/config"
	"github.com/Kodecable/ClusterRightHand/client/internal/executor"
	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
	"github.com/Kodecable/ClusterRightHand/client/internal/taskinput"
	"github.com/fxamacker/cbor/v2"
)

// A task.cancel may reach crha before the task.start it is meant for: crhs claims a task before it
// sends it. The id of an unknown cancelled task is remembered for cancelTombstoneTTL, so a task.start
// that arrives afterwards is refused instead of running. maxCancelTombstones bounds the memory; the
// oldest entry is evicted when it is full.
const cancelTombstoneTTL = 10 * time.Minute

// maxCancelTombstones is a variable so tests can lower it.
var maxCancelTombstones = 1024

// cancelTombstone is one recorded cancellation, with the time it was recorded for expiry and for
// telling a stale order entry from a newer tombstone of the same id.
type cancelTombstone struct {
	id string
	at time.Time
}

// task is one accepted task. Its fields are the same for every mode; the mode that executes it, with
// that mode's state and code, is its taskRun.
type task struct {
	id     string
	spec   *protocol.TaskStart
	output *executor.Output
	cancel context.CancelFunc
	// runCtx is kept so launch can start the task after the accepting session is gone.
	runCtx context.Context
	// run executes the task in this agent's mode: locally, through a native helper or through the
	// privileged daemon.
	run taskRun
	// started is guarded by a.mu and set by the one launch that starts the task. The success
	// response usually launches it, but when that response cannot be sent the session-end sweep
	// does, so both can race and launch must be idempotent.
	started bool
	// suppressOutput withholds task.output events for batch "status" tasks, which deliver only
	// task.exit (with the real stream ends) and the output file.
	suppressOutput bool
	// transferDone says the task's data connection finished, so task.exit may be sent. A
	// file.push/file.pull task waits for it, because crhs must have the bytes before the exit
	// that commits them (doc/design/library.md "Data connections").
	transferDone bool
	// transferSend sends one chunk of a file.pull task's content on the data connection; it is
	// set before the task starts. closeTransfer closes the data connection.
	transferSend  func([]byte) error
	closeTransfer func()
	// transferReady is closed once transferSend is set.
	transferReady chan struct{}
	// doneCh is closed when done and result are set, so a transfer can wait without polling.
	doneCh   chan struct{}
	doneOnce sync.Once

	// input is the shared offset, size and SHA-256 accounting of the task's declared input.
	// inputErr records why an input failed and overrides the task's outcome.
	input    taskinput.Input
	inputErr *protocol.Error

	// finishOnce makes the one call that completes the task win: a native task can be finished by
	// the helper's task.exit and by the stream breaking at the same time.
	finishOnce sync.Once

	done   bool
	result *protocol.TaskExit

	// Per connection: how far the task's one output stream has been sent, and whether TaskExit went
	// out.
	sent     uint64
	exitSent bool
}

// taskRun is the mode-specific half of an accepted task: who executes it, where its input goes and
// how it is stopped. There is one implementation per mode: localRun executes the task in this
// process (execute.go), nativeRun through a privileged helper (native.go), and forwardRun in the
// privileged daemon over the crh-priv connection (forward.go). A runner is created before the task is
// registered and never changes afterwards, so the agent may read t.run under a.mu and call its
// methods after unlocking. Each method states whether it needs a.mu.
type taskRun interface {
	// prepare does the mode's work before the task is accepted: the native mode spawns the helper
	// and sends it the task.start, the forward mode relays the task.start to the daemon. It runs
	// without a.mu held and returns the refusal that leaves the task unaccepted.
	prepare(a *Agent, ctx context.Context, t *task) error
	// registered runs once the task is registered, before its response is sent: the forward mode
	// attaches its event handlers so no event of the task is lost. It runs without a.mu held.
	registered(a *Agent, t *task)
	// start begins execution, after the task.start response was sent or once the session ended
	// without sending it. It runs without a.mu held.
	start(a *Agent, t *task)
	// input applies one task.input chunk and returns the command's response body. It runs without
	// a.mu held.
	input(a *Agent, ctx context.Context, t *task, in *protocol.TaskInput) (any, error)
	// inputComplete reports whether every declared input byte arrived.
	inputComplete(t *task) bool
	// failInput stops the task after its input failed. It runs with a.mu held.
	failInput(a *Agent, t *task, message string)
	// cancel stops a running task for a task.cancel. It runs without a.mu held.
	cancel(a *Agent, ctx context.Context, t *task)
	// query answers a task.query from the mode's owner when it can. It runs without a.mu held.
	query(a *Agent, ctx context.Context, q protocol.TaskQuery) (protocol.TaskStatus, bool)
	// finished does the mode's cleanup once the task's exit is recorded. It runs without a.mu held.
	finished(t *task)
}

// signalDone closes doneCh once, when the task's outcome is recorded.
func (t *task) signalDone() { t.doneOnce.Do(func() { close(t.doneCh) }) }

// emitTransfer sends one chunk of a pull task's content on the data connection, if the transfer
// goroutine has attached one. A missing connection is a cancelled transfer.
func (a *Agent) emitTransfer(t *task, data []byte) error {
	a.mu.Lock()
	send := t.transferSend
	a.mu.Unlock()
	if send == nil {
		return errors.New("the data connection is not open")
	}
	return send(data)
}

// relayTransfer handles one transfer.data event of a privileged pull task: it waits for the data
// connection (opened once crhs answered the task.start) and sends the chunk on it. The event stream
// is ordered, so the wait cannot reorder chunks.
func (a *Agent) relayTransfer(t *task, chunk *protocol.TaskOutput) error {
	a.mu.Lock()
	ready, send := t.transferReady, t.transferSend
	a.mu.Unlock()
	if send == nil {
		select {
		case <-ready:
		case <-t.runCtx.Done():
			return nil
		}
		a.mu.Lock()
		send = t.transferSend
		a.mu.Unlock()
	}
	if send == nil {
		return errors.New("the data connection is not open")
	}
	return send(chunk.Data)
}

func (t *task) status() protocol.TaskStatus {
	st := protocol.TaskRunning
	if t.done {
		st = protocol.TaskExited
	}
	return protocol.TaskStatus{
		TaskID:    t.id,
		State:     st,
		OutputEnd: protocol.Uint(t.output.End()),
	}
}

// exitReady reports whether every output byte task.exit reports has been sent. Batch "status" tasks
// send no output at all, so their exit is ready as soon as the task is done. a.mu must be held.
func (t *task) exitReady() bool {
	if !t.transferDone {
		return false
	}
	if t.suppressOutput {
		return true
	}
	return t.sent >= uint64(t.result.OutputEnd)
}

// inputComplete reports whether every declared input byte arrived, or the task has no input at all.
func (t *task) inputComplete() bool { return t.run.inputComplete(t) }

func (a *Agent) handleTaskStart(ctx context.Context, body cbor.RawMessage) (any, error) {
	var ts protocol.TaskStart
	if err := protocol.UnmarshalBody(body, &ts); err != nil {
		return nil, err
	}
	return a.start(ctx, &ts)
}

// start validates and accepts a task. It records the id in the accepted set before returning, so an
// accepted task is never forgotten, and defers starting the task's goroutines until the success
// response has gone out, so no task event can precede it. If that response cannot be sent, After
// never runs; the task is still executed, since crhs already committed to it, and the session's
// deferred sweep or the closed-peer check below starts it.
func (a *Agent) start(ctx context.Context, ts *protocol.TaskStart) (any, error) {
	if ts.TaskID == "" {
		return nil, &protocol.RemoteError{Code: protocol.CodeInvalidSpec, Message: "task id must not be empty"}
	}
	// A malformed sha256 cannot reach here: protocol.Hash decodes to exactly 32 bytes.
	a.mu.Lock()
	cancelled := a.takeCancelledLocked(ts.TaskID)
	_, dup := a.accepted[ts.TaskID]
	if !dup {
		// An id whose entry was evicted must still be refused while its task is held: the
		// duplicate would otherwise overwrite a running task in a.tasks.
		_, dup = a.tasks[ts.TaskID]
	}
	a.mu.Unlock()
	if cancelled {
		return nil, &protocol.RemoteError{Code: protocol.CodeCancelled, Message: "the task was cancelled before it started"}
	}
	if dup {
		return nil, &protocol.RemoteError{Code: protocol.CodeAlreadyAccepted, Message: "task " + ts.TaskID + " was already accepted"}
	}
	// One transfer per node: a second one is refused with busy before it is accepted. crhs
	// schedules transfers, so this is a backstop (doc/design/library.md "Data connections").
	if isTransferKind(ts.Spec.Kind) && !a.claimTransfer() {
		return nil, &protocol.RemoteError{Code: protocol.CodeBusy, Message: "this node is already running a transfer"}
	}
	// The mode decides how the task runs. A privileged task this mode cannot run is refused before
	// an output file or an input stream is created for it.
	run, err := a.newRun(ts)
	if err != nil {
		a.releaseTransfer()
		return nil, err
	}
	if err := checkTaskKind(ts.Spec); err != nil {
		a.releaseTransfer()
		return nil, err
	}

	kind := ts.Spec.Kind
	t := &task{
		id:             ts.TaskID,
		spec:           ts,
		run:            run,
		output:         executor.NewOutput(ts.TaskID, a.opts.OutputDir, outputOptions(ts.Output)),
		suppressOutput: ts.Output.Kind == protocol.OutputStatus,
		transferDone:   !isTransferKind(kind),
		transferReady:  make(chan struct{}),
		doneCh:         make(chan struct{}),
	}
	if ref := taskinput.Ref(&ts.Spec); ref != nil {
		// A zero-size input still commits crhs to the SHA-256 of empty input. A different hash can
		// never match, so refuse the task before accepting it.
		if err := taskinput.ValidateRef(ref); err != nil {
			a.releaseTransfer()
			return nil, err
		}
		t.input = taskinput.New(ref)
	}
	runCtx, cancel := context.WithCancel(context.Background()) // tasks outlive connections
	t.cancel, t.runCtx = cancel, runCtx
	if err := run.prepare(a, ctx, t); err != nil {
		cancel()
		a.releaseTransfer()
		return nil, err
	}
	a.mu.Lock()
	a.acceptLocked(t.id)
	a.tasks[t.id] = t
	a.mu.Unlock()
	run.registered(a, t)
	// The peer may have been closed while this request was handled, and the sweep after the session
	// ends may already have run without seeing this task: the response cannot be sent any more
	// (Close sets the peer closed before it cancels its context), so start the task here. While the
	// peer is still live, either the response is sent and After starts the task, or the send fails
	// and the session's sweep starts it.
	if ctx.Err() != nil {
		a.launch(t)
		// The peer is closed, so no task.input can follow on this connection: a task whose input
		// never completed cannot run to completion and would wait for a reader forever.
		a.mu.Lock()
		a.abortIncompleteInputLocked(t)
		a.mu.Unlock()
	}
	return protocol.Deferred{Body: protocol.Empty{}, After: func() { a.launch(t) }}, nil
}

// newRun returns the runner that executes ts in this agent's mode. A privileged task the mode does not
// support is refused here, before the task exists.
func (a *Agent) newRun(ts *protocol.TaskStart) (taskRun, error) {
	if !ts.Privileged {
		return newLocalRun(ts), nil
	}
	switch a.mode() {
	case config.ModeIgnore:
		// Ignore the privileged flag and run the task as crha's own user.
		return newLocalRun(ts), nil
	case config.ModeNative:
		return &nativeRun{}, nil
	case config.ModeForward:
		return &forwardRun{}, nil
	default:
		return nil, &protocol.RemoteError{Code: protocol.CodePrivilegedUnsupported, Message: "privileged tasks are not supported by this crha"}
	}
}

// checkTaskKind rejects a task whose kind this agent does not implement. A decoded TaskSpec always
// has a body for its kind; the nil checks guard programmatic input.
func checkTaskKind(spec protocol.TaskSpec) *protocol.RemoteError {
	invalid := &protocol.RemoteError{Code: protocol.CodeInvalidSpec, Message: "task spec has no body"}
	switch spec.Kind {
	case protocol.TaskSpecExec:
		if spec.Exec == nil {
			return invalid
		}
	case protocol.TaskSpecFileRead:
		if spec.FileRead == nil {
			return invalid
		}
	case protocol.TaskSpecFileWrite:
		if spec.FileWrite == nil {
			return invalid
		}
	case protocol.TaskSpecFilePush:
		if spec.FilePush == nil {
			return invalid
		}
	case protocol.TaskSpecFilePull:
		if spec.FilePull == nil {
			return invalid
		}
	case protocol.TaskSpecFileEdit:
		if spec.FileEdit == nil {
			return invalid
		}
	case protocol.TaskSpecFileStat:
		if spec.FileStat == nil {
			return invalid
		}
	case protocol.TaskSpecFileList:
		if spec.FileList == nil {
			return invalid
		}
	default:
		// Cannot happen after decoding; keep the guard for a future kind this build does not know.
		return &protocol.RemoteError{Code: protocol.CodeUnsupportedKind, Message: fmt.Sprintf("unsupported task kind %q", spec.Kind)}
	}
	return nil
}

// outputOptions returns the executor output configuration for a TaskStart. "full" carries its spill
// thresholds on the wire; batch "text" and "status" tasks always write the full output to the node
// file, so task.exit carries its path even when the output is empty. See
// doc/design/execution.md "Output".
func outputOptions(mode protocol.OutputMode) executor.OutputOptions {
	switch mode.Kind {
	case protocol.OutputFull:
		return executor.OutputOptions{SpillBytes: uint64(mode.SpillBytes), SpillLines: uint64(mode.SpillLines)}
	case protocol.OutputText, protocol.OutputStatus:
		return executor.OutputOptions{
			SpillBytes:  defaultSpillBytes,
			SpillLines:  defaultSpillLines,
			AlwaysSpill: true,
		}
	default:
		return executor.OutputOptions{}
	}
}

func (a *Agent) handleTaskInput(ctx context.Context, body cbor.RawMessage) (any, error) {
	var in protocol.TaskInput
	if err := protocol.UnmarshalBody(body, &in); err != nil {
		return nil, err
	}
	return a.input(ctx, &in)
}

// input applies one task.input chunk. The mode owns the accounting: the local and native modes check
// it against the declaration here, while a forwarded task relays the chunk to the privileged daemon,
// which owns it, and only tracks how much arrived.
func (a *Agent) input(ctx context.Context, in *protocol.TaskInput) (any, error) {
	a.mu.Lock()
	t := a.tasks[in.TaskID]
	a.mu.Unlock()
	if t == nil {
		return nil, &protocol.RemoteError{Code: protocol.CodeUnknownTask, Message: "unknown task " + in.TaskID}
	}
	return t.run.input(a, ctx, t, in)
}

// acceptInput applies the shared input accounting of one chunk and records the failure it finds. It is
// the input path of the modes that check the input themselves; a.mu must be held.
func (a *Agent) acceptInput(t *task, in *protocol.TaskInput) taskinput.ChunkResult {
	res := t.input.Accept(t.id, in)
	if res.Failure != nil {
		a.failInputLocked(t, res.Failure.Code, res.Failure.Message)
	}
	return res
}

// failInputLocked records why a task's input failed and stops the task: the queue failure unblocks a
// reader the executor left waiting, and the mode stops the process. The first input error wins. a.mu
// must be held.
func (a *Agent) failInputLocked(t *task, code, message string) {
	if t.inputErr == nil {
		t.inputErr = &protocol.Error{Code: code, Message: message}
	}
	t.run.failInput(a, t, message)
}

// abortIncompleteInputs fails every task whose input never completed. A connection that ends before
// all task.input chunks arrived cannot resume the input, so those tasks fail with input_incomplete;
// the queue failure and the cancel also unblock a reader the executor left waiting. A session calls
// it once its peer is closed, after launching accepted tasks that never started.
func (a *Agent) abortIncompleteInputs() {
	a.mu.Lock()
	defer a.mu.Unlock()
	for _, t := range a.tasks {
		a.abortIncompleteInputLocked(t)
	}
}

// abortIncompleteInputLocked aborts the input of one task if it declared one that never completed
// and the task is still running. a.mu must be held.
func (a *Agent) abortIncompleteInputLocked(t *task) {
	if t.done || t.inputComplete() {
		return
	}
	a.failInputLocked(t, protocol.CodeInputIncomplete, "connection closed before the task input was complete")
}

// handleTaskCancel stops a running task. A cancel for a task this agent does not know is recorded:
// the task.start may still be on its way, and running it after a cancel would execute a command crhs
// already gave up on.
func (a *Agent) handleTaskCancel(ctx context.Context, body cbor.RawMessage) (any, error) {
	var c protocol.TaskCancel
	if err := protocol.UnmarshalBody(body, &c); err != nil {
		return nil, err
	}
	a.mu.Lock()
	t := a.tasks[c.TaskID]
	running := t != nil && !t.done
	if t == nil {
		// A task this agent accepted once is known even after its exit; only a truly unknown id needs
		// the tombstone that refuses a task.start still on its way.
		if _, known := a.accepted[c.TaskID]; !known {
			a.tombstoneCancelledLocked(c.TaskID)
		}
	}
	a.mu.Unlock()
	if running {
		t.run.cancel(a, ctx, t)
		a.mu.Lock()
		closeTransfer := t.closeTransfer
		a.mu.Unlock()
		if closeTransfer != nil {
			closeTransfer()
		}
	}
	return protocol.Empty{}, nil
}

// tombstoneCancelledLocked records the cancel of a task this agent does not know. a.mu must be held.
func (a *Agent) tombstoneCancelledLocked(id string) {
	if _, ok := a.cancelTombstones[id]; ok {
		return
	}
	at := time.Now()
	a.cancelTombstones[id] = at
	a.cancelTombstoneOrder = append(a.cancelTombstoneOrder, cancelTombstone{id: id, at: at})
	for len(a.cancelTombstoneOrder) > maxCancelTombstones {
		oldest := a.cancelTombstoneOrder[0]
		a.cancelTombstoneOrder = a.cancelTombstoneOrder[1:]
		if current, ok := a.cancelTombstones[oldest.id]; ok && current.Equal(oldest.at) {
			delete(a.cancelTombstones, oldest.id)
		}
	}
}

// takeCancelledLocked reports whether the id was cancelled before this agent knew the task, and
// forgets the tombstone: the task.start is refused once, and a later start of the same id is judged on
// its own. An expired tombstone no longer counts. a.mu must be held.
func (a *Agent) takeCancelledLocked(id string) bool {
	at, ok := a.cancelTombstones[id]
	if !ok {
		return false
	}
	delete(a.cancelTombstones, id)
	return time.Since(at) < cancelTombstoneTTL
}

func (a *Agent) handleTaskQuery(ctx context.Context, body cbor.RawMessage) (any, error) {
	var q protocol.TaskQuery
	if err := protocol.UnmarshalBody(body, &q); err != nil {
		return nil, err
	}
	a.mu.Lock()
	t := a.tasks[q.TaskID]
	a.mu.Unlock()
	if t != nil {
		if status, ok := t.run.query(a, ctx, q); ok {
			return status, nil
		}
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if t != nil {
		return t.status(), nil
	}
	return protocol.TaskStatus{TaskID: q.TaskID, State: protocol.TaskUnknown}, nil
}

// handleOutputAck accepts and ignores an output acknowledgement; crhs may not send it yet.
func (a *Agent) handleOutputAck(body cbor.RawMessage) error {
	var ack protocol.OutputAck
	return protocol.UnmarshalBody(body, &ack)
}

func (a *Agent) handleTaskExitAck(body cbor.RawMessage) error {
	var ack protocol.TaskExitAck
	if err := protocol.UnmarshalBody(body, &ack); err != nil {
		return err
	}
	a.mu.Lock()
	if t := a.tasks[ack.TaskID]; t != nil && t.done {
		t.output.Release()
		delete(a.tasks, t.id)
	}
	// The id stays in the accepted set: a duplicate task.start is still refused.
	a.mu.Unlock()
	a.relay.discard(ack.TaskID)
	return nil
}

// launch starts a task's forwarding and execution exactly once. Deferred.After calls it when the
// success response was sent; the session-end sweep and start's closed-peer check call it when it was
// not. Those callers can race, so started is checked and set under a.mu and only the winner starts the
// task: a double start would run the task twice.
func (a *Agent) launch(t *task) {
	a.mu.Lock()
	if t.started {
		a.mu.Unlock()
		return
	}
	t.started = true
	run := t.run
	a.mu.Unlock()
	go a.forward(t)
	if isTransferKind(t.spec.Spec.Kind) {
		// A transfer opens its data connection first and starts the runner itself.
		go a.transfer(t)
		return
	}
	run.start(a, t)
}

// launchUnstarted starts accepted tasks that no success response started, because the response frame
// could not be sent and Peer therefore never called Deferred.After. A session calls it after closing
// its peer; an already started task is skipped, and one racing its After is protected by launch.
func (a *Agent) launchUnstarted() {
	a.mu.Lock()
	pending := make([]*task, 0, len(a.tasks))
	for _, t := range a.tasks {
		if !t.started {
			pending = append(pending, t)
		}
	}
	a.mu.Unlock()
	for _, t := range pending {
		a.launch(t)
	}
}

// acceptLocked records a task id in the accepted set, evicting the oldest ids beyond
// maxAcceptedTasks. An id whose task is still held is never evicted: a duplicate task.start for it
// must still be refused, and dropping it would let the duplicate overwrite the running task in
// a.tasks. Such an id is moved to the back of the queue and reconsidered once its task is gone, so
// the set can temporarily stay above the bound while tasks run. a.mu must be held.
func (a *Agent) acceptLocked(id string) {
	a.accepted[id] = struct{}{}
	a.acceptedOrder = append(a.acceptedOrder, id)
	// The scan is bounded by the length of the queue: if every id names a held task, none can be
	// evicted and the set simply stays above its bound until tasks finish.
	for budget := len(a.acceptedOrder); len(a.acceptedOrder) > maxAcceptedTasks && budget > 0; budget-- {
		oldest := a.acceptedOrder[0]
		a.acceptedOrder = a.acceptedOrder[1:]
		if _, live := a.tasks[oldest]; live {
			a.acceptedOrder = append(a.acceptedOrder, oldest)
			continue
		}
		delete(a.accepted, oldest)
	}
}
