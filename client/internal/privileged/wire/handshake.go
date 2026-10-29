package wire

import (
	"fmt"
	"io"

	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
)

// PrivHello is the first crh-priv frame, sent by the non-privileged side (non-privileged mode or a
// local command) to the privileged peer. It is not a frame inside the Peer's namespace: the
// handshake is the first pair of length-prefixed messages on the stream.
type PrivHello struct {
	_           struct{} `cbor:",toarray"`
	PrivMajor   protocol.Uint
	PrivMinor   protocol.Uint
	Commands    []string
	CRHAVersion string
	Role        Role
}

// PrivWelcome is the privileged peer's answer to PrivHello.
type PrivWelcome struct {
	_           struct{} `cbor:",toarray"`
	PrivMajor   protocol.Uint
	PrivMinor   protocol.Uint
	Commands    []string
	CRHAVersion string
}

// ClientOptions configures ClientHandshake.
type ClientOptions struct {
	// Role is the role this side claims.
	Role Role
	// CRHAVersion is this build's version, reported to the peer.
	CRHAVersion string
}

// ServerOptions configures ServerHandshake.
type ServerOptions struct {
	// Role is the only role the server accepts. Identifying the peer itself (peer uid for forward
	// and local) is the caller's job: it happens before or around the handshake.
	Role Role
	// CRHAVersion is this build's version. For the native role the peer's version must equal it
	// (doc/protocol.md: native 只在 stdio 上出现，此时要求 crha_version 完全相等).
	CRHAVersion string
}

// ClientHandshake sends hello and reads the privileged peer's welcome. It returns the welcome and
// the negotiated command and event set for NewStream.
func ClientHandshake(r io.Reader, w io.Writer, opts ClientOptions) (*PrivWelcome, protocol.Set, error) {
	hello := PrivHello{
		PrivMajor:   PrivMajor,
		PrivMinor:   PrivMinor,
		Commands:    Names(),
		CRHAVersion: opts.CRHAVersion,
		Role:        opts.Role,
	}
	body, err := protocol.Marshal(hello)
	if err != nil {
		return nil, nil, fmt.Errorf("crh-priv: encode hello: %w", err)
	}
	if err := WriteFrame(w, body); err != nil {
		return nil, nil, fmt.Errorf("crh-priv: write hello: %w", err)
	}
	frame, err := ReadFrame(r)
	if err != nil {
		return nil, nil, fmt.Errorf("crh-priv: read welcome: %w", err)
	}
	// priv_major is the first element; a peer that speaks another major version may have put
	// different fields behind it, so check it before decoding the rest.
	if err := checkMajor(frame, "welcome"); err != nil {
		return nil, nil, err
	}
	var welcome PrivWelcome
	if err := protocol.Unmarshal(frame, &welcome); err != nil {
		return nil, nil, fmt.Errorf("crh-priv: welcome: %w", err)
	}
	negotiated, err := negotiate(welcome.Commands)
	if err != nil {
		return nil, nil, err
	}
	return &welcome, negotiated, nil
}

// ServerHandshake reads the peer's hello, validates the version and the role the caller allows, and
// answers with a welcome. It returns the hello and the negotiated set for NewStream.
func ServerHandshake(r io.Reader, w io.Writer, opts ServerOptions) (*PrivHello, protocol.Set, error) {
	frame, err := ReadFrame(r)
	if err != nil {
		return nil, nil, fmt.Errorf("crh-priv: read hello: %w", err)
	}
	// priv_major is the first element; a peer that speaks another major version may have put
	// different fields behind it, so check it before decoding the rest.
	if err := checkMajor(frame, "hello"); err != nil {
		return nil, nil, err
	}
	var hello PrivHello
	if err := protocol.Unmarshal(frame, &hello); err != nil {
		return nil, nil, fmt.Errorf("crh-priv: hello: %w", err)
	}
	if hello.Role != opts.Role {
		return nil, nil, fmt.Errorf("crh-priv: peer role %q is not allowed here (want %q)", hello.Role, opts.Role)
	}
	if opts.Role == RoleNative && hello.CRHAVersion != opts.CRHAVersion {
		return nil, nil, fmt.Errorf("crh-priv: peer crha version %q, want %q", hello.CRHAVersion, opts.CRHAVersion)
	}
	negotiated, err := negotiate(hello.Commands)
	if err != nil {
		return nil, nil, err
	}
	welcome := PrivWelcome{
		PrivMajor:   PrivMajor,
		PrivMinor:   PrivMinor,
		Commands:    Names(),
		CRHAVersion: opts.CRHAVersion,
	}
	body, err := protocol.Marshal(welcome)
	if err != nil {
		return nil, nil, fmt.Errorf("crh-priv: encode welcome: %w", err)
	}
	if err := WriteFrame(w, body); err != nil {
		return nil, nil, fmt.Errorf("crh-priv: write welcome: %w", err)
	}
	return &hello, negotiated, nil
}

// checkMajor verifies the priv_major of a handshake frame without decoding the rest of it.
func checkMajor(frame []byte, what string) error {
	major, err := protocol.PeekMajor(frame)
	if err != nil {
		return fmt.Errorf("crh-priv: %s: %w", what, err)
	}
	if major != PrivMajor {
		return fmt.Errorf("crh-priv: peer priv_major %d, want %d", major, PrivMajor)
	}
	return nil
}
