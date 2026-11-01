package noise

import (
	"bytes"
	"crypto/rand"
	"fmt"
	"testing"

	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
)

func pair(t *testing.T) (Keypair, Keypair) {
	t.Helper()
	c, err := GenerateKeypair()
	if err != nil {
		t.Fatal(err)
	}
	s, err := GenerateKeypair()
	if err != nil {
		t.Fatal(err)
	}
	return c, s
}

func challenge() []byte {
	b := make([]byte, ChallengeLen)
	_, _ = rand.Read(b)
	return b
}

func TestHandshakeAndTransport(t *testing.T) {
	client, server := pair(t)
	ch := challenge()
	ini, err := NewInitiator(client, server.Public, ch)
	if err != nil {
		t.Fatal(err)
	}
	m1, err := ini.WriteInit([]byte("hello"))
	if err != nil {
		t.Fatal(err)
	}
	res, _ := NewResponder(server, ch)
	payload, clientPub, err := res.ReadInit(m1)
	if err != nil || string(payload) != "hello" || !bytes.Equal(clientPub, client.Public) {
		t.Fatalf("ReadInit = %q, %x, %v", payload, clientPub, err)
	}
	m2, rs, err := res.WriteResponse([]byte("welcome"))
	if err != nil {
		t.Fatal(err)
	}
	payload, cs, err := ini.ReadResponse(m2)
	if err != nil || string(payload) != "welcome" {
		t.Fatalf("ReadResponse = %q, %v", payload, err)
	}
	if !bytes.Equal(cs.HandshakeHash, rs.HandshakeHash) {
		t.Fatal("handshake hashes differ")
	}

	ct, _ := cs.Encrypt([]byte("ping"))
	if pt, err := rs.Decrypt(ct); err != nil || string(pt) != "ping" {
		t.Fatalf("decrypt = %q, %v", pt, err)
	}
	if _, err := rs.Decrypt(ct); err == nil {
		t.Fatal("replayed transport message accepted")
	}
	ct, _ = rs.Encrypt([]byte("pong"))
	if pt, err := cs.Decrypt(ct); err != nil || string(pt) != "pong" {
		t.Fatalf("decrypt = %q, %v", pt, err)
	}
	if _, err := cs.Encrypt(make([]byte, MaxPlaintextLen+1)); err == nil {
		t.Fatal("oversized message accepted")
	}
}

func TestReplayOnAnotherConnectionFails(t *testing.T) {
	client, server := pair(t)
	ini, _ := NewInitiator(client, server.Public, challenge())
	m1, _ := ini.WriteInit(nil)
	res, _ := NewResponder(server, challenge())
	if _, _, err := res.ReadInit(m1); err == nil {
		t.Fatal("message 1 accepted under a different challenge")
	}
}

func TestWrongServerKeyFails(t *testing.T) {
	client, server := pair(t)
	_, other := pair(t)
	ch := challenge()
	ini, _ := NewInitiator(client, other.Public, ch)
	m1, _ := ini.WriteInit(nil)
	res, _ := NewResponder(server, ch)
	if _, _, err := res.ReadInit(m1); err == nil {
		t.Fatal("handshake for another server key accepted")
	}
}

func TestPrologueUsesProtocolMajor(t *testing.T) {
	ch := challenge()
	want := append([]byte(fmt.Sprintf("crh/%d", protocol.ProtocolMajor)), ch...)
	if got := Prologue(ch); !bytes.Equal(got, want) {
		t.Fatalf("Prologue = %q, want %q", got, want)
	}
}

func TestPrologueMismatchFailsHandshake(t *testing.T) {
	client, server := pair(t)
	ch := challenge()
	// A peer from major 1 builds the old prologue; the handshake must fail before any payload.
	legacy := append([]byte("crh/1"), ch...)
	ini, err := newInitiatorPrologue(client, server.Public, legacy, nil)
	if err != nil {
		t.Fatal(err)
	}
	m1, err := ini.WriteInit([]byte("hello"))
	if err != nil {
		t.Fatal(err)
	}
	res, err := NewResponder(server, ch)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := res.ReadInit(m1); err == nil {
		t.Fatal("handshake with a major-1 prologue accepted")
	}
}

func TestKeypairFromPrivate(t *testing.T) {
	k, _ := GenerateKeypair()
	k2, err := KeypairFromPrivate(k.Private)
	if err != nil || !bytes.Equal(k.Public, k2.Public) {
		t.Fatalf("KeypairFromPrivate = %x, %v", k2.Public, err)
	}
}
