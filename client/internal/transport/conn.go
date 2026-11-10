// Package transport carries crh frames between crha and crhs: a WebSocket connection, the server's
// challenge, a Noise IK handshake bound to that challenge, then one encrypted frame per binary message.
// See doc/design/protocol.md "Transport security" and doc/design/protocol.md "Frames".
package transport

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/Kodecable/ClusterRightHand/client/internal/noise"
	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
	"github.com/coder/websocket"
)

// MaxEnvelopeLen bounds one encoded frame so that it fits a Noise transport message.
const MaxEnvelopeLen = protocol.MaxFrameBytes

const handshakeTimeout = 20 * time.Second

// writeTimeout bounds one WebSocket write. A protocol Peer holds its send lock while calling send, so
// a stalled peer must not be able to block Peer.Close forever. It is a variable so tests can shorten it.
var writeTimeout = 30 * time.Second

type DialOptions struct {
	// URL of the agent endpoint, wss://host/agent.
	URL string
	// InsecureSkipVerify disables TLS certificate checks (tls_verify = "none"). Safe because the
	// Noise layer authenticates crhs by its static key.
	InsecureSkipVerify bool
	Identity           noise.Keypair
	ServerPublic       []byte
	// Init is the handshake payload. Dial fills in the protocol version, the supported command and
	// event names and the client time; CRHAVersion and Enroll come from the caller.
	Init *protocol.HandshakeInit
}

// wsConn is the part of *websocket.Conn the transport uses. Tests substitute a connection whose
// writes block, to check the send timeout.
type wsConn interface {
	Read(ctx context.Context) (websocket.MessageType, []byte, error)
	Write(ctx context.Context, typ websocket.MessageType, p []byte) error
	Close(code websocket.StatusCode, reason string) error
	SetReadLimit(n int64)
}

// Conn is an authenticated, encrypted frame stream. Send is safe for concurrent use; Recv is not.
type Conn struct {
	ws       wsConn
	session  *noise.Session
	Response *protocol.HandshakeResponse
	// Negotiated is the intersection of both handshakes' command and event names. Only those may be
	// sent or received.
	Negotiated protocol.Set
	// ClockOffset is the local clock minus crhs's clock, measured during the handshake.
	ClockOffset time.Duration

	sendMu sync.Mutex
}

// HandshakeError means crhs rejected us (unknown key, bad token, incompatible protocol, ...) rather
// than a network failure.
type HandshakeError struct{ Err error }

func (e *HandshakeError) Error() string { return "handshake: " + e.Err.Error() }
func (e *HandshakeError) Unwrap() error { return e.Err }

func Dial(ctx context.Context, opts DialOptions) (*Conn, error) {
	ctx, cancel := context.WithTimeout(ctx, handshakeTimeout)
	defer cancel()

	client := http.DefaultClient
	if opts.InsecureSkipVerify {
		client = &http.Client{Transport: &http.Transport{
			Proxy:           http.ProxyFromEnvironment,
			TLSClientConfig: &tls.Config{InsecureSkipVerify: true}, //nolint:gosec // see DialOptions
		}}
	}
	ws, _, err := websocket.Dial(ctx, opts.URL, &websocket.DialOptions{HTTPClient: client})
	if err != nil {
		return nil, fmt.Errorf("dial %s: %w", opts.URL, err)
	}
	ws.SetReadLimit(noise.MaxMessageLen)
	c, err := handshake(ctx, ws, opts)
	if err != nil {
		ws.Close(websocket.StatusPolicyViolation, "handshake failed")
		return nil, err
	}
	return c, nil
}

func handshake(ctx context.Context, ws wsConn, opts DialOptions) (*Conn, error) {
	challenge, err := readBinary(ctx, ws)
	if err != nil {
		return nil, fmt.Errorf("read challenge: %w", err)
	}
	if len(challenge) != noise.ChallengeLen {
		return nil, &HandshakeError{fmt.Errorf("challenge of %d bytes", len(challenge))}
	}
	ini, err := noise.NewInitiator(opts.Identity, opts.ServerPublic, challenge)
	if err != nil {
		return nil, err
	}
	init := protocol.HandshakeInit{}
	if opts.Init != nil {
		init = *opts.Init
	}
	init.ProtocolMajor = protocol.ProtocolMajor
	init.ProtocolMinor = protocol.ProtocolMinor
	init.Commands = protocol.SupportedNames()
	sent := time.Now()
	init.ClientTimeMS = protocol.Int(sent.UnixMilli())
	payload, err := protocol.Marshal(init)
	if err != nil {
		return nil, err
	}
	m1, err := ini.WriteInit(payload)
	if err != nil {
		return nil, err
	}
	if err := ws.Write(ctx, websocket.MessageBinary, m1); err != nil {
		return nil, fmt.Errorf("send handshake: %w", err)
	}
	m2, err := readBinary(ctx, ws)
	if err != nil {
		// crhs closes the connection instead of answering when it rejects us.
		var ce websocket.CloseError
		if errors.As(err, &ce) {
			return nil, &HandshakeError{fmt.Errorf("rejected by server: %s", ce.Reason)}
		}
		return nil, fmt.Errorf("read handshake response: %w", err)
	}
	received := time.Now()
	respPayload, session, err := ini.ReadResponse(m2)
	if err != nil {
		return nil, &HandshakeError{err}
	}
	// The first element is always protocol_major. A different major version may have a different
	// schema after it, so it must not be parsed at all.
	major, err := protocol.PeekMajor(respPayload)
	if err != nil {
		return nil, &HandshakeError{fmt.Errorf("decode response: %w", err)}
	}
	if major != protocol.ProtocolMajor {
		return nil, &HandshakeError{fmt.Errorf("protocol_major mismatch: server %d, client %d", major, protocol.ProtocolMajor)}
	}
	var resp protocol.HandshakeResponse
	if err := protocol.Unmarshal(respPayload, &resp); err != nil {
		return nil, &HandshakeError{fmt.Errorf("decode response: %w", err)}
	}
	// The minor version is not refused: it only adds optional names, negotiated by intersection.
	negotiated := protocol.SupportedSet().Intersect(protocol.NewSet(resp.Commands...))
	for _, name := range protocol.RequiredNames() {
		if negotiated.Has(name) {
			continue
		}
		_ = ws.Close(websocket.StatusPolicyViolation, "missing required command: "+name)
		return nil, &HandshakeError{fmt.Errorf("missing required command: %s", name)}
	}
	// Assume the server stamped its time halfway through the round trip.
	mid := sent.Add(received.Sub(sent) / 2)
	offset := mid.Sub(time.UnixMilli(int64(resp.ServerTimeMS)))
	return &Conn{ws: ws, session: session, Response: &resp, Negotiated: negotiated, ClockOffset: offset}, nil
}

func readBinary(ctx context.Context, ws wsConn) ([]byte, error) {
	typ, data, err := ws.Read(ctx)
	if err != nil {
		return nil, err
	}
	if typ != websocket.MessageBinary {
		return nil, errors.New("unexpected text message")
	}
	return data, nil
}

// Send encrypts and writes one encoded frame. The write is bounded by writeTimeout so a stalled peer
// cannot hold the Peer's send lock forever.
func (c *Conn) Send(ctx context.Context, frame []byte) error {
	if len(frame) > MaxEnvelopeLen {
		return fmt.Errorf("frame of %d bytes exceeds %d", len(frame), MaxEnvelopeLen)
	}
	c.sendMu.Lock()
	defer c.sendMu.Unlock()
	wctx, cancel := context.WithTimeout(ctx, writeTimeout)
	defer cancel()
	// Encrypt under the lock: the nonce order must match the wire order.
	ct, err := c.session.Encrypt(frame)
	if err != nil {
		return err
	}
	return c.ws.Write(wctx, websocket.MessageBinary, ct)
}

// Recv reads and decrypts one frame. The returned bytes are still encoded; protocol.Peer decodes them.
func (c *Conn) Recv(ctx context.Context) ([]byte, error) {
	ct, err := readBinary(ctx, c.ws)
	if err != nil {
		return nil, err
	}
	data, err := c.session.Decrypt(ct)
	if err != nil {
		return nil, fmt.Errorf("decrypt: %w", err)
	}
	if len(data) > MaxEnvelopeLen {
		return nil, fmt.Errorf("frame of %d bytes exceeds %d", len(data), MaxEnvelopeLen)
	}
	return data, nil
}

func (c *Conn) Close(reason string) error {
	return c.ws.Close(websocket.StatusNormalClosure, reason)
}
