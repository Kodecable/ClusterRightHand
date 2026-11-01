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
// *ProtocolError is fatal for the connection instead, as required for malformed request
// bodies.
//
// By default handlers run synchronously inside Receive, on the goroutine that called it.
// A handler must not call Peer.Request and wait for its response: Receive is blocked in
// the handler, so the response cannot be processed and the call deadlocks. A handler
// should also not block for long, because every incoming frame waits behind it.
//
// With WithRequestWorker the handlers run on the Peer's own goroutines instead: requests
// for one task run one at a time and in arrival order, while requests for different tasks
// (and requests that name no task) proceed independently. A handler that blocks on another
// connection therefore stops neither responses and events nor the requests of other tasks.
// A handler that waits for a response from the same Peer still blocks the other requests
// for its own task, which wait behind it.
//
// A handler that returns a Deferred (or *Deferred) instead of a plain body defers the
// work that must not precede the response: the Peer sends Deferred.Body as the success
// response, then calls Deferred.After after send accepted the response frame. That is how
// a handler starts a task whose task.output and task.exit events are guaranteed to follow
// the task.start response. After may call Peer.Emit; it must not wait for a Peer.Request
// response for the same reason as above. If Deferred.Body cannot be encoded, the Peer
// sends an internal_error response instead and does not call After; if the response cannot
// be sent (the peer is closed), After is not called either. A nil *Deferred is treated as
// an empty Deferred.
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
	send           func([]byte) error
	negotiated     Set
	commandSchemas map[string]commandSchema
	ctx            context.Context
	cancel         context.CancelFunc

	sendMu sync.Mutex // serializes send and Close
	recvMu sync.Mutex // serializes Receive

	// worker runs the request handlers off the receive loop (WithRequestWorker). queues holds
	// the requests waiting per ordering key, and active records the keys whose goroutine is
	// draining their queue: one task's requests stay in order, different tasks run at once.
	worker bool
	queues map[string][]*Frame
	active map[string]bool

	mu              sync.Mutex
	nextID          Uint
	pending         map[Uint]*pendingCall
	requestHandlers map[string]RequestHandler
	eventHandlers   map[string]EventHandler
	closed          bool
	closeErr        error
}

// PeerOption configures a Peer at construction.
type PeerOption func(*Peer)

// WithRequestWorker runs request handlers on the Peer's own goroutines instead of inside
// Receive. Requests are ordered per task: every task id has a queue holding its requests in
// arrival order, and one queue holds the requests that name no task (hello, ping,
// revocations.add). Each queue is drained by its own goroutine, so a handler that blocks on
// another connection — a forwarded request waiting for the privileged mode, for example —
// delays neither the receive loop nor the requests of a different task. The queues are unbounded, so a blocked task
// accumulates the frames behind it instead of stalling the connection; the peer bounds that by
// not sending more than it awaits. Requests still queued when Close is called are dropped: no
// handler ever accepted them, and the peer can no longer send an answer.
func WithRequestWorker() PeerOption {
	return func(p *Peer) { p.worker = true }
}

// NewPeer returns a Peer that writes outgoing frames with send and accepts only the
// command and event names in negotiated (the intersection of both handshake lists).
func NewPeer(send func([]byte) error, negotiated Set, opts ...PeerOption) *Peer {
	ctx, cancel := context.WithCancel(context.Background())
	p := &Peer{
		send:            send,
		negotiated:      negotiated.Clone(),
		commandSchemas:  cloneCommandSchemas(),
		ctx:             ctx,
		cancel:          cancel,
		pending:         make(map[Uint]*pendingCall),
		requestHandlers: make(map[string]RequestHandler),
		eventHandlers:   make(map[string]EventHandler),
	}
	p.queues = make(map[string][]*Frame)
	p.active = make(map[string]bool)
	for _, opt := range opts {
		opt(p)
	}
	return p
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

// RegisterCommand adds the request and response body schemas of a command to this Peer.
// It exists for protocols that reuse Peer's frames and bodies but have commands of their
// own: crh-priv's trust.query, pending.list, local.approve and local.deny are not part of
// the crhs <-> crha registry, so they are registered on the peering that needs them.
// Register schemas before the first Receive.
func (p *Peer) RegisterCommand(cmd string, request, response func() any) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.commandSchemas == nil {
		p.commandSchemas = make(map[string]commandSchema)
	}
	p.commandSchemas[cmd] = commandSchema{request: request, response: response}
}

// schemas returns the body schemas of a command this Peer knows, if any.
func (p *Peer) schemas(cmd string) (commandSchema, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	schema, ok := p.commandSchemas[cmd]
	return schema, ok
}

// cloneCommandSchemas copies the package registry into a Peer's own map, so extensions
// stay local to one peer.
func cloneCommandSchemas() map[string]commandSchema {
	out := make(map[string]commandSchema, len(commandSchemas))
	for name, schema := range commandSchemas {
		out[name] = schema
	}
	return out
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
	if schema, ok := p.schemas(cmd); ok {
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

// Receive processes one complete frame from the peer. For a request it runs the handler
// and sends the response (and the handler's Deferred.After hook), either here or, with
// WithRequestWorker, on the peer's request worker. Every malformed input, unknown
// response id, mismatched response command and unexpected event is reported as
// *ProtocolError.
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
	// The queue goroutines see closed on their next turn and drop what they have not taken:
	// no handler ran for those requests, and the peer can no longer answer them.
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
		if schema, ok := p.schemas(f.Name); ok {
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
		if err := UnmarshalBody(f.Body, call.resp); err != nil {
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
	if schema, ok := p.schemas(f.Name); ok {
		if err := schema.validateRequest(f.Body); err != nil {
			return err
		}
	}

	p.mu.Lock()
	handler := p.requestHandlers[f.Name]
	negotiated := p.negotiated.Has(f.Name)
	if p.worker && negotiated && handler != nil {
		key := requestOrderKey(f.Name, f.Body)
		p.queues[key] = append(p.queues[key], f)
		if !p.active[key] {
			p.active[key] = true
			go p.serveRequests(key)
		}
		p.mu.Unlock()
		return nil
	}
	p.mu.Unlock()

	if !negotiated || handler == nil {
		// The cmd field already carries the name; do not repeat it in the message.
		return p.sendErrorResponse(f.ID, f.Name, "unsupported_command", "command is not supported")
	}
	return p.runRequest(f, handler)
}

// serveRequests runs the queued requests of one ordering key, one at a time and in arrival order,
// until that queue is empty or the peer closes. Running handlers here instead of inside Receive is
// what keeps a blocked handler (a forwarded request waiting for the privileged mode) from stalling
// the responses and events behind it; one goroutine per key keeps the order that matters per task
// and lets the requests of different tasks run at the same time.
func (p *Peer) serveRequests(key string) {
	for {
		p.mu.Lock()
		if p.closed {
			p.mu.Unlock()
			return
		}
		queue := p.queues[key]
		if len(queue) == 0 {
			delete(p.queues, key)
			p.active[key] = false
			p.mu.Unlock()
			return
		}
		f := queue[0]
		queue[0] = nil
		p.queues[key] = queue[1:]
		handler := p.requestHandlers[f.Name]
		p.mu.Unlock()
		if handler == nil {
			// Handlers are registered before Receive starts, so this cannot happen; skip the
			// request rather than answer it with the wrong result.
			continue
		}
		if err := p.runRequest(f, handler); err != nil {
			// A handler error is fatal for the connection, exactly as when Receive ran the
			// handler synchronously. Closing the peer makes the receive loop report ErrClosed on
			// its next frame; a transport failure is also seen by the caller's next read.
			p.Close(err)
			return
		}
	}
}

// taskCommands are the commands crhs sends whose request tuple starts with the task id: the worker
// runs their requests in the order they arrived for that task, because a task.start must precede its
// task.input chunks and the cancel that follows them. The other commands (hello, ping,
// revocations.add) name no task, so they share one queue.
var taskCommands = map[string]bool{
	CmdTaskStart:     true,
	CmdTaskInput:     true,
	CmdTaskCancel:    true,
	CmdTaskQuery:     true,
	CmdLocalRequest:  true,
	CmdLocalWithdraw: true,
}

// requestOrderKey returns the ordering key of one request: the task id of a task command, or "" for
// a request that names no task. The body was validated before it was queued, so a decoding failure
// here cannot happen; falling back to the shared queue keeps such a request ordered at least among
// the requests that name no task.
func requestOrderKey(cmd string, body cbor.RawMessage) string {
	if !taskCommands[cmd] {
		return ""
	}
	var args []cbor.RawMessage
	if err := decMode.Unmarshal(body, &args); err != nil || len(args) == 0 {
		return ""
	}
	var taskID string
	if err := decMode.Unmarshal(args[0], &taskID); err != nil {
		return ""
	}
	return taskID
}

// runRequest invokes one request handler, sends its response and then runs the handler's Deferred
// hook. The returned error is fatal for the connection (a protocol error or a failed send).
func (p *Peer) runRequest(f *Frame, handler RequestHandler) error {
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
	if schema, ok := p.schemas(f.Name); ok {
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
// after-send hook. For every other value the hook is nil, so runRequest can treat all
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
	// A received event body is validated like a received request body, before the handler
	// sees it: an event this package knows must decode, and a body that does not is a
	// protocol error that closes the connection. Validating here also covers the native
	// helper's bufferedEvents, whose handlers only ever receive validated bodies.
	if err := validateEventBody(f.Name, f.Body); err != nil {
		return err
	}

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
