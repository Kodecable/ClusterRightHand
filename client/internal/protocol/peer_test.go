package protocol

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/fxamacker/cbor/v2"
)

type testPeer struct {
	t    *testing.T
	peer *Peer
	out  chan []byte
}

func newTestPeer(t *testing.T, names ...string) *testPeer {
	t.Helper()
	out := make(chan []byte, 128)
	peer := NewPeer(func(frame []byte) error {
		select {
		case out <- frame:
			return nil
		default:
			return errors.New("test transport buffer full")
		}
	}, NewSet(names...))
	return &testPeer{t: t, peer: peer, out: out}
}

func (tp *testPeer) nextFrame() []byte {
	tp.t.Helper()
	select {
	case frame := <-tp.out:
		return frame
	case <-time.After(2 * time.Second):
		tp.t.Fatal("no frame was sent")
		return nil
	}
}

func (tp *testPeer) requestID(t *testing.T, frame []byte) Uint {
	t.Helper()
	decoded, err := DecodeFrame(frame)
	if err != nil {
		t.Fatalf("DecodeFrame: %v", err)
	}
	return decoded.ID
}

func startRequest(ctx context.Context, p *Peer, cmd string, req, resp any) <-chan error {
	done := make(chan error, 1)
	go func() { done <- p.Request(ctx, cmd, req, resp) }()
	return done
}

func TestPeerOutOfOrderResponses(t *testing.T) {
	tp := newTestPeer(t, CmdPing)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	var first, second Ping
	firstDone := startRequest(ctx, tp.peer, CmdPing, Ping{Seq: 1}, &first)
	secondDone := startRequest(ctx, tp.peer, CmdPing, Ping{Seq: 2}, &second)

	ids := make([]Uint, 2)
	seqs := make([]Uint, 2)
	for i := range ids {
		frame, err := DecodeFrame(tp.nextFrame())
		if err != nil {
			t.Fatalf("DecodeFrame: %v", err)
		}
		ids[i] = frame.ID
		var ping Ping
		if err := Unmarshal(frame.Body, &ping); err != nil {
			t.Fatalf("request body: %v", err)
		}
		seqs[i] = ping.Seq
	}
	if ids[0] == ids[1] {
		t.Fatalf("duplicate request id %d", ids[0])
	}

	// Respond to the second request first, echoing each request's seq.
	for i := 1; i >= 0; i-- {
		response, err := EncodeResponse(ids[i], CmdPing, Ping{Seq: seqs[i]})
		if err != nil {
			t.Fatalf("EncodeResponse: %v", err)
		}
		if err := tp.peer.Receive(response); err != nil {
			t.Fatalf("Receive: %v", err)
		}
	}
	if err := <-firstDone; err != nil {
		t.Fatalf("first request: %v", err)
	}
	if err := <-secondDone; err != nil {
		t.Fatalf("second request: %v", err)
	}
	if first.Seq != 1 || second.Seq != 2 {
		t.Fatalf("responses = %d, %d", first.Seq, second.Seq)
	}
}

func TestPeerRemoteError(t *testing.T) {
	tp := newTestPeer(t, CmdPing)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	done := startRequest(ctx, tp.peer, CmdPing, Ping{Seq: 1}, &Ping{})
	frame := tp.nextFrame()
	id := tp.requestID(t, frame)
	response, err := EncodeErrorResponse(id, CmdPing, "node_pending", "not approved")
	if err != nil {
		t.Fatalf("EncodeErrorResponse: %v", err)
	}
	if err := tp.peer.Receive(response); err != nil {
		t.Fatalf("Receive: %v", err)
	}
	err = <-done
	var remote *RemoteError
	if !errors.As(err, &remote) {
		t.Fatalf("error = %v (%T), want *RemoteError", err, err)
	}
	if remote.Code != "node_pending" || remote.Message != "not approved" {
		t.Fatalf("remote error = %#v", remote)
	}
	if got, want := remote.Error(), "remote error node_pending: not approved"; got != want {
		t.Fatalf("RemoteError.Error() = %q, want %q", got, want)
	}
}

func TestPeerCloseFailsPending(t *testing.T) {
	tp := newTestPeer(t, CmdPing, EventFacts)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	done := startRequest(ctx, tp.peer, CmdPing, Ping{Seq: 1}, &Ping{})
	tp.nextFrame()

	cause := errors.New("boom")
	tp.peer.Close(cause)
	err := <-done
	if !errors.Is(err, ErrClosed) {
		t.Fatalf("pending request error = %v, want ErrClosed", err)
	}
	if !errors.Is(err, cause) {
		t.Fatalf("pending request error = %v, want cause", err)
	}

	if err := tp.peer.Receive([]byte{0x80}); !errors.Is(err, ErrClosed) {
		t.Fatalf("Receive after Close = %v, want ErrClosed", err)
	}
	if err := tp.peer.Emit(EventFacts, sampleFacts()); !errors.Is(err, ErrClosed) {
		t.Fatalf("Emit after Close = %v, want ErrClosed", err)
	}
	if err := tp.peer.Request(ctx, CmdPing, Ping{Seq: 2}, &Ping{}); !errors.Is(err, ErrClosed) {
		t.Fatalf("Request after Close = %v, want ErrClosed", err)
	}
	tp.peer.Close(errors.New("second")) // idempotent
}

func TestPeerUnsupportedCommand(t *testing.T) {
	for _, test := range []struct {
		name       string
		negotiated []string
		register   bool
	}{
		{"not negotiated", []string{CmdHello}, false},
		{"no handler", []string{CmdPing}, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			tp := newTestPeer(t, test.negotiated...)
			request, err := EncodeRequest(9, CmdPing, Ping{Seq: 1})
			if err != nil {
				t.Fatalf("EncodeRequest: %v", err)
			}
			if err := tp.peer.Receive(request); err != nil {
				t.Fatalf("Receive: %v", err)
			}
			frame, err := DecodeFrame(tp.nextFrame())
			if err != nil {
				t.Fatalf("DecodeFrame: %v", err)
			}
			if frame.Kind != FrameResponse || frame.ID != 9 || frame.Name != CmdPing || frame.OK {
				t.Fatalf("response = %#v", frame)
			}
			if frame.Err == nil || frame.Err.Code != "unsupported_command" {
				t.Fatalf("error = %#v", frame.Err)
			}
		})
	}
}

func TestPeerValidatesKnownCommandBodies(t *testing.T) {
	malformedPing := func(t *testing.T) []byte {
		t.Helper()
		// A ping body must be [seq: uint]; Welcome is a one-element array whose
		// first element is itself an array, so this is well-formed CBOR with the
		// wrong schema.
		request, err := EncodeRequest(20, CmdPing, Welcome{Acks: []OutputAck{}})
		if err != nil {
			t.Fatalf("EncodeRequest: %v", err)
		}
		return request
	}
	expectUnsupported := func(t *testing.T, tp *testPeer, err error) {
		t.Helper()
		if err != nil {
			t.Fatalf("Receive: %v", err)
		}
		frame, err := DecodeFrame(tp.nextFrame())
		if err != nil {
			t.Fatalf("DecodeFrame: %v", err)
		}
		if frame.Kind != FrameResponse || frame.OK || frame.Err == nil || frame.Err.Code != "unsupported_command" {
			t.Fatalf("response = %#v, want unsupported_command", frame)
		}
	}

	t.Run("known not negotiated malformed body", func(t *testing.T) {
		tp := newTestPeer(t, CmdHello)
		err := tp.peer.Receive(malformedPing(t))
		var protocolErr *ProtocolError
		if !errors.As(err, &protocolErr) {
			t.Fatalf("Receive = %v (%T), want *ProtocolError", err, err)
		}
		select {
		case frame := <-tp.out:
			t.Fatalf("sent a response for a malformed known command body: %x", frame)
		default:
		}
	})

	t.Run("known no handler malformed body", func(t *testing.T) {
		tp := newTestPeer(t, CmdPing)
		err := tp.peer.Receive(malformedPing(t))
		var protocolErr *ProtocolError
		if !errors.As(err, &protocolErr) {
			t.Fatalf("Receive = %v (%T), want *ProtocolError", err, err)
		}
	})

	t.Run("known handler exists malformed body", func(t *testing.T) {
		tp := newTestPeer(t, CmdPing)
		called := false
		tp.peer.HandleRequest(CmdPing, func(context.Context, cbor.RawMessage) (any, error) {
			called = true
			return Ping{Seq: 1}, nil
		})
		err := tp.peer.Receive(malformedPing(t))
		var protocolErr *ProtocolError
		if !errors.As(err, &protocolErr) {
			t.Fatalf("Receive = %v (%T), want *ProtocolError", err, err)
		}
		if called {
			t.Fatal("handler ran before the known command body was validated")
		}
	})

	t.Run("known not negotiated valid body", func(t *testing.T) {
		tp := newTestPeer(t, CmdHello)
		request, err := EncodeRequest(21, CmdPing, Ping{Seq: 1})
		if err != nil {
			t.Fatalf("EncodeRequest: %v", err)
		}
		expectUnsupported(t, tp, tp.peer.Receive(request))
	})

	t.Run("unknown command malformed body", func(t *testing.T) {
		tp := newTestPeer(t, CmdHello)
		// "future.command" is not in the schema, so its body must not be decoded.
		request, err := (&Frame{
			Kind: FrameRequest, ID: 22, Name: "future.command",
			Body: mustHex(t, "820000"),
		}).Encode()
		if err != nil {
			t.Fatalf("Encode: %v", err)
		}
		expectUnsupported(t, tp, tp.peer.Receive(request))
	})
}

func TestPeerRequestHandlers(t *testing.T) {
	t.Run("success", func(t *testing.T) {
		tp := newTestPeer(t, CmdPing)
		tp.peer.HandleRequest(CmdPing, func(_ context.Context, body cbor.RawMessage) (any, error) {
			var ping Ping
			if err := Unmarshal(body, &ping); err != nil {
				return nil, err
			}
			return Ping{Seq: ping.Seq + 1}, nil
		})
		request, err := EncodeRequest(4, CmdPing, Ping{Seq: 1})
		if err != nil {
			t.Fatalf("EncodeRequest: %v", err)
		}
		if err := tp.peer.Receive(request); err != nil {
			t.Fatalf("Receive: %v", err)
		}
		frame, err := DecodeFrame(tp.nextFrame())
		if err != nil {
			t.Fatalf("DecodeFrame: %v", err)
		}
		if !frame.OK || frame.ID != 4 {
			t.Fatalf("response = %#v", frame)
		}
		var ping Ping
		if err := Unmarshal(frame.Body, &ping); err != nil || ping.Seq != 2 {
			t.Fatalf("body = %#v, err = %v", ping, err)
		}
	})
	t.Run("remote error", func(t *testing.T) {
		tp := newTestPeer(t, CmdTaskQuery)
		tp.peer.HandleRequest(CmdTaskQuery, func(context.Context, cbor.RawMessage) (any, error) {
			return nil, &RemoteError{Code: "unknown_task", Message: "no such task"}
		})
		request, err := EncodeRequest(5, CmdTaskQuery, TaskQuery{TaskID: "t"})
		if err != nil {
			t.Fatalf("EncodeRequest: %v", err)
		}
		if err := tp.peer.Receive(request); err != nil {
			t.Fatalf("Receive: %v", err)
		}
		frame, err := DecodeFrame(tp.nextFrame())
		if err != nil {
			t.Fatalf("DecodeFrame: %v", err)
		}
		if frame.Err == nil || frame.Err.Code != "unknown_task" {
			t.Fatalf("response = %#v", frame)
		}
	})
	t.Run("internal error", func(t *testing.T) {
		tp := newTestPeer(t, CmdPing)
		tp.peer.HandleRequest(CmdPing, func(context.Context, cbor.RawMessage) (any, error) {
			return nil, errors.New("kaboom")
		})
		request, err := EncodeRequest(6, CmdPing, Ping{Seq: 1})
		if err != nil {
			t.Fatalf("EncodeRequest: %v", err)
		}
		if err := tp.peer.Receive(request); err != nil {
			t.Fatalf("Receive: %v", err)
		}
		frame, err := DecodeFrame(tp.nextFrame())
		if err != nil {
			t.Fatalf("DecodeFrame: %v", err)
		}
		if frame.Err == nil || frame.Err.Code != "internal_error" {
			t.Fatalf("response = %#v", frame)
		}
	})
	t.Run("protocol error aborts receive", func(t *testing.T) {
		tp := newTestPeer(t, CmdPing)
		tp.peer.HandleRequest(CmdPing, func(context.Context, cbor.RawMessage) (any, error) {
			return nil, &ProtocolError{Err: errors.New("bad body")}
		})
		request, err := EncodeRequest(7, CmdPing, Ping{Seq: 1})
		if err != nil {
			t.Fatalf("EncodeRequest: %v", err)
		}
		err = tp.peer.Receive(request)
		var protocolErr *ProtocolError
		if !errors.As(err, &protocolErr) {
			t.Fatalf("Receive = %v (%T), want *ProtocolError", err, err)
		}
		select {
		case frame := <-tp.out:
			t.Fatalf("sent a response for a protocol error: %x", frame)
		default:
		}
	})
}

func TestPeerInternalErrorSanitizesMessage(t *testing.T) {
	tp := newTestPeer(t, CmdPing)
	tp.peer.HandleRequest(CmdPing, func(context.Context, cbor.RawMessage) (any, error) {
		return nil, errors.New("open /tmp/bad\xff: no such file or directory")
	})
	request, err := EncodeRequest(23, CmdPing, Ping{Seq: 1})
	if err != nil {
		t.Fatalf("EncodeRequest: %v", err)
	}
	if err := tp.peer.Receive(request); err != nil {
		t.Fatalf("Receive: %v", err)
	}
	frame, err := DecodeFrame(tp.nextFrame())
	if err != nil {
		t.Fatalf("DecodeFrame: %v", err)
	}
	if frame.Kind != FrameResponse || frame.OK || frame.Err == nil || frame.Err.Code != "internal_error" {
		t.Fatalf("response = %#v, want internal_error", frame)
	}
	if !strings.Contains(frame.Err.Message, "�") {
		t.Fatalf("internal_error message = %q, want the invalid byte replaced", frame.Err.Message)
	}
}

func TestPeerHandlerResultMustMatchResponseSchema(t *testing.T) {
	newPingPeer := func(t *testing.T, handler RequestHandler) *testPeer {
		t.Helper()
		tp := newTestPeer(t, CmdPing)
		tp.peer.HandleRequest(CmdPing, handler)
		request, err := EncodeRequest(24, CmdPing, Ping{Seq: 1})
		if err != nil {
			t.Fatalf("EncodeRequest: %v", err)
		}
		if err := tp.peer.Receive(request); err != nil {
			t.Fatalf("Receive: %v", err)
		}
		return tp
	}
	expectInternalError := func(t *testing.T, tp *testPeer) {
		t.Helper()
		frame, err := DecodeFrame(tp.nextFrame())
		if err != nil {
			t.Fatalf("DecodeFrame: %v", err)
		}
		if frame.Kind != FrameResponse || frame.ID != 24 || frame.OK || frame.Err == nil || frame.Err.Code != "internal_error" {
			t.Fatalf("response = %#v, want an internal_error response", frame)
		}
	}

	t.Run("nil result", func(t *testing.T) {
		// A null body encodes fine, but it is not a valid ping response.
		tp := newPingPeer(t, func(context.Context, cbor.RawMessage) (any, error) {
			return nil, nil
		})
		expectInternalError(t, tp)
	})
	t.Run("after not run", func(t *testing.T) {
		afterRan := false
		tp := newPingPeer(t, func(context.Context, cbor.RawMessage) (any, error) {
			return Deferred{Body: nil, After: func() { afterRan = true }}, nil
		})
		expectInternalError(t, tp)
		if afterRan {
			t.Fatal("After ran although the result was not a valid success body")
		}
	})
}

func TestPeerValidatesAbandonedResponse(t *testing.T) {
	tp := newTestPeer(t, CmdPing)
	ctx, cancel := context.WithCancel(context.Background())
	done := startRequest(ctx, tp.peer, CmdPing, Ping{Seq: 1}, &Ping{})
	id := tp.requestID(t, tp.nextFrame())
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("request error = %v, want context.Canceled", err)
	}

	// "x" is not a valid ping response. The call is abandoned, but the peer must still
	// report the malformed response instead of swallowing it.
	response, err := EncodeResponse(id, CmdPing, "x")
	if err != nil {
		t.Fatalf("EncodeResponse: %v", err)
	}
	err = tp.peer.Receive(response)
	var protocolErr *ProtocolError
	if !errors.As(err, &protocolErr) {
		t.Fatalf("Receive = %v (%T), want *ProtocolError", err, err)
	}
}

func TestPeerSchemaValidationPrecedesCallerDestination(t *testing.T) {
	tp := newTestPeer(t, CmdPing)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	var anyVar any
	done := startRequest(ctx, tp.peer, CmdPing, Ping{Seq: 1}, &anyVar)
	id := tp.requestID(t, tp.nextFrame())
	response, err := EncodeResponse(id, CmdPing, "x")
	if err != nil {
		t.Fatalf("EncodeResponse: %v", err)
	}
	err = tp.peer.Receive(response)
	var protocolErr *ProtocolError
	if !errors.As(err, &protocolErr) {
		t.Fatalf("Receive = %v (%T), want *ProtocolError", err, err)
	}
	if requestErr := <-done; !errors.As(requestErr, &protocolErr) {
		t.Fatalf("request error = %v (%T), want *ProtocolError", requestErr, requestErr)
	}
}

func TestPeerCallerDecodeErrorIsNotProtocolError(t *testing.T) {
	tp := newTestPeer(t, CmdPing)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// The ping response body is a valid [seq: uint], but it cannot decode into an int.
	var notAnArray int
	done := startRequest(ctx, tp.peer, CmdPing, Ping{Seq: 1}, &notAnArray)
	id := tp.requestID(t, tp.nextFrame())
	response, err := EncodeResponse(id, CmdPing, Ping{Seq: 7})
	if err != nil {
		t.Fatalf("EncodeResponse: %v", err)
	}
	if err := tp.peer.Receive(response); err != nil {
		t.Fatalf("Receive = %v, want nil: a caller's destination type is not a protocol error", err)
	}
	if requestErr := <-done; requestErr == nil {
		t.Fatal("request succeeded although the response did not decode into its destination")
	}
}

func TestPeerInternalErrorTruncatesMessage(t *testing.T) {
	tp := newTestPeer(t, CmdPing)
	tp.peer.HandleRequest(CmdPing, func(context.Context, cbor.RawMessage) (any, error) {
		return nil, errors.New(strings.Repeat("x", 4*MaxErrorMessageBytes))
	})
	request, err := EncodeRequest(25, CmdPing, Ping{Seq: 1})
	if err != nil {
		t.Fatalf("EncodeRequest: %v", err)
	}
	if err := tp.peer.Receive(request); err != nil {
		t.Fatalf("Receive: %v", err)
	}
	frame, err := DecodeFrame(tp.nextFrame())
	if err != nil {
		t.Fatalf("DecodeFrame: %v", err)
	}
	if frame.Err == nil || frame.Err.Code != "internal_error" {
		t.Fatalf("response = %#v, want internal_error", frame)
	}
	if len(frame.Err.Message) != MaxErrorMessageBytes {
		t.Fatalf("internal_error message has %d bytes, want %d", len(frame.Err.Message), MaxErrorMessageBytes)
	}
}

func TestPeerValidatesOutgoingBodies(t *testing.T) {
	tp := newTestPeer(t, CmdPing, EventFacts)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// Welcome is not a valid ping request body.
	if err := tp.peer.Request(ctx, CmdPing, Welcome{}, &Ping{}); err == nil {
		t.Fatal("Request sent a body that does not match the command schema")
	}
	// Ping is not a valid facts event body.
	if err := tp.peer.Emit(EventFacts, Ping{Seq: 1}); err == nil {
		t.Fatal("Emit sent a body that does not match the event schema")
	}
	select {
	case frame := <-tp.out:
		t.Fatalf("sent a frame despite an invalid body: %x", frame)
	default:
	}

	// The peer is still usable and the connection was not torn down.
	done := startRequest(ctx, tp.peer, CmdPing, Ping{Seq: 1}, &Ping{})
	id := tp.requestID(t, tp.nextFrame())
	response, err := EncodeResponse(id, CmdPing, Ping{Seq: 1})
	if err != nil {
		t.Fatalf("EncodeResponse: %v", err)
	}
	if err := tp.peer.Receive(response); err != nil {
		t.Fatalf("Receive: %v", err)
	}
	if err := <-done; err != nil {
		t.Fatalf("request after a rejected body: %v", err)
	}
}

func TestPeerDeferred(t *testing.T) {
	t.Run("After runs after the response frame", func(t *testing.T) {
		tp := newTestPeer(t, CmdTaskCancel, EventTaskExitAck)
		var afterRan bool
		tp.peer.HandleRequest(CmdTaskCancel, func(_ context.Context, body cbor.RawMessage) (any, error) {
			var cancel TaskCancel
			if err := Unmarshal(body, &cancel); err != nil {
				return nil, err
			}
			return Deferred{
				Body: Empty{},
				After: func() {
					afterRan = true
					if err := tp.peer.Emit(EventTaskExitAck, TaskExitAck{TaskID: cancel.TaskID}); err != nil {
						t.Errorf("Emit in After: %v", err)
					}
				},
			}, nil
		})
		request, err := EncodeRequest(11, CmdTaskCancel, TaskCancel{TaskID: "task-1"})
		if err != nil {
			t.Fatalf("EncodeRequest: %v", err)
		}
		if err := tp.peer.Receive(request); err != nil {
			t.Fatalf("Receive: %v", err)
		}
		if !afterRan {
			t.Fatal("After did not run before Receive returned")
		}

		first, err := DecodeFrame(tp.nextFrame())
		if err != nil {
			t.Fatalf("DecodeFrame response: %v", err)
		}
		if first.Kind != FrameResponse || first.ID != 11 || first.Name != CmdTaskCancel || !first.OK {
			t.Fatalf("first frame = %#v, want the success response", first)
		}
		if len(first.Body) != 1 || first.Body[0] != 0x80 {
			t.Fatalf("response body = %x, want an empty tuple", first.Body)
		}
		second, err := DecodeFrame(tp.nextFrame())
		if err != nil {
			t.Fatalf("DecodeFrame event: %v", err)
		}
		if second.Kind != FrameEvent || second.Name != EventTaskExitAck {
			t.Fatalf("second frame = %#v, want the event emitted by After", second)
		}
		var ack TaskExitAck
		if err := Unmarshal(second.Body, &ack); err != nil {
			t.Fatalf("event body: %v", err)
		}
		if ack.TaskID != "task-1" {
			t.Fatalf("event task id = %q", ack.TaskID)
		}
		select {
		case extra := <-tp.out:
			t.Fatalf("unexpected extra frame %x", extra)
		default:
		}
	})
	t.Run("pointer Deferred", func(t *testing.T) {
		tp := newTestPeer(t, CmdPing)
		afterRan := false
		tp.peer.HandleRequest(CmdPing, func(context.Context, cbor.RawMessage) (any, error) {
			return &Deferred{
				Body:  Ping{Seq: 2},
				After: func() { afterRan = true },
			}, nil
		})
		request, err := EncodeRequest(12, CmdPing, Ping{Seq: 1})
		if err != nil {
			t.Fatalf("EncodeRequest: %v", err)
		}
		if err := tp.peer.Receive(request); err != nil {
			t.Fatalf("Receive: %v", err)
		}
		if !afterRan {
			t.Fatal("After did not run")
		}
		frame, err := DecodeFrame(tp.nextFrame())
		if err != nil {
			t.Fatalf("DecodeFrame: %v", err)
		}
		if !frame.OK || frame.ID != 12 {
			t.Fatalf("response = %#v", frame)
		}
		var ping Ping
		if err := Unmarshal(frame.Body, &ping); err != nil || ping.Seq != 2 {
			t.Fatalf("body = %#v, err = %v", ping, err)
		}
	})
	t.Run("After not called when the body cannot be encoded", func(t *testing.T) {
		tp := newTestPeer(t, CmdTaskCancel)
		afterRan := false
		tp.peer.HandleRequest(CmdTaskCancel, func(context.Context, cbor.RawMessage) (any, error) {
			return Deferred{Body: make(chan int), After: func() { afterRan = true }}, nil
		})
		request, err := EncodeRequest(13, CmdTaskCancel, TaskCancel{TaskID: "task-1"})
		if err != nil {
			t.Fatalf("EncodeRequest: %v", err)
		}
		if err := tp.peer.Receive(request); err != nil {
			t.Fatalf("Receive: %v", err)
		}
		frame, err := DecodeFrame(tp.nextFrame())
		if err != nil {
			t.Fatalf("DecodeFrame: %v", err)
		}
		if frame.OK || frame.Err == nil || frame.Err.Code != "internal_error" {
			t.Fatalf("response = %#v, want internal_error", frame)
		}
		if afterRan {
			t.Fatal("After ran after the response body failed to encode")
		}
		select {
		case extra := <-tp.out:
			t.Fatalf("unexpected extra frame %x", extra)
		default:
		}
	})
	t.Run("After not called when the response send fails", func(t *testing.T) {
		sendErr := errors.New("write failed")
		p := NewPeer(func([]byte) error { return sendErr }, NewSet(CmdTaskCancel))
		afterRan := false
		p.HandleRequest(CmdTaskCancel, func(context.Context, cbor.RawMessage) (any, error) {
			return Deferred{Body: Empty{}, After: func() { afterRan = true }}, nil
		})
		request, err := EncodeRequest(14, CmdTaskCancel, TaskCancel{TaskID: "task-1"})
		if err != nil {
			t.Fatalf("EncodeRequest: %v", err)
		}
		if err := p.Receive(request); !errors.Is(err, sendErr) {
			t.Fatalf("Receive = %v, want the send error", err)
		}
		if afterRan {
			t.Fatal("After ran after the response send failed")
		}
	})
	t.Run("After not called after Close", func(t *testing.T) {
		t.Run("closed before Receive", func(t *testing.T) {
			tp := newTestPeer(t, CmdTaskCancel)
			afterRan := false
			tp.peer.HandleRequest(CmdTaskCancel, func(context.Context, cbor.RawMessage) (any, error) {
				return Deferred{Body: Empty{}, After: func() { afterRan = true }}, nil
			})
			request, err := EncodeRequest(15, CmdTaskCancel, TaskCancel{TaskID: "task-1"})
			if err != nil {
				t.Fatalf("EncodeRequest: %v", err)
			}
			tp.peer.Close(nil)
			if err := tp.peer.Receive(request); !errors.Is(err, ErrClosed) {
				t.Fatalf("Receive = %v, want ErrClosed", err)
			}
			if afterRan {
				t.Fatal("After ran after Close")
			}
		})
		t.Run("closed by the handler", func(t *testing.T) {
			tp := newTestPeer(t, CmdTaskCancel)
			afterRan := false
			tp.peer.HandleRequest(CmdTaskCancel, func(context.Context, cbor.RawMessage) (any, error) {
				tp.peer.Close(nil)
				return Deferred{Body: Empty{}, After: func() { afterRan = true }}, nil
			})
			request, err := EncodeRequest(16, CmdTaskCancel, TaskCancel{TaskID: "task-1"})
			if err != nil {
				t.Fatalf("EncodeRequest: %v", err)
			}
			if err := tp.peer.Receive(request); !errors.Is(err, ErrClosed) {
				t.Fatalf("Receive = %v, want ErrClosed", err)
			}
			if afterRan {
				t.Fatal("After ran after Close")
			}
			select {
			case frame := <-tp.out:
				t.Fatalf("sent a frame after Close: %x", frame)
			default:
			}
		})
	})
}

func TestPeerEvents(t *testing.T) {
	t.Run("handled", func(t *testing.T) {
		tp := newTestPeer(t, EventFacts)
		var got Facts
		tp.peer.HandleEvent(EventFacts, func(body cbor.RawMessage) error {
			return Unmarshal(body, &got)
		})
		event, err := EncodeEvent(EventFacts, sampleFacts())
		if err != nil {
			t.Fatalf("EncodeEvent: %v", err)
		}
		if err := tp.peer.Receive(event); err != nil {
			t.Fatalf("Receive: %v", err)
		}
		if !reflect.DeepEqual(got, sampleFacts()) {
			t.Fatalf("got %#v", got)
		}
	})
	t.Run("not negotiated", func(t *testing.T) {
		tp := newTestPeer(t, CmdHello)
		event, err := EncodeEvent(EventFacts, sampleFacts())
		if err != nil {
			t.Fatalf("EncodeEvent: %v", err)
		}
		err = tp.peer.Receive(event)
		var protocolErr *ProtocolError
		if !errors.As(err, &protocolErr) {
			t.Fatalf("Receive = %v (%T), want *ProtocolError", err, err)
		}
	})
	t.Run("no handler", func(t *testing.T) {
		tp := newTestPeer(t, EventFacts)
		event, err := EncodeEvent(EventFacts, sampleFacts())
		if err != nil {
			t.Fatalf("EncodeEvent: %v", err)
		}
		err = tp.peer.Receive(event)
		var protocolErr *ProtocolError
		if !errors.As(err, &protocolErr) {
			t.Fatalf("Receive = %v (%T), want *ProtocolError", err, err)
		}
	})
	t.Run("handler error", func(t *testing.T) {
		tp := newTestPeer(t, EventFacts)
		tp.peer.HandleEvent(EventFacts, func(cbor.RawMessage) error {
			return errors.New("bad facts")
		})
		event, err := EncodeEvent(EventFacts, sampleFacts())
		if err != nil {
			t.Fatalf("EncodeEvent: %v", err)
		}
		err = tp.peer.Receive(event)
		var protocolErr *ProtocolError
		if !errors.As(err, &protocolErr) {
			t.Fatalf("Receive = %v (%T), want *ProtocolError", err, err)
		}
	})
}

func TestPeerProtocolErrors(t *testing.T) {
	t.Run("unknown response id", func(t *testing.T) {
		tp := newTestPeer(t, CmdPing)
		response, err := EncodeResponse(42, CmdPing, Ping{Seq: 1})
		if err != nil {
			t.Fatalf("EncodeResponse: %v", err)
		}
		err = tp.peer.Receive(response)
		var protocolErr *ProtocolError
		if !errors.As(err, &protocolErr) {
			t.Fatalf("Receive = %v (%T), want *ProtocolError", err, err)
		}
	})
	t.Run("response cmd mismatch", func(t *testing.T) {
		tp := newTestPeer(t, CmdPing, CmdHello)
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		done := startRequest(ctx, tp.peer, CmdPing, Ping{Seq: 1}, &Ping{})
		frame := tp.nextFrame()
		id := tp.requestID(t, frame)
		response, err := EncodeResponse(id, CmdHello, Welcome{})
		if err != nil {
			t.Fatalf("EncodeResponse: %v", err)
		}
		err = tp.peer.Receive(response)
		var protocolErr *ProtocolError
		if !errors.As(err, &protocolErr) {
			t.Fatalf("Receive = %v (%T), want *ProtocolError", err, err)
		}
		if requestErr := <-done; !errors.As(requestErr, &protocolErr) {
			t.Fatalf("request error = %v (%T), want *ProtocolError", requestErr, requestErr)
		}
	})
	t.Run("response body mismatch", func(t *testing.T) {
		tp := newTestPeer(t, CmdPing)
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		done := startRequest(ctx, tp.peer, CmdPing, Ping{Seq: 1}, &Ping{})
		frame := tp.nextFrame()
		id := tp.requestID(t, frame)
		response, err := EncodeResponse(id, CmdPing, Welcome{})
		if err != nil {
			t.Fatalf("EncodeResponse: %v", err)
		}
		err = tp.peer.Receive(response)
		var protocolErr *ProtocolError
		if !errors.As(err, &protocolErr) {
			t.Fatalf("Receive = %v (%T), want *ProtocolError", err, err)
		}
		if requestErr := <-done; !errors.As(requestErr, &protocolErr) {
			t.Fatalf("request error = %v (%T), want *ProtocolError", requestErr, requestErr)
		}
	})
	t.Run("decode failure", func(t *testing.T) {
		tp := newTestPeer(t, CmdPing)
		err := tp.peer.Receive([]byte{0xc1, 0x00})
		var protocolErr *ProtocolError
		if !errors.As(err, &protocolErr) {
			t.Fatalf("Receive = %v (%T), want *ProtocolError", err, err)
		}
	})
}

func TestPeerValidatesResponseBodyWithoutDestination(t *testing.T) {
	tp := newTestPeer(t, CmdPing)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	done := startRequest(ctx, tp.peer, CmdPing, Ping{Seq: 1}, nil)
	frame := tp.nextFrame()
	id := tp.requestID(t, frame)
	// A success response for ping must be [seq: uint]; Welcome has the wrong schema.
	response, err := EncodeResponse(id, CmdPing, Welcome{Acks: []OutputAck{}})
	if err != nil {
		t.Fatalf("EncodeResponse: %v", err)
	}
	err = tp.peer.Receive(response)
	var protocolErr *ProtocolError
	if !errors.As(err, &protocolErr) {
		t.Fatalf("Receive = %v (%T), want *ProtocolError", err, err)
	}
	if requestErr := <-done; !errors.As(requestErr, &protocolErr) {
		t.Fatalf("request error = %v (%T), want *ProtocolError", requestErr, requestErr)
	}
}

func TestPeerCancelledRequestSwallowsLateResponse(t *testing.T) {
	tp := newTestPeer(t, CmdPing)
	ctx, cancel := context.WithCancel(context.Background())
	done := startRequest(ctx, tp.peer, CmdPing, Ping{Seq: 1}, &Ping{})
	frame := tp.nextFrame()
	id := tp.requestID(t, frame)
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("request error = %v, want context.Canceled", err)
	}

	response, err := EncodeResponse(id, CmdPing, Ping{Seq: 1})
	if err != nil {
		t.Fatalf("EncodeResponse: %v", err)
	}
	if err := tp.peer.Receive(response); err != nil {
		t.Fatalf("late response: %v", err)
	}
}

func TestPeerConcurrentRequests(t *testing.T) {
	tp := newTestPeer(t, CmdPing)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	const n = 8
	var responses [n]Ping
	dones := make([]<-chan error, n)
	for i := 0; i < n; i++ {
		dones[i] = startRequest(ctx, tp.peer, CmdPing, Ping{Seq: Uint(i)}, &responses[i])
	}
	type request struct {
		id  Uint
		seq Uint
	}
	requests := make([]request, n)
	for i := 0; i < n; i++ {
		frame, err := DecodeFrame(tp.nextFrame())
		if err != nil {
			t.Fatalf("DecodeFrame: %v", err)
		}
		var ping Ping
		if err := Unmarshal(frame.Body, &ping); err != nil {
			t.Fatalf("request body: %v", err)
		}
		requests[i] = request{id: frame.ID, seq: ping.Seq}
	}

	// Respond in reverse order.
	for i := n - 1; i >= 0; i-- {
		response, err := EncodeResponse(requests[i].id, CmdPing, Ping{Seq: requests[i].seq})
		if err != nil {
			t.Fatalf("EncodeResponse: %v", err)
		}
		if err := tp.peer.Receive(response); err != nil {
			t.Fatalf("Receive: %v", err)
		}
	}
	for i := 0; i < n; i++ {
		if err := <-dones[i]; err != nil {
			t.Fatalf("request %d: %v", i, err)
		}
		if responses[i].Seq != Uint(i) {
			t.Fatalf("response %d = %d", i, responses[i].Seq)
		}
	}
}

func TestPeerConcurrentEmits(t *testing.T) {
	tp := newTestPeer(t, EventFacts)
	const n = 8
	var wg sync.WaitGroup
	errs := make(chan error, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			errs <- tp.peer.Emit(EventFacts, sampleFacts())
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("Emit: %v", err)
		}
	}
	for i := 0; i < n; i++ {
		frame, err := DecodeFrame(tp.nextFrame())
		if err != nil {
			t.Fatalf("DecodeFrame: %v", err)
		}
		if frame.Kind != FrameEvent || frame.Name != EventFacts {
			t.Fatalf("frame = %#v", frame)
		}
	}
}

func TestPeerSendFailure(t *testing.T) {
	sendErr := errors.New("write failed")
	p := NewPeer(func([]byte) error { return sendErr }, NewSet(CmdPing))
	err := p.Request(context.Background(), CmdPing, Ping{Seq: 1}, &Ping{})
	if !errors.Is(err, sendErr) {
		t.Fatalf("Request error = %v, want send error", err)
	}
	// The failed request must not leave a pending entry behind.
	response, err := EncodeResponse(1, CmdPing, Ping{Seq: 1})
	if err != nil {
		t.Fatalf("EncodeResponse: %v", err)
	}
	err = p.Receive(response)
	var protocolErr *ProtocolError
	if !errors.As(err, &protocolErr) {
		t.Fatalf("Receive = %v (%T), want *ProtocolError for the unknown id", err, err)
	}
}

func TestPeerRejectsUnnegotiatedSend(t *testing.T) {
	tp := newTestPeer(t, CmdHello)
	if err := tp.peer.Request(context.Background(), CmdPing, Ping{Seq: 1}, &Ping{}); err == nil {
		t.Fatal("Request accepted an un-negotiated command")
	}
	if err := tp.peer.Emit(EventFacts, sampleFacts()); err == nil {
		t.Fatal("Emit accepted an un-negotiated event")
	}
}
