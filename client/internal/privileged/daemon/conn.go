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
	c := &conn{s: s, nc: nc}
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
	// a matching local trust entry, exactly like every other uid (doc/privilege.md 校验流程).
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
	})
	if err != nil {
		s.log.Warn("crh-priv handshake failed", "uid", uid, "err", err)
		c.close()
		return
	}
	_ = nc.SetDeadline(time.Time{})
	c.role = hello.Role
	c.stream = wire.NewStreamFor(nc, nc, negotiated, hello.Role)
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
		s.addForward(c)
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
	// with its output dropped and its outcome in the local log (doc/protocol.md crh-priv
	// 断开). Task.Start runs at most once, so a Deferred.After that already ran is a no-op.
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
		c.mu.Unlock()
		// Close the socket first: Peer.Close waits for an in-flight frame write, and a peer
		// that stopped reading must not hold the connection or daemon shutdown open.
		_ = c.nc.Close()
		if peer != nil {
			peer.Close(errors.New("connection closed"))
		}
	})
}

// addForward adds c to the set of connections that receive trust.summary and local.decision.
func (s *Server) addForward(c *conn) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.forwards[c] = struct{}{}
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

// handleTaskStart verifies an authorization, persists the used records, logs the acceptance
// and starts the task after the success response (doc/privilege.md 校验流程 steps 2–10).
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

	runStart := executionStart(&ts, decided)
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

	session := c.currentSession()
	task, err := session.Accept(runStart)
	if err != nil {
		c.s.log.Error("prepare an accepted task", "task", ts.TaskID, "err", err)
		return nil, &protocol.RemoteError{Code: protocol.CodeInternalError, Message: err.Error()}
	}
	c.s.registerTask(task)
	if decided.approval != nil {
		c.s.consumeApproval(approvalKey{taskID: ts.TaskID, attempt: uint64(ts.Attempt)})
	}
	return protocol.Deferred{Body: protocol.Empty{}, After: func() { session.Launch(task) }}, nil
}

// executionStart prepares the task.start the executor receives. The cwd of a task that was
// not authorized with an exact command (or by a local approval) is fixed to "/"
// (doc/privilege.md 执行环境).
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
	// response is empty (doc/protocol.md crh-priv table).
	return protocol.Empty{}, nil
}
