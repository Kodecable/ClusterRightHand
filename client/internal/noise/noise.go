// Package noise wraps github.com/flynn/noise for the crh channel:
// Noise_IK_25519_ChaChaPoly_BLAKE2s with the prologue "crh/1" || server challenge.
// See doc/execution-plane.md#通信安全.
package noise

import (
	"bytes"
	"crypto/rand"
	"errors"
	"fmt"

	"github.com/flynn/noise"
	"golang.org/x/crypto/curve25519"
)

const (
	KeyLen       = 32
	ChallengeLen = 32
	// MaxMessageLen is the largest Noise message, handshake or transport.
	MaxMessageLen = noise.MaxMsgLen
	// MaxPlaintextLen is the largest payload of one transport message.
	MaxPlaintextLen = MaxMessageLen - 16
)

var suite = noise.NewCipherSuite(noise.DH25519, noise.CipherChaChaPoly, noise.HashBLAKE2s)

type Keypair = noise.DHKey

func GenerateKeypair() (Keypair, error) {
	return suite.GenerateKeypair(rand.Reader)
}

func KeypairFromPrivate(private []byte) (Keypair, error) {
	if len(private) != KeyLen {
		return Keypair{}, errors.New("noise: private key must be 32 bytes")
	}
	public, err := curve25519.X25519(private, curve25519.Basepoint)
	if err != nil {
		return Keypair{}, err
	}
	return Keypair{Private: append([]byte(nil), private...), Public: public}, nil
}

// Prologue binds a handshake to the connection that carried the server's challenge.
func Prologue(challenge []byte) []byte {
	return append([]byte("crh/1"), challenge...)
}

// Session holds the transport ciphers after a completed handshake.
type Session struct {
	send, recv    *noise.CipherState
	HandshakeHash []byte
}

func (s *Session) Encrypt(plaintext []byte) ([]byte, error) {
	if len(plaintext) > MaxPlaintextLen {
		return nil, fmt.Errorf("noise: message of %d bytes too large", len(plaintext))
	}
	return s.send.Encrypt(nil, nil, plaintext)
}

func (s *Session) Decrypt(ciphertext []byte) ([]byte, error) {
	if len(ciphertext) > MaxMessageLen {
		return nil, errors.New("noise: message too large")
	}
	return s.recv.Decrypt(nil, nil, ciphertext)
}

// Initiator runs the client side of the IK handshake.
type Initiator struct {
	hs *noise.HandshakeState
}

func NewInitiator(static Keypair, serverPublic, challenge []byte) (*Initiator, error) {
	return newInitiator(static, serverPublic, challenge, nil)
}

func newInitiator(static Keypair, serverPublic, challenge []byte, ephemeral *Keypair) (*Initiator, error) {
	if len(serverPublic) != KeyLen {
		return nil, errors.New("noise: server public key must be 32 bytes")
	}
	cfg := noise.Config{
		CipherSuite:   suite,
		Pattern:       noise.HandshakeIK,
		Initiator:     true,
		Prologue:      Prologue(challenge),
		StaticKeypair: static,
		PeerStatic:    serverPublic,
	}
	if ephemeral != nil {
		// flynn/noise draws the ephemeral private key from Random (tests only).
		cfg.Random = bytes.NewReader(ephemeral.Private)
	}
	hs, err := noise.NewHandshakeState(cfg)
	if err != nil {
		return nil, err
	}
	return &Initiator{hs: hs}, nil
}

// WriteInit returns handshake message 1 carrying payload.
func (i *Initiator) WriteInit(payload []byte) ([]byte, error) {
	msg, _, _, err := i.hs.WriteMessage(nil, payload)
	return msg, err
}

// ReadResponse consumes handshake message 2 and returns its payload and the session.
func (i *Initiator) ReadResponse(msg []byte) ([]byte, *Session, error) {
	payload, cs1, cs2, err := i.hs.ReadMessage(nil, msg)
	if err != nil {
		return nil, nil, err
	}
	if cs1 == nil || cs2 == nil {
		return nil, nil, errors.New("noise: handshake did not complete")
	}
	return payload, &Session{send: cs1, recv: cs2, HandshakeHash: i.hs.ChannelBinding()}, nil
}

// Responder runs the server side; crhs implements it in TypeScript, this one exists for tests
// and for a future server-dials-client transport.
type Responder struct {
	hs *noise.HandshakeState
}

func NewResponder(static Keypair, challenge []byte) (*Responder, error) {
	return newResponder(static, challenge, nil)
}

func newResponder(static Keypair, challenge []byte, ephemeral *Keypair) (*Responder, error) {
	cfg := noise.Config{
		CipherSuite:   suite,
		Pattern:       noise.HandshakeIK,
		Prologue:      Prologue(challenge),
		StaticKeypair: static,
	}
	if ephemeral != nil {
		// flynn/noise draws the ephemeral private key from Random (tests only).
		cfg.Random = bytes.NewReader(ephemeral.Private)
	}
	hs, err := noise.NewHandshakeState(cfg)
	if err != nil {
		return nil, err
	}
	return &Responder{hs: hs}, nil
}

// ReadInit consumes message 1 and returns its payload and the client's static public key.
func (r *Responder) ReadInit(msg []byte) (payload, clientPublic []byte, err error) {
	payload, _, _, err = r.hs.ReadMessage(nil, msg)
	if err != nil {
		return nil, nil, err
	}
	return payload, r.hs.PeerStatic(), nil
}

func (r *Responder) WriteResponse(payload []byte) ([]byte, *Session, error) {
	msg, cs1, cs2, err := r.hs.WriteMessage(nil, payload)
	if err != nil {
		return nil, nil, err
	}
	return msg, &Session{send: cs2, recv: cs1, HandshakeHash: r.hs.ChannelBinding()}, nil
}
