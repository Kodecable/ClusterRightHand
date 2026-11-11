// Package agent is crha's non-privileged mode: it keeps a connection to crhs, runs tasks, streams their
// output and resumes after reconnects. It never replays a task: a task id it does not hold is unknown.
// See doc/design/execution.md.
package agent

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"math/rand/v2"
	"sync"
	"sync/atomic"
	"time"

	"github.com/Kodecable/ClusterRightHand/client/internal/config"
	"github.com/Kodecable/ClusterRightHand/client/internal/execenv"
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
	// doc/design/execution.md "Output". Batch "text"/"status" tasks always spill; they use these only
	// as the memory thresholds when the output file cannot be created.
	defaultSpillBytes = 50 << 10
	defaultSpillLines = 2000
)

// maxAcceptedTasks bounds the process-wide set of task ids accepted at least once. It is a variable
// so tests can lower it.
var maxAcceptedTasks = 16_384

// ErrNodeRejected reports that crhs rejected this node during enrollment. Run returns it wrapped
// with crhs's node.status message.
var ErrNodeRejected = errors.New("node rejected by crhs")

// errReconnectNow asks Run to dial again without backoff: crhs just approved the node and is
// closing the restricted connection.
var errReconnectNow = errors.New("reconnect requested by crhs")

// nodeRejectedError wraps crhs's explanation in ErrNodeRejected, sanitizing and bounding it for the
// terminal.
func nodeRejectedError(message string) error {
	if message == "" {
		return ErrNodeRejected
	}
	return fmt.Errorf("%w: %s", ErrNodeRejected, protocol.ErrorMessage(message))
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
// Receive stops and the session ends immediately; active lets the connection close.
func (n *nodeStatus) handle(body cbor.RawMessage) error {
	var st protocol.NodeStatus
	if err := protocol.UnmarshalBody(body, &st); err != nil {
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
	// PrivilegedMode is the [privileged] mode from the configuration and is reported in Hello:
	// reject, ignore, forward or native (doc/design/privilege.md). An empty mode behaves like reject.
	PrivilegedMode string
	// NativePrefix is the argv prefix that runs the native helper as the target identity, for
	// example ["sudo", "-n"]; the helper's executable and "privileged stdio" are appended. It is
	// empty when no escalation tool runs the helper directly, which is only useful to tests (there
	// the helper is this very binary) and to deployments where crha already runs as the target user.
	NativePrefix []string
	// NativeTimeout bounds spawning the escalation tool, the crh-priv handshake and the forwarded
	// task.start. 0 = DefaultNativeTimeout.
	NativeTimeout time.Duration
	// PrivilegedSocket is the [privileged] socket of forward mode: the unix socket the
	// privileged mode listens on. It is unused in the other modes.
	PrivilegedSocket string
	// ForwardRequestTimeout bounds every request to the privileged mode in forward mode. The
	// daemon answers from memory, so a slower answer means it is wedged; the request then fails
	// instead of blocking the peer's request worker. 0 = DefaultForwardRequestTimeout.
	ForwardRequestTimeout time.Duration
	// ClockWarn is the [clock_warn] threshold: after every successful crhs handshake a clock
	// offset larger than it is logged as a warning. 0 disables the warning.
	ClockWarn time.Duration
	// Env is the task environment resolved when `crha run` started (execenv.Resolve). nil resolves it
	// per task, which only tests and programmatic callers do.
	Env *execenv.Environment
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
	// cancelTombstones holds the ids of tasks cancelled before this agent knew them, with the time
	// they were recorded; cancelTombstoneOrder is the FIFO order for eviction at maxCancelTombstones.
	cancelTombstones     map[string]time.Time
	cancelTombstoneOrder []cancelTombstone
	kick                 chan struct{}
	// The current active connection, for RefreshFacts and Reconnect.
	conn *transport.Conn
	peer *protocol.Peer

	// forwardStarted guards startForward so the daemon connection is dialed once per process.
	forwardStarted atomic.Bool
	// fwd is the crh-priv connection to the privileged mode (forward mode), nil while it is
	// down; fwdErr is the reason.
	fwdMu  sync.Mutex
	fwd    *forwardConn
	fwdErr error
	// relay routes the daemon's task events to their tasks, and trust tracks the trust report
	// crhs was told.
	relay *relayRouter
	trust trustReporter
}

func New(opts Options) *Agent {
	if opts.Logger == nil {
		opts.Logger = slog.Default()
	}
	a := &Agent{
		opts:             opts,
		log:              opts.Logger,
		tasks:            map[string]*task{},
		accepted:         map[string]struct{}{},
		cancelTombstones: map[string]time.Time{},
		kick:             make(chan struct{}, 1),
		relay:            newRelayRouter(),
	}
	if opts.PrivilegedMode == config.ModeForward {
		// The first connection attempt has not finished yet; crhs must not wait for it.
		a.trust.report = unavailableReport(nil)
	} else {
		a.trust.report = protocol.TrustReport{Kind: protocol.TrustReportNotForward}
	}
	a.trust.have = true
	return a
}

// Run connects and reconnects until ctx is cancelled or crhs rejects this node. Running tasks survive
// disconnects.
func (a *Agent) Run(ctx context.Context) error {
	if a.opts.PrivilegedMode == config.ModeForward {
		a.startForward(ctx)
	}
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

	a.checkClock(conn)
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
		a.abortIncompleteInputs()
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
	// The trust report follows the hello response, once per connection (doc/design/protocol.md "Trust summary").
	a.announceTrust()
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
	// Wait for the remaining goroutines before returning: an old pump could otherwise run
	// nextOutbound after the next connection's resume and corrupt a task's send position.
	for range 2 {
		<-errc
	}
	return rejectionError(err, ns)
}

// pendingSession waits for an administrator to approve the node. A restricted connection may only
// send facts and ping; crhs pushes node.status and then closes. "active" reconnects immediately and
// "rejected" stops Run.
func (a *Agent) pendingSession(ctx context.Context, conn *transport.Conn) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	a.log.Info("waiting for approval on crhs", "node", conn.Response.NodeID)

	ns := &nodeStatus{}
	peer := a.newPeer(ctx, conn, ns, false)
	defer peer.Close(nil)

	errc := make(chan error, 2)
	recvdone := make(chan struct{})
	go func() {
		err := a.receive(ctx, conn, peer)
		peer.Close(err)
		errc <- err
		close(recvdone)
	}()
	go func() { errc <- a.keepalive(ctx, peer) }()

	if err := peer.Emit(protocol.EventFacts, a.facts(conn)); err != nil {
		return rejectionError(err, ns)
	}
	err := <-errc
	cancel()
	peer.Close(err)
	// crhs sends node.status{rejected} and closes at once, and the resulting receive error races the
	// keepalive error the close also produces. Wait for the receive goroutine so the recorded node
	// status decides, instead of reconnecting on whichever error came first.
	<-recvdone
	if state, message := ns.get(); state == protocol.NodeStatusRejected {
		return nodeRejectedError(message)
	}
	if state, _ := ns.get(); state == protocol.NodeStatusActive {
		return errReconnectNow
	}
	return err
}

// newPeer builds the protocol peer for one connection and registers the handlers. Restricted
// connections only need node.status; active ones handle tasks and their acknowledgements.
func (a *Agent) newPeer(ctx context.Context, conn *transport.Conn, ns *nodeStatus, tasks bool) *protocol.Peer {
	// The request worker keeps the receive loop reading while a handler waits: a forwarded
	// request can block on the privileged mode, and crhs's pong must still be processed
	// (doc/design/protocol.md "task.start"). Handlers still run one at a time, in arrival order.
	peer := protocol.NewPeer(func(frame []byte) error { return conn.Send(ctx, frame) }, conn.Negotiated,
		protocol.WithRequestWorker())
	peer.HandleEvent(protocol.EventNodeStatus, ns.handle)
	if !tasks {
		return peer
	}
	peer.HandleRequest(protocol.CmdLocalRequest, a.handleLocalRequest)
	peer.HandleRequest(protocol.CmdLocalWithdraw, a.handleLocalWithdraw)
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
	offset := protocol.Int(conn.ClockOffset.Milliseconds())
	f.ClockOffsetMS = &offset
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
		t.sent, t.exitSent = 0, false
		if ok {
			t.sent = uint64(ack.Offset)
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
			if err := a.send(peer, ob); err != nil {
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

// send emits one outbound event. A frame that cannot be encoded is a local failure: the connection
// is fine, so it must not end the session. task.exit falls back to an internal_error outcome and is
// retried once; a task.output chunk that cannot be encoded is dropped, since task.exit's end offsets
// tell crhs what it missed. Connection errors are still returned.
func (a *Agent) send(peer *protocol.Peer, ob *outbound) error {
	err := peer.Emit(ob.name, ob.body)
	var encodeErr *protocol.EncodeError
	if err == nil || !errors.As(err, &encodeErr) {
		return err
	}
	a.log.Warn("event could not be encoded", "event", ob.name, "err", err)
	exit, ok := ob.body.(*protocol.TaskExit)
	if ob.name != protocol.EventTaskExit || !ok {
		return nil
	}
	exit.Outcome = protocol.Outcome{
		Kind:  protocol.OutcomeError,
		Error: &protocol.Error{Code: protocol.CodeInternalError, Message: "task.exit could not be encoded"},
	}
	retryErr := peer.Emit(ob.name, ob.body)
	if retryErr == nil {
		return nil
	}
	if !errors.As(retryErr, &encodeErr) {
		return retryErr
	}
	a.log.Warn("task.exit could not be encoded", "task", exit.TaskID, "err", retryErr)
	return nil
}

func (a *Agent) nextOutbound() *outbound {
	a.mu.Lock()
	defer a.mu.Unlock()
	for _, t := range a.tasks {
		if !t.suppressOutput {
			if end := t.output.End(); t.sent < end {
				data, err := t.output.ReadAt(t.sent, outputChunk)
				if err != nil || len(data) == 0 {
					// Lost output (memory cap without a spill file): skip it; TaskExit's end tells crhs.
					a.log.Warn("output lost", "task", t.id, "err", err)
					t.sent = end
				} else {
					off := t.sent
					t.sent += uint64(len(data))
					return &outbound{name: protocol.EventTaskOutput, body: protocol.TaskOutput{
						TaskID: t.id, Offset: protocol.Uint(off), Data: data,
					}}
				}
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

// mode returns the configured privileged mode. An empty mode behaves like reject, which is also
// the configuration default (doc/design/privilege.md "Privilege modes").
func (a *Agent) mode() string {
	if a.opts.PrivilegedMode == "" {
		return config.ModeReject
	}
	return a.opts.PrivilegedMode
}

// checkClock logs a warning when the clock offset measured in the crhs handshake exceeds
// [clock_warn] (doc/design/privilege.md "Clock"). Nothing else depends on the offset.
func (a *Agent) checkClock(conn *transport.Conn) {
	threshold := a.opts.ClockWarn
	if threshold <= 0 {
		return
	}
	offset := conn.ClockOffset
	if offset > threshold || offset < -threshold {
		a.log.Warn("clock offset from crhs exceeds clock_warn",
			"offset", offset.Round(time.Millisecond), "threshold", threshold)
	}
}

// forward turns output notifications into pump wake-ups. execute closes the output when the
// task ends, which closes the notification channel and ends the range.
func (a *Agent) forward(t *task) {
	for range t.output.Notify() {
		a.wake()
	}
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

// RefreshFacts reports facts again on the current connection, e.g. after a reload changed the notes
// path.
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
