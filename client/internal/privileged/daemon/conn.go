package daemon

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"sync"
	"time"

	"github.com/fxamacker/cbor/v2"

	"github.com/Kodecable/ClusterRightHand/client/internal/privileged/audit"
	"github.com/Kodecable/ClusterRightHand/client/internal/privileged/authz"
	"github.com/Kodecable/ClusterRightHand/client/internal/privileged/state"
	"github.com/Kodecable/ClusterRightHand/client/internal/privileged/taskrun"
	"github.com/Kodecable/ClusterRightHand/client/internal/privileged/termhost"
	"github.com/Kodecable/ClusterRightHand/client/internal/privileged/wire"
	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
)

// handshakeTimeout bounds the crh-priv handshake of one socket connection. A local command
// that connects and says nothing must not pin a goroutine forever, especially during
// shutdown.
const handshakeTimeout = 10 * time.Second

const (
	// writeFrameTimeout bounds one frame write to a privileged connection. A peer that stops
	// reading must not block a caller (or the daemon's Run loop) forever; a write that exceeds
	// it closes the connection because the stream cannot be resumed in the middle of a frame.
	writeFrameTimeout = 10 * time.Second
	// maxForwardConns caps the forward connections that receive trust.summary. Forward
	// connections are the unprivileged peer's; refusing beyond the cap keeps one process from
	// adding connections without limit.
	maxForwardConns = 8
	// forwardOutboxSize buffers the events queued for one forward connection. Enqueuing never
	// waits for the peer; the writer drains the queue on its own goroutine.
	forwardOutboxSize = 64
)

// outbound is one event queued for a connection's writer.
type outbound struct {
	name string
	body any
}

// conn is one accepted unix-socket connection and the role it negotiated.
type conn struct {
	s    *Server
	nc   net.Conn
	uid  uint32
	role wire.Role

	stream *wire.Stream

	// mu orders the peer and session the handshake installs against close. Both are set once;
	// close reads the peer under mu so a connection closed while its handshake completes
	// closes the peer too (setPeer closes it when close already ran).
	mu      sync.Mutex
	peer    *protocol.Peer
	session *taskrun.Session
	closed  bool
	// done is closed by close so a queued writer stops even before the socket is torn down.
	done chan struct{}
	// outbox holds trust.summary events for this connection. Their order is kept, and a slow
	// peer only delays its own goroutine, never pushTrustSummary or reload. Terminal output is
	// queued here too, but a producer waits for room instead of dropping the bytes.
	outbox chan outbound

	closeOnce sync.Once
}

// serveConn authenticates the peer with SO_PEERCRED, negotiates a role and serves the
// connection until it ends.
func (s *Server) serveConn(nc net.Conn) {
	unixConn, ok := nc.(*net.UnixConn)
	if !ok {
		_ = nc.Close()
		return
	}
	c := &conn{s: s, nc: nc, outbox: make(chan outbound, forwardOutboxSize)}
	s.registerConn(c)
	defer s.unregisterConn(c)

	uid, _, err := peerCredential(unixConn)
	if err != nil {
		s.log.Warn("cannot read the peer uid of a privileged socket connection", "err", err)
		c.close()
		return
	}
	c.uid = uid

	// The privileged mode's own user is not implicitly a local approver: a local role needs
	// a matching local trust entry, exactly like every other uid (doc/design/privilege.md "Validation flow").
	cfg := s.Config()
	roles := make([]wire.Role, 0, 2)
	if uid == cfg.UnprivilegedUID {
		roles = append(roles, wire.RoleForward)
	}
	if cfg.LocalEntry(uid) != nil {
		roles = append(roles, wire.RoleLocal)
	}
	if len(roles) == 0 {
		s.log.Warn("rejecting socket connection from an untrusted uid", "uid", uid)
		c.close()
		return
	}

	_ = nc.SetDeadline(time.Now().Add(handshakeTimeout))
	hello, negotiated, err := wire.ServerHandshake(nc, nc, wire.ServerOptions{
		Roles:       roles,
		CRHAVersion: s.opts.Version,
		// Reserve the forward slot before the welcome: a peer over the cap must fail the
		// handshake, and the slot is released by unregisterConn if the handshake still fails.
		BeforeWelcome: func(hello *wire.PrivHello) error {
			if hello.Role != wire.RoleForward {
				return nil
			}
			if !s.addForward(c) {
				return fmt.Errorf("too many forward connections (max %d)", maxForwardConns)
			}
			return nil
		},
	})
	if err != nil {
		s.log.Warn("crh-priv handshake failed", "uid", uid, "err", err)
		c.close()
		return
	}
	_ = nc.SetDeadline(time.Time{})
	c.role = hello.Role
	// Every frame write gets its own deadline. A timed-out write closes the socket, so a peer
	// that never reads cannot keep a write (or Close behind it) blocked.
	c.stream = wire.NewStreamFor(nc, writeDeadlineWriter{conn: nc, timeout: s.writeTimeout}, negotiated, hello.Role)
	peer := c.stream.Peer()
	session := taskrun.NewSession(peer, taskrun.SessionOptions{
		Env:       s.opts.Env,
		SpoolRoot: s.Config().StateDir,
		Log:       connLog{s},
		OnExit:    s.unregisterTask,
	})
	if !c.setPeer(peer, session) {
		return
	}
	if hello.Role == wire.RoleForward {
		// The slot was reserved before the welcome; this is idempotent and also covers a caller
		// that did not run BeforeWelcome.
		if !s.addForward(c) {
			c.close()
			return
		}
		go c.drainOutbox()
	}
	c.registerHandlers()

	if err := c.stream.Run(); err != nil && !errors.Is(err, io.EOF) && !errors.Is(err, net.ErrClosed) {
		var protocolErr *wire.ProtocolError
		if errors.As(err, &protocolErr) {
			s.log.Warn("crh-priv connection violated the protocol", "role", c.role, "err", err)
		}
	}
	c.close()
	// A terminal has no meaning without the unprivileged mode that carries its bytes, so its
	// process is ended with the connection (doc/design/pty.md "Privilege"). This also records the
	// terminals whose pty.open response could not be sent, which never started.
	if c.role == wire.RoleForward {
		c.closeTerminals("the forward connection ended")
	}
	// A task whose task.start success response could not be sent is still accepted: run it,
	// with its output dropped and its outcome in the local log (doc/design/protocol.md "crh-priv").
	// Task.Start runs at most once, so a Deferred.After that already ran is a no-op.
	c.launchAccepted()
}

// setPeer installs the peer and session the handshake negotiated. It reports false when the
// connection was already closed: close has run and will never see the peer, so the peer is closed
// here instead.
func (c *conn) setPeer(peer *protocol.Peer, session *taskrun.Session) bool {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		peer.Close(errors.New("connection closed"))
		return false
	}
	c.peer, c.session = peer, session
	c.mu.Unlock()
	return true
}

// currentPeer returns the connection's peer, or nil before the handshake completed.
func (c *conn) currentPeer() *protocol.Peer {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.peer
}

// currentSession returns the connection's task session, or nil before the handshake completed.
func (c *conn) currentSession() *taskrun.Session {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.session
}

// close tears down the connection. It is idempotent.
func (c *conn) close() {
	c.closeOnce.Do(func() {
		c.mu.Lock()
		c.closed = true
		peer := c.peer
		done := c.done
		if done == nil {
			done = make(chan struct{})
			c.done = done
		}
		c.mu.Unlock()
		close(done)
		// Close the socket first: Peer.Close waits for an in-flight frame write, and a peer
		// that stopped reading must not hold the connection or daemon shutdown open. The write
		// deadline above makes that write fail even if the peer keeps the connection open.
		_ = c.nc.Close()
		if peer != nil {
			peer.Close(errors.New("connection closed"))
		}
	})
}

// doneSignal returns the connection's done channel, creating it for a conn built without the
// serveConn constructor (tests).
func (c *conn) doneSignal() chan struct{} {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.done == nil {
		c.done = make(chan struct{})
	}
	return c.done
}

// addForward adds c to the set of connections that receive trust.summary. It reports false
// when maxForwardConns connections are already registered; an existing c is idempotent.
func (s *Server) addForward(c *conn) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.forwards[c]; ok {
		return true
	}
	if len(s.forwards) >= maxForwardConns {
		return false
	}
	s.forwards[c] = struct{}{}
	return true
}

// enqueue queues one event for c without waiting for the peer. A full queue drops the event: a
// connection that cannot keep up with 64 events while its writes are deadline-bounded is being
// closed by the writer anyway, and blocking here would put the slowness back on the caller.
func (c *conn) enqueue(name string, body any) {
	c.mu.Lock()
	if c.closed || c.outbox == nil {
		c.mu.Unlock()
		return
	}
	done := c.done
	if done == nil {
		done = make(chan struct{})
		c.done = done
	}
	c.mu.Unlock()
	select {
	case c.outbox <- outbound{name: name, body: body}:
	case <-done:
	default:
		if c.s != nil {
			c.s.log.Warn("dropping a crh-priv event for a connection whose queue is full", "event", name)
		}
	}
}

// enqueueBlocking queues one event for c, waiting while the queue is full. It is for a producer
// that can afford to wait, and only for one whose wait does not hold up other traffic: a terminal's
// own reader, so a slow peer applies backpressure to that PTY (the process stops once its output
// buffer is full) without growing the queue or blocking another terminal, a task or a response.
// The wait ends when the connection closes, whose writer gives up on a peer that stops reading.
func (c *conn) enqueueBlocking(name string, body any) {
	c.mu.Lock()
	outbox := c.outbox
	closed := c.closed
	c.mu.Unlock()
	if closed || outbox == nil {
		return
	}
	select {
	case outbox <- outbound{name: name, body: body}:
	case <-c.doneSignal():
	}
}

// drainOutbox writes queued events in order. Only a forward connection has one; a failed write
// usually means the writer closed the socket on its deadline, so the connection is torn down.
func (c *conn) drainOutbox() {
	done := c.doneSignal()
	for {
		select {
		case msg := <-c.outbox:
			peer := c.currentPeer()
			if peer == nil {
				continue
			}
			if err := peer.Emit(msg.name, msg.body); err != nil {
				if c.s != nil {
					c.s.log.Debug("push a crh-priv event failed", "event", msg.name, "err", err)
				}
				c.close()
				return
			}
		case <-done:
			return
		}
	}
}

// writeDeadlineWriter gives every write to one connection a fresh deadline. A timed-out write
// closes the socket: WriteFrame may already have sent part of a frame, so the stream cannot be
// resumed, and closing also releases Peer.Close waiting on the peer's send lock.
type writeDeadlineWriter struct {
	conn    net.Conn
	timeout time.Duration
}

func (w writeDeadlineWriter) Write(p []byte) (int, error) {
	if err := w.conn.SetWriteDeadline(time.Now().Add(w.timeout)); err != nil {
		return 0, err
	}
	n, err := w.conn.Write(p)
	if err != nil {
		var netErr net.Error
		if errors.As(err, &netErr) && netErr.Timeout() {
			_ = w.conn.Close()
		}
	}
	return n, err
}

// registerHandlers installs the role's crh-priv command handlers.
func (c *conn) registerHandlers() {
	p := c.currentPeer()
	session := c.currentSession()
	if p == nil || session == nil {
		return
	}
	switch c.role {
	case wire.RoleForward:
		p.HandleRequest(protocol.CmdTaskStart, c.handleTaskStart)
		c.s.terms.Register(p, termhost.Channel{
			Authorize:   c.authorizeTerminal,
			BeforeStart: c.mayStartTerminal,
			Emit:        c.emitTerminal,
		})
		session.HandleRequests()
		p.HandleRequest(wire.CmdTrustQuery, c.handleTrustQuery)
	case wire.RoleLocal:
		p.HandleRequest(wire.CmdWindowStatus, c.handleWindowStatus)
		p.HandleRequest(wire.CmdWindowOpen, c.handleWindowOpen)
		p.HandleRequest(wire.CmdWindowClose, c.handleWindowClose)
	}
}

// launchAccepted handles the tasks of a connection that just ended. An accepted task whose
// Deferred.After did not run because the response could not be sent still executes. An input
// that can no longer be completed is failed, as with a native helper whose stdin closed;
// otherwise a task reading stdin would never finish.
func (c *conn) launchAccepted() {
	session := c.currentSession()
	if session == nil {
		return
	}
	session.EndInput()
	session.LaunchAll()
}

// handleTaskStart verifies an authorization, prepares the task's staging, persists the used
// records, logs the acceptance and starts the task after the success response (doc/design/privilege.md
// "Validation flow" steps 2–9). Staging is prepared before AddUsed: a refusal with input_too_large must
// not burn the task id, so the same id can be retried (doc/design/privilege.md "Validation flow").
func (c *conn) handleTaskStart(_ context.Context, raw cbor.RawMessage) (any, error) {
	var ts protocol.TaskStart
	if err := protocol.UnmarshalBody(raw, &ts); err != nil {
		return nil, err
	}
	decided, refused := c.s.decide(&ts)
	if refused != nil {
		c.s.logRefusal(&ts, refused)
		return nil, refused.remote()
	}

	session := c.currentSession()
	runStart := executionStart(&ts, decided)
	task, err := session.Prepare(runStart)
	if err != nil {
		var remote *protocol.RemoteError
		if errors.As(err, &remote) {
			// A resource refusal (input_too_large) keeps its protocol code and writes no used
			// record; the caller can retry this task id with a smaller input.
			c.s.logRefusal(&ts, &refusal{code: remote.Code, message: remote.Message})
			return nil, remote
		}
		c.s.log.Error("prepare a task", "task", ts.TaskID, "err", err)
		return nil, &protocol.RemoteError{Code: protocol.CodeInternalError, Message: err.Error()}
	}
	// Any failure before the task joins the session releases its staging: the task id stays
	// unused (or, for a log failure after AddUsed, no spool file is left behind).
	accepted := false
	defer func() {
		if !accepted {
			task.Discard()
		}
	}()

	// An accepted task always carries an authorization (authz.Decide refuses a task without one).
	refused, remote := c.s.accept(acceptance{
		id:      ts.TaskID,
		attempt: ts.Attempt,
		spec:    &ts.Spec,
		decided: decided,
		event:   "task.accepted",
	})
	if refused != nil {
		c.s.logRefusal(&ts, refused)
		return nil, refused.remote()
	}
	if remote != nil {
		return nil, remote
	}

	session.Add(task)
	accepted = true
	c.s.registerTask(task)
	return protocol.Deferred{Body: protocol.Empty{}, After: func() { session.Launch(task) }}, nil
}

// acceptance is one accepted task or terminal: the id, its attempt, the spec it was authorized
// with, the verified decision, and the audit event that names it (task.accepted or
// terminal.opened). A terminal's id stands in for the task id in the used list and the local window.
type acceptance struct {
	id      string
	attempt protocol.Uint
	spec    *protocol.TaskSpec
	decided *decidedTask
	event   string
	// terminal selects the terminal columns and messages of the acceptance: pty_id instead of
	// task_id, and the terminal wording of the duplicate refusal.
	terminal bool
}

// accept persists the one-shot used record of an accepted task or terminal and writes its acceptance
// record, with the local window's opening uid when it was accepted through one. A nil refusal and a
// nil remote error mean accepted; the caller records the duplicate-use refusal in its own shape
// (task.refused or terminal.refused). AddUsed runs after decide and produces the exact codes and
// messages of the task path.
func (s *Server) accept(a acceptance) (*refusal, *protocol.RemoteError) {
	now := s.now()
	record := state.Record{
		TaskID:          a.id,
		Attempt:         uint64(a.attempt),
		AuthorizationID: hex.EncodeToString(a.decided.authorizationID[:]),
		IssuedAtMS:      int64(a.decided.payload.IssuedAtMS),
		SpecSHA256:      hex.EncodeToString(a.decided.specHash[:]),
		AcceptedAtMS:    now.UnixMilli(),
	}
	if a.decided.payload.DeadlineMS != nil {
		record.DeadlineMS = int64(*a.decided.payload.DeadlineMS)
	}
	if err := s.store.AddUsed(record); err != nil {
		if errors.Is(err, state.ErrAlreadyRecorded) {
			if a.terminal {
				return stepRefusal(authz.ResultAlreadyAccepted, authz.StepOneShot,
					fmt.Sprintf("terminal %s was already accepted on this node", a.id)), nil
			}
			return stepRefusal(authz.ResultAlreadyAccepted, authz.StepOneShot,
				fmt.Sprintf("task %s already ran on this node", a.id)), nil
		}
		s.log.Error("persist used record", "id", a.id, "err", err)
		return nil, &protocol.RemoteError{Code: protocol.CodeInternalError, Message: "persist used record: " + err.Error()}
	}

	acceptedRecord := audit.Record{
		Event:           a.event,
		Attempt:         a.attempt,
		Entry:           a.decided.decision.Entry,
		AuthorizationID: record.AuthorizationID,
		SpecSHA256:      record.SpecSHA256,
		Spec:            a.spec,
	}
	if a.terminal {
		acceptedRecord.PTYID = a.id
	} else {
		acceptedRecord.TaskID = a.id
	}
	if a.decided.window != nil {
		uid := a.decided.window.openedBy
		acceptedRecord.UID = &uid
		acceptedRecord.Detail = fmt.Sprintf("via local window opened by uid %d", uid)
	}
	if err := s.opts.Log.Log(acceptedRecord); err != nil {
		// The acceptance is already persisted, so the id is burned either way. Do not run a
		// privileged process whose acceptance could not be audited.
		s.log.Error("write the local log; refusing to start", "id", a.id, "err", err)
		return nil, &protocol.RemoteError{Code: protocol.CodeInternalError, Message: "local log: " + err.Error()}
	}
	return nil, nil
}

// executionStart prepares the task.start the executor receives. The cwd of a task that was
// not authorized with a spec command is fixed to "/".
func executionStart(ts *protocol.TaskStart, decided *decidedTask) protocol.TaskStart {
	out := *ts
	if decided.spec || ts.Spec.Kind != protocol.TaskSpecExec || ts.Spec.Exec == nil {
		return out
	}
	exec := *ts.Spec.Exec
	exec.Cwd = "/"
	out.Spec = protocol.TaskSpec{Kind: protocol.TaskSpecExec, Exec: &exec}
	return out
}

// connLog records the outcome of a forward connection's tasks in the local log. The
// acceptance is logged by handleTaskStart, so a task's start adds nothing.
type connLog struct{ s *Server }

// TaskStarted implements taskrun.Log.
func (connLog) TaskStarted(*taskrun.Task) {}

// TaskFinished implements taskrun.Log.
func (l connLog) TaskFinished(t *taskrun.Task, exit *protocol.TaskExit, took time.Duration) {
	ts := t.TaskStart()
	_ = l.s.opts.Log.Log(audit.Record{
		Event:      "task.finished",
		TaskID:     ts.TaskID,
		Attempt:    ts.Attempt,
		Outcome:    taskrun.OutcomeText(exit.Outcome),
		TimedOut:   exit.TimedOut,
		Cancelled:  exit.Cancelled,
		OutputEnd:  uint64(exit.OutputEnd),
		DurationMS: took.Milliseconds(),
	})
}

// ExitUndelivered implements taskrun.Log: the forward connection is gone; the task still ran
// and is in the local log.
func (l connLog) ExitUndelivered(t *taskrun.Task, err error) {
	_ = l.s.opts.Log.Log(audit.Record{
		Event: "task.exit.undelivered", TaskID: t.TaskStart().TaskID, Detail: err.Error(),
	})
}

func (c *conn) handleTrustQuery(_ context.Context, raw cbor.RawMessage) (any, error) {
	var empty protocol.Empty
	if err := protocol.UnmarshalBody(raw, &empty); err != nil {
		return nil, err
	}
	return c.s.summary(), nil
}

// logRefusal records a refused task.start in the local log. The code, step and message are
// the ones returned to the caller.
func (s *Server) logRefusal(ts *protocol.TaskStart, refused *refusal) {
	if err := s.opts.Log.Log(audit.Record{
		Event:   "task.refused",
		TaskID:  ts.TaskID,
		Attempt: ts.Attempt,
		Code:    refused.code,
		Step:    refused.step,
		Message: refused.message,
	}); err != nil {
		s.log.Warn("write local log", "err", err)
	}
}

func (c *conn) handleWindowStatus(_ context.Context, raw cbor.RawMessage) (any, error) {
	var empty protocol.Empty
	if err := protocol.UnmarshalBody(raw, &empty); err != nil {
		return nil, err
	}
	if !c.s.localUIDAllowed(c.uid) {
		return nil, &protocol.RemoteError{
			Code: protocol.CodeLocalNotTrusted, Message: fmt.Sprintf("uid %d is not a local approver", c.uid),
		}
	}
	return c.s.windowState(), nil
}

func (c *conn) handleWindowOpen(_ context.Context, raw cbor.RawMessage) (any, error) {
	var open protocol.WindowOpen
	if err := protocol.UnmarshalBody(raw, &open); err != nil {
		return nil, err
	}
	ms := uint64(open.DurationMS)
	if ms == 0 || ms > uint64(1<<63-1)/uint64(time.Millisecond) {
		return nil, &protocol.RemoteError{Code: protocol.CodeInvalidSpec, Message: "the window length is out of range"}
	}
	state, refusal := c.s.openWindow(c.uid, time.Duration(ms)*time.Millisecond)
	if refusal != nil {
		return nil, refusal
	}
	return state, nil
}

func (c *conn) handleWindowClose(_ context.Context, raw cbor.RawMessage) (any, error) {
	var empty protocol.Empty
	if err := protocol.UnmarshalBody(raw, &empty); err != nil {
		return nil, err
	}
	state, refusal := c.s.closeWindow(c.uid)
	if refusal != nil {
		return nil, refusal
	}
	return state, nil
}
