package daemon

import (
	"context"
	"errors"

	"github.com/Kodecable/ClusterRightHand/client/internal/privileged/audit"
	"github.com/Kodecable/ClusterRightHand/client/internal/privileged/termhost"
	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
	"github.com/Kodecable/ClusterRightHand/client/internal/pty"
)

// The local log events of a privileged terminal (doc/design/privilege.md "The privileged mode").
// They mirror a task's events: the terminal id takes the place of the task id, and the accepted
// record carries the same authorization fields as task.accepted.
const (
	auditTerminalOpened  = "terminal.opened"
	auditTerminalRefused = "terminal.refused"
	auditTerminalExited  = "terminal.exited"
	auditTerminalClosed  = "terminal.closed"
)

// termRecorder writes a terminal's records to the local audit log (doc/design/privilege.md "The
// privileged mode"). The acceptance is written by authorizeTerminal, where the one-shot record and
// the acceptance record are one step.
type termRecorder struct{ s *Server }

// Opened implements termhost.Recorder. The daemon writes terminal.opened in authorizeTerminal,
// because there the used record, the audit record and the decision are one acceptance step.
func (termRecorder) Opened(string, protocol.Uint, protocol.TaskSpec) error { return nil }

// Refused records a refused pty.open, as logRefusal does for a task.start.
func (r termRecorder) Refused(id string, attempt protocol.Uint, refused termhost.Refused) {
	if err := r.s.opts.Log.Log(audit.Record{
		Event:   auditTerminalRefused,
		PTYID:   id,
		Attempt: attempt,
		Code:    refused.Code,
		Step:    refused.Step,
		Message: refused.Message,
	}); err != nil {
		r.s.log.Warn("write local log", "err", err)
	}
}

// Exited records the process's exit code.
func (r termRecorder) Exited(id string, code int) {
	if err := r.s.opts.Log.Log(audit.Record{
		Event:    auditTerminalExited,
		PTYID:    id,
		ExitCode: &code,
	}); err != nil {
		r.s.log.Warn("write local log", "err", err)
	}
}

// Closed records a terminal's close, with its exit code when the process had already ended, and
// forgets it as the connection's terminal.
func (r termRecorder) Closed(id string, code *int, detail string) {
	r.s.forgetTerminal(id)
	r.s.auditTerminalClosed(id, code, detail)
}

// syntheticPTYStart builds the task.start a privileged pty.open is decided as: the terminal id and
// the pty.open attempt stand in for the task's, and the spec is the pty.create kind whose only
// field is the argv (doc/design/pty.md "Privilege"). The decision is the same decide() a task.start
// runs, with no special cases beyond the kind.
func syntheticPTYStart(req protocol.PTYOpen) protocol.TaskStart {
	return protocol.TaskStart{
		TaskID:         req.PTYID,
		Attempt:        req.Attempt,
		Privileged:     true,
		Spec:           protocol.TaskSpec{Kind: protocol.TaskSpecPtyCreate, PtyCreate: &protocol.PtyCreateSpec{Argv: append([]string{}, req.Argv...)}},
		Authorizations: req.Authorizations,
		Cosign:         req.Cosign,
	}
}

// authorizeTerminal verifies a privileged terminal's authorization, persists its one-shot record,
// logs the acceptance and binds it to the connection before the pty.open response goes out
// (doc/design/privilege.md "Validation flow" steps 2–9). Everything a task.start does before it
// runs happens here too: the terminal id is recorded in the used list before the process starts,
// and a refusal has no side effect carried over.
func (c *conn) authorizeTerminal(_ context.Context, req protocol.PTYOpen) error {
	ts := syntheticPTYStart(req)
	decided, refused := c.s.decide(&ts)
	if refused != nil {
		return &termhost.Refused{Code: refused.code, Step: refused.step, Message: refused.message}
	}
	// The size is not part of the authorization, so it is checked after the decision and before
	// the used record: an out-of-range request must not burn a one-shot authorization.
	if err := pty.ValidateOpen(req.PTYID, uint64(req.Rows), uint64(req.Cols)); err != nil {
		var remote *protocol.RemoteError
		if errors.As(err, &remote) {
			return &termhost.Refused{Code: remote.Code, Message: remote.Message}
		}
		return &termhost.Refused{Code: protocol.CodeInvalidSpec, Message: err.Error()}
	}
	refused, remote := c.s.accept(acceptance{
		id:       req.PTYID,
		attempt:  req.Attempt,
		spec:     &ts.Spec,
		decided:  decided,
		event:    auditTerminalOpened,
		terminal: true,
	})
	if refused != nil {
		return &termhost.Refused{Code: refused.code, Step: refused.step, Message: refused.message}
	}
	if remote != nil {
		return remote
	}
	c.s.bindTerminal(req.PTYID, c)
	return nil
}

// bindTerminal records c as the owner of id before the pty.open response goes out, so connection
// teardown closes exactly the terminals it accepted and records the ones whose process never
// started. A connection that already closed cannot send the response, so nothing will start.
func (s *Server) bindTerminal(id string, c *conn) {
	c.mu.Lock()
	closed := c.closed
	c.mu.Unlock()
	if closed {
		return
	}
	s.mu.Lock()
	s.termConns[id] = &termOwner{conn: c}
	s.mu.Unlock()
}

// mayStartTerminal marks an accepted terminal as started and reports whether its process may start.
// It runs under the host's start lock, so teardown either sees the terminal started and closes the
// process, or sees it not started and records that it never ran.
func (c *conn) mayStartTerminal(id string) bool {
	c.mu.Lock()
	closed := c.closed
	c.mu.Unlock()
	if closed {
		return false
	}
	c.s.mu.Lock()
	owner := c.s.termConns[id]
	if owner != nil && owner.conn == c {
		owner.started = true
	}
	c.s.mu.Unlock()
	return owner != nil && owner.conn == c
}

// emitTerminal queues a terminal event for the connection. The connection's outbox bounds the wait:
// a slow peer applies backpressure to that terminal's PTY and never to another terminal or a task.
func (c *conn) emitTerminal(name string, body any) {
	c.enqueueBlocking(name, body)
}

// ownedTerminal is one terminal a connection accepted, with whether its process started.
type ownedTerminal struct {
	id      string
	started bool
}

// terminalsOf removes and returns the terminals c accepted.
func (s *Server) terminalsOf(c *conn) []ownedTerminal {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]ownedTerminal, 0, len(s.termConns))
	for id, owner := range s.termConns {
		if owner.conn != c {
			continue
		}
		out = append(out, ownedTerminal{id: id, started: owner.started})
		delete(s.termConns, id)
	}
	return out
}

// terminalDropped forgets a terminal the manager removed, however it ended.
func (s *Server) terminalDropped(t *pty.Terminal) {
	s.forgetTerminal(t.ID())
}

// forgetTerminal drops a terminal's connection ownership.
func (s *Server) forgetTerminal(id string) {
	s.mu.Lock()
	delete(s.termConns, id)
	s.mu.Unlock()
}

// auditTerminalClosed records a terminal's close. code is set when the process had already exited.
func (s *Server) auditTerminalClosed(id string, code *int, detail string) {
	if err := s.opts.Log.Log(audit.Record{
		Event:    auditTerminalClosed,
		PTYID:    id,
		ExitCode: code,
		Detail:   detail,
	}); err != nil {
		s.log.Warn("write local log", "err", err)
	}
}

// closeTerminals ends every terminal accepted on a connection that is going away and records the
// accepted ones whose response could not be sent, which never started. The connection's terminals
// die with it: a privileged terminal has no meaning without the unprivileged mode that carries its
// bytes (doc/design/pty.md "Privilege").
func (c *conn) closeTerminals(reason string) {
	for _, owned := range c.s.terminalsOf(c) {
		if owned.started {
			c.s.terms.Close(owned.id, reason)
			continue
		}
		c.s.auditTerminalClosed(owned.id, nil, "the connection ended before the terminal started")
	}
}
