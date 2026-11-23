package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/Kodecable/ClusterRightHand/client/internal/executor"
	"github.com/Kodecable/ClusterRightHand/client/internal/privileged/helper"
	"github.com/Kodecable/ClusterRightHand/client/internal/privileged/wire"
	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
	"github.com/Kodecable/ClusterRightHand/client/internal/version"
)

// DefaultNativeTimeout bounds spawning the escalation tool, the crh-priv handshake and the forwarded
// task.start. A tool that needs a password fails at once with -n, but a misconfigured or hanging
// tool must not wedge the crhs request that waits for the answer.
const DefaultNativeTimeout = 10 * time.Second

const (
	// nativeStderrTail is how much of the helper's stderr is kept for a failure message.
	nativeStderrTail = 8 << 10
	// nativeLineMax bounds one unsent stderr line kept in memory.
	nativeLineMax = 4 << 10
)

// nativeRun executes one task through the privileged helper: the helper runs as the target identity,
// owns the process and the input accounting, and reports the task's events over its own crh-priv
// connection (doc/design/privilege.md "Native mode").
type nativeRun struct {
	// conn is the helper connection, set by prepare.
	conn *nativeConn
}

// prepare spawns the helper and forwards the task.start. The helper must accept the task before this
// agent does: a tool that cannot run (a password is required, no sudoers rule, a version mismatch)
// makes the task privileged_unsupported, never a fall back to unprivileged execution
// (doc/design/privilege.md "Native mode").
func (r *nativeRun) prepare(a *Agent, _ context.Context, t *task) error {
	n, err := a.startNative(t.spec)
	if err != nil {
		return &protocol.RemoteError{Code: protocol.CodePrivilegedUnsupported, Message: err.Error()}
	}
	r.conn = n
	return nil
}

// registered does nothing: the helper's events are buffered until start watches the stream.
func (r *nativeRun) registered(*Agent, *task) {}

// start watches the helper's stream and forwards the queued input to it.
func (r *nativeRun) start(a *Agent, t *task) {
	go r.run(a, t)
	go r.forward(a, t)
}

// abortTransfer ends a task whose helper was spawned but whose data connection never opened: the
// helper accepted the task and runs it, so the watcher and the forwarder must start for the cancel to
// reach it and for it to be reaped. Without them the queued cancel has no sender and the root helper
// runs until the node restarts (doc/design/privilege.md "Native mode").
func (r *nativeRun) abortTransfer(a *Agent, t *task) {
	r.start(a, t)
	// Queued here rather than left to the caller's goroutine: finished closes the queue, and a cancel
	// pushed after that is dropped without ever being sent.
	r.conn.inputs.pushCancel()
}

// input forwards the chunk to the helper, which owns the input accounting.
func (r *nativeRun) input(a *Agent, _ context.Context, t *task, in *protocol.TaskInput) (any, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	res := a.acceptInput(t, in)
	if res.Data != nil {
		r.conn.inputs.push(in)
	}
	if res.Refusal != nil {
		return nil, res.Refusal
	}
	return protocol.Empty{}, nil
}

// pushInput applies one chunk of a data-connection push and waits while its queue is full, so the
// helper's slower read applies backpressure to crhs instead of the node buffering a whole file.
func (r *nativeRun) pushInput(a *Agent, ctx context.Context, t *task, in *protocol.TaskInput) (any, error) {
	a.mu.Lock()
	res := a.acceptInput(t, in)
	a.mu.Unlock()
	if res.Refusal != nil {
		return nil, res.Refusal
	}
	if res.Data != nil {
		if err := r.conn.inputs.pushWait(ctx, in); err != nil {
			return nil, err
		}
	}
	return protocol.Empty{}, nil
}

// inputComplete reports the accounting this side keeps; the helper's verdict arrives with its
// task.exit.
func (r *nativeRun) inputComplete(t *task) bool { return t.input.Complete() }

// failInput fails the task's input through the helper, which owns the process.
func (r *nativeRun) failInput(*Agent, *task, string) { r.conn.inputs.pushCancel() }

// cancel asks the helper to cancel the task: the agent never signals it (doc/design/privilege.md "Native mode").
// The request is queued so it follows the input chunks already forwarded.
func (r *nativeRun) cancel(*Agent, context.Context, *task) { r.conn.inputs.pushCancel() }

// query cannot answer: the helper holds the task's state.
func (r *nativeRun) query(*Agent, context.Context, protocol.TaskQuery) (protocol.TaskStatus, bool) {
	return protocol.TaskStatus{}, false
}

// finished ends the helper's input queue and wakes its watcher once task.exit completed the task.
func (r *nativeRun) finished(*task) {
	r.conn.inputs.close()
	r.conn.signalDone()
}

// nativeConn is the crh-priv connection to the helper of one accepted native task.
type nativeConn struct {
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	stream *wire.Stream
	log    *slog.Logger
	// inputs queues the task.input chunks and task.cancel for one forwarding goroutine.
	inputs *nativeInputQueue
	// events buffers task.output and task.exit until the task is accepted and its handlers exist.
	// The read loop must run before the forwarded task.start is awaited, and the helper may
	// already send output while the task is being accepted.
	events *relayRouter

	// loopStarted says whether the stream read loop was started, so a failed start knows whether it
	// has to wait for the loop before reaping the process.
	loopStarted bool
	loopDone    chan struct{}
	loopErr     error

	// done is closed once the helper's task.exit has completed the task.
	done     chan struct{}
	doneOnce sync.Once
}

// startNative spawns the helper through the escalation tool, completes the crh-priv handshake and
// sends it the task.start, all within the native timeout. The agent accepts the task unless the
// helper refused it: a response lost after acceptance must not make crhs retry a task that may
// have run (doc/design/protocol.md "crh-priv").
func (a *Agent) startNative(ts *protocol.TaskStart) (*nativeConn, error) {
	h, err := a.launchNative(context.Background())
	if err != nil {
		return nil, err
	}
	argv, stderr := h.argv, h.stderr
	n := &nativeConn{
		cmd:      h.cmd,
		stdin:    h.stdin,
		log:      a.log,
		inputs:   newNativeInputQueue(),
		events:   newRelayRouter(),
		loopDone: make(chan struct{}),
		done:     make(chan struct{}),
	}
	n.stream = wire.NewStream(h.stdout, h.stdin, h.negotiated)
	peer := n.stream.Peer()
	output, transfer, exit := n.events.eventHandlers(func(string) string { return ts.TaskID })
	peer.HandleEvent(protocol.EventTaskOutput, output)
	peer.HandleEvent(wire.EventTransferData, transfer)
	peer.HandleEvent(protocol.EventTaskExit, exit)
	n.loopStarted = true
	go func() {
		n.loopErr = n.stream.Run()
		// Fail requests that are waiting for a response; the read loop is the only receiver.
		n.stream.Close(n.loopErr)
		close(n.loopDone)
	}()

	startCtx, cancel := context.WithTimeout(context.Background(), a.nativeTimeout())
	defer cancel()
	var empty protocol.Empty
	if err := peer.Request(startCtx, protocol.CmdTaskStart, *ts, &empty); err != nil {
		var remote *protocol.RemoteError
		if errors.As(err, &remote) {
			n.abort()
			return nil, nativeFailure(argv, stderr, err)
		}
		// The helper may have accepted the task before the response was lost (a timeout, a broken
		// stream), and it runs an accepted task even when its stdin closes. Refusing it here would
		// let crhs retry a task that may have run, so keep the helper and report the task accepted;
		// nativeRun delivers its events or ends it with helper_lost.
		n.log.Warn("the native helper did not answer task.start; treating the task as accepted",
			"task", ts.TaskID, "err", err)
		return n, nil
	}
	return n, nil
}

// nativeHelper is a started native helper whose crh-priv handshake completed.
type nativeHelper struct {
	argv       []string
	cmd        *exec.Cmd
	stdin      io.WriteCloser
	stdout     io.ReadCloser
	stderr     *nativeStderr
	negotiated protocol.Set
}

// launchNative starts the native helper and completes its handshake, for a task and for the readiness
// probe alike. A helper that fails the handshake is killed and reaped. ctx ends the process early.
func (a *Agent) launchNative(ctx context.Context) (*nativeHelper, error) {
	argv, err := a.nativeArgv()
	if err != nil {
		return nil, err
	}
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, fmt.Errorf("native helper stdin: %w", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		_ = stdin.Close()
		return nil, fmt.Errorf("native helper stdout: %w", err)
	}
	stderr := &nativeStderr{log: a.log}
	cmd.Stderr = stderr
	if err := cmd.Start(); err != nil {
		return nil, nativeFailure(argv, stderr, err)
	}
	// Bound the handshake with a read deadline on the helper's pipe: a tool that sits waiting for
	// something (a password on a terminal it does not have, a network lookup) never answers.
	deadline, ok := stdout.(interface{ SetReadDeadline(time.Time) error })
	if ok {
		_ = deadline.SetReadDeadline(time.Now().Add(a.nativeTimeout()))
	}
	_, negotiated, err := wire.ClientHandshake(stdout, stdin, wire.ClientOptions{
		Role:        wire.RoleNative,
		CRHAVersion: version.Version,
	})
	if err != nil {
		_ = stdin.Close()
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		return nil, nativeFailure(argv, stderr, err)
	}
	if ok {
		_ = deadline.SetReadDeadline(time.Time{})
	}
	return &nativeHelper{argv: argv, cmd: cmd, stdin: stdin, stdout: stdout, stderr: stderr, negotiated: negotiated}, nil
}

// abort tears down a helper whose start failed. It never accepted the task, so signalling it is
// fitting; the no-signal rule covers cancelling an accepted task.
func (n *nativeConn) abort() {
	_ = n.stdin.Close()
	if n.cmd.Process != nil {
		_ = n.cmd.Process.Kill()
	}
	if n.loopStarted {
		<-n.loopDone
	}
	_ = n.cmd.Wait()
}

// wait reaps the helper and reports an exit that is not a plain zero status.
func (n *nativeConn) wait() {
	if err := n.cmd.Wait(); err != nil {
		n.log.Warn("native helper exited", "err", err)
	}
}

// signalDone wakes nativeRun once the helper's task.exit completed the task.
func (n *nativeConn) signalDone() { n.doneOnce.Do(func() { close(n.done) }) }

func (a *Agent) nativeTimeout() time.Duration {
	if a.opts.NativeTimeout > 0 {
		return a.opts.NativeTimeout
	}
	return DefaultNativeTimeout
}

// nativeArgv is the command that runs the helper: the escalation tool followed by this binary's
// `privileged stdio`. The executable is absolute with symlinks resolved, so the sudoers or doas rule
// and the command match one path.
func (a *Agent) nativeArgv() ([]string, error) {
	exe, err := os.Executable()
	if err != nil {
		return nil, fmt.Errorf("locate the crha executable: %w", err)
	}
	exe, err = filepath.EvalSymlinks(exe)
	if err != nil {
		return nil, fmt.Errorf("resolve %s: %w", exe, err)
	}
	argv := append([]string(nil), a.opts.NativePrefix...)
	return append(argv, exe, "privileged", "stdio"), nil
}

// nativeFailure describes a failed native start, quoting the tool's stderr so the caller learns why
// (for example "sudo: a password is required").
func nativeFailure(argv []string, stderr *nativeStderr, err error) error {
	tool := "crha privileged stdio"
	if prefix := argv[:len(argv)-3]; len(prefix) > 0 {
		tool = strings.Join(prefix, " ")
	}
	msg := fmt.Sprintf("%s failed: %v", tool, err)
	if line := stderr.lastLine(); line != "" {
		msg += ": " + line
	}
	return errors.New(msg)
}

// run watches the helper's stream and completes the task. It starts after the task is accepted and
// its handlers exist, which is also when the buffered events are replayed.
func (r *nativeRun) run(a *Agent, t *task) {
	n := r.conn
	err := n.events.attach(t.id, a.relayTaskHandlers(t, "native helper"))
	if err != nil {
		// A malformed event is fatal for the connection: the helper cannot be trusted past it.
		n.stream.Close(err)
	}
	finished := false
	select {
	case <-n.loopDone:
	case <-n.done:
		// The helper reported the exit; close its stdin so it stops reading and exits.
		finished = true
		_ = n.stdin.Close()
		<-n.loopDone
	}
	if !a.taskDone(t) {
		r.lost(a, t, n.loopErr)
	}
	if finished || errors.Is(n.loopErr, io.EOF) {
		n.wait()
		return
	}
	// The stream broke while the helper may still be running the task: it finishes the task on its
	// own and writes the outcome to its local log (doc/design/privilege.md), so only reap it in the
	// background instead of waiting for a process that may run for minutes. Closing its stdin makes
	// it stop reading, and the broken pipe ends whatever output it still tries to send.
	_ = n.stdin.Close()
	go n.wait()
}

func (a *Agent) taskDone(t *task) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return t.done
}

// lost completes a native task whose helper connection broke before task.exit.
func (*nativeRun) lost(a *Agent, t *task, err error) {
	message := "the native helper disconnected before task.exit"
	if err != nil && !errors.Is(err, io.EOF) {
		message = err.Error()
	}
	a.finishRelayed(t, helperLostExit(t.id, message))
}

// forward sends the queued task.input chunks and task.cancel to the helper, in order. It never waits
// from the receive loop: a slow or broken helper must not hold up crhs's other frames.
func (r *nativeRun) forward(a *Agent, t *task) {
	n := r.conn
	for {
		req, ok := n.inputs.next()
		if !ok {
			return
		}
		var err error
		if req.input != nil {
			err = n.stream.Peer().Request(t.runCtx, protocol.CmdTaskInput, req.input, &protocol.Empty{})
		} else {
			err = n.stream.Peer().Request(t.runCtx, protocol.CmdTaskCancel, protocol.TaskCancel{TaskID: t.id}, &protocol.Empty{})
		}
		if err != nil {
			if !errors.Is(err, protocol.ErrClosed) && !errors.Is(err, context.Canceled) {
				a.log.Warn("native helper request failed", "task", t.id, "err", err)
			}
			return
		}
	}
}

// nativeStderr keeps the tail of the helper's stderr and logs its complete lines: the helper's local
// log arrives as JSON lines on its stderr pipe, which the parent turns into human-readable records,
// and a failed start quotes the tail in its error message.
type nativeStderr struct {
	log *slog.Logger

	mu   sync.Mutex
	buf  []byte
	line []byte
}

func (w *nativeStderr) Write(p []byte) (int, error) {
	var lines []string
	w.mu.Lock()
	w.buf = append(w.buf, p...)
	if len(w.buf) > nativeStderrTail {
		w.buf = append(w.buf[:0], w.buf[len(w.buf)-nativeStderrTail:]...)
	}
	w.line = append(w.line, p...)
	for {
		i := bytes.IndexByte(w.line, '\n')
		if i < 0 {
			break
		}
		text := strings.TrimSpace(string(w.line[:i]))
		w.line = w.line[i+1:]
		if text != "" {
			lines = append(lines, text)
		}
	}
	if len(w.line) > nativeLineMax {
		w.line = append(w.line[:0], w.line[len(w.line)-nativeLineMax:]...)
	}
	w.mu.Unlock()

	for _, line := range lines {
		if rec, ok := helper.ParseLogRecord(line); ok {
			w.log.Log(context.Background(), nativeLevel(rec), "native helper "+rec.Event, nativeAttrs(rec)...)
			continue
		}
		// Not the helper's log: the escalation tool's own message, a warning from sudo, or a line
		// the helper could not finish. Keep it readable and keep it out of the structured format.
		w.log.Warn("native helper stderr", "stderr", line)
	}
	return len(p), nil
}

// nativeLevel mirrors a helper record at Warn when the parent could not deliver the task's exit
// (the helper's failure event) or a privileged terminal was refused, and at Info otherwise.
func nativeLevel(rec helper.LogRecord) slog.Level {
	if rec.Event == "task.exit.undelivered" || rec.Event == "terminal.refused" {
		return slog.LevelWarn
	}
	return slog.LevelInfo
}

// nativeAttrs are the fields of a relayed helper record: the event's data, but never the time (the
// log line has one). The full spec is included, as raw JSON: native mode has no privileged daemon
// and no audit file, so this relayed line is the only record of what ran privileged
// (doc/design/privilege.md "Native mode").
func nativeAttrs(rec helper.LogRecord) []any {
	attrs := make([]any, 0, 9)
	if rec.TaskID != "" {
		attrs = append(attrs, "task_id", rec.TaskID)
	}
	if rec.PTYID != "" {
		attrs = append(attrs, "pty_id", rec.PTYID)
	}
	if rec.Attempt != 0 {
		attrs = append(attrs, "attempt", uint64(rec.Attempt))
	}
	if rec.Privileged {
		attrs = append(attrs, "privileged", true)
	}
	if rec.Outcome != "" {
		attrs = append(attrs, "outcome", rec.Outcome)
	}
	if rec.TimedOut {
		attrs = append(attrs, "timed_out", true)
	}
	if rec.Cancelled {
		attrs = append(attrs, "cancelled", true)
	}
	if rec.OutputEnd != 0 {
		attrs = append(attrs, "output_end", uint64(rec.OutputEnd))
	}
	if rec.DurationMS != 0 {
		attrs = append(attrs, "duration_ms", rec.DurationMS)
	}
	if rec.ExitCode != nil {
		attrs = append(attrs, "exit_code", *rec.ExitCode)
	}
	if rec.Code != "" {
		attrs = append(attrs, "code", rec.Code)
	}
	if rec.Detail != "" {
		attrs = append(attrs, "detail", rec.Detail)
	}
	if rec.Spec != nil {
		// Re-marshalling the parsed spec keeps the helper's JSON shape, and logging renders a
		// json.RawMessage verbatim instead of as one quoted Go string.
		if raw, err := json.Marshal(rec.Spec); err == nil {
			attrs = append(attrs, slog.Any("spec", json.RawMessage(raw)))
		} else {
			// A spec that cannot be encoded must still not disappear from the only record.
			attrs = append(attrs, "spec", rec.Spec)
		}
	}
	return attrs
}

// lastLine returns the last non-empty line captured from stderr, bounded for an error message.
func (w *nativeStderr) lastLine() string {
	w.mu.Lock()
	lines := strings.Split(string(w.buf), "\n")
	w.mu.Unlock()
	for i := len(lines) - 1; i >= 0; i-- {
		if s := strings.TrimSpace(lines[i]); s != "" {
			return protocol.ErrorMessage(s)
		}
	}
	return ""
}

// nativeInputQueue orders the task.input chunks and the task.cancel that the agent forwards to the
// helper. The receive loop must never block on the helper, because it also processes crhs's other
// frames, so one goroutine sends them one at a time from this queue.
type nativeInputQueue struct {
	mu   sync.Mutex
	cond *sync.Cond
	reqs []nativeRequest
	// bytes is how much task.input data the queue holds, for the push path's bound.
	bytes  int
	closed bool
}

// nativeRequest is one forwarded request: a task.input chunk, or a task.cancel when input is nil.
type nativeRequest struct{ input *protocol.TaskInput }

func newNativeInputQueue() *nativeInputQueue {
	q := &nativeInputQueue{}
	q.cond = sync.NewCond(&q.mu)
	return q
}

func (q *nativeInputQueue) push(in *protocol.TaskInput) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.closed {
		return
	}
	q.reqs = append(q.reqs, nativeRequest{input: in})
	q.bytes += len(in.Data)
	q.cond.Signal()
}

// pushWait queues a data-connection push's chunk, waiting while executor.MaxBufferedBytes are already
// queued so the helper's read pace bounds what this side holds. The forwarder releases it as it sends,
// and close or ctx ends the wait; a chunk that arrives after close is dropped.
func (q *nativeInputQueue) pushWait(ctx context.Context, in *protocol.TaskInput) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	stop := context.AfterFunc(ctx, func() {
		q.mu.Lock()
		q.cond.Broadcast()
		q.mu.Unlock()
	})
	defer stop()
	for q.bytes >= executor.MaxBufferedBytes && !q.closed && ctx.Err() == nil {
		q.cond.Wait()
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if q.closed {
		return nil
	}
	q.reqs = append(q.reqs, nativeRequest{input: in})
	q.bytes += len(in.Data)
	q.cond.Signal()
	return nil
}

func (q *nativeInputQueue) pushCancel() {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.closed {
		return
	}
	q.reqs = append(q.reqs, nativeRequest{})
	q.cond.Signal()
}

func (q *nativeInputQueue) close() {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.closed {
		return
	}
	q.closed = true
	q.cond.Broadcast()
}

// next blocks until a request is queued or the queue is closed.
func (q *nativeInputQueue) next() (nativeRequest, bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	for len(q.reqs) == 0 && !q.closed {
		q.cond.Wait()
	}
	if len(q.reqs) == 0 {
		return nativeRequest{}, false
	}
	req := q.reqs[0]
	q.reqs = q.reqs[1:]
	if req.input != nil {
		q.bytes -= len(req.input.Data)
	}
	// A data-connection push may be waiting for room.
	q.cond.Broadcast()
	return req, true
}
