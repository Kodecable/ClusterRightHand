package agent

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/Kodecable/ClusterRightHand/client/internal/config"
	"github.com/Kodecable/ClusterRightHand/client/internal/privileged/wire"
	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
	"github.com/Kodecable/ClusterRightHand/client/internal/pty"
	"github.com/Kodecable/ClusterRightHand/client/internal/transport"
	"github.com/fxamacker/cbor/v2"
)

// ptyMinBackoff and ptyMaxBackoff are the terminal data connection's redial delays. They are
// variables so tests do not wait a second for the first retry (doc/design/pty.md "crha").
var (
	ptyMinBackoff = time.Second
	ptyMaxBackoff = 30 * time.Second
)

var (
	// errPTYPeerEnded means crhs sent [end] or [abort]: only the data connection ends.
	errPTYPeerEnded = errors.New("crhs ended the terminal data connection")
	// errPTYBehind means the connection read slower than the ring buffer wrapped: its next byte is
	// already gone, so it must be replaced by a fresh replay.
	errPTYBehind = errors.New("terminal output fell behind the ring buffer")
)

// ptyControl is the control connection the terminal data connections belong to. crhs accepts a
// terminal data connection only while a control connection is up (doc/design/protocol.md "Data
// connections").
type ptyControl struct {
	ctx        context.Context
	peer       *protocol.Peer
	negotiated protocol.Set
}

// ptyWorker keeps one terminal's data connection: it dials after pty.open, replays the ring,
// forwards live output and input, and redials with backoff while the terminal exists and a
// control connection is up.
type ptyWorker struct {
	term   *pty.Terminal
	cancel context.CancelFunc
	done   chan struct{}
}

// ptyState is the agent's terminal state. It lives in its own struct so agent.go stays about the
// control connection and tasks.
type ptyState struct {
	mgr    *pty.Manager
	root   context.Context
	cancel context.CancelFunc

	mu      sync.Mutex
	ctrl    *ptyControl
	workers map[string]*ptyWorker
	// relayed holds the terminals whose process runs in the privileged mode, keyed by terminal id,
	// from before pty.open is sent until the manager drops the terminal: over the shared forward
	// connection, or over the native helper started for that terminal.
	relayed map[string]*relayPTY
	// wake is a broadcast: wakePTYLocked closes it and installs a fresh channel, so every worker
	// waiting on the old one wakes, not just one of them.
	wake    chan struct{}
	closing bool
}

// initPTY builds the terminal manager and the per-terminal data connection bookkeeping.
func (a *Agent) initPTY(opts Options) {
	s := &a.pty
	s.root, s.cancel = context.WithCancel(context.Background())
	s.mgr = pty.NewManager(pty.Options{
		Env:    opts.Env,
		Logger: opts.Logger,
		OnExit: a.onPTYExit,
		OnDrop: a.onPTYDrop,
	})
	s.workers = map[string]*ptyWorker{}
	s.relayed = map[string]*relayPTY{}
	s.wake = make(chan struct{})
}

// handlePTYOpen starts a terminal and, once the empty response is on the wire, its data
// connection loop (doc/design/pty.md "crha"). An ordinary terminal runs here; a privileged one
// runs in the privileged mode and is relayed (doc/design/pty.md "Privilege").
func (a *Agent) handlePTYOpen(ctx context.Context, body cbor.RawMessage) (any, error) {
	var req protocol.PTYOpen
	if err := protocol.UnmarshalBody(body, &req); err != nil {
		return nil, err
	}
	if req.Privileged {
		return a.openPrivilegedPTY(ctx, req)
	}
	t, err := a.pty.mgr.Open(pty.OpenRequest{
		ID:              req.PTYID,
		Argv:            req.Argv,
		Rows:            uint64(req.Rows),
		Cols:            uint64(req.Cols),
		ScrollbackBytes: uint64(req.ScrollbackBytes),
		Meta:            req.Meta,
	})
	if err != nil {
		return nil, err
	}
	return protocol.Deferred{Body: protocol.Empty{}, After: func() { a.startPTYWorker(t, false) }}, nil
}

// openPrivilegedPTY relays a privileged pty.open over the node's privileged channel and registers
// the accepted terminal as a relayed one: the same object as a local terminal, with its output
// coming from pty.output events and its input, size and close going back over the same channel
// (doc/design/pty.md "Privilege"). Forward mode uses the shared daemon connection; native mode
// starts one helper for this terminal. The pty.open has the 30-second timeout of a forwarded
// task.start; a timeout asks the privileged side to close the terminal and answers crhs helper_lost.
func (a *Agent) openPrivilegedPTY(ctx context.Context, req protocol.PTYOpen) (any, error) {
	// Validate the size like an unprivileged open, before anything is launched or forwarded.
	if err := pty.ValidateOpen(req.PTYID, uint64(req.Rows), uint64(req.Cols)); err != nil {
		return nil, err
	}
	var ch privChannel
	switch a.mode() {
	case config.ModeForward:
		fc, ferr := a.forwardConnection()
		if fc == nil {
			return nil, forwardUnavailable(ferr)
		}
		if !fc.negotiated.Has(wire.CmdPTYOpen) {
			return nil, &protocol.RemoteError{
				Code:    protocol.CodePrivilegedUnsupported,
				Message: "the privileged mode does not implement pty.open",
			}
		}
		ch = forwardPTYChannel{a: a, fc: fc}
	case config.ModeNative:
		// Check the id before launching a helper the rest of the request might refuse.
		if a.pty.mgr.Get(req.PTYID) != nil {
			return nil, alreadyAcceptedTerminal(req.PTYID)
		}
		n, err := a.launchNativePTY()
		if err != nil {
			return nil, err
		}
		ch = n
	default:
		return nil, a.privilegedTerminalUnsupported()
	}
	return a.startRelayedPTY(ctx, ch, req)
}

// startRelayedPTY sends pty.open over ch and registers the terminal the privileged side accepts.
func (a *Agent) startRelayedPTY(ctx context.Context, ch privChannel, req protocol.PTYOpen) (any, error) {
	if a.pty.mgr.Get(req.PTYID) != nil {
		ch.Close()
		return nil, alreadyAcceptedTerminal(req.PTYID)
	}
	relay := newRelayPTY(a, ch, req.PTYID)
	if !a.registerRelayPTY(relay) {
		ch.Close()
		return nil, alreadyAcceptedTerminal(req.PTYID)
	}
	rctx, cancel := context.WithTimeout(ctx, a.forwardTimeout())
	defer cancel()
	// pty.open travels as crhs sent it: the terminal metadata and scrollback are the unprivileged
	// mode's, and the privileged side ignores them (doc/design/pty.md "Protocol additions").
	err := ch.Request(rctx, wire.CmdPTYOpen, req, nil)
	if err != nil {
		a.unregisterRelayPTY(req.PTYID)
		relay.drop()
		var remote *protocol.RemoteError
		if errors.As(err, &remote) {
			ch.Close()
			// Report a changed trust summary before the refusal, as for a forwarded task.
			if authorizationCode(remote.Code) {
				a.refreshTrust(ctx)
			}
			return nil, remote
		}
		if errors.Is(err, context.DeadlineExceeded) && ctx.Err() == nil {
			// The privileged side may have accepted and started the terminal without its answer
			// reaching us: ask it to close the terminal and answer helper_lost, like a timed-out
			// task.start (doc/design/protocol.md "crh-priv").
			a.log.Warn("the privileged side did not answer pty.open", "terminal", req.PTYID, "err", err)
			go a.closePrivPTY(ch, req.PTYID)
			return nil, &protocol.RemoteError{
				Code:    protocol.CodeHelperLost,
				Message: "the privileged side did not answer pty.open; the terminal was cancelled",
			}
		}
		// A terminal cannot survive the loss of its channel: a broken forward connection closes
		// every terminal it carries, and a helper that failed is reaped. Nothing is left to retry.
		ch.Close()
		return nil, a.channelUnavailable(err)
	}
	t, err := a.pty.mgr.OpenRelay(pty.OpenRequest{
		ID:              req.PTYID,
		Argv:            req.Argv,
		Rows:            uint64(req.Rows),
		Cols:            uint64(req.Cols),
		Privileged:      true,
		ScrollbackBytes: uint64(req.ScrollbackBytes),
		Meta:            req.Meta,
	}, relay)
	if err != nil {
		a.unregisterRelayPTY(req.PTYID)
		go a.closePrivPTY(ch, req.PTYID)
		relay.drop()
		return nil, err
	}
	// Output that arrived before the answer is handed to the terminal here.
	relay.attach(t)
	return protocol.Deferred{Body: protocol.Empty{}, After: func() { a.startPTYWorker(t, false) }}, nil
}

// alreadyAcceptedTerminal refuses a second pty.open for a held terminal id.
func alreadyAcceptedTerminal(id string) *protocol.RemoteError {
	return &protocol.RemoteError{
		Code:    protocol.CodeAlreadyAccepted,
		Message: "terminal " + id + " was already accepted",
	}
}

// privilegedTerminalUnsupported refuses a privileged pty.open in a mode that has no privileged
// channel: reject and ignore, and an unset mode, which behaves like reject
// (doc/design/pty.md "Privilege").
func (a *Agent) privilegedTerminalUnsupported() *protocol.RemoteError {
	return &protocol.RemoteError{
		Code:    protocol.CodePrivilegedUnsupported,
		Message: "privileged terminals are not supported by this crha",
	}
}

// channelUnavailable describes a privileged channel that was lost while its terminal was being
// accepted. Forward mode keeps the daemon-unreachable error; a native helper that broke is its own
// failure.
func (a *Agent) channelUnavailable(err error) *protocol.RemoteError {
	if a.mode() == config.ModeNative {
		message := "the native helper failed"
		if err != nil {
			message += ": " + err.Error()
		}
		return &protocol.RemoteError{Code: protocol.CodePrivilegedUnavailable, Message: protocol.ErrorMessage(message)}
	}
	return forwardUnavailable(err)
}

// closePrivPTY asks the privileged side to close a terminal whose pty.open answer this side will
// not accept, then releases the channel. It is best effort: a broken forward connection already
// ended every terminal on the daemon, and a dead helper has nothing left to close.
func (a *Agent) closePrivPTY(ch privChannel, id string) {
	ctx, cancel := context.WithTimeout(context.Background(), a.forwardTimeout())
	defer cancel()
	if err := ch.Request(ctx, wire.CmdPTYClose, protocol.PTYClose{PTYID: id, Reason: relayCloseReason}, nil); err != nil {
		a.log.Debug("close a relayed terminal", "terminal", id, "err", err)
	}
	ch.Close()
}

// handlePTYResize applies an explicit size change. Attaching or detaching a viewer never resizes
// a terminal (doc/design/pty.md "crhs").
func (a *Agent) handlePTYResize(_ context.Context, body cbor.RawMessage) (any, error) {
	var req protocol.PTYResize
	if err := protocol.UnmarshalBody(body, &req); err != nil {
		return nil, err
	}
	if err := a.pty.mgr.Resize(req.PTYID, uint64(req.Rows), uint64(req.Cols)); err != nil {
		return nil, err
	}
	return protocol.Empty{}, nil
}

// handlePTYClose drops a terminal. It is idempotent for an unknown id, and the process group is
// closed after the response so a slow hangup does not hold the control connection. No pty.exited
// follows a close crhs asked for (doc/design/pty.md "crha").
func (a *Agent) handlePTYClose(_ context.Context, body cbor.RawMessage) (any, error) {
	var req protocol.PTYClose
	if err := protocol.UnmarshalBody(body, &req); err != nil {
		return nil, err
	}
	t := a.pty.mgr.Drop(req.PTYID)
	if t == nil {
		return protocol.Empty{}, nil
	}
	a.stopPTYWorker(t.ID())
	a.log.Info("terminal closed", "id", t.ID(), "reason", req.Reason)
	go func() {
		if err := t.Close(); err != nil {
			a.log.Warn("close terminal", "id", t.ID(), "err", err)
		}
	}()
	return protocol.Empty{}, nil
}

// handlePTYMeta replaces crhs's opaque metadata blob; crha never interprets it.
func (a *Agent) handlePTYMeta(_ context.Context, body cbor.RawMessage) (any, error) {
	var req protocol.PTYMeta
	if err := protocol.UnmarshalBody(body, &req); err != nil {
		return nil, err
	}
	if err := a.pty.mgr.SetMeta(req.PTYID, req.Meta); err != nil {
		return nil, err
	}
	return protocol.Empty{}, nil
}

// beginPTY reports every held terminal after hello and starts a data connection loop for each one
// on this control connection: a running terminal reconnects, and an exited terminal crhs has not
// closed replays once and ends with [end] (doc/design/pty.md "Reconnect").
func (a *Agent) beginPTY(ctx context.Context, conn *transport.Conn, peer *protocol.Peer) error {
	if !conn.Negotiated.Has(protocol.CmdPTYOpen) {
		// A node of an older minor, or crhs did not offer terminals: nothing on this connection
		// may use them, and any terminal already held waits for a connection that does.
		return nil
	}
	if conn.Negotiated.Has(protocol.EventPTYList) {
		if err := peer.Emit(protocol.EventPTYList, protocol.PTYList{Terminals: a.pty.mgr.List()}); err != nil {
			return err
		}
	}
	held := a.pty.mgr.Held()
	exited := make([]bool, len(held))
	for i, t := range held {
		exited[i], _ = t.Exit()
	}
	a.pty.mu.Lock()
	// An exited terminal is served once per control connection, by the fresh loop started below.
	// Stop its previous loop before announcing this connection, so the two cannot both serve it.
	for i, t := range held {
		if !exited[i] {
			continue
		}
		if old := a.pty.workers[t.ID()]; old != nil {
			old.cancel()
		}
	}
	a.pty.ctrl = &ptyControl{ctx: ctx, peer: peer, negotiated: conn.Negotiated}
	a.wakePTYLocked()
	a.pty.mu.Unlock()
	for i, t := range held {
		// A running terminal's waiting worker reuses the wake-up. An exited terminal gets a fresh
		// loop even if the previous one is still finishing.
		a.startPTYWorker(t, exited[i])
	}
	return nil
}

// endPTY stops the terminal data connections of a control connection that is going away. The
// terminals themselves keep running for the next connection.
func (a *Agent) endPTY(peer *protocol.Peer) {
	a.pty.mu.Lock()
	if a.pty.ctrl != nil && a.pty.ctrl.peer == peer {
		a.pty.ctrl = nil
	}
	a.wakePTYLocked()
	a.pty.mu.Unlock()
}

// onPTYExit emits pty.exited once for a terminal whose process ended. If no control connection is
// up, or crhs did not negotiate the event, the next pty.list carries the exit state instead.
func (a *Agent) onPTYExit(t *pty.Terminal) {
	_, code := t.Exit()
	a.pty.mu.Lock()
	ctrl, closing := a.pty.ctrl, a.pty.closing
	a.pty.mu.Unlock()
	if closing || ctrl == nil || !ctrl.negotiated.Has(protocol.EventPTYExited) {
		return
	}
	reason := protocol.PTYExitReasonExited
	if t.Lost() {
		// A relayed terminal whose privileged mode disappeared reports helper_lost with code -1
		// (doc/design/pty.md "Lifecycle").
		reason = protocol.PTYExitReasonHelperLost
	}
	exited := protocol.PTYExited{
		PTYID:    t.ID(),
		ExitCode: protocol.Int(code),
		Reason:   reason,
	}
	if err := ctrl.peer.Emit(protocol.EventPTYExited, exited); err != nil {
		a.log.Warn("emit pty.exited", "id", t.ID(), "err", err)
	}
}

func (a *Agent) ptyControl() *ptyControl {
	a.pty.mu.Lock()
	defer a.pty.mu.Unlock()
	return a.pty.ctrl
}

// ptyControlOrWake returns the control connection and the channel closed by the next control
// change. Both are read under one lock, so a change between the two cannot be missed.
func (a *Agent) ptyControlOrWake() (*ptyControl, <-chan struct{}) {
	a.pty.mu.Lock()
	defer a.pty.mu.Unlock()
	return a.pty.ctrl, a.pty.wake
}

// ptyWake returns the channel closed by the next control change.
func (a *Agent) ptyWake() <-chan struct{} {
	a.pty.mu.Lock()
	defer a.pty.mu.Unlock()
	return a.pty.wake
}

// wakePTYLocked broadcasts a control change to every terminal worker and installs a fresh channel
// for the next one, so no worker can take another's wake-up. a.pty.mu must be held.
func (a *Agent) wakePTYLocked() {
	close(a.pty.wake)
	a.pty.wake = make(chan struct{})
}

// startPTYWorker starts the one data connection loop for t, replacing a loop left over from the
// same id if crhs reopened it. Repeating the call for the same running terminal does nothing.
// replace restarts the loop even when t already has one: an exited terminal replays once per
// control connection, and its previous loop may be finishing as the new connection arrives.
func (a *Agent) startPTYWorker(t *pty.Terminal, replace bool) {
	if a.opts.PTYDial == nil {
		return
	}
	a.pty.mu.Lock()
	if old := a.pty.workers[t.ID()]; old != nil {
		if old.term == t && !replace {
			a.pty.mu.Unlock()
			return
		}
		old.cancel()
	}
	ctx, cancel := context.WithCancel(a.pty.root)
	w := &ptyWorker{term: t, cancel: cancel, done: make(chan struct{})}
	a.pty.workers[t.ID()] = w
	a.pty.mu.Unlock()
	go func() {
		defer close(w.done)
		defer a.forgetPTYWorker(t.ID(), w)
		a.ptyWorkerLoop(ctx, w)
	}()
}

func (a *Agent) stopPTYWorker(id string) {
	a.pty.mu.Lock()
	w := a.pty.workers[id]
	a.pty.mu.Unlock()
	if w != nil {
		w.cancel()
	}
}

// forgetPTYWorker removes w from the map if it is still the terminal's current worker.
func (a *Agent) forgetPTYWorker(id string, w *ptyWorker) {
	a.pty.mu.Lock()
	if a.pty.workers[id] == w {
		delete(a.pty.workers, id)
	}
	a.pty.mu.Unlock()
}

// ptyWorkerLoop runs one terminal's data connection for as long as the terminal exists. A control
// connection change is not a failure: the loop waits for the next connection instead of backing
// off.
func (a *Agent) ptyWorkerLoop(ctx context.Context, w *ptyWorker) {
	backoff := ptyMinBackoff
	failing := false
	for {
		if ctx.Err() != nil {
			return
		}
		select {
		case <-w.term.Gone():
			return
		default:
		}
		// The wake channel is read with the control connection: a change between reading them
		// cannot be missed, and a change from before this point cannot cut a later wait short.
		ctrl, wake := a.ptyControlOrWake()
		if ctrl == nil {
			if !a.waitPTYEvent(ctx, w.term, wake) {
				return
			}
			continue
		}
		result, err := a.servePTYData(ctx, ctrl, w.term, func() {
			if failing {
				a.log.Info("terminal data connection recovered", "id", w.term.ID())
				failing = false
				backoff = ptyMinBackoff
			}
		})
		switch result {
		case ptyServeEnded:
			return
		case ptyServeControlLost:
			continue
		case ptyServePeerEnded:
			// crhs closed the data connection on purpose, not because it failed. Do not reconnect
			// to the same control connection; wait for a new one.
			if !a.waitPTYControlChange(ctx, w.term, ctrl) {
				return
			}
		case ptyServeDropped:
			if !failing {
				a.log.Warn("terminal data connection failed", "id", w.term.ID(), "err", err)
				failing = true
			}
			if !a.waitPTYBackoff(ctx, w.term, backoff) {
				return
			}
			backoff = min(backoff*2, ptyMaxBackoff)
		}
	}
}

// waitPTYEvent waits until a control connection is (re)announced, the terminal is gone, or the
// agent stops. wake is the broadcast channel current when the caller last checked the control
// connection, so the announcement cannot be missed.
func (a *Agent) waitPTYEvent(ctx context.Context, t *pty.Terminal, wake <-chan struct{}) bool {
	select {
	case <-ctx.Done():
		return false
	case <-t.Gone():
		return false
	case <-wake:
		return true
	}
}

// waitPTYControlChange waits until ctrl is replaced by another control connection.
func (a *Agent) waitPTYControlChange(ctx context.Context, t *pty.Terminal, ctrl *ptyControl) bool {
	for {
		current, wake := a.ptyControlOrWake()
		if current != ctrl {
			return true
		}
		select {
		case <-ctx.Done():
			return false
		case <-t.Gone():
			return false
		case <-wake:
		}
	}
}

// waitPTYBackoff waits before the next redial. A control change cuts the wait short: a new
// connection is dialed at once. The broadcast channel is taken when the wait starts, so a change
// from before it does not cut it short.
func (a *Agent) waitPTYBackoff(ctx context.Context, t *pty.Terminal, delay time.Duration) bool {
	wake := a.ptyWake()
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.Gone():
		return false
	case <-timer.C:
		return true
	case <-wake:
		return true
	}
}

// ptyServeResult classifies why servePTYData returned.
type ptyServeResult int

const (
	// ptyServeDropped means the connection failed or fell behind; the worker redials after a
	// backoff.
	ptyServeDropped ptyServeResult = iota
	// ptyServeEnded means the terminal's output ended and [end] was sent; no more connections.
	ptyServeEnded
	// ptyServeControlLost means the control connection ended; wait for the next one.
	ptyServeControlLost
	// ptyServePeerEnded means crhs ended the data connection; wait for a new control connection.
	ptyServePeerEnded
)

// servePTYData runs one data connection until it ends. Every connection starts by replaying the
// whole current ring buffer, so crhs treats each one as a fresh screen replay, then live output
// follows (doc/design/pty.md "crha").
func (a *Agent) servePTYData(ctx context.Context, ctrl *ptyControl, t *pty.Terminal, connected func()) (ptyServeResult, error) {
	// The attempt ends when its control connection ends, when the agent stops, or when the
	// terminal is dropped.
	actx, cancel := context.WithCancel(ctrl.ctx)
	defer cancel()
	go func() {
		select {
		case <-ctx.Done():
			cancel()
		case <-t.Gone():
			cancel()
		case <-actx.Done():
		}
	}()

	conn, err := a.opts.PTYDial(actx, t.ID())
	if err != nil {
		if terminalGone(t) || a.ptyAttemptLost(actx, ctrl) {
			return ptyServeControlLost, err
		}
		return ptyServeDropped, err
	}
	defer func() { _ = conn.Close("terminal data connection closed") }()
	connected()

	snapshot, off := t.Ring().Snapshot()
	if err := writePTYFrames(actx, conn, snapshot); err != nil {
		return a.ptyAttemptResult(actx, ctrl, t, err)
	}
	if t.Ended() {
		if err := writeDataFrame(actx, conn, protocol.DataFrame{Kind: protocol.DataFrameEnd}); err != nil {
			return a.ptyAttemptResult(actx, ctrl, t, err)
		}
		return ptyServeEnded, nil
	}

	recvErr := make(chan error, 1)
	go func() { recvErr <- a.recvPTYInput(actx, conn, t) }()
	sendErr := make(chan error, 1)
	go func() { sendErr <- a.sendPTYOutput(actx, conn, t, off) }()
	select {
	case err := <-sendErr:
		if err == nil {
			return ptyServeEnded, nil
		}
		return a.ptyAttemptResult(actx, ctrl, t, err)
	case err := <-recvErr:
		if errors.Is(err, errPTYPeerEnded) {
			return ptyServePeerEnded, nil
		}
		return a.ptyAttemptResult(actx, ctrl, t, err)
	}
}

// ptyAttemptLost reports whether an attempt's context ended because its control connection did,
// rather than because the connection itself failed.
func (a *Agent) ptyAttemptLost(actx context.Context, ctrl *ptyControl) bool {
	return actx.Err() != nil && (ctrl.ctx.Err() != nil || a.ptyControl() != ctrl)
}

func (a *Agent) ptyAttemptResult(actx context.Context, ctrl *ptyControl, t *pty.Terminal, err error) (ptyServeResult, error) {
	if errors.Is(err, errPTYPeerEnded) {
		return ptyServePeerEnded, nil
	}
	// A terminal crhs closed is not a connection failure: cancellation is expected, and the worker
	// exits on its next turn without warning.
	if terminalGone(t) || a.ptyAttemptLost(actx, ctrl) {
		return ptyServeControlLost, err
	}
	return ptyServeDropped, err
}

// terminalGone reports whether the terminal was dropped, so its data connection must not be
// redialed.
func terminalGone(t *pty.Terminal) bool {
	select {
	case <-t.Gone():
		return true
	default:
		return false
	}
}

// sendPTYOutput forwards the ring to crhs in order. It fails when the reader fell behind the ring
// (a reconnect replays instead of skipping bytes) and sends [end] after the terminal's last byte.
func (a *Agent) sendPTYOutput(ctx context.Context, conn DataConn, t *pty.Terminal, off uint64) error {
	for {
		data, ok := t.Ring().ReadAt(off, protocol.DataChunkBytes)
		if !ok {
			return errPTYBehind
		}
		if len(data) > 0 {
			if err := writeDataFrame(ctx, conn, protocol.DataFrame{Kind: protocol.DataFrameData, Bytes: data}); err != nil {
				return err
			}
			off += uint64(len(data))
			continue
		}
		if t.Ended() {
			return writeDataFrame(ctx, conn, protocol.DataFrame{Kind: protocol.DataFrameEnd})
		}
		select {
		case <-t.Ring().Wake():
		case <-t.OutputDone():
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}

// recvPTYInput writes crhs's input to the PTY in arrival order. [end] and [abort] end only the
// data connection, never the terminal.
func (a *Agent) recvPTYInput(ctx context.Context, conn DataConn, t *pty.Terminal) error {
	for {
		frame, err := readDataFrame(ctx, conn)
		if err != nil {
			return err
		}
		switch frame.Kind {
		case protocol.DataFrameData:
			if len(frame.Bytes) == 0 {
				continue
			}
			if err := t.Write(frame.Bytes); err != nil {
				return err
			}
		case protocol.DataFrameEnd, protocol.DataFrameAbort:
			return errPTYPeerEnded
		default:
			return fmt.Errorf("unknown terminal data frame %q", frame.Kind)
		}
	}
}

// writePTYFrames sends data as [data, bytes] frames chunked at the protocol's data chunk size.
func writePTYFrames(ctx context.Context, conn DataConn, data []byte) error {
	for len(data) > 0 {
		n := min(len(data), protocol.DataChunkBytes)
		if err := writeDataFrame(ctx, conn, protocol.DataFrame{Kind: protocol.DataFrameData, Bytes: data[:n]}); err != nil {
			return err
		}
		data = data[n:]
	}
	return nil
}

// shutdownPTY stops every data connection and closes every terminal, and with it every process
// group, when crha stops (doc/design/pty.md "The terminal object").
func (a *Agent) shutdownPTY() {
	a.pty.mu.Lock()
	a.pty.closing = true
	a.pty.mu.Unlock()
	a.pty.cancel()

	a.pty.mu.Lock()
	workers := make([]*ptyWorker, 0, len(a.pty.workers))
	for _, w := range a.pty.workers {
		workers = append(workers, w)
	}
	a.pty.mu.Unlock()
	deadline := time.After(10 * time.Second)
	for _, w := range workers {
		select {
		case <-w.done:
		case <-deadline:
			a.log.Warn("terminal data connection did not stop", "id", w.term.ID())
		}
	}
	a.pty.mgr.Shutdown()
}
