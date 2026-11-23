package agent

import (
	"context"
	"errors"
	"sync"

	"github.com/fxamacker/cbor/v2"

	"github.com/Kodecable/ClusterRightHand/client/internal/privileged/wire"
	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
	"github.com/Kodecable/ClusterRightHand/client/internal/pty"
)

// relayCloseReason is the reason a relayed terminal's pty.close carries. The privileged side records
// it as the detail of terminal.closed (doc/design/privilege.md "The privileged mode").
const relayCloseReason = "closed by the unprivileged mode"

// errRelayEnded reports input or a resize sent to a terminal that already ended.
var errRelayEnded = errors.New("the relayed terminal has ended")

// privChannel is the privileged channel that carries one relayed terminal: the shared forward
// connection in forward mode, or the native helper process started for exactly this terminal in
// native mode. The relay must not know which one it is (doc/design/pty.md "Privilege").
type privChannel interface {
	// Request sends one crh-priv pty.* request and waits for its answer. A refusal of the
	// privileged side is returned as a *protocol.RemoteError; a broken channel as its own error.
	Request(ctx context.Context, cmd string, req, resp any) error
	// Done is closed when the channel is gone: the forward connection broke, or the helper's
	// process exited or its stdio broke.
	Done() <-chan struct{}
	// Close releases the channel after pty.close was sent. A native helper is reaped here; the
	// shared forward connection is left open. It is idempotent.
	Close()
}

// forwardPTYChannel is the shared forward connection seen as the channel of one terminal.
type forwardPTYChannel struct {
	a  *Agent
	fc *forwardConn
}

func (c forwardPTYChannel) Request(ctx context.Context, cmd string, req, resp any) error {
	if !c.fc.negotiated.Has(cmd) {
		return &protocol.RemoteError{
			Code:    protocol.CodePrivilegedUnsupported,
			Message: "the privileged mode does not implement " + cmd,
		}
	}
	return c.fc.peer.Request(ctx, cmd, req, resp)
}

func (c forwardPTYChannel) Done() <-chan struct{} { return c.fc.done }

// Close does nothing: the forward connection is shared by every terminal and by the tasks of the
// node, and the daemon closes a terminal when pty.close reaches it.
func (c forwardPTYChannel) Close() {}

// relayPTY is the pty.Backend of a terminal whose process runs in the privileged mode: input, resize
// and close go to the privileged side as crh-priv requests, while its pty.output events feed the
// terminal's ring and its pty.exited ends it like a local process exit (doc/design/pty.md
// "Privilege"). Output that arrives before the pty.open answer is buffered until the manager's
// terminal exists; a channel that is lost first ends the terminal as helper_lost with code -1.
type relayPTY struct {
	a  *Agent
	ch privChannel
	id string

	mu      sync.Mutex
	term    *pty.Terminal
	pending []byte
	ended   bool
	dropped bool
	// gotExit, code and lost hold the exit the privileged side reported before the terminal
	// existed.
	gotExit bool
	code    int
	lost    bool

	stop     chan struct{}
	stopOnce sync.Once
}

// newRelayPTY returns the relay of a terminal whose pty.open is about to be sent.
func newRelayPTY(a *Agent, ch privChannel, id string) *relayPTY {
	r := &relayPTY{a: a, ch: ch, id: id, stop: make(chan struct{})}
	go func() {
		select {
		case <-ch.Done():
			r.end(-1, true)
		case <-r.stop:
		}
	}()
	return r
}

// attach gives the relay the manager's terminal and applies the output and the exit that arrived
// before it.
func (r *relayPTY) attach(t *pty.Terminal) {
	r.mu.Lock()
	r.term = t
	pending := r.pending
	r.pending = nil
	gotExit, code, lost, dropped := r.gotExit, r.code, r.lost, r.dropped
	r.mu.Unlock()
	if dropped {
		return
	}
	t.Feed(pending)
	if gotExit {
		t.End(code, lost)
	}
}

// output feeds one pty.output chunk to the terminal's ring, or buffers it until attach.
func (r *relayPTY) output(data []byte) {
	if len(data) == 0 {
		return
	}
	r.mu.Lock()
	if r.ended || r.dropped {
		r.mu.Unlock()
		return
	}
	if r.term == nil {
		r.pending = append(r.pending, data...)
		r.mu.Unlock()
		return
	}
	t := r.term
	r.mu.Unlock()
	t.Feed(data)
}

// exited ends the terminal with the privileged side's exit code.
func (r *relayPTY) exited(code int) { r.end(code, false) }

// end records the exit once and passes it to the manager's terminal, which runs the same exit path
// as a local process.
func (r *relayPTY) end(code int, lost bool) {
	r.mu.Lock()
	if r.ended || r.dropped {
		r.mu.Unlock()
		return
	}
	r.ended, r.gotExit, r.code, r.lost = true, true, code, lost
	t := r.term
	r.mu.Unlock()
	r.stopOnce.Do(func() { close(r.stop) })
	if t != nil {
		t.End(code, lost)
	}
}

// drop discards the relay without reporting anything: the pty.open was refused here, so the
// terminal never reached the manager.
func (r *relayPTY) drop() {
	r.mu.Lock()
	r.dropped, r.ended = true, true
	r.term, r.pending = nil, nil
	r.mu.Unlock()
	r.stopOnce.Do(func() { close(r.stop) })
}

// Write relays input to the privileged side in arrival order. The call waits for the answer, so the
// bytes of one data connection keep their order.
func (r *relayPTY) Write(p []byte) (int, error) {
	if r.hasEnded() {
		return 0, errRelayEnded
	}
	if err := r.request(wire.CmdPTYInput, wire.PrivPTYInput{PTYID: r.id, Data: p}); err != nil {
		return 0, err
	}
	return len(p), nil
}

// Resize relays a size change to the privileged side.
func (r *relayPTY) Resize(rows, cols uint16) error {
	if r.hasEnded() {
		return errRelayEnded
	}
	return r.request(wire.CmdPTYResize, protocol.PTYResize{PTYID: r.id, Rows: protocol.Uint(rows), Cols: protocol.Uint(cols)})
}

// Close asks the privileged side to close the terminal's process group and releases its channel: a
// native helper is reaped here, after pty.close.
func (r *relayPTY) Close() error {
	r.mu.Lock()
	ended, t := r.ended, r.term
	r.dropped, r.ended = true, true
	r.term, r.pending = nil, nil
	r.mu.Unlock()
	r.stopOnce.Do(func() { close(r.stop) })
	if t != nil {
		// The manager dropped the terminal before closing it, so this ends the output without a
		// report and lets its exit watcher return.
		t.End(-1, false)
	}
	err := r.request(wire.CmdPTYClose, protocol.PTYClose{PTYID: r.id, Reason: relayCloseReason})
	r.ch.Close()
	gone := false
	select {
	case <-r.ch.Done():
		gone = true
	default:
	}
	// Nothing is left to close when the channel was already gone or the terminal had ended.
	if err == nil || ended || gone {
		return nil
	}
	return err
}

// request sends one terminal request with the privileged request timeout, so a wedged privileged
// side fails the call instead of holding the terminal's data connection forever.
func (r *relayPTY) request(cmd string, req any) error {
	ctx, cancel := context.WithTimeout(context.Background(), r.a.forwardTimeout())
	defer cancel()
	return r.ch.Request(ctx, cmd, req, nil)
}

func (r *relayPTY) hasEnded() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.ended
}

// registerRelayPTY records a relayed terminal before its pty.open is sent, so output that arrives
// before the response is not lost. It reports false for an id that is already relayed.
func (a *Agent) registerRelayPTY(r *relayPTY) bool {
	a.pty.mu.Lock()
	defer a.pty.mu.Unlock()
	if _, ok := a.pty.relayed[r.id]; ok {
		return false
	}
	a.pty.relayed[r.id] = r
	return true
}

// unregisterRelayPTY forgets a relayed terminal that never reached the manager.
func (a *Agent) unregisterRelayPTY(id string) {
	a.pty.mu.Lock()
	delete(a.pty.relayed, id)
	a.pty.mu.Unlock()
}

func (a *Agent) relayedPTY(id string) *relayPTY {
	a.pty.mu.Lock()
	defer a.pty.mu.Unlock()
	return a.pty.relayed[id]
}

// onPTYDrop forgets a terminal the manager removed, so a late privileged event cannot revive it.
func (a *Agent) onPTYDrop(t *pty.Terminal) {
	a.unregisterRelayPTY(t.ID())
}

// handlePrivPTYOutput feeds one chunk of a relayed terminal's output to its relay. It is the event
// handler of both the forward connection and a native helper's stream. An event for a terminal this
// side does not know is dropped: the privileged side may still be finishing a terminal whose
// pty.open was refused here.
func (a *Agent) handlePrivPTYOutput(body cbor.RawMessage) error {
	var out wire.PrivPTYOutput
	if err := protocol.UnmarshalBody(body, &out); err != nil {
		return err
	}
	if relay := a.relayedPTY(out.PTYID); relay != nil {
		relay.output(out.Data)
		return nil
	}
	a.log.Debug("dropping pty.output for an unknown terminal", "terminal", out.PTYID)
	return nil
}

// handlePrivPTYExited ends a relayed terminal with the privileged side's exit code, exactly like a
// local process exit. It is the event handler of both modes.
func (a *Agent) handlePrivPTYExited(body cbor.RawMessage) error {
	var exit protocol.PTYExited
	if err := protocol.UnmarshalBody(body, &exit); err != nil {
		return err
	}
	if relay := a.relayedPTY(exit.PTYID); relay != nil {
		relay.exited(int(exit.ExitCode))
		return nil
	}
	a.log.Debug("dropping pty.exited for an unknown terminal", "terminal", exit.PTYID)
	return nil
}
