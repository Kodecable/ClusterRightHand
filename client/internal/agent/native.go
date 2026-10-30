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
	"github.com/fxamacker/cbor/v2"
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

// nativeConn is the crh-priv connection to the helper of one accepted native task.
type nativeConn struct {
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	stream *wire.Stream
	log    *slog.Logger
	// inputs queues the task.input chunks and task.cancel for one forwarding goroutine.
	inputs *nativeInputQueue
	// events buffers task.output and task.exit until the task is accepted and its handlers exist.
	events *bufferedEvents

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
		events:   newBufferedEvents(protocol.EventTaskOutput, protocol.EventTaskExit),
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
	for _, name := range []string{protocol.EventTaskOutput, protocol.EventTaskExit} {
		peer.HandleEvent(name, n.events.handler(name))
	}
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

// nativeRun watches the helper's stream and completes the task. It starts after the task is
// accepted and its handlers exist, which is also when the buffered events are replayed.
func (a *Agent) nativeRun(t *task) {
	n := t.native
	err := n.events.attach(map[string]protocol.EventHandler{
		protocol.EventTaskOutput: a.nativeOutput(t),
		protocol.EventTaskExit:   a.nativeExit(t),
	})
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
		a.nativeLost(t, n.loopErr)
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

// nativeLost completes a native task whose helper connection broke before task.exit.
func (a *Agent) nativeLost(t *task, err error) {
	message := "the native helper disconnected before task.exit"
	if err != nil && !errors.Is(err, io.EOF) {
		message = err.Error()
	}
	a.finishRelayed(t, helperLostExit(t.id, message))
}

// nativeOutput writes the helper's output into the task's own executor.Output, so the spill file,
// resume after a reconnect and the acknowledgements keep working unchanged.
func (a *Agent) nativeOutput(t *task) protocol.EventHandler {
	return func(body cbor.RawMessage) error {
		var out protocol.TaskOutput
		if err := protocol.Unmarshal(body, &out); err != nil {
			return err
		}
		if out.TaskID != t.id {
			return fmt.Errorf("native helper sent output for task %q, want %q", out.TaskID, t.id)
		}
		return a.relayOutput(t, &out)
	}
}

func (a *Agent) nativeExit(t *task) protocol.EventHandler {
	return func(body cbor.RawMessage) error {
		var exit protocol.TaskExit
		if err := protocol.Unmarshal(body, &exit); err != nil {
			return err
		}
		if exit.TaskID != t.id {
			return fmt.Errorf("native helper sent task.exit for %q, want %q", exit.TaskID, t.id)
		}
		a.finishRelayed(t, &exit)
		return nil
	}
}

// nativeForward sends the queued task.input chunks and task.cancel to the helper, in order. It never
// waits from the receive loop: a slow or broken helper must not hold up crhs's other frames.
func (a *Agent) nativeForward(t *task) {
	n := t.native
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

// bufferedEvents holds the helper's task.output and task.exit events that arrive before the task is
// accepted and its real handlers are attached. The read loop must run before the forwarded
// task.start is awaited, and the helper may already send output while the task is being accepted.
type bufferedEvents struct {
	mu       sync.Mutex
	handlers map[string]protocol.EventHandler
	pending  []bufferedEvent
}

type bufferedEvent struct {
	name string
	body cbor.RawMessage
}

func newBufferedEvents(names ...string) *bufferedEvents {
	b := &bufferedEvents{handlers: make(map[string]protocol.EventHandler, len(names))}
	for _, name := range names {
		b.handlers[name] = nil
	}
	return b
}

// handler buffers the event until attach installs the real one.
func (b *bufferedEvents) handler(name string) protocol.EventHandler {
	return func(body cbor.RawMessage) error {
		b.mu.Lock()
		defer b.mu.Unlock()
		if h := b.handlers[name]; h != nil {
			return h(body)
		}
		b.pending = append(b.pending, bufferedEvent{name: name, body: body})
		return nil
	}
}

// attach installs the real handlers and replays the buffered events in arrival order.
func (b *bufferedEvents) attach(handlers map[string]protocol.EventHandler) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	for name, h := range handlers {
		b.handlers[name] = h
	}
	pending := b.pending
	b.pending = nil
	for _, e := range pending {
		if h := b.handlers[e.name]; h != nil {
			if err := h(e.body); err != nil {
				return err
			}
		}
	}
	return nil
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
