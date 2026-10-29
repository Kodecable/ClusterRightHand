package protocol

import (
	"bytes"
	"errors"
	"fmt"

	"github.com/fxamacker/cbor/v2"
)

// FrameKind is the first element of every frame tuple.
type FrameKind uint64

const (
	FrameRequest  FrameKind = 0
	FrameResponse FrameKind = 1
	FrameEvent    FrameKind = 2
)

// Frame is one decoded wire frame. Kind selects which fields apply:
//   - FrameRequest: ID, Name and Body.
//   - FrameResponse with OK: ID, Name and Body.
//   - FrameResponse with !OK: ID, Name and Err (Body is nil).
//   - FrameEvent: Name and Body.
type Frame struct {
	Kind FrameKind
	ID   Uint
	Name string
	OK   bool
	Body cbor.RawMessage
	Err  *Error
}

// Encode serializes f in its canonical wire form and enforces MaxFrameBytes. It rejects
// an invalid UTF-8 command/event name or Error text; Body is already-encoded CBOR.
func (f *Frame) Encode() ([]byte, error) {
	if err := validateTextValue(f); err != nil {
		return nil, fmt.Errorf("protocol: encode frame: %w", err)
	}
	var elems []any
	switch f.Kind {
	case FrameRequest:
		elems = []any{uint64(FrameRequest), f.ID, f.Name, f.Body}
	case FrameResponse:
		if f.OK {
			elems = []any{uint64(FrameResponse), f.ID, f.Name, true, f.Body}
		} else {
			if f.Err == nil {
				return nil, errors.New("protocol: error response without an Error body")
			}
			elems = []any{uint64(FrameResponse), f.ID, f.Name, false, f.Err}
		}
	case FrameEvent:
		elems = []any{uint64(FrameEvent), f.Name, f.Body}
	default:
		return nil, fmt.Errorf("protocol: unknown frame kind %d", f.Kind)
	}
	data, err := encMode.Marshal(elems)
	if err != nil {
		return nil, fmt.Errorf("protocol: encode frame: %w", err)
	}
	if len(data) > MaxFrameBytes {
		return nil, fmt.Errorf("protocol: frame of %d bytes exceeds %d", len(data), MaxFrameBytes)
	}
	return data, nil
}

// DecodeFrame parses and strictly validates one frame: the CBOR profile, the tuple
// length selected by the kind, the error body of an error response, and a final
// re-encode-and-compare of the whole frame.
func DecodeFrame(data []byte) (*Frame, error) {
	if len(data) > MaxFrameBytes {
		return nil, protocolErrorf("frame of %d bytes exceeds %d", len(data), MaxFrameBytes)
	}
	if _, err := decodeAny(data); err != nil {
		return nil, &ProtocolError{Err: fmt.Errorf("frame: %w", err)}
	}
	var elems []cbor.RawMessage
	if err := decMode.Unmarshal(data, &elems); err != nil {
		return nil, &ProtocolError{Err: fmt.Errorf("frame: %w", err)}
	}
	if len(elems) == 0 {
		return nil, protocolErrorf("frame is an empty array")
	}
	var kind Uint
	if err := decMode.Unmarshal(elems[0], &kind); err != nil {
		return nil, &ProtocolError{Err: fmt.Errorf("frame kind: %w", err)}
	}
	f := &Frame{Kind: FrameKind(kind)}
	switch {
	case kind == Uint(FrameRequest) && len(elems) == 4:
		if err := decMode.Unmarshal(elems[1], &f.ID); err != nil {
			return nil, &ProtocolError{Err: fmt.Errorf("request id: %w", err)}
		}
		if err := decMode.Unmarshal(elems[2], &f.Name); err != nil {
			return nil, &ProtocolError{Err: fmt.Errorf("request command: %w", err)}
		}
		f.Body = cloneRaw(elems[3])
	case kind == Uint(FrameResponse) && len(elems) == 5:
		if err := decMode.Unmarshal(elems[1], &f.ID); err != nil {
			return nil, &ProtocolError{Err: fmt.Errorf("response id: %w", err)}
		}
		if err := decMode.Unmarshal(elems[2], &f.Name); err != nil {
			return nil, &ProtocolError{Err: fmt.Errorf("response command: %w", err)}
		}
		if err := decMode.Unmarshal(elems[3], &f.OK); err != nil {
			return nil, &ProtocolError{Err: fmt.Errorf("response ok flag: %w", err)}
		}
		if f.OK {
			f.Body = cloneRaw(elems[4])
		} else {
			var wireErr Error
			if err := Unmarshal(elems[4], &wireErr); err != nil {
				return nil, &ProtocolError{Err: fmt.Errorf("error response body: %w", err)}
			}
			f.Err = &wireErr
		}
	case kind == Uint(FrameEvent) && len(elems) == 3:
		if err := decMode.Unmarshal(elems[1], &f.Name); err != nil {
			return nil, &ProtocolError{Err: fmt.Errorf("event name: %w", err)}
		}
		f.Body = cloneRaw(elems[2])
	default:
		return nil, protocolErrorf("frame with kind %d and %d elements", kind, len(elems))
	}

	encoded, err := f.Encode()
	if err != nil {
		return nil, &ProtocolError{Err: fmt.Errorf("frame: %w", err)}
	}
	if !bytes.Equal(encoded, data) {
		return nil, &ProtocolError{Err: errors.New("frame: re-encoding differs from input")}
	}
	return f, nil
}

// EncodeRequest encodes a request frame with an already typed body.
func EncodeRequest(id Uint, cmd string, body any) ([]byte, error) {
	raw, err := Marshal(body)
	if err != nil {
		return nil, err
	}
	return (&Frame{Kind: FrameRequest, ID: id, Name: cmd, Body: raw}).Encode()
}

// EncodeResponse encodes a successful response frame with an already typed body.
func EncodeResponse(id Uint, cmd string, body any) ([]byte, error) {
	raw, err := Marshal(body)
	if err != nil {
		return nil, err
	}
	return (&Frame{Kind: FrameResponse, ID: id, Name: cmd, OK: true, Body: raw}).Encode()
}

// EncodeErrorResponse encodes an error response frame.
func EncodeErrorResponse(id Uint, cmd, code, message string) ([]byte, error) {
	return (&Frame{
		Kind: FrameResponse,
		ID:   id,
		Name: cmd,
		Err:  &Error{Code: code, Message: message},
	}).Encode()
}

// EncodeEvent encodes an event frame with an already typed body.
func EncodeEvent(name string, body any) ([]byte, error) {
	raw, err := Marshal(body)
	if err != nil {
		return nil, err
	}
	return (&Frame{Kind: FrameEvent, Name: name, Body: raw}).Encode()
}

func cloneRaw(raw cbor.RawMessage) cbor.RawMessage {
	return append(cbor.RawMessage(nil), raw...)
}
