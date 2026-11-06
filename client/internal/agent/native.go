package agent

import (
	"bytes"
	"context"
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
// connection (doc/privilege.md "native").
type nativeRun struct {
	// conn is the helper connection, set by prepare.
	conn *nativeConn
}

// prepare spawns the helper and forwards the task.start. The helper must accept the task before this
// agent does: a tool that cannot run (a password is required, no sudoers rule, a version mismatch)
// makes the task privileged_unsupported, never a fall back to unprivileged execution
// (doc/privilege.md "native").
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

// inputComplete reports the accounting this side keeps; the helper's verdict arrives with its
// task.exit.
func (r *nativeRun) inputComplete(t *task) bool { return t.input.Complete() }

// failInput fails the task's input through the helper, which owns the process.
func (r *nativeRun) failInput(*Agent, *task, string) { r.conn.inputs.pushCancel() }

// cancel asks the helper to cancel the task: the agent never signals it (doc/privilege.md, native).
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
// have run (doc/protocol.md crh-priv 断开).
func (a *Agent) startNative(ts *protocol.TaskStart) (*nativeConn, error) {
	argv, err := a.nativeArgv()
	if err != nil {
		return nil, err
	}
	cmd := exec.Command(argv[0], argv[1:]...)
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
	n := &nativeConn{
		cmd:      cmd,
		stdin:    stdin,
		log:      a.log,
		inputs:   newNativeInputQueue(),
		events:   newRelayRouter(),
		loopDone: make(chan struct{}),
		done:     make(chan struct{}),
	}

	// Bound the handshake with a read deadline on the helper's pipe: a tool that sits waiting for
	// something (a password on a terminal it does not have, a network lookup) never answers.
	if d, ok := stdout.(interface{ SetReadDeadline(time.Time) error }); ok {
		_ = d.SetReadDeadline(time.Now().Add(a.nativeTimeout()))
	}
	_, negotiated, err := wire.ClientHandshake(stdout, stdin, wire.ClientOptions{
		Role:        wire.RoleNative,
		CRHAVersion: version.Version,
	})
	if err != nil {
		n.abort()
		return nil, nativeFailure(argv, stderr, err)
	}
	if d, ok := stdout.(interface{ SetReadDeadline(time.Time) error }); ok {
		_ = d.SetReadDeadline(time.Time{})
	}

	n.stream = wire.NewStream(stdout, stdin, negotiated)
	peer := n.stream.Peer()
	output, exit := n.events.eventHandlers(func(string) string { return ts.TaskID })
	peer.HandleEvent(protocol.EventTaskOutput, output)
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
		// stream), and it runs an accepted task even when its stdin closes (doc/protocol.md
		// crh-priv 断开). Refusing it here would let crhs retry a task that may have run, so keep
		// the helper and report the task accepted; nativeRun delivers its events or ends it with
		// helper_lost.
		n.log.Warn("the native helper did not answer task.start; treating the task as accepted",
			"task", ts.TaskID, "err", err)
		return n, nil
	}
	return n, nil
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
// and the command match one path (doc/privilege.md, native).
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
	// own and writes the outcome to its local log (doc/privilege.md), so only reap it in the
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

// nativeStderr keeps the tail of the helper's stderr and logs its complete lines: the parent
// relays the helper's local JSON log into its own log (doc/protocol.md, native helper), and a
// failed start quotes the tail in its error message.
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
		w.log.Info("native helper", "stderr", line)
	}
	return len(p), nil
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
	mu     sync.Mutex
	cond   *sync.Cond
	reqs   []nativeRequest
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
	q.cond.Signal()
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
	return req, true
}
