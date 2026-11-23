// Package termhost hosts privileged terminals on a crh-priv connection. It is the terminal side
// shared by the privileged daemon (forward mode: one connection carries every terminal, after the
// authorization) and the native helper (one helper process carries one terminal, with no
// authorization, as native tasks have none). The host owns the terminals under a pty.Manager, the
// four crh-priv terminal commands, and the pty.output/pty.exited delivery with backpressure.
// Authorization, the acceptance record and the local log stay with the caller, which supplies them
// as hooks (doc/design/pty.md "Privilege").
package termhost

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"

	"github.com/fxamacker/cbor/v2"

	"github.com/Kodecable/ClusterRightHand/client/internal/execenv"
	"github.com/Kodecable/ClusterRightHand/client/internal/privileged/wire"
	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
	"github.com/Kodecable/ClusterRightHand/client/internal/pty"
)

// Channel is one crh-priv peer's terminal hooks. A host may serve several peers (the daemon's
// forward connections); each terminal's events go back to the peer that opened it.
type Channel struct {
	// Authorize verifies a pty.open before anything is recorded or started: the daemon decides the
	// authorization, checks the size and persists the used record. Native mode has no
	// authorization and leaves the hook nil, so the host validates the size itself.
	Authorize func(ctx context.Context, req protocol.PTYOpen) error
	// BeforeStart, when non-nil, is asked after the pty.open response was sent and before the
	// process starts. It reports whether the terminal may still start: the daemon refuses when its
	// connection ended while the response was in flight. A nil hook always starts.
	BeforeStart func(id string) bool
	// Emit sends one crh-priv event to the peer. pty.output runs on the terminal's reader, so a
	// blocking Emit applies the PTY's own backpressure to the process instead of growing a queue.
	Emit func(name string, body any)
}

// Recorder writes a terminal's records to the privileged side's local record: the daemon's audit
// log, or the native helper's JSON lines on stderr. Opened returns an error, so a caller that cannot
// record an acceptance refuses to start the process; the other records are best effort.
type Recorder interface {
	Opened(id string, attempt protocol.Uint, spec protocol.TaskSpec) error
	Refused(id string, attempt protocol.Uint, refused Refused)
	Exited(id string, code int)
	Closed(id string, code *int, detail string)
}

// Refused is a refused pty.open: the wire code, the verification step of
// doc/design/privilege.md "Validation flow" it failed (0 outside the flow) and its message. It is an
// error so an Authorize hook returns it unchanged.
type Refused struct {
	Code    string
	Step    int
	Message string
}

func (r *Refused) Error() string { return r.Message }

// Remote builds the pty.open error response: code plus "step N: message" from the failed
// verification step, or the bare message of a refusal outside the flow.
func (r *Refused) Remote() *protocol.RemoteError {
	message := r.Message
	if r.Step != 0 {
		message = fmt.Sprintf("step %d: %s", r.Step, message)
	}
	return &protocol.RemoteError{Code: r.Code, Message: message}
}

// Options configure a Host.
type Options struct {
	// Env is the privileged task environment. nil resolves it on first use.
	Env *execenv.Environment
	// Logger receives the manager's informational lines. nil discards them: a native helper's
	// stderr carries its JSON records, and a human line there would be relayed as a warning.
	Logger *slog.Logger
	// Single permits one terminal per host, as a native helper hosts exactly one. A second
	// pty.open is refused with already_accepted.
	Single bool
	// Recorder, when non-nil, receives the terminal's records.
	Recorder Recorder
	// CloseWait makes Close return after the process group is gone. The native helper sets it: it
	// leaves once its only terminal is closed, so nothing of the terminal may outlive the helper.
	CloseWait bool
	// OnDrop, when non-nil, runs after a terminal left the manager, however it ended. The daemon
	// uses it to forget which connection accepted the terminal.
	OnDrop func(*pty.Terminal)
}

// Host hosts the privileged terminals of one or more crh-priv peers.
type Host struct {
	opts Options
	log  *slog.Logger
	mgr  *pty.Manager

	// mu serializes a terminal's start against its close and guards the Single terminal's use.
	mu     sync.Mutex
	single bool

	channelsMu sync.Mutex
	channels   map[string]Channel
}

// New builds a host with its own terminal manager.
func New(opts Options) *Host {
	logger := opts.Logger
	if logger == nil {
		logger = slog.New(slog.DiscardHandler)
	}
	h := &Host{opts: opts, log: logger, channels: map[string]Channel{}}
	h.mgr = pty.NewManager(pty.Options{
		Env:             opts.Env,
		Logger:          logger,
		Privileged:      true,
		AllowPrivileged: true,
		OnOutput:        h.output,
		OnExit:          h.exited,
		OnDrop:          h.dropped,
	})
	return h
}

// Register installs the four crh-priv terminal handlers on peer, with the peer's hooks.
func (h *Host) Register(peer *protocol.Peer, ch Channel) {
	peer.HandleRequest(wire.CmdPTYOpen, func(ctx context.Context, raw cbor.RawMessage) (any, error) {
		return h.open(ctx, raw, ch)
	})
	peer.HandleRequest(wire.CmdPTYInput, h.handleInput)
	peer.HandleRequest(wire.CmdPTYResize, h.handleResize)
	peer.HandleRequest(wire.CmdPTYClose, h.handleClose)
}

// Count reports how many terminals the host holds.
func (h *Host) Count() int { return h.mgr.Count() }

// Used reports whether a terminal was accepted by a Single host. A native helper refuses a
// task.start once it agreed to host a terminal.
func (h *Host) Used() bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.single
}

// CloseAll closes every held terminal, with detail as the recorded reason.
func (h *Host) CloseAll(detail string) {
	for _, t := range h.mgr.Held() {
		h.Close(t.ID(), detail)
	}
}

// Shutdown closes every terminal and its process group when the host's process stops.
func (h *Host) Shutdown() {
	h.channelsMu.Lock()
	h.channels = map[string]Channel{}
	h.channelsMu.Unlock()
	h.mgr.Shutdown()
}

// open implements pty.open: the hooks accept or refuse the terminal, its record is written, and the
// process starts after the success response (doc/design/privilege.md "Validation flow" steps 2–9).
func (h *Host) open(ctx context.Context, raw cbor.RawMessage, ch Channel) (any, error) {
	var req protocol.PTYOpen
	if err := protocol.UnmarshalBody(raw, &req); err != nil {
		return nil, err
	}
	if h.opts.Single {
		h.mu.Lock()
		used := h.single
		h.single = true
		h.mu.Unlock()
		if used {
			return nil, h.refuse(req, &Refused{
				Code:    protocol.CodeAlreadyAccepted,
				Message: "the native helper hosts exactly one task or terminal",
			})
		}
	}
	var err error
	if ch.Authorize != nil {
		err = ch.Authorize(ctx, req)
	} else {
		err = pty.ValidateOpen(req.PTYID, uint64(req.Rows), uint64(req.Cols))
	}
	if err == nil && h.opts.Recorder != nil {
		err = h.opts.Recorder.Opened(req.PTYID, req.Attempt, protocol.TaskSpec{
			Kind:      protocol.TaskSpecPtyCreate,
			PtyCreate: &protocol.PtyCreateSpec{Argv: append([]string{}, req.Argv...)},
		})
	}
	if err != nil {
		if h.opts.Single {
			h.mu.Lock()
			h.single = false
			h.mu.Unlock()
		}
		return nil, h.refuseErr(req, err)
	}
	h.channelsMu.Lock()
	h.channels[req.PTYID] = ch
	h.channelsMu.Unlock()
	return protocol.Deferred{Body: protocol.Empty{}, After: func() { h.start(req, ch) }}, nil
}

// start opens the terminal's process after the success response went out.
func (h *Host) start(req protocol.PTYOpen, ch Channel) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if ch.BeforeStart != nil && !ch.BeforeStart(req.PTYID) {
		// The connection ended while the response was in flight; its teardown records the
		// accepted-but-not-started terminal.
		h.forget(req.PTYID)
		return
	}
	if _, err := h.mgr.Open(pty.OpenRequest{
		ID:         req.PTYID,
		Argv:       req.Argv,
		Rows:       uint64(req.Rows),
		Cols:       uint64(req.Cols),
		Privileged: true,
	}); err != nil {
		h.forget(req.PTYID)
		h.log.Error("start a terminal", "terminal", req.PTYID, "err", err)
		h.recordClosed(req.PTYID, nil, "the terminal could not be started: "+err.Error())
		ch.emit(wire.EventPTYExited, protocol.PTYExited{
			PTYID:    req.PTYID,
			ExitCode: protocol.Int(-1),
			Reason:   protocol.PTYExitReasonExited,
		})
	}
}

// handleInput implements the crh-priv pty.input command.
func (h *Host) handleInput(_ context.Context, raw cbor.RawMessage) (any, error) {
	var req wire.PrivPTYInput
	if err := protocol.UnmarshalBody(raw, &req); err != nil {
		return nil, err
	}
	t := h.mgr.Get(req.PTYID)
	if t == nil {
		return nil, &protocol.RemoteError{Code: protocol.CodeNotFound, Message: "unknown terminal " + req.PTYID}
	}
	if len(req.Data) == 0 {
		return protocol.Empty{}, nil
	}
	if _, err := t.Write(req.Data); err != nil {
		return nil, &protocol.RemoteError{Code: protocol.CodeIOError, Message: "write to the terminal: " + err.Error()}
	}
	return protocol.Empty{}, nil
}

// handleResize implements the crh-priv pty.resize command. An unknown id is not_found and an
// out-of-range size invalid_spec, exactly as an unprivileged pty.resize answers.
func (h *Host) handleResize(_ context.Context, raw cbor.RawMessage) (any, error) {
	var req protocol.PTYResize
	if err := protocol.UnmarshalBody(raw, &req); err != nil {
		return nil, err
	}
	return protocol.Empty{}, h.mgr.Resize(req.PTYID, uint64(req.Rows), uint64(req.Cols))
}

// handleClose implements the crh-priv pty.close command. An unknown id is still a success, so
// pty.close stays idempotent.
func (h *Host) handleClose(_ context.Context, raw cbor.RawMessage) (any, error) {
	var req protocol.PTYClose
	if err := protocol.UnmarshalBody(raw, &req); err != nil {
		return nil, err
	}
	detail := req.Reason
	if detail == "" {
		detail = "closed by the unprivileged mode"
	}
	h.Close(req.PTYID, detail)
	return protocol.Empty{}, nil
}

// Close removes a terminal, records the close and closes its process group. It reports false for an
// unknown id.
func (h *Host) Close(id, detail string) bool {
	h.mu.Lock()
	t := h.mgr.Drop(id)
	h.mu.Unlock()
	if t == nil {
		return false
	}
	var code *int
	if exited, exitCode := t.Exit(); exited {
		code = &exitCode
	}
	h.recordClosed(id, code, detail)
	closeTerminal := func() {
		if err := t.Close(); err != nil {
			h.log.Warn("close terminal", "id", id, "err", err)
		}
	}
	if h.opts.CloseWait {
		closeTerminal()
		return true
	}
	// pty.close's answer must not wait for a hangup grace period.
	go closeTerminal()
	return true
}

// refuse records a host-level refusal and builds its error response.
func (h *Host) refuse(req protocol.PTYOpen, refused *Refused) error {
	if h.opts.Recorder != nil {
		h.opts.Recorder.Refused(req.PTYID, req.Attempt, *refused)
	}
	return refused.Remote()
}

// refuseErr records an Authorize hook's refusal. A hook returns *Refused to carry a verification
// step; any other error keeps its wire code when it has one and is internal_error otherwise.
func (h *Host) refuseErr(req protocol.PTYOpen, err error) error {
	refused := &Refused{Code: protocol.CodeInternalError, Message: err.Error()}
	var stepRefusal *Refused
	var remote *protocol.RemoteError
	if errors.As(err, &stepRefusal) {
		refused = stepRefusal
	} else if errors.As(err, &remote) {
		refused = &Refused{Code: remote.Code, Message: remote.Message}
	}
	return h.refuse(req, refused)
}

func (h *Host) recordClosed(id string, code *int, detail string) {
	if h.opts.Recorder != nil {
		h.opts.Recorder.Closed(id, code, detail)
	}
}

// output feeds one chunk of a terminal's output back to the peer, on the terminal's reader.
func (h *Host) output(t *pty.Terminal, data []byte) {
	h.channelsMu.Lock()
	ch := h.channels[t.ID()]
	h.channelsMu.Unlock()
	ch.emit(wire.EventPTYOutput, wire.PrivPTYOutput{PTYID: t.ID(), Data: append([]byte(nil), data...)})
}

// exited reports a terminal's exit to the record and to its peer, once, after its last output. The
// record is written first: a peer that stops reading must not keep the exit out of the local log.
func (h *Host) exited(t *pty.Terminal) {
	_, code := t.Exit()
	if h.opts.Recorder != nil {
		h.opts.Recorder.Exited(t.ID(), code)
	}
	h.channelsMu.Lock()
	ch := h.channels[t.ID()]
	h.channelsMu.Unlock()
	ch.emit(wire.EventPTYExited, protocol.PTYExited{
		PTYID:    t.ID(),
		ExitCode: protocol.Int(code),
		Reason:   protocol.PTYExitReasonExited,
	})
}

// dropped forgets a terminal the manager removed, however it ended, and lets the caller forget it.
func (h *Host) dropped(t *pty.Terminal) {
	h.forget(t.ID())
	if h.opts.OnDrop != nil {
		h.opts.OnDrop(t)
	}
}

func (h *Host) forget(id string) {
	h.channelsMu.Lock()
	delete(h.channels, id)
	h.channelsMu.Unlock()
}

func (c Channel) emit(name string, body any) {
	if c.Emit != nil {
		c.Emit(name, body)
	}
}
