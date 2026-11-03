// Package wire implements crh-priv, the framed command/event protocol between crha's
// non-privileged mode and a privileged peer: the native helper over stdio and the privileged
// daemon over a unix socket. It reuses protocol's frames, command bodies and Peer; only the
// transport (a 4-byte length prefix instead of Noise) and the handshake differ. See
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
	// version the crh-priv protocol itself, not the crhs <-> crha protocol. Major 2 carries the
	// task.exit.result element and the line-range file.read spec; a peer with a different major is
	// refused, because crha and its privileged mode always upgrade together (doc/protocol.md,
	// crh-priv：非特权模式 ↔ 特权模式). The minor stays additive and never refuses a handshake.
	PrivMajor = 2
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

// crh-priv commands that are not part of the crhs <-> crha registry: trust.query is the
// forward role's explicit query, pending.list and local.approve / local.deny are the local
// role's. They are registered on the Peer that needs them instead of in
// client/internal/protocol, so crha's crhs-facing handshake never advertises them.
const (
	CmdTrustQuery   = "trust.query"
	CmdPendingList  = "pending.list"
	CmdLocalApprove = "local.approve"
	CmdLocalDeny    = "local.deny"
)

// Names returns the task command and event names shared by every crh-priv role, sorted. It is
// the native helper's complete set; forward and local add their own names (NamesFor).
func Names() []string {
	return coreNames()
}

func coreNames() []string {
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

// NamesFor returns the command and event names a role implements, sorted, including the
// M4 names that role needs. The handshake advertises this list.
func NamesFor(role Role) []string {
	switch role {
	case RoleForward:
		names := append(coreNames(),
			CmdTrustQuery,
			protocol.EventTrustSummary,
			protocol.CmdLocalRequest,
			protocol.CmdLocalWithdraw,
			protocol.EventLocalDecision,
		)
		slices.Sort(names)
		return names
	case RoleLocal:
		names := []string{
			CmdPendingList,
			CmdLocalApprove,
			CmdLocalDeny,
		}
		slices.Sort(names)
		return names
	default:
		return coreNames()
	}
}

// requiredNamesFor returns the names a handshake with role must negotiate. They are part of
// crh-priv 1.0; the later additions of the forward role stay optional, so an older peer that
// only implements the 1.0 subset still connects. The local role is new in this phase and
// requires its whole set.
func requiredNamesFor(role Role) []string {
	switch role {
	case RoleForward:
		return []string{
			protocol.CmdTaskStart, protocol.CmdTaskInput, protocol.CmdTaskCancel, protocol.CmdTaskQuery,
			protocol.EventTaskOutput, protocol.EventTaskExit,
			CmdTrustQuery, protocol.EventTrustSummary,
		}
	default:
		return NamesFor(role)
	}
}

// negotiate intersects the local names for role with the peer's advertised list. A name the
// role requires but the peer does not implement leaves no usable protocol, so it fails the
// handshake.
func negotiate(role Role, theirs []string) (protocol.Set, error) {
	set := protocol.NewSet(NamesFor(role)...).Intersect(protocol.NewSet(theirs...))
	var missing []string
	for _, name := range requiredNamesFor(role) {
		if !set.Has(name) {
			missing = append(missing, name)
		}
	}
	if len(missing) > 0 {
		return nil, protocolErrorf("peer does not implement %v", missing)
	}
	return set, nil
}

// RegisterSchemas adds the crh-priv-only command bodies of role to peer. Call it before the
// stream starts receiving; the protocol package's registry does not contain them because they
// are not part of the crhs <-> crha protocol.
func RegisterSchemas(peer *protocol.Peer, role Role) {
	register := func(cmd string, request, response func() any) {
		peer.RegisterCommand(cmd, request, response)
	}
	switch role {
	case RoleForward:
		register(CmdTrustQuery,
			func() any { return new(protocol.Empty) },
			func() any { return new(protocol.TrustSummary) })
	case RoleLocal:
		register(CmdPendingList,
			func() any { return new(protocol.Empty) },
			func() any { return new([]protocol.PendingEntry) })
		registerVerdict := func(cmd string) {
			register(cmd,
				func() any { return new(protocol.LocalVerdict) },
				func() any { return new(protocol.Empty) })
		}
		registerVerdict(CmdLocalApprove)
		registerVerdict(CmdLocalDeny)
	}
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
