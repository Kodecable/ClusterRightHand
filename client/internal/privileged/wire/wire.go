// Package wire implements crh-priv, the framed command/event protocol between crha's
// non-privileged mode and a privileged peer: the native helper over stdio and, later, the
// privileged mode over a unix socket. It reuses protocol's frames, command bodies and Peer; only
// the transport (a 4-byte length prefix instead of Noise) and the handshake differ. See
// doc/protocol.md "crh-priv：非特权模式 ↔ 特权模式".
package wire

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"slices"

	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
)

const (
	// PrivMajor and PrivMinor are the crh-priv versions carried by PrivHello and PrivWelcome. They
	// version the crh-priv protocol itself, not the crhs <-> crha protocol.
	PrivMajor = 1
	PrivMinor = 0
	// MaxFrameBytes bounds one frame. Length 0 and lengths above it are protocol errors.
	MaxFrameBytes = protocol.MaxFrameBytes
)

// Role is the PrivHello role enum. It must match the peer's identity: forward and local are
// checked against SO_PEERCRED by the privileged side, and native only exists on a helper's stdio.
type Role string

const (
	RoleForward Role = "forward"
	RoleNative  Role = "native"
	RoleLocal   Role = "local"
)

func (r Role) valid() bool { return r == RoleForward || r == RoleNative || r == RoleLocal }

// MarshalCBOR encodes the role enum, rejecting values outside the schema.
func (r Role) MarshalCBOR() ([]byte, error) {
	if !r.valid() {
		return nil, fmt.Errorf("crh-priv: unknown role %q", string(r))
	}
	return protocol.Marshal(string(r))
}

// UnmarshalCBOR decodes the role enum.
func (r *Role) UnmarshalCBOR(data []byte) error {
	var s string
	if err := protocol.Unmarshal(data, &s); err != nil {
		return err
	}
	v := Role(s)
	if !v.valid() {
		return fmt.Errorf("crh-priv: unknown role %q", s)
	}
	*r = v
	return nil
}

// Names returns the crh-priv command and event names implemented by this phase, sorted. It is the
// commands list of the handshake and the set both sides must be able to use.
func Names() []string {
	names := []string{
		protocol.CmdTaskStart,
		protocol.CmdTaskInput,
		protocol.CmdTaskCancel,
		protocol.CmdTaskQuery,
		protocol.EventTaskOutput,
		protocol.EventTaskExit,
	}
	slices.Sort(names)
	return names
}

// negotiate intersects the local names with the peer's advertised list. A name this phase requires
// but the peer does not implement leaves no usable protocol, so it fails the handshake.
func negotiate(theirs []string) (protocol.Set, error) {
	set := protocol.NewSet(Names()...).Intersect(protocol.NewSet(theirs...))
	var missing []string
	for _, name := range Names() {
		if !set.Has(name) {
			missing = append(missing, name)
		}
	}
	if len(missing) > 0 {
		return nil, protocolErrorf("peer does not implement %v", missing)
	}
	return set, nil
}

// WriteFrame writes one frame preceded by its 4-byte big-endian length.
func WriteFrame(w io.Writer, frame []byte) error {
	if len(frame) == 0 || len(frame) > MaxFrameBytes {
		return fmt.Errorf("crh-priv: refusing to write a frame of %d bytes", len(frame))
	}
	buf := make([]byte, 4+len(frame))
	binary.BigEndian.PutUint32(buf, uint32(len(frame)))
	copy(buf[4:], frame)
	for len(buf) > 0 {
		n, err := w.Write(buf)
		if err != nil {
			return err
		}
		if n == 0 {
			return io.ErrShortWrite
		}
		buf = buf[n:]
	}
	return nil
}

// ReadFrame reads one length-prefixed frame. It returns io.EOF only when the stream ended between
// frames, which callers treat as a clean end of the connection; a frame cut short by the end of the
// stream is a *ProtocolError, because the peer started to send it.
func ReadFrame(r io.Reader) ([]byte, error) {
	var head [4]byte
	n, err := io.ReadFull(r, head[:])
	if err != nil {
		if n == 0 && errors.Is(err, io.EOF) {
			return nil, io.EOF
		}
		return nil, protocolErrorf("frame length: %w", err)
	}
	size := binary.BigEndian.Uint32(head[:])
	if size == 0 || size > MaxFrameBytes {
		return nil, protocolErrorf("frame length %d is outside 1..%d", size, MaxFrameBytes)
	}
	frame := make([]byte, size)
	if _, err := io.ReadFull(r, frame); err != nil {
		return nil, protocolErrorf("frame body of %d bytes: %w", size, err)
	}
	return frame, nil
}

// ProtocolError is a violation of the crh-priv framing or handshake. The stream is unusable
// afterwards: the receiver closes it and sends nothing back.
type ProtocolError struct{ Err error }

func (e *ProtocolError) Error() string {
	if e.Err == nil {
		return "crh-priv protocol error"
	}
	return "crh-priv protocol error: " + e.Err.Error()
}

func (e *ProtocolError) Unwrap() error { return e.Err }

func protocolErrorf(format string, args ...any) error {
	return &ProtocolError{Err: fmt.Errorf(format, args...)}
}
