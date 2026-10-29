package protocol

import (
	"context"
	"errors"
	"fmt"
	"sync"

	"github.com/fxamacker/cbor/v2"
)

// ErrClosed reports that a Peer was closed while a request was pending or before a
// request/event was sent. Close wraps its cause with it.
var ErrClosed = errors.New("protocol: peer closed")

// RemoteError is an error response sent by the peer: [code, message].
type RemoteError struct {
	Code    string
	Message string
}

func (e *RemoteError) Error() string {
	return fmt.Sprintf("remote error %s: %s", e.Code, e.Message)
}

// Deferred is a response body plus a function the Peer runs right after the response
// frame has been handed to send. A RequestHandler returns it when follow-up work (such
// as starting a task whose events must follow the response) must not race the response.
//
// The Peer encodes and sends Body as the success response and calls After only when that
// send succeeded, so an event emitted by After is ordered after the response frame. If
// Body cannot be encoded, an internal_error response is sent and After is not called. If
// the response cannot be sent, for example because the peer is closed, After is not
// called either.
type Deferred struct {
	Body  any
	After func()
}

// RequestHandler handles one incoming request. It decodes body itself (usually with
// Unmarshal), returns the response body, or returns a *RemoteError to send an error
// response. Any other error is reported to the peer as internal_error; returning a
// *ProtocolError aborts Receive instead, as required for malformed request bodies.
//
// Handlers run synchronously inside Receive, on the goroutine that called it. A handler
// must not call Peer.Request and wait for its response: Receive is blocked in the
// handler, so the response cannot be processed and the call deadlocks. A handler should
// also not block for long, because every incoming frame waits behind it.
//
// A handler that returns a Deferred (or *Deferred) instead of a plain body defers the
// work that must not precede the response: the Peer sends Deferred.Body as the success
// response, then calls Deferred.After synchronously, still inside Receive, after send
// accepted the response frame. That is how a handler starts a task whose task.output and
// task.exit events are guaranteed to follow the task.start response. After may call
// Peer.Emit; it must not wait for a Peer.Request response for the same reason as above.
// If Deferred.Body cannot be encoded, the Peer sends an internal_error response instead
// and does not call After; if the response cannot be sent (the peer is closed), After is
// not called either. A nil *Deferred is treated as an empty Deferred.
type RequestHandler func(ctx context.Context, body cbor.RawMessage) (any, error)

// EventHandler handles one incoming event. A non-nil error is a protocol error: events
// have no error response, so the receiver closes the connection.
type EventHandler func(body cbor.RawMessage) error

type pendingCall struct {
	cmd       string
	resp      any
	done      chan callResult
	abandoned bool
}

type callResult struct{ err error }

// Peer multiplexes requests, responses and events over one ordered message stream.
// Request and Emit are safe for concurrent use; Receive must be called from a single
// goroutine. Outgoing frames are serialized internally, so send is called from one
// goroutine at a time and need not be safe for concurrent use.
//
// Peers do not own the transport: the caller writes frames returned by send and passes
// every received frame to Receive. A Receive error is fatal for the connection; the
// caller must close it and call Close.
type Peer struct {
	send       func([]byte) error
	negotiated Set
	ctx        context.Context
	cancel     context.CancelFunc

	sendMu sync.Mutex // serializes send and Close
	recvMu sync.Mutex // serializes Receive

	mu              sync.Mutex
	nextID          Uint
	pending         map[Uint]*pendingCall
	requestHandlers map[string]RequestHandler
	eventHandlers   map[string]EventHandler
	closed          bool
	closeErr        error
}

// NewPeer returns a Peer that writes outgoing frames with send and accepts only the
// command and event names in negotiated (the intersection of both handshake lists).
func NewPeer(send func([]byte) error, negotiated Set) *Peer {
	ctx, cancel := context.WithCancel(context.Background())
	return &Peer{
		send:            send,
		negotiated:      negotiated.Clone(),
		ctx:             ctx,
		cancel:          cancel,
		pending:         make(map[Uint]*pendingCall),
		requestHandlers: make(map[string]RequestHandler),
		eventHandlers:   make(map[string]EventHandler),
	}
}

// HandleRequest registers the handler for an incoming command. Registering a nil
// handler removes it. Handlers should be registered before Receive starts.
func (p *Peer) HandleRequest(cmd string, handler RequestHandler) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if handler == nil {
		delete(p.requestHandlers, cmd)
		return
	}
	p.requestHandlers[cmd] = handler
}

// HandleEvent registers the handler for an incoming event. Registering a nil handler
// removes it. Handlers should be registered before Receive starts.
func (p *Peer) HandleEvent(name string, handler EventHandler) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if handler == nil {
		delete(p.eventHandlers, name)
		return
	}
	p.eventHandlers[name] = handler
}

// Request sends one command and waits for its response. ids start at 1 and are private
// to this Peer. An error response is returned as *RemoteError. If Close is called while
// the request is pending, the request returns an error wrapping ErrClosed. Cancelling
// ctx abandons the request; a response that arrives later is ignored.
func (p *Peer) Request(ctx context.Context, cmd string, req, resp any) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if !p.negotiated.Has(cmd) {
		return fmt.Errorf("protocol: command %q was not negotiated", cmd)
	}
	body, err := Marshal(req)
	if err != nil {
		return err
	}
	if schema, ok := commandSchemas[cmd]; ok {
		if err := schema.validateRequest(body); err != nil {
			return encodeErrorf("protocol: request %q body: %w", cmd, err)
		}
	}
	call := &pendingCall{cmd: cmd, resp: resp, done: make(chan callResult, 1)}

	p.mu.Lock()
	if p.closed {
		err := p.closedErrorLocked()
		p.mu.Unlock()
		return err
	}
	if uint64(p.nextID) >= MaxSafeInteger {
		p.mu.Unlock()
		return errors.New("protocol: request id space exhausted")
	}
	p.nextID++
	id := p.nextID
	p.pending[id] = call
	p.mu.Unlock()

	frame, err := (&Frame{Kind: FrameRequest, ID: id, Name: cmd, Body: body}).Encode()
	if err != nil {
		p.forget(id, call)
		return err
	}
	if err := p.sendFrame(frame); err != nil {
		p.forget(id, call)
		return fmt.Errorf("protocol: send request %q: %w", cmd, err)
	}

	select {
	case result := <-call.done:
		return result.err
	case <-ctx.Done():
		p.mu.Lock()
		if current, ok := p.pending[id]; ok && current == call {
			// Keep the entry as a tombstone so a late response is swallowed
			// rather than reported as an unknown response id.
			current.abandoned = true
		}
		p.mu.Unlock()
		return ctx.Err()
	}
}

// Emit sends an event. Events have no response. A body that does not match the event's
// schema is rejected before anything is sent.
func (p *Peer) Emit(name string, body any) error {
	if !p.negotiated.Has(name) {
		return fmt.Errorf("protocol: event %q was not negotiated", name)
	}
	raw, err := Marshal(body)
	if err != nil {
		return err
	}
	if err := validateEventBody(name, raw); err != nil {
		return encodeErrorf("protocol: event %q body: %w", name, err)
	}
	frame, err := (&Frame{Kind: FrameEvent, Name: name, Body: raw}).Encode()
	if err != nil {
		return err
	}
	return p.sendFrame(frame)
}

// Receive processes one complete frame from the peer. It may send a response frame
// through the send function, followed by a Deferred.After hook returned by a request
// handler. Every malformed input, unknown response id, mismatched response command and
// unexpected event is reported as *ProtocolError.
func (p *Peer) Receive(frame []byte) error {
	p.recvMu.Lock()
	defer p.recvMu.Unlock()

	p.mu.Lock()
	if p.closed {
		err := p.closedErrorLocked()
		p.mu.Unlock()
		return err
	}
	p.mu.Unlock()

	f, err := DecodeFrame(frame)
	if err != nil {
		return err
	}
	switch f.Kind {
	case FrameRequest:
		return p.handleRequest(f)
	case FrameResponse:
		return p.handleResponse(f)
	case FrameEvent:
		return p.handleEvent(f)
	default:
		return protocolErrorf("unknown frame kind %d", f.Kind)
	}
}

// Close closes the peer and fails every pending request with an error wrapping
// ErrClosed. err is attached as the cause when non-nil. Close is idempotent; the first
// cause wins. Subsequent Request, Emit and Receive calls also return ErrClosed.
func (p *Peer) Close(err error) {
	p.sendMu.Lock()
	defer p.sendMu.Unlock()

	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return
	}
	p.closed = true
	p.closeErr = err
	pending := p.pending
	p.pending = make(map[Uint]*pendingCall)
	p.mu.Unlock()

	p.cancel()
	closedErr := p.closedError(err)
	for _, call := range pending {
		call.done <- callResult{err: closedErr}
	}
}

func (p *Peer) handleResponse(f *Frame) error {
	p.mu.Lock()
	call, ok := p.pending[f.ID]
	if !ok {
		p.mu.Unlock()
		return protocolErrorf("response for unknown request id %d", f.ID)
	}
	if call.cmd != f.Name {
		delete(p.pending, f.ID)
		p.mu.Unlock()
		err := protocolErrorf("response command %q does not match request %q", f.Name, call.cmd)
		call.done <- callResult{err: err}
		return err
	}
	delete(p.pending, f.ID)
	abandoned := call.abandoned
	p.mu.Unlock()

	// A successful response of a known command is always validated against the command's
	// schema, whether the caller wants the body and whether it still waits for it: a
	// malformed response is a protocol error even for an abandoned call.
	if f.OK {
		if schema, ok := commandSchemas[f.Name]; ok {
			if err := schema.validateResponse(f.Body); err != nil {
				if !abandoned {
					call.done <- callResult{err: err}
				}
				return err
			}
		}
	}
	if abandoned {
		return nil
	}
	if !f.OK {
		call.done <- callResult{err: &RemoteError{Code: f.Err.Code, Message: f.Err.Message}}
		return nil
	}
	if call.resp != nil {
		// The body is valid for the command; failing to decode it into the caller's type
		// is a caller bug, not a reason to drop the connection.
		if err := Unmarshal(f.Body, call.resp); err != nil {
			call.done <- callResult{err: err}
			return nil
		}
	}
	call.done <- callResult{}
	return nil
}

func (p *Peer) handleRequest(f *Frame) error {
	// A command this package knows is decoded before the negotiation and handler
	// checks, even if nobody is going to handle it; only a completely unknown name
	// is answered without inspecting its body.
	if schema, ok := commandSchemas[f.Name]; ok {
		if err := schema.validateRequest(f.Body); err != nil {
			return err
		}
	}

	p.mu.Lock()
	handler := p.requestHandlers[f.Name]
	negotiated := p.negotiated.Has(f.Name)
	p.mu.Unlock()

	if !negotiated || handler == nil {
		// The cmd field already carries the name; do not repeat it in the message.
		return p.sendErrorResponse(f.ID, f.Name, "unsupported_command", "command is not supported")
	}

	result, err := handler(p.ctx, f.Body)
	if err != nil {
		var remote *RemoteError
		if errors.As(err, &remote) {
			return p.sendErrorResponse(f.ID, f.Name, remote.Code, remote.Message)
		}
		var protocolErr *ProtocolError
		if errors.As(err, &protocolErr) {
			return protocolErr
		}
		return p.sendErrorResponse(f.ID, f.Name, "internal_error", err.Error())
	}

	result, after := unwrapDeferred(result)

	raw, err := Marshal(result)
	if err != nil {
		return p.sendErrorResponse(f.ID, f.Name, "internal_error", err.Error())
	}
	// A success body must be valid for the command's schema even if the caller ignores it;
	// a handler result that is not cannot be sent as a success response.
	if schema, ok := commandSchemas[f.Name]; ok {
		if err := schema.validateResponse(raw); err != nil {
			return p.sendErrorResponse(f.ID, f.Name, "internal_error", err.Error())
		}
	}
	frame, err := (&Frame{Kind: FrameResponse, ID: f.ID, Name: f.Name, OK: true, Body: raw}).Encode()
	if err != nil {
		return p.sendErrorResponse(f.ID, f.Name, "internal_error", err.Error())
	}
	if err := p.sendFrame(frame); err != nil {
		return err
	}
	if after != nil {
		after()
	}
	return nil
}

// unwrapDeferred splits a handler result into the response body and the optional
// after-send hook. For every other value the hook is nil, so handleRequest can treat all
// results the same way. A nil *Deferred yields a nil body and no hook.
func unwrapDeferred(result any) (body any, after func()) {
	switch deferred := result.(type) {
	case Deferred:
		return deferred.Body, deferred.After
	case *Deferred:
		if deferred == nil {
			return nil, nil
		}
		return deferred.Body, deferred.After
	default:
		return result, nil
	}
}

func (p *Peer) handleEvent(f *Frame) error {
	p.mu.Lock()
	handler := p.eventHandlers[f.Name]
	negotiated := p.negotiated.Has(f.Name)
	p.mu.Unlock()

	if !negotiated {
		return protocolErrorf("event %q was not negotiated", f.Name)
	}
	if handler == nil {
		return protocolErrorf("event %q has no handler", f.Name)
	}
	if err := handler(f.Body); err != nil {
		var protocolErr *ProtocolError
		if errors.As(err, &protocolErr) {
			return protocolErr
		}
		return &ProtocolError{Err: fmt.Errorf("event %q: %w", f.Name, err)}
	}
	return nil
}

func (p *Peer) sendErrorResponse(id Uint, cmd, code, message string) error {
	frame, err := EncodeErrorResponse(id, cmd, code, ErrorMessage(message))
	if err != nil {
		return err
	}
	return p.sendFrame(frame)
}

// sendFrame serializes access to send and refuses to write after Close, so a frame
// cannot be handed to the transport after the peer has been torn down.
func (p *Peer) sendFrame(frame []byte) error {
	p.sendMu.Lock()
	defer p.sendMu.Unlock()

	p.mu.Lock()
	closed := p.closed
	var closedErr error
	if closed {
		closedErr = p.closedErrorLocked()
	}
	p.mu.Unlock()
	if closed {
		return closedErr
	}
	return p.send(frame)
}

func (p *Peer) forget(id Uint, call *pendingCall) {
	p.mu.Lock()
	if current, ok := p.pending[id]; ok && current == call {
		delete(p.pending, id)
	}
	p.mu.Unlock()
}

func (p *Peer) closedErrorLocked() error {
	if p.closeErr == nil {
		return ErrClosed
	}
	return fmt.Errorf("%w: %w", ErrClosed, p.closeErr)
}

func (p *Peer) closedError(cause error) error {
	if cause == nil {
		return ErrClosed
	}
	return fmt.Errorf("%w: %w", ErrClosed, cause)
}
