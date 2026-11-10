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
	// maxForwardConns caps the forward connections that receive trust.summary and local.decision.
	// Forward connections are the unprivileged peer's; refusing beyond the cap keeps one process
	// from adding connections without limit (doc/design/privilege.md "The privileged mode").
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
	// outbox holds trust.summary and local.decision events for this connection. Their order is
	// kept, and a slow peer only delays its own goroutine, never pushLocalDecision or reload.
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

// addForward adds c to the set of connections that receive trust.summary and local.decision. It
// reports false when maxForwardConns connections are already registered; an existing c is
// idempotent.
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
		session.HandleRequests()
		p.HandleRequest(wire.CmdTrustQuery, c.handleTrustQuery)
		p.HandleRequest(protocol.CmdLocalRequest, c.handleLocalRequest)
		p.HandleRequest(protocol.CmdLocalWithdraw, c.handleLocalWithdraw)
	case wire.RoleLocal:
		p.HandleRequest(wire.CmdPendingList, c.handlePendingList)
		p.HandleRequest(wire.CmdLocalApprove, c.handleLocalApprove)
		p.HandleRequest(wire.CmdLocalDeny, c.handleLocalDeny)
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

	now := c.s.now()
	record := state.Record{
		TaskID:       ts.TaskID,
		Attempt:      uint64(ts.Attempt),
		SpecSHA256:   hex.EncodeToString(decided.specHash[:]),
		AcceptedAtMS: now.UnixMilli(),
	}
	if decided.authorization != nil {
		record.AuthorizationID = hex.EncodeToString(decided.authorizationID[:])
		record.IssuedAtMS = int64(decided.payload.IssuedAtMS)
		if decided.payload.DeadlineMS != nil {
			deadline := int64(*decided.payload.DeadlineMS)
			record.DeadlineMS = &deadline
		}
	}
	if err := c.s.store.AddUsed(record); err != nil {
		if errors.Is(err, state.ErrAlreadyRecorded) {
			refused := stepRefusal(authz.ResultAlreadyAccepted, authz.StepOneShot,
				fmt.Sprintf("task %s already ran on this node", ts.TaskID))
			c.s.logRefusal(&ts, refused)
			return nil, refused.remote()
		}
		c.s.log.Error("persist used record", "task", ts.TaskID, "err", err)
		return nil, &protocol.RemoteError{Code: protocol.CodeInternalError, Message: "persist used record: " + err.Error()}
	}

	entry := decided.decision.Entry
	authID := ""
	if decided.authorization != nil {
		authID = record.AuthorizationID
	}
	if err := c.s.opts.Log.Log(audit.Record{
		Event:           "task.accepted",
		TaskID:          ts.TaskID,
		Attempt:         ts.Attempt,
		Entry:           entry,
		AuthorizationID: authID,
		SpecSHA256:      record.SpecSHA256,
		Spec:            &ts.Spec,
	}); err != nil {
		// The acceptance is already persisted, so the task id is burned either way. Do not
		// execute a privileged task whose acceptance could not be audited.
		c.s.log.Error("write the local log; refusing to execute", "task", ts.TaskID, "err", err)
		return nil, &protocol.RemoteError{Code: protocol.CodeInternalError, Message: "local log: " + err.Error()}
	}

	session.Add(task)
	accepted = true
	c.s.registerTask(task)
	if decided.approval != nil {
		c.s.consumeApproval(approvalKey{taskID: ts.TaskID, attempt: uint64(ts.Attempt)})
	}
	return protocol.Deferred{Body: protocol.Empty{}, After: func() { session.Launch(task) }}, nil
}

// executionStart prepares the task.start the executor receives. The cwd of a task that was
// not authorized with an exact command (or by a local approval) is fixed to "/"
// (doc/design/privilege.md "Validation flow").
func executionStart(ts *protocol.TaskStart, decided *decidedTask) protocol.TaskStart {
	out := *ts
	if decided.exact || ts.Spec.Kind != protocol.TaskSpecExec || ts.Spec.Exec == nil {
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
	return c.s.Config().Summary(), nil
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

func (c *conn) handlePendingList(_ context.Context, raw cbor.RawMessage) (any, error) {
	var empty protocol.Empty
	if err := protocol.UnmarshalBody(raw, &empty); err != nil {
		return nil, err
	}
	return c.s.pendingEntries(), nil
}

func (c *conn) handleLocalRequest(_ context.Context, raw cbor.RawMessage) (any, error) {
	var req protocol.LocalRequest
	if err := protocol.UnmarshalBody(raw, &req); err != nil {
		return nil, err
	}
	state, refusal := c.s.requestLocal(&req)
	if refusal != nil {
		return nil, refusal
	}
	return state, nil
}

func (c *conn) handleLocalWithdraw(_ context.Context, raw cbor.RawMessage) (any, error) {
	var withdraw protocol.LocalWithdraw
	if err := protocol.UnmarshalBody(raw, &withdraw); err != nil {
		return nil, err
	}
	c.s.withdrawLocal(withdraw.TaskID, uint64(withdraw.Attempt))
	return protocol.Empty{}, nil
}

func (c *conn) handleLocalApprove(_ context.Context, raw cbor.RawMessage) (any, error) {
	return c.decideLocal(raw, true)
}

func (c *conn) handleLocalDeny(_ context.Context, raw cbor.RawMessage) (any, error) {
	return c.decideLocal(raw, false)
}

func (c *conn) decideLocal(raw cbor.RawMessage, approve bool) (any, error) {
	var verdict protocol.LocalVerdict
	if err := protocol.UnmarshalBody(raw, &verdict); err != nil {
		return nil, err
	}
	if _, refusal := c.s.decideLocal(c.uid, &verdict, approve); refusal != nil {
		return nil, refusal
	}
	// The decision itself reaches crhs as the local.decision event; the command's success
	// response is empty (doc/design/protocol.md "crh-priv").
	return protocol.Empty{}, nil
}
