package agent

import (
	"context"
	"errors"
	"fmt"
	"net"
	"sync"
	"time"

	"github.com/fxamacker/cbor/v2"

	"github.com/Kodecable/ClusterRightHand/client/internal/config"
	"github.com/Kodecable/ClusterRightHand/client/internal/privileged/wire"
	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
	"github.com/Kodecable/ClusterRightHand/client/internal/version"
)

const (
	// forwardRetryMin and forwardRetryMax bound the backoff of the forward mode connection while
	// the privileged mode's socket is down: the delay doubles from the first to the second value
	// (doc/privilege.md 非特权模式如何处理特权任务).
	forwardRetryMin = time.Second
	forwardRetryMax = 30 * time.Second
	// forwardDialTimeout bounds connecting to the privileged mode's socket.
	forwardDialTimeout = 5 * time.Second
	// forwardHandshakeTimeout bounds the crh-priv handshake.
	forwardHandshakeTimeout = 10 * time.Second
	// DefaultForwardRequestTimeout bounds one request to the privileged mode. The daemon
	// answers from memory, so a slower answer means it is wedged.
	DefaultForwardRequestTimeout = 30 * time.Second

	// forwardNotConnected is the trust report message before the first connection attempt
	// finished.
	forwardNotConnected = "the privileged mode is not connected yet"
	// forwardLostMessage ends a task whose daemon connection broke (doc/protocol.md crh-priv 断开).
	forwardLostMessage = "lost the connection to the privileged mode; the task may still be running"
)

// forwardRun executes one task in the privileged mode over the forward-mode connection. The daemon
// owns the process, the input accounting and the task's state; this side relays the task's requests
// and events and keeps what the crhs protocol needs (doc/protocol.md crh-priv).
type forwardRun struct {
	// conn is the daemon connection the task.start was accepted on, set by prepare.
	conn *forwardConn
	// unknown records a task.start whose answer was lost (a broken connection or a timeout): the
	// daemon may have accepted the task, so start never waits for its events and ends it as
	// helper_lost.
	unknown bool
}

// prepare relays the task.start. The daemon must refuse an unauthorized task before this agent
// accepts it: an accepted task is never retried (doc/protocol.md task.start).
func (r *forwardRun) prepare(a *Agent, ctx context.Context, t *task) error {
	fc, unknown, err := a.startForwardTask(ctx, t.spec)
	if err != nil {
		var remote *protocol.RemoteError
		if errors.As(err, &remote) {
			return remote
		}
		return err
	}
	r.conn, r.unknown = fc, unknown
	return nil
}

// registered attaches the handlers that relay the daemon's events into the task's output spool.
func (r *forwardRun) registered(a *Agent, t *task) { a.attachForward(t) }

// start ends a task whose daemon connection was already gone when the task was accepted: a forwarded
// task executes in the privileged mode, which keeps an accepted task running, so its outcome is
// unknowable here.
func (r *forwardRun) start(a *Agent, t *task) {
	if r.unknown || !a.forwardAlive(r.conn) {
		a.finishRelayed(t, helperLostExit(t.id, forwardLostMessage))
	}
}

// input relays the chunk to the daemon, which owns the input accounting of a forwarded task. Only how
// much arrived is tracked here, so a session that ends mid-input can cancel a task that could never
// read the rest.
func (r *forwardRun) input(a *Agent, ctx context.Context, t *task, in *protocol.TaskInput) (any, error) {
	return a.forwardInput(ctx, t, in)
}

func (r *forwardRun) inputComplete(t *task) bool { return t.input.Complete() }

// failInput cancels the task on the daemon: it owns the process, and cancelling it also unblocks the
// reader waiting for the rest of the input. Its task.exit ends the task here.
func (r *forwardRun) failInput(a *Agent, t *task, _ string) { go a.cancelForwardTask(t.id) }

// cancel cancels the task on the daemon. task.cancel never fails on an unknown or finished task, and
// an unreachable daemon ends the task as helper_lost anyway.
func (r *forwardRun) cancel(a *Agent, ctx context.Context, t *task) {
	if err := a.relayForward(ctx, protocol.CmdTaskCancel, protocol.TaskCancel{TaskID: t.id}, nil); err != nil {
		a.log.Debug("cancel a forwarded task", "task", t.id, "err", err)
	}
}

// query answers from the daemon when it can be reached: the daemon knows the state and the output
// ends of a forwarded task even when its connection was lost here.
func (r *forwardRun) query(a *Agent, ctx context.Context, q protocol.TaskQuery) (protocol.TaskStatus, bool) {
	var status protocol.TaskStatus
	if err := a.relayForward(ctx, protocol.CmdTaskQuery, q, &status); err != nil {
		return status, false
	}
	return status, true
}

// finished does nothing: the daemon owns the task, and its events end it here.
func (r *forwardRun) finished(*task) {}

// forwardConn is the crh-priv connection of forward mode to the privileged mode: one connection
// serves every task, and its events are routed by task id (doc/protocol.md crh-priv).
type forwardConn struct {
	conn   net.Conn
	stream *wire.Stream
	peer   *protocol.Peer
	// negotiated is what both sides implement; the daemon's crh-priv 1.0 subset has no
	// local.* commands (doc/protocol.md crh-priv).
	negotiated protocol.Set
	done       chan struct{}
	runErr     error
	once       sync.Once
}

// start begins reading frames. The read loop routes the daemon's events through the agent and
// answers the requests this side sends.
func (fc *forwardConn) start() {
	go func() {
		fc.runErr = fc.stream.Run()
		// Fail requests waiting for a response; the read loop is the only receiver.
		fc.stream.Close(fc.runErr)
		close(fc.done)
	}()
}

// wait blocks until the connection ended, or closes it when ctx is cancelled first.
func (fc *forwardConn) wait(ctx context.Context) error {
	select {
	case <-ctx.Done():
		fc.close()
		<-fc.done
		return ctx.Err()
	case <-fc.done:
		return fc.runErr
	}
}

// close closes the socket. Closing it is what ends a read loop, so it is idempotent.
func (fc *forwardConn) close() {
	fc.once.Do(func() { _ = fc.conn.Close() })
}

// dialForward connects to the privileged mode's socket as the crh-priv forward role and installs
// the event handlers. The caller owns the connection until it closes.
func (a *Agent) dialForward(ctx context.Context) (*forwardConn, error) {
	socket := a.opts.PrivilegedSocket
	if socket == "" {
		return nil, errors.New("no [privileged] socket is configured")
	}
	dialer := net.Dialer{Timeout: forwardDialTimeout}
	conn, err := dialer.DialContext(ctx, "unix", socket)
	if err != nil {
		return nil, fmt.Errorf("connect %s: %w", socket, err)
	}
	_ = conn.SetDeadline(time.Now().Add(forwardHandshakeTimeout))
	_, negotiated, err := wire.ClientHandshake(conn, conn, wire.ClientOptions{
		Role:        wire.RoleForward,
		CRHAVersion: version.Version,
	})
	if err != nil {
		conn.Close()
		return nil, fmt.Errorf("crh-priv handshake: %w", err)
	}
	_ = conn.SetDeadline(time.Time{})

	fc := &forwardConn{
		conn:       conn,
		stream:     wire.NewStreamFor(conn, conn, negotiated, wire.RoleForward),
		negotiated: negotiated,
		done:       make(chan struct{}),
	}
	fc.peer = fc.stream.Peer()
	fc.peer.HandleEvent(protocol.EventTaskOutput, a.handleForwardOutput)
	fc.peer.HandleEvent(protocol.EventTaskExit, a.handleForwardExit)
	fc.peer.HandleEvent(protocol.EventTrustSummary, a.handleForwardSummary)
	fc.peer.HandleEvent(protocol.EventLocalDecision, a.handleForwardLocalDecision)
	return fc, nil
}

// startForward starts the connection to the privileged mode once. forward mode connects at start
// and reconnects with backoff while the socket is down (doc/privilege.md 非特权模式如何处理特权任务).
func (a *Agent) startForward(ctx context.Context) {
	if !a.forwardStarted.CompareAndSwap(false, true) {
		return
	}
	go a.runForward(ctx)
}

// runForward keeps the crh-priv connection to the privileged mode alive and reports its state:
// ok with the trust summary after connecting, unavailable with the dial or stream error while it
// is down.
func (a *Agent) runForward(ctx context.Context) {
	backoff := forwardRetryMin
	for ctx.Err() == nil {
		fc, err := a.dialForward(ctx)
		if err == nil {
			fc.start()
			a.setForward(fc, nil)
			if qerr := a.queryTrust(ctx, fc); qerr != nil {
				err = fmt.Errorf("trust query: %w", qerr)
				fc.close()
			} else {
				backoff = forwardRetryMin
				err = fc.wait(ctx)
			}
			a.setForward(nil, err)
			if ctx.Err() != nil {
				return
			}
			// Ending the tasks here is the point of the report: the daemon keeps them running
			// but crha can no longer learn their outcome.
			a.forwardLost()
		}
		if err != nil {
			a.log.Warn("the privileged mode is not reachable", "socket", a.opts.PrivilegedSocket, "err", err)
			a.setTrust(unavailableReport(err))
		}
		if !sleepCtx(ctx, backoff) {
			return
		}
		backoff = min(backoff*2, forwardRetryMax)
	}
}

// setForward records the current daemon connection (nil while it is down) and the reason.
func (a *Agent) setForward(fc *forwardConn, err error) {
	a.fwdMu.Lock()
	defer a.fwdMu.Unlock()
	a.fwd = fc
	if err != nil {
		a.fwdErr = err
	} else if fc != nil {
		a.fwdErr = nil
	}
}

// forwardConnection returns the current daemon connection, or nil with the reason it is down.
func (a *Agent) forwardConnection() (*forwardConn, error) {
	a.fwdMu.Lock()
	defer a.fwdMu.Unlock()
	return a.fwd, a.fwdErr
}

// queryTrust asks the daemon for its trust summary and reports it as ok.
func (a *Agent) queryTrust(ctx context.Context, fc *forwardConn) error {
	qctx, cancel := context.WithTimeout(ctx, a.forwardTimeout())
	defer cancel()
	var summary protocol.TrustSummary
	if err := fc.peer.Request(qctx, wire.CmdTrustQuery, protocol.Empty{}, &summary); err != nil {
		return err
	}
	a.setTrust(okReport(&summary))
	return nil
}

// refreshTrust queries the daemon again after an authorization_* refusal and reports a changed
// summary before the refusal goes out, so crhs plans its retry against the current trust
// (doc/privilege.md 信任缓存).
func (a *Agent) refreshTrust(ctx context.Context) {
	fc, _ := a.forwardConnection()
	if fc == nil {
		return
	}
	qctx, cancel := context.WithTimeout(ctx, a.forwardTimeout())
	defer cancel()
	var summary protocol.TrustSummary
	if err := fc.peer.Request(qctx, wire.CmdTrustQuery, protocol.Empty{}, &summary); err != nil {
		a.log.Warn("refresh the trust summary after an authorization error", "err", err)
		return
	}
	a.setTrust(okReport(&summary))
}

// forwarded reports whether t executes in the privileged mode.
func (t *task) forwarded() bool {
	_, ok := t.run.(*forwardRun)
	return ok
}

// forwardLost ends the tasks of the connection that just ended. The daemon keeps running an
// accepted task until it finishes (doc/protocol.md crh-priv 断开), so their outcome is unknowable
// here.
func (a *Agent) forwardLost() {
	a.mu.Lock()
	lost := make([]*task, 0, len(a.tasks))
	for _, t := range a.tasks {
		if t.forwarded() && !t.done {
			lost = append(lost, t)
		}
	}
	a.mu.Unlock()
	for _, t := range lost {
		a.finishRelayed(t, helperLostExit(t.id, forwardLostMessage))
	}
}

// forwardTimeout bounds one request to the privileged mode. Options.ForwardRequestTimeout
// overrides DefaultForwardRequestTimeout for tests.
func (a *Agent) forwardTimeout() time.Duration {
	if a.opts.ForwardRequestTimeout > 0 {
		return a.opts.ForwardRequestTimeout
	}
	return DefaultForwardRequestTimeout
}

// startForwardTask relays one privileged task.start over the current daemon connection and reports
// its refusal. Nothing is accepted here when the daemon refuses, so crhs can retry with a higher
// attempt. The returned connection is the one that accepted the task; unknown reports that the
// daemon may have accepted it without this side ever learning the outcome (the connection broke or
// the answer timed out), so launch ends it as helper_lost instead of waiting for its events.
func (a *Agent) startForwardTask(ctx context.Context, ts *protocol.TaskStart) (*forwardConn, bool, error) {
	fc, ferr := a.forwardConnection()
	if fc == nil {
		return nil, false, forwardUnavailable(ferr)
	}
	rctx, cancel := context.WithTimeout(ctx, a.forwardTimeout())
	defer cancel()
	err := fc.peer.Request(rctx, protocol.CmdTaskStart, ts, nil)
	if err == nil {
		return fc, false, nil
	}
	var remote *protocol.RemoteError
	if !errors.As(err, &remote) {
		if errors.Is(err, context.DeadlineExceeded) && ctx.Err() == nil {
			// The daemon did not answer within the deadline, but it may still accept and run the
			// task: the request is queued there, so refusing it would let crhs re-issue a task
			// that may execute (doc/protocol.md task.start, forward). Report it accepted like a
			// lost connection, ask the daemon to cancel it best-effort, and let launch end it as
			// helper_lost: its outcome is unknowable here.
			a.log.Warn("the privileged mode did not answer task.start", "task", ts.TaskID, "err", err)
			go a.cancelForwardTask(ts.TaskID)
			return fc, true, nil
		}
		// The request may have reached the daemon before the connection broke, and an accepted
		// task runs to completion there (doc/protocol.md crh-priv 断开). Refusing it here would
		// let crhs retry a task that may have run, so report it accepted: launch then ends it as
		// helper_lost.
		a.log.Warn("the privileged mode connection broke during task.start", "task", ts.TaskID, "err", err)
		return fc, true, nil
	}
	if authorizationCode(remote.Code) {
		// The daemon refused the authorization: report a changed trust summary first, then the
		// refusal (doc/protocol.md task.start, forward).
		a.refreshTrust(ctx)
	}
	return nil, false, remote
}

// forwardAlive reports whether fc is still the agent's daemon connection.
func (a *Agent) forwardAlive(fc *forwardConn) bool {
	current, _ := a.forwardConnection()
	return current != nil && current == fc
}

// authorizationCode reports whether code is one of the retryable authorization refusals.
func authorizationCode(code string) bool {
	switch code {
	case "authorization_required", "authorization_invalid", "authorization_expired", "authorization_rejected":
		return true
	default:
		return false
	}
}

// relayForward sends one request over the current daemon connection and relays its response.
func (a *Agent) relayForward(ctx context.Context, cmd string, req, resp any) error {
	fc, ferr := a.forwardConnection()
	if fc == nil {
		return forwardUnavailable(ferr)
	}
	return a.relayOn(ctx, fc, cmd, req, resp)
}

// relayOn sends one request over fc. Every request has the forward deadline, so a wedged daemon
// fails the request instead of leaving it pending forever. A refusal of the daemon is returned as
// it is; a broken connection or a timeout becomes privileged_unavailable.
func (a *Agent) relayOn(ctx context.Context, fc *forwardConn, cmd string, req, resp any) error {
	if !fc.negotiated.Has(cmd) {
		return &protocol.RemoteError{
			Code:    "privileged_unsupported",
			Message: "the privileged mode does not implement " + cmd,
		}
	}
	rctx, cancel := context.WithTimeout(ctx, a.forwardTimeout())
	defer cancel()
	err := fc.peer.Request(rctx, cmd, req, resp)
	if err == nil {
		return nil
	}
	var remote *protocol.RemoteError
	if errors.As(err, &remote) {
		return remote
	}
	if errors.Is(err, context.DeadlineExceeded) && ctx.Err() == nil {
		a.log.Warn("the privileged mode did not answer", "request", cmd, "err", err)
	}
	return forwardUnavailable(err)
}

// forwardUnavailable is the terminal error of a privileged operation while the privileged mode
// cannot be reached (doc/protocol.md task.start error codes).
func forwardUnavailable(err error) *protocol.RemoteError {
	message := "the privileged mode is not reachable"
	if err != nil {
		message += ": " + err.Error()
	}
	return &protocol.RemoteError{Code: "privileged_unavailable", Message: protocol.ErrorMessage(message)}
}

// notForwardError refuses a privileged mode command in a mode that does not forward.
func notForwardError(mode string) *protocol.RemoteError {
	return &protocol.RemoteError{Code: "privileged_unsupported", Message: "privileged mode is " + mode + ", not forward"}
}

func (a *Agent) handleForwardOutput(body cbor.RawMessage) error {
	var out protocol.TaskOutput
	if err := protocol.UnmarshalBody(body, &out); err != nil {
		return err
	}
	return a.relay.route(out.TaskID, relayEvent{output: &out})
}

func (a *Agent) handleForwardExit(body cbor.RawMessage) error {
	var exit protocol.TaskExit
	if err := protocol.UnmarshalBody(body, &exit); err != nil {
		return err
	}
	return a.relay.route(exit.TaskID, relayEvent{exit: &exit})
}

// handleForwardSummary forwards the daemon's trust report to crhs. The daemon pushes one after
// every reload that changed the digest.
func (a *Agent) handleForwardSummary(body cbor.RawMessage) error {
	var report protocol.TrustReport
	if err := protocol.UnmarshalBody(body, &report); err != nil {
		return err
	}
	a.setTrust(report)
	return nil
}

// handleForwardLocalDecision forwards a local approve or deny decision to crhs.
func (a *Agent) handleForwardLocalDecision(body cbor.RawMessage) error {
	var decision protocol.LocalDecision
	if err := protocol.UnmarshalBody(body, &decision); err != nil {
		return err
	}
	a.emitLocalDecision(decision)
	return nil
}

// emitLocalDecision relays one local.decision event to crhs. It is called from the daemon's read
// loop, so the frame goes out before any later frame this side sends on the crhs connection.
func (a *Agent) emitLocalDecision(decision protocol.LocalDecision) {
	a.mu.Lock()
	conn, peer := a.conn, a.peer
	a.mu.Unlock()
	if peer == nil || conn == nil || !conn.Negotiated.Has(protocol.EventLocalDecision) {
		return
	}
	if err := peer.Emit(protocol.EventLocalDecision, decision); err != nil {
		if !errors.Is(err, protocol.ErrClosed) {
			a.log.Warn("relay local.decision", "task", decision.TaskID, "err", err)
		}
	}
}

// trustReporter tracks the trust report crha knows and the one crhs was last told on the current
// connection, so trust.summary is only sent when it changed (doc/protocol.md trust.summary).
type trustReporter struct {
	mu       sync.Mutex
	report   protocol.TrustReport
	have     bool
	sent     string
	haveSent bool
}

// setTrust records the current trust report and sends it to crhs when it changed.
func (a *Agent) setTrust(report protocol.TrustReport) {
	a.trust.mu.Lock()
	defer a.trust.mu.Unlock()
	a.trust.report, a.trust.have = report, true
	a.sendTrustLocked(false)
}

// announceTrust sends the current report after a hello response, changed or not.
func (a *Agent) announceTrust() {
	a.trust.mu.Lock()
	defer a.trust.mu.Unlock()
	a.sendTrustLocked(true)
}

// sendTrustLocked sends the current report on the active crhs connection. The frame is written
// before sendTrustLocked returns, so a caller that must report a change before a response (the
// authorization refusal) can rely on the order. a.trust.mu must be held.
func (a *Agent) sendTrustLocked(force bool) {
	if !a.trust.have {
		return
	}
	key, err := trustKey(a.trust.report)
	if err != nil {
		a.log.Warn("the trust report cannot be digested", "err", err)
		return
	}
	if !force && a.trust.haveSent && key == a.trust.sent {
		return
	}
	a.mu.Lock()
	conn, peer := a.conn, a.peer
	a.mu.Unlock()
	if peer == nil || conn == nil || !conn.Negotiated.Has(protocol.EventTrustSummary) {
		// Nothing to send to yet: the next hello response announces the report.
		return
	}
	if err := peer.Emit(protocol.EventTrustSummary, a.trust.report); err != nil {
		if !errors.Is(err, protocol.ErrClosed) {
			a.log.Warn("send trust.summary", "err", err)
		}
		return
	}
	a.trust.sent, a.trust.haveSent = key, true
}

// trustKey identifies a report by its kind, message and (for ok) the summary digest, which is
// what "the report changed" means in doc/privilege.md 信任缓存.
func trustKey(report protocol.TrustReport) (string, error) {
	switch report.Kind {
	case protocol.TrustReportOK:
		if report.Summary == nil {
			return "", errors.New("ok trust report has no summary")
		}
		digest, err := protocol.TrustDigest(report.Summary)
		if err != nil {
			return "", err
		}
		return fmt.Sprintf("ok:%x", digest), nil
	case protocol.TrustReportUnavailable:
		return "unavailable:" + report.Message, nil
	case protocol.TrustReportNotForward:
		return "not_forward", nil
	default:
		return "", fmt.Errorf("unknown trust report kind %q", string(report.Kind))
	}
}

func okReport(summary *protocol.TrustSummary) protocol.TrustReport {
	return protocol.TrustReport{Kind: protocol.TrustReportOK, Summary: summary}
}

func unavailableReport(err error) protocol.TrustReport {
	message := forwardNotConnected
	if err != nil {
		message = protocol.ErrorMessage(err.Error())
	}
	return protocol.TrustReport{Kind: protocol.TrustReportUnavailable, Message: message}
}

// sleepCtx waits for d and reports whether ctx is still alive.
func sleepCtx(ctx context.Context, d time.Duration) bool {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

// attachForward installs the handlers that relay the daemon's events into a task's output spool.
// It runs once the task is registered, so events that arrived while the task was being accepted
// are replayed in order.
func (a *Agent) attachForward(t *task) {
	err := a.relay.attach(t.id, &relayHandlers{
		output: func(out *protocol.TaskOutput) error {
			if out.TaskID != t.id {
				return fmt.Errorf("the privileged mode sent output for task %q, want %q", out.TaskID, t.id)
			}
			return a.relayOutput(t, out)
		},
		exit: func(exit *protocol.TaskExit) error {
			if exit.TaskID != t.id {
				return fmt.Errorf("the privileged mode sent task.exit for %q, want %q", exit.TaskID, t.id)
			}
			a.finishRelayed(t, exit)
			return nil
		},
	})
	if err != nil {
		// A malformed buffered event makes the connection unusable: the daemon cannot be trusted
		// past it. Closing the socket ends the read loop and with it the running tasks.
		if fc, _ := a.forwardConnection(); fc != nil {
			a.log.Warn("replay buffered events of a forwarded task", "task", t.id, "err", err)
			fc.close()
		}
	}
}

// forwardInput relays one task.input chunk of a forwarded task. The daemon answers with the
// crh-priv input error codes, which crhs defines identically.
func (a *Agent) forwardInput(ctx context.Context, t *task, in *protocol.TaskInput) (any, error) {
	err := a.relayForward(ctx, protocol.CmdTaskInput, in, nil)
	if err != nil {
		var remote *protocol.RemoteError
		if errors.As(err, &remote) && remote.Code == "privileged_unavailable" {
			// The chunk did not reach the daemon (or its answer was lost), so the task can never
			// get the input it declared. Fail the input and cancel the task there, instead of
			// leaving it waiting for bytes that will not come.
			a.mu.Lock()
			a.failInputLocked(t, "input_incomplete", "the privileged mode did not accept the task input")
			a.mu.Unlock()
		}
		return nil, err
	}
	a.mu.Lock()
	t.input.Advance(uint64(in.Offset) + uint64(len(in.Data)))
	a.mu.Unlock()
	return protocol.Empty{}, nil
}

// cancelForwardTask cancels a forwarded task on the daemon, for an input that can never complete.
func (a *Agent) cancelForwardTask(taskID string) {
	ctx, cancel := context.WithTimeout(context.Background(), a.forwardTimeout())
	defer cancel()
	if err := a.relayForward(ctx, protocol.CmdTaskCancel, protocol.TaskCancel{TaskID: taskID}, nil); err != nil {
		a.log.Debug("cancel a forwarded task", "task", taskID, "err", err)
	}
}

// handleLocalRequest relays a local approval request and its state (doc/privilege.md 本地批准).
func (a *Agent) handleLocalRequest(ctx context.Context, body cbor.RawMessage) (any, error) {
	if a.mode() != config.ModeForward {
		return nil, notForwardError(a.mode())
	}
	var req protocol.LocalRequest
	if err := protocol.UnmarshalBody(body, &req); err != nil {
		return nil, err
	}
	var state protocol.LocalState
	if err := a.relayForward(ctx, protocol.CmdLocalRequest, req, &state); err != nil {
		return nil, err
	}
	return state, nil
}

// handleLocalWithdraw relays a withdrawn local approval request.
func (a *Agent) handleLocalWithdraw(ctx context.Context, body cbor.RawMessage) (any, error) {
	if a.mode() != config.ModeForward {
		return nil, notForwardError(a.mode())
	}
	var withdraw protocol.LocalWithdraw
	if err := protocol.UnmarshalBody(body, &withdraw); err != nil {
		return nil, err
	}
	if err := a.relayForward(ctx, protocol.CmdLocalWithdraw, withdraw, nil); err != nil {
		return nil, err
	}
	return protocol.Empty{}, nil
}
