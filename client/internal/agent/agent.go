// Package agent is crha's non-privileged mode: it keeps a connection to crhs, runs tasks, streams their
// output and resumes after reconnects. It never replays a task: a task id it does not hold is unknown.
// See doc/execution-plane.md.
package agent

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"hash"
	"io"
	"log/slog"
	"math/rand/v2"
	"sync"
	"time"

	"github.com/Kodecable/ClusterRightHand/client/internal/executor"
	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
	"github.com/Kodecable/ClusterRightHand/client/internal/transport"
	"github.com/fxamacker/cbor/v2"
)

const (
	outputChunk = 32 << 10
	// The protocol obliges crha to ping at least every 45 s (crhs only answers); 30 s ± 5 s is the
	// recommended interval. crhs closes a connection after 90 s without a message, and so does crha,
	// since every ping is answered.
	pingInterval    = 30 * time.Second
	pingJitter      = 5 * time.Second
	pingTimeout     = 10 * time.Second
	idleTimeout     = 90 * time.Second
	maxConnLifetime = 24 * time.Hour // instead of Noise rekeying
	minBackoff      = time.Second
	maxBackoff      = time.Minute

	// defaultSpillBytes and defaultSpillLines are the single-task output thresholds from
	// doc/execution-plane.md#输出. Batch "text"/"status" tasks always spill; they use these only
	// as the memory thresholds when the output file cannot be created.
	defaultSpillBytes = 50 << 10
	defaultSpillLines = 2000
)

// maxAcceptedTasks bounds the process-wide set of task ids accepted at least once. It is a variable
// so tests can lower it.
var maxAcceptedTasks = 100_000

// ErrNodeRejected reports that crhs rejected this node during enrollment. Run returns it wrapped
// with crhs's node.status message.
var ErrNodeRejected = errors.New("node rejected by crhs")

// errReconnectNow asks Run to dial again without backoff: crhs just approved the node and is
// closing the restricted connection.
var errReconnectNow = errors.New("reconnect requested by crhs")

// nodeRejectedError wraps crhs's explanation in ErrNodeRejected, cleaning it for the terminal.
func nodeRejectedError(message string) error {
	if message == "" {
		return ErrNodeRejected
	}
	return fmt.Errorf("%w: %s", ErrNodeRejected, protocol.CleanText(message))
}

// nodeStatus records the last node.status event of one connection.
type nodeStatus struct {
	mu      sync.Mutex
	state   protocol.NodeStatusState
	message string
}

func (n *nodeStatus) set(st protocol.NodeStatus) {
	n.mu.Lock()
	n.state, n.message = st.State, st.Message
	n.mu.Unlock()
}

func (n *nodeStatus) get() (protocol.NodeStatusState, string) {
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.state, n.message
}

// handle validates and records a node.status event. A rejection is returned as an error so that
// Receive stops and the session ends immediately; active and disabled let the connection close.
func (n *nodeStatus) handle(body cbor.RawMessage) error {
	var st protocol.NodeStatus
	if err := protocol.Unmarshal(body, &st); err != nil {
		return err
	}
	n.set(st)
	if st.State == protocol.NodeStatusRejected {
		return nodeRejectedError(st.Message)
	}
	return nil
}

// rejectionError turns the internal protocol error that carried ErrNodeRejected back into the clean
// error returned by Run.
func rejectionError(err error, ns *nodeStatus) error {
	if err == nil || !errors.Is(err, ErrNodeRejected) {
		return err
	}
	_, message := ns.get()
	return nodeRejectedError(message)
}

// Options configure the agent. Dial is called for every connection attempt.
type Options struct {
	Dial      func(ctx context.Context) (*transport.Conn, error)
	Facts     func() protocol.Facts
	OutputDir string
	Logger    *slog.Logger
	// PrivilegedMode is reported in Hello; privileged tasks are rejected until M4.
	PrivilegedMode string
}

type Agent struct {
	opts Options
	log  *slog.Logger

	mu    sync.Mutex
	tasks map[string]*task
	// accepted holds every task id ever accepted in this process, including ids whose task exited
	// and was acknowledged. acceptedOrder is the FIFO order for eviction at maxAcceptedTasks.
	accepted      map[string]struct{}
	acceptedOrder []string
	kick          chan struct{}
	// The current active connection, for RefreshFacts and Reconnect.
	conn *transport.Conn
	peer *protocol.Peer
}

type task struct {
	id     string
	spec   *protocol.TaskStart
	output *executor.Output
	cancel context.CancelFunc
	// runCtx and in are kept so launch can start the executor after the accepting session is gone.
	runCtx context.Context
	in     io.Reader
	// started is guarded by a.mu and set by the one launch that starts the task. The success
	// response usually launches it, but when that response cannot be sent the session-end sweep
	// does, so both can race and launch must be idempotent.
	started bool
	// suppressOutput withholds task.output events for batch "status" tasks, which deliver only
	// task.exit (with the real stream ends) and the output file.
	suppressOutput bool

	// TaskInput chunks for the executor (stdin or file content), fed by a goroutine so that a slow
	// reader never blocks the receive loop.
	inputCh   chan []byte
	inputOff  uint64
	inputSize uint64
	inputHash protocol.Hash
	hasher    hash.Hash

	done   bool
	result *protocol.TaskExit

	// Per connection: how far output has been sent, and whether TaskExit went out. The indexes are
	// executor.StreamIndex values (stdout, stderr).
	sent     [executor.StreamSlots]uint64
	exitSent bool
}

func New(opts Options) *Agent {
	if opts.Logger == nil {
		opts.Logger = slog.Default()
	}
	return &Agent{
		opts:     opts,
		log:      opts.Logger,
		tasks:    map[string]*task{},
		accepted: map[string]struct{}{},
		kick:     make(chan struct{}, 1),
	}
}

// Run connects and reconnects until ctx is cancelled or crhs rejects this node. Running tasks survive
// disconnects.
func (a *Agent) Run(ctx context.Context) error {
	backoff := minBackoff
	for ctx.Err() == nil {
		conn, err := a.opts.Dial(ctx)
		if err != nil {
			var he *transport.HandshakeError
			if errors.As(err, &he) {
				a.log.Error("crhs rejected the connection", "err", err)
			} else {
				a.log.Warn("connect failed", "err", err)
			}
		} else {
			backoff = minBackoff
			start := time.Now()
			err := a.session(ctx, conn)
			a.log.Info("disconnected", "err", err, "after", time.Since(start).Round(time.Second))
			if errors.Is(err, ErrNodeRejected) {
				return err
			}
			if errors.Is(err, errReconnectNow) {
				continue
			}
		}
		// Full jitter keeps a fleet from reconnecting in lockstep after a crhs restart.
		wait := time.Duration(rand.Int64N(int64(backoff))) + backoff/2
		select {
		case <-ctx.Done():
		case <-time.After(wait):
		}
		backoff = min(backoff*2, maxBackoff)
	}
	return ctx.Err()
}

func (a *Agent) session(ctx context.Context, conn *transport.Conn) error {
	ctx, cancel := context.WithTimeout(ctx, maxConnLifetime)
	defer cancel()
	defer conn.Close("bye")

	if conn.Response.NodeState == protocol.NodePending {
		return a.pendingSession(ctx, conn)
	}
	a.log.Info("connected", "node", conn.Response.NodeID, "clock_offset", conn.ClockOffset.Round(time.Millisecond))

	ns := &nodeStatus{}
	peer := a.newPeer(ctx, conn, ns, true)
	defer func() {
		// A task recorded in the accepted set whose success response could not be sent (the
		// connection dropped at that instant) is not started by Deferred.After: Peer calls After
		// only after the response frame was handed to the transport. crhs will not resend it; it
		// learns about the task from the next hello and expects its output and task.exit, so the
		// task must still run. Start every such task now that the peer is closed and no response
		// send is still in flight.
		peer.Close(nil)
		a.launchUnstarted()
	}()

	// The receive goroutine must run before the hello request: its response is processed there.
	errc := make(chan error, 3)
	go func() {
		err := a.receive(ctx, conn, peer)
		peer.Close(err)
		errc <- err
	}()

	var welcome protocol.Welcome
	if err := peer.Request(ctx, protocol.CmdHello, a.hello(), &welcome); err != nil {
		return rejectionError(err, ns)
	}
	a.resume(welcome.Acks)
	a.mu.Lock()
	a.conn, a.peer = conn, peer
	a.mu.Unlock()
	defer func() {
		a.mu.Lock()
		if a.conn == conn {
			a.conn, a.peer = nil, nil
		}
		a.mu.Unlock()
	}()
	if err := peer.Emit(protocol.EventFacts, a.facts(conn)); err != nil {
		return rejectionError(err, ns)
	}

	go func() { errc <- a.pump(ctx, peer) }()
	go func() { errc <- a.keepalive(ctx, peer) }()
	err := <-errc
	cancel()
	peer.Close(err)
	return rejectionError(err, ns)
}

// pendingSession waits for an administrator to approve the node. A restricted connection may only
// send facts and ping; crhs pushes node.status and then closes. "active" reconnects immediately,
// "disabled" backs off and "rejected" stops Run.
func (a *Agent) pendingSession(ctx context.Context, conn *transport.Conn) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	a.log.Info("waiting for approval on crhs", "node", conn.Response.NodeID)

	ns := &nodeStatus{}
	peer := a.newPeer(ctx, conn, ns, false)
	defer peer.Close(nil)

	errc := make(chan error, 2)
	go func() {
		err := a.receive(ctx, conn, peer)
		peer.Close(err)
		errc <- err
	}()
	go func() { errc <- a.keepalive(ctx, peer) }()

	if err := peer.Emit(protocol.EventFacts, a.facts(conn)); err != nil {
		return rejectionError(err, ns)
	}
	err := <-errc
	if errors.Is(err, ErrNodeRejected) {
		return rejectionError(err, ns)
	}
	if state, _ := ns.get(); state == protocol.NodeStatusActive {
		return errReconnectNow
	}
	return err
}

// newPeer builds the protocol peer for one connection and registers the handlers. Restricted
// connections only need node.status; active ones handle tasks and their acknowledgements.
func (a *Agent) newPeer(ctx context.Context, conn *transport.Conn, ns *nodeStatus, tasks bool) *protocol.Peer {
	peer := protocol.NewPeer(func(frame []byte) error { return conn.Send(ctx, frame) }, conn.Negotiated)
	peer.HandleEvent(protocol.EventNodeStatus, ns.handle)
	if !tasks {
		return peer
	}
	peer.HandleRequest(protocol.CmdTaskStart, a.handleTaskStart)
	peer.HandleRequest(protocol.CmdTaskInput, a.handleTaskInput)
	peer.HandleRequest(protocol.CmdTaskCancel, a.handleTaskCancel)
	peer.HandleRequest(protocol.CmdTaskQuery, a.handleTaskQuery)
	peer.HandleEvent(protocol.EventOutputAck, a.handleOutputAck)
	peer.HandleEvent(protocol.EventTaskExitAck, a.handleTaskExitAck)
	return peer
}

func (a *Agent) receive(ctx context.Context, conn *transport.Conn, peer *protocol.Peer) error {
	for {
		rctx, cancel := context.WithTimeout(ctx, idleTimeout)
		frame, err := conn.Recv(rctx)
		cancel()
		if err != nil {
			return err
		}
		if err := peer.Receive(frame); err != nil {
			return err
		}
	}
}

func (a *Agent) facts(conn *transport.Conn) protocol.Facts {
	var f protocol.Facts
	if a.opts.Facts != nil {
		f = a.opts.Facts()
	}
	f.ClockOffsetMS = protocol.Int(conn.ClockOffset.Milliseconds())
	return f
}

func (a *Agent) hello() protocol.Hello {
	a.mu.Lock()
	defer a.mu.Unlock()
	h := protocol.Hello{
		TaskKinds:      []string{"exec", "file.read", "file.write", "file.edit", "file.stat", "file.list"},
		PrivilegedMode: a.opts.PrivilegedMode,
	}
	for _, t := range a.tasks {
		h.Tasks = append(h.Tasks, t.status())
	}
	return h
}

func (t *task) status() protocol.TaskStatus {
	st := protocol.TaskRunning
	if t.done {
		st = protocol.TaskExited
	}
	return protocol.TaskStatus{
		TaskID:    t.id,
		State:     st,
		StdoutEnd: protocol.Uint(t.output.End(protocol.StreamStdout)),
		StderrEnd: protocol.Uint(t.output.End(protocol.StreamStderr)),
	}
}

// resume rewinds each task's send position to what crhs has acknowledged.
func (a *Agent) resume(acks []protocol.OutputAck) {
	a.mu.Lock()
	defer a.mu.Unlock()
	byID := map[string]protocol.OutputAck{}
	for _, ack := range acks {
		byID[ack.TaskID] = ack
	}
	for id, t := range a.tasks {
		ack, ok := byID[id]
		t.sent, t.exitSent = [executor.StreamSlots]uint64{}, false
		if ok {
			t.sent[executor.StreamIndex(protocol.StreamStdout)] = uint64(ack.StdoutOffset)
			t.sent[executor.StreamIndex(protocol.StreamStderr)] = uint64(ack.StderrOffset)
		}
	}
	a.wake()
}

func (a *Agent) wake() {
	select {
	case a.kick <- struct{}{}:
	default:
	}
}

// nextOutbound is one frame the pump should send.
type outbound struct {
	name string
	body any
}

// pump sends pending output, then TaskExit for finished tasks whose output is all sent.
func (a *Agent) pump(ctx context.Context, peer *protocol.Peer) error {
	for {
		for {
			ob := a.nextOutbound()
			if ob == nil {
				break
			}
			if err := peer.Emit(ob.name, ob.body); err != nil {
				return err
			}
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-a.kick:
		}
	}
}

func (a *Agent) nextOutbound() *outbound {
	a.mu.Lock()
	defer a.mu.Unlock()
	for _, t := range a.tasks {
		if !t.suppressOutput {
			for _, s := range [...]protocol.Stream{protocol.StreamStdout, protocol.StreamStderr} {
				idx := executor.StreamIndex(s)
				if t.sent[idx] >= t.output.End(s) {
					continue
				}
				data, err := t.output.ReadAt(s, t.sent[idx], outputChunk)
				if err != nil || len(data) == 0 {
					// Lost output (memory cap without a spill file): skip it; TaskExit's ends tell crhs.
					a.log.Warn("output lost", "task", t.id, "stream", s, "err", err)
					t.sent[idx] = t.output.End(s)
					continue
				}
				off := t.sent[idx]
				t.sent[idx] += uint64(len(data))
				return &outbound{name: protocol.EventTaskOutput, body: protocol.TaskOutput{
					TaskID: t.id, Stream: s, Offset: protocol.Uint(off), Data: data,
				}}
			}
		}
		if t.done && !t.exitSent && t.exitReady() {
			t.exitSent = true // resent after every reconnect until acknowledged
			return &outbound{name: protocol.EventTaskExit, body: t.result}
		}
	}
	return nil
}

// exitReady reports whether every output byte task.exit reports has been sent. Batch "status" tasks
// send no output at all, so their exit is ready as soon as the task is done. a.mu must be held.
func (t *task) exitReady() bool {
	if t.suppressOutput {
		return true
	}
	return t.sent[executor.StreamIndex(protocol.StreamStdout)] >= uint64(t.result.StdoutEnd) &&
		t.sent[executor.StreamIndex(protocol.StreamStderr)] >= uint64(t.result.StderrEnd)
}

func (a *Agent) keepalive(ctx context.Context, peer *protocol.Peer) error {
	timer := time.NewTimer(nextPing())
	defer timer.Stop()
	var seq protocol.Uint
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-timer.C:
			timer.Reset(nextPing())
			seq++
			rctx, cancel := context.WithTimeout(ctx, pingTimeout)
			var pong protocol.Ping
			err := peer.Request(rctx, protocol.CmdPing, protocol.Ping{Seq: seq}, &pong)
			cancel()
			if err != nil {
				return fmt.Errorf("ping: %w", err)
			}
			if pong.Seq != seq {
				return fmt.Errorf("ping: response seq %d, want %d", pong.Seq, seq)
			}
		}
	}
}

func nextPing() time.Duration {
	return pingInterval - pingJitter + rand.N(2*pingJitter+1)
}

func (a *Agent) handleTaskStart(ctx context.Context, body cbor.RawMessage) (any, error) {
	var ts protocol.TaskStart
	if err := protocol.Unmarshal(body, &ts); err != nil {
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
	reject := func(code, message string) (any, error) {
		return nil, &protocol.RemoteError{Code: code, Message: message}
	}
	if ts.TaskID == "" {
		return reject("invalid_spec", "task id must not be empty")
	}
	// A malformed sha256 cannot reach here: protocol.Hash decodes to exactly 32 bytes.
	a.mu.Lock()
	_, dup := a.accepted[ts.TaskID]
	a.mu.Unlock()
	if dup {
		return reject("already_accepted", "task "+ts.TaskID+" was already accepted")
	}
	if ts.Privileged {
		return reject("privileged_unsupported", "privileged tasks are not supported by this crha")
	}
	if err := checkTaskKind(ts.Spec); err != nil {
		return nil, err
	}

	t := &task{
		id:             ts.TaskID,
		spec:           ts,
		output:         executor.NewOutput(ts.TaskID, a.opts.OutputDir, outputOptions(ts.Output)),
		suppressOutput: ts.Output.Kind == protocol.OutputStatus,
	}
	var in io.Reader
	if ref := inputRef(&ts.Spec); ref != nil {
		r, w := io.Pipe()
		in = r
		t.inputSize, t.inputHash, t.hasher = uint64(ref.Size), ref.SHA256, sha256.New()
		// Room for every chunk crhs may send (it sends <= 48 KiB chunks), so queuing never blocks
		// while holding a.mu; the input itself is bounded by crhs.
		t.inputCh = make(chan []byte, min(ref.Size/(16<<10)+2, 1<<14))
		go feed(w, t.inputCh)
		if ref.Size == 0 {
			close(t.inputCh)
		}
	}
	runCtx, cancel := context.WithCancel(context.Background()) // tasks outlive connections
	t.cancel, t.runCtx, t.in = cancel, runCtx, in
	a.mu.Lock()
	a.acceptLocked(t.id)
	a.tasks[t.id] = t
	a.mu.Unlock()
	// The peer may have been closed while this request was handled, and the sweep after the session
	// ends may already have run without seeing this task: the response cannot be sent any more
	// (Close sets the peer closed before it cancels its context), so start the task here. While the
	// peer is still live, either the response is sent and After starts the task, or the send fails
	// and the session's sweep starts it.
	if ctx.Err() != nil {
		a.launch(t)
	}
	return protocol.Deferred{Body: protocol.Empty{}, After: func() { a.launch(t) }}, nil
}

// launch starts a task's forwarding and execution goroutines exactly once. Deferred.After calls it
// when the success response was sent; the session-end sweep and start's closed-peer check call it
// when it was not. Those callers can race, so started is checked and set under a.mu and only the
// winner starts the goroutines: a double start would run the task twice.
func (a *Agent) launch(t *task) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if t.started {
		return
	}
	t.started = true
	go a.forward(t)
	go a.execute(t.runCtx, t, t.in)
}

// launchUnstarted starts accepted tasks that no success response started, because the response
// frame could not be sent and Peer therefore never called Deferred.After. A session calls it after
// closing its peer; an already started task is skipped, and one racing its After is protected by
// launch.
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

// acceptLocked records a task id in the accepted set, evicting the oldest id beyond maxAcceptedTasks.
// a.mu must be held.
func (a *Agent) acceptLocked(id string) {
	a.accepted[id] = struct{}{}
	a.acceptedOrder = append(a.acceptedOrder, id)
	for len(a.acceptedOrder) > maxAcceptedTasks {
		oldest := a.acceptedOrder[0]
		a.acceptedOrder = a.acceptedOrder[1:]
		delete(a.accepted, oldest)
	}
}

// checkTaskKind rejects a task whose kind this agent does not implement. A decoded TaskSpec always
// has a body for its kind; the nil checks guard programmatic input.
func checkTaskKind(spec protocol.TaskSpec) *protocol.RemoteError {
	invalid := &protocol.RemoteError{Code: "invalid_spec", Message: "task spec has no body"}
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
		return &protocol.RemoteError{Code: "unsupported_kind", Message: fmt.Sprintf("unsupported task kind %q", spec.Kind)}
	}
	return nil
}

// outputOptions returns the executor output configuration for a TaskStart. "full" carries its spill
// thresholds on the wire; batch "text" and "status" tasks always write the full output to the node
// file, so task.exit carries its path even when the output is empty. See
// doc/execution-plane.md#输出.
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

func (a *Agent) handleTaskInput(_ context.Context, body cbor.RawMessage) (any, error) {
	var in protocol.TaskInput
	if err := protocol.Unmarshal(body, &in); err != nil {
		return nil, err
	}
	return a.input(&in)
}

// input queues a TaskInput chunk. Chunks arrive in order on one connection; a reconnect mid-input
// cannot be resumed (crhs sends the start once), so the executor then sees a short input and fails.
func (a *Agent) input(in *protocol.TaskInput) (any, error) {
	tooLarge := func(size uint64) (any, error) {
		return nil, &protocol.RemoteError{
			Code:    "input_too_large",
			Message: fmt.Sprintf("task %s input exceeds the declared %d bytes", in.TaskID, size),
		}
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	t := a.tasks[in.TaskID]
	if t == nil {
		return nil, &protocol.RemoteError{Code: "unknown_task", Message: "unknown task " + in.TaskID}
	}
	if uint64(in.Offset) != t.inputOff {
		return nil, &protocol.RemoteError{
			Code:    "input_out_of_order",
			Message: fmt.Sprintf("task %s input offset %d, want %d", in.TaskID, in.Offset, t.inputOff),
		}
	}
	if t.inputCh == nil || t.inputOff >= t.inputSize {
		// The task declared no input, or it is already complete: only an empty chunk is harmless.
		if len(in.Data) == 0 {
			return protocol.Empty{}, nil
		}
		return tooLarge(t.inputSize)
	}
	if t.inputOff+uint64(len(in.Data)) > t.inputSize {
		t.inputOff += uint64(len(in.Data))
		t.inputCh <- nil // poison: input longer than declared
		close(t.inputCh)
		return tooLarge(t.inputSize)
	}
	t.inputOff += uint64(len(in.Data))
	_, _ = t.hasher.Write(in.Data)
	if t.inputOff == t.inputSize && !bytes.Equal(t.hasher.Sum(nil), t.inputHash[:]) {
		t.inputCh <- nil
	} else {
		t.inputCh <- in.Data
	}
	if t.inputOff >= t.inputSize {
		close(t.inputCh)
	}
	return protocol.Empty{}, nil
}

// feed copies queued input into the executor's pipe. A nil chunk aborts the input.
func feed(w *io.PipeWriter, ch <-chan []byte) {
	for chunk := range ch {
		if chunk == nil {
			w.CloseWithError(errors.New("input does not match its declared size and hash"))
			for range ch {
			}
			return
		}
		if _, err := w.Write(chunk); err != nil {
			for range ch { // the executor stopped reading; drain
			}
			return
		}
	}
	_ = w.Close()
}

func (a *Agent) handleTaskCancel(_ context.Context, body cbor.RawMessage) (any, error) {
	var c protocol.TaskCancel
	if err := protocol.Unmarshal(body, &c); err != nil {
		return nil, err
	}
	a.mu.Lock()
	if t := a.tasks[c.TaskID]; t != nil && !t.done {
		t.cancel()
	}
	a.mu.Unlock()
	return protocol.Empty{}, nil
}

func (a *Agent) handleTaskQuery(_ context.Context, body cbor.RawMessage) (any, error) {
	var q protocol.TaskQuery
	if err := protocol.Unmarshal(body, &q); err != nil {
		return nil, err
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if t := a.tasks[q.TaskID]; t != nil {
		return t.status(), nil
	}
	return protocol.TaskStatus{TaskID: q.TaskID, State: protocol.TaskUnknown}, nil
}

// handleOutputAck accepts and ignores an output acknowledgement; crhs may not send it yet.
func (a *Agent) handleOutputAck(body cbor.RawMessage) error {
	var ack protocol.OutputAck
	return protocol.Unmarshal(body, &ack)
}

func (a *Agent) handleTaskExitAck(body cbor.RawMessage) error {
	var ack protocol.TaskExitAck
	if err := protocol.Unmarshal(body, &ack); err != nil {
		return err
	}
	a.mu.Lock()
	if t := a.tasks[ack.TaskID]; t != nil && t.done {
		t.output.Release()
		delete(a.tasks, t.id)
	}
	// The id stays in the accepted set: a duplicate task.start is still refused.
	a.mu.Unlock()
	return nil
}

// forward turns output notifications into pump wake-ups.
func (a *Agent) forward(t *task) {
	for range t.output.Notify() {
		a.wake()
		a.mu.Lock()
		done := t.done
		a.mu.Unlock()
		if done {
			return
		}
	}
}

func (a *Agent) execute(ctx context.Context, t *task, in io.Reader) {
	exit := &protocol.TaskExit{TaskID: t.id}
	switch t.spec.Spec.Kind {
	case protocol.TaskSpecExec:
		res := executor.RunExec(ctx, t.spec.Spec.Exec, in, t.output, executor.ExecOptions{
			Timeout:   time.Duration(t.spec.TimeoutMS) * time.Millisecond,
			KillGrace: time.Duration(t.spec.KillGraceMS) * time.Millisecond,
		})
		exit.TimedOut, exit.Cancelled = res.TimedOut, res.Cancelled
		switch {
		case res.Err != nil:
			exit.Outcome = protocol.Outcome{
				Kind:  protocol.OutcomeError,
				Error: &protocol.Error{Code: res.Err.Code, Message: protocol.CleanText(res.Err.Message)},
			}
		case res.Signal != "":
			exit.Outcome = protocol.Outcome{Kind: protocol.OutcomeSignal, Signal: protocol.CleanText(res.Signal)}
		default:
			exit.Outcome = protocol.Outcome{Kind: protocol.OutcomeCode, Code: protocol.Int(*res.ExitCode)}
		}
	default:
		err := executor.RunFile(ctx, &t.spec.Spec, in, t.output.Writer(protocol.StreamStdout))
		var e *executor.Error
		switch {
		case err == nil:
			exit.Outcome = protocol.Outcome{Kind: protocol.OutcomeCode, Code: 0}
		case errors.As(err, &e):
			exit.Outcome = protocol.Outcome{
				Kind:  protocol.OutcomeError,
				Error: &protocol.Error{Code: e.Code, Message: protocol.CleanText(e.Message)},
			}
			exit.Cancelled = e.Code == "cancelled"
		default:
			exit.Outcome = protocol.Outcome{
				Kind:  protocol.OutcomeError,
				Error: &protocol.Error{Code: "io_error", Message: protocol.CleanText(err.Error())},
			}
		}
	}
	if pr, ok := in.(*io.PipeReader); ok {
		_ = pr.CloseWithError(errors.New("task finished")) // unblocks feed
	}
	t.output.Close()
	exit.StdoutEnd = protocol.Uint(t.output.End(protocol.StreamStdout))
	exit.StderrEnd = protocol.Uint(t.output.End(protocol.StreamStderr))
	exit.OutputFile = protocol.CleanText(t.output.Path())

	a.mu.Lock()
	t.done, t.result = true, exit
	a.mu.Unlock()
	a.wake()
}

// OutputFilesInUse lists the spill files of tasks still held (running, or exit not yet acknowledged),
// which the output janitor must keep.
func (a *Agent) OutputFilesInUse() map[string]bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	inUse := map[string]bool{}
	for _, t := range a.tasks {
		if p := t.output.Path(); p != "" {
			inUse[p] = true
		}
	}
	return inUse
}

// RefreshFacts reports facts again on the current connection, e.g. after a reload changed the groups.
func (a *Agent) RefreshFacts(_ context.Context) error {
	a.mu.Lock()
	conn, peer := a.conn, a.peer
	a.mu.Unlock()
	if peer == nil {
		return nil // sent on the next connection anyway
	}
	return peer.Emit(protocol.EventFacts, a.facts(conn))
}

// Reconnect drops the current connection; Run dials again (with the current dial settings).
func (a *Agent) Reconnect() {
	a.mu.Lock()
	conn := a.conn
	a.mu.Unlock()
	if conn != nil {
		_ = conn.Close("reconnecting after reload")
	}
}
