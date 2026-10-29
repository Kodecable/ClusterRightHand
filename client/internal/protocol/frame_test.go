package protocol

import (
	"bytes"
	"context"
	"encoding/hex"
	"errors"
	"strings"
	"testing"

	"github.com/fxamacker/cbor/v2"
)

func TestFrameRoundTrip(t *testing.T) {
	t.Run("request", func(t *testing.T) {
		raw, err := EncodeRequest(1, CmdPing, Ping{Seq: 5})
		if err != nil {
			t.Fatalf("EncodeRequest: %v", err)
		}
		if got := hex.EncodeToString(raw); got != "8400016470696e678105" {
			t.Fatalf("encoded as %s", got)
		}
		frame, err := DecodeFrame(raw)
		if err != nil {
			t.Fatalf("DecodeFrame: %v", err)
		}
		if frame.Kind != FrameRequest || frame.ID != 1 || frame.Name != CmdPing {
			t.Fatalf("frame = %#v", frame)
		}
		var ping Ping
		if err := Unmarshal(frame.Body, &ping); err != nil || ping.Seq != 5 {
			t.Fatalf("body = %#v, err = %v", ping, err)
		}
	})
	t.Run("response", func(t *testing.T) {
		raw, err := EncodeResponse(2, CmdHello, Welcome{Acks: []OutputAck{}})
		if err != nil {
			t.Fatalf("EncodeResponse: %v", err)
		}
		frame, err := DecodeFrame(raw)
		if err != nil {
			t.Fatalf("DecodeFrame: %v", err)
		}
		if frame.Kind != FrameResponse || frame.ID != 2 || !frame.OK || frame.Err != nil {
			t.Fatalf("frame = %#v", frame)
		}
		var welcome Welcome
		if err := Unmarshal(frame.Body, &welcome); err != nil {
			t.Fatalf("body: %v", err)
		}
		if welcome.Acks == nil || len(welcome.Acks) != 0 {
			t.Fatalf("acks = %#v", welcome.Acks)
		}
	})
	t.Run("error response", func(t *testing.T) {
		raw, err := EncodeErrorResponse(3, CmdTaskStart, "invalid_spec", "bad")
		if err != nil {
			t.Fatalf("EncodeErrorResponse: %v", err)
		}
		frame, err := DecodeFrame(raw)
		if err != nil {
			t.Fatalf("DecodeFrame: %v", err)
		}
		if frame.Kind != FrameResponse || frame.ID != 3 || frame.OK {
			t.Fatalf("frame = %#v", frame)
		}
		if frame.Err == nil || frame.Err.Code != "invalid_spec" || frame.Err.Message != "bad" {
			t.Fatalf("err = %#v", frame.Err)
		}
		encoded, err := frame.Encode()
		if err != nil {
			t.Fatalf("Encode: %v", err)
		}
		if !bytes.Equal(encoded, raw) {
			t.Fatalf("re-encoded %x, want %x", encoded, raw)
		}
	})
	t.Run("event", func(t *testing.T) {
		raw, err := EncodeEvent(EventFacts, sampleFacts())
		if err != nil {
			t.Fatalf("EncodeEvent: %v", err)
		}
		frame, err := DecodeFrame(raw)
		if err != nil {
			t.Fatalf("DecodeFrame: %v", err)
		}
		if frame.Kind != FrameEvent || frame.Name != EventFacts || frame.ID != 0 {
			t.Fatalf("frame = %#v", frame)
		}
		var facts Facts
		if err := Unmarshal(frame.Body, &facts); err != nil {
			t.Fatalf("body: %v", err)
		}
	})
}

func TestFrameEncodeRejectsInvalidUTF8(t *testing.T) {
	body, err := Marshal(Empty{})
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	tests := []struct {
		name  string
		frame *Frame
	}{
		{"request name", &Frame{Kind: FrameRequest, ID: 1, Name: "bad\xff", Body: body}},
		{"event name", &Frame{Kind: FrameEvent, Name: "bad\xff", Body: body}},
		{"error code", &Frame{
			Kind: FrameResponse, ID: 1, Name: CmdPing,
			Err: &Error{Code: "bad\xff", Message: "message"},
		}},
		{"error message", &Frame{
			Kind: FrameResponse, ID: 1, Name: CmdPing,
			Err: &Error{Code: "internal_error", Message: "bad\xff"},
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := test.frame.Encode(); err == nil {
				t.Fatalf("Encode accepted invalid UTF-8 in %s", test.name)
			}
		})
	}
	// EncodeErrorResponse sanitizes the message rather than refusing the frame.
	raw, err := EncodeErrorResponse(1, CmdPing, "internal_error", "bad\xff")
	if err != nil {
		t.Fatalf("EncodeErrorResponse: %v", err)
	}
	frame, err := DecodeFrame(raw)
	if err != nil {
		t.Fatalf("DecodeFrame: %v", err)
	}
	if frame.Err == nil || frame.Err.Message != "bad\uFFFD" {
		t.Fatalf("message = %#v, want the invalid byte replaced", frame.Err)
	}
	if _, err := EncodeRequest(1, "bad\xff", Empty{}); err == nil {
		t.Fatal("EncodeRequest accepted an invalid UTF-8 command")
	}
}

func TestFrameNameLimit(t *testing.T) {
	long := strings.Repeat("a", MaxNameBytes+1)
	if _, err := EncodeRequest(1, long, Ping{Seq: 1}); err == nil {
		t.Fatal("EncodeRequest accepted an over-long command name")
	}
	if _, err := EncodeEvent(long, sampleFacts()); err == nil {
		t.Fatal("EncodeEvent accepted an over-long event name")
	}
	if _, err := EncodeErrorResponse(1, long, "internal_error", "x"); err == nil {
		t.Fatal("EncodeErrorResponse accepted an over-long command name")
	}

	// Exactly MaxNameBytes is allowed.
	name := strings.Repeat("a", MaxNameBytes)
	raw, err := EncodeRequest(1, name, Ping{Seq: 1})
	if err != nil {
		t.Fatalf("EncodeRequest(%d-byte name): %v", MaxNameBytes, err)
	}
	if _, err := DecodeFrame(raw); err != nil {
		t.Fatalf("DecodeFrame(%d-byte name): %v", MaxNameBytes, err)
	}

	body := mustHex(t, "8101")
	frames := []struct {
		name string
		raw  []byte
	}{
		{"request", encodeRaw(t, []any{uint64(FrameRequest), uint64(1), long, cbor.RawMessage(body)})},
		{"response", encodeRaw(t, []any{uint64(FrameResponse), uint64(1), long, true, cbor.RawMessage(body)})},
		{"event", encodeRaw(t, []any{uint64(FrameEvent), long, cbor.RawMessage(body)})},
	}
	for _, test := range frames {
		t.Run(test.name, func(t *testing.T) {
			_, err := DecodeFrame(test.raw)
			var protocolErr *ProtocolError
			if !errors.As(err, &protocolErr) {
				t.Fatalf("DecodeFrame = %v (%T), want *ProtocolError for an over-long name", err, err)
			}
		})
	}
}

func TestFrameErrorMessageTruncated(t *testing.T) {
	message := strings.Repeat("x", 4*MaxErrorMessageBytes)
	raw, err := EncodeErrorResponse(1, CmdPing, "internal_error", message)
	if err != nil {
		t.Fatalf("EncodeErrorResponse: %v", err)
	}
	frame, err := DecodeFrame(raw)
	if err != nil {
		t.Fatalf("DecodeFrame: %v", err)
	}
	if frame.Err == nil {
		t.Fatal("response has no error body")
	}
	if frame.Err.Message != message[:MaxErrorMessageBytes] {
		t.Fatalf("message has %d bytes, want %d", len(frame.Err.Message), MaxErrorMessageBytes)
	}
}

func TestFrameDecodeAllowsLongErrorMessage(t *testing.T) {
	// The sender guarantees the bound; a receiver does not check Error.message's length.
	message := strings.Repeat("x", 4*MaxErrorMessageBytes)
	body := encodeRaw(t, []any{"internal_error", message})
	raw := encodeRaw(t, []any{uint64(FrameResponse), uint64(1), CmdPing, false, cbor.RawMessage(body)})
	frame, err := DecodeFrame(raw)
	if err != nil {
		t.Fatalf("DecodeFrame: %v", err)
	}
	if frame.Err == nil {
		t.Fatal("response has no error body")
	}
	if frame.Err.Message != message {
		t.Fatalf("message has %d bytes, want %d", len(frame.Err.Message), len(message))
	}
}

// encodeRaw encodes v with the package encoder, bypassing the frame name checks.
func encodeRaw(t *testing.T, v any) []byte {
	t.Helper()
	raw, err := encMode.Marshal(v)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	return raw
}

func TestFrameErrorResponseHex(t *testing.T) {
	raw, err := EncodeErrorResponse(1, CmdPing, "x", "y")
	if err != nil {
		t.Fatalf("EncodeErrorResponse: %v", err)
	}
	const want = "8501016470696e67f48261786179"
	if got := hex.EncodeToString(raw); got != want {
		t.Fatalf("encoded as %s, want %s", got, want)
	}
	frame, err := DecodeFrame(raw)
	if err != nil {
		t.Fatalf("DecodeFrame: %v", err)
	}
	if frame.Err == nil || frame.Err.Code != "x" || frame.Err.Message != "y" {
		t.Fatalf("err = %#v", frame.Err)
	}
}

func TestFrameMaxBytes(t *testing.T) {
	t.Run("encode", func(t *testing.T) {
		body := TaskInput{TaskID: "t", Data: bytes.Repeat([]byte{0}, MaxFrameBytes)}
		if _, err := EncodeEvent(EventTaskOutput, body); err == nil {
			t.Fatal("encoded a frame larger than MaxFrameBytes")
		}
	})
	t.Run("decode", func(t *testing.T) {
		frame, err := EncodeRequest(1, CmdPing, Ping{Seq: 1})
		if err != nil {
			t.Fatalf("EncodeRequest: %v", err)
		}
		oversized := append(frame, make([]byte, MaxFrameBytes)...)
		if _, err := DecodeFrame(oversized); err == nil {
			t.Fatal("accepted a frame larger than MaxFrameBytes")
		}
	})
}

func TestFrameRejections(t *testing.T) {
	valid, err := EncodeRequest(1, CmdPing, Ping{Seq: 1})
	if err != nil {
		t.Fatalf("EncodeRequest: %v", err)
	}
	tests := []struct {
		name string
		hex  string
	}{
		{"non-minimal id", "840018016470696e678101"},
		{"trailing bytes", hex.EncodeToString(append(append([]byte(nil), valid...), 0x00))},
		{"unknown kind", "8464746f6f6c01"},
		{"request too long", "8500016470696e67810100"},
		{"request too short", "83016470696e67"},
		{"response too long", "8601016470696e67f5810100"},
		{"response too short", "8401016470696e67f5"},
		{"error body not a tuple", "8501016470696e67f480"},
		{"error body one element", "8501016470696e67f4816178"},
		{"response ok not bool", "8501016470696e67008101"},
		{"event too long", "84026566616374738000"},
		{"event too short", "8202656661637473"},
		{"request id over 2^53-1", "84001b00200000000000006470696e678101"},
		{"indefinite frame", "9f00016470696e678101ff"},
		{"tag", "c100"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			raw := mustHex(t, test.hex)
			if _, err := DecodeFrame(raw); err == nil {
				t.Fatalf("accepted %s", test.hex)
			}
			var protocolErr *ProtocolError
			if _, err := DecodeFrame(raw); !errors.As(err, &protocolErr) {
				t.Fatalf("error is %T, want *ProtocolError", err)
			}
		})
	}
}

func TestFrameBodyDecodeError(t *testing.T) {
	// A request whose body has the wrong tuple length is rejected by the handler's
	// Unmarshal, which returns a *ProtocolError.
	p := newTestPeer(t, CmdPing)
	p.peer.HandleRequest(CmdPing, func(_ context.Context, body cbor.RawMessage) (any, error) {
		var ping Ping
		if err := Unmarshal(body, &ping); err != nil {
			return nil, err
		}
		return ping, nil
	})
	raw := mustHex(t, "8400016470696e67820100")
	err := p.peer.Receive(raw)
	var protocolErr *ProtocolError
	if !errors.As(err, &protocolErr) {
		t.Fatalf("Receive error = %v (%T), want *ProtocolError", err, err)
	}
}
