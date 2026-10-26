// Package transport carries crh envelopes between crha and crhs: a WebSocket connection, the server's
// challenge, a Noise IK handshake bound to that challenge, then one encrypted envelope per binary message.
// See doc/execution-plane.md#通信安全.
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
	"github.com/Kodecable/ClusterRightHand/client/internal/proto/crhv1"
	"github.com/coder/websocket"
	"google.golang.org/protobuf/proto"
)

// MaxEnvelopeLen bounds one encoded envelope so that it fits a Noise transport message.
const MaxEnvelopeLen = 60 * 1024

const handshakeTimeout = 20 * time.Second

type DialOptions struct {
	// URL of the agent endpoint, wss://host/agent.
	URL string
	// InsecureSkipVerify disables TLS certificate checks (tls_verify = "none"). Safe because the
	// Noise layer authenticates crhs by its static key.
	InsecureSkipVerify bool
	Identity           noise.Keypair
	ServerPublic       []byte
	Init               *crhv1.HandshakeInit
}

// Conn is an authenticated, encrypted envelope stream. Send is safe for concurrent use; Recv is not.
type Conn struct {
	ws       *websocket.Conn
	session  *noise.Session
	Response *crhv1.HandshakeResponse
	// ClockOffset is the local clock minus crhs's clock, measured during the handshake.
	ClockOffset time.Duration

	sendMu sync.Mutex
}

// HandshakeError means crhs rejected us (unknown key, bad token, ...) rather than a network failure.
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

func handshake(ctx context.Context, ws *websocket.Conn, opts DialOptions) (*Conn, error) {
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
	init := proto.Clone(opts.Init).(*crhv1.HandshakeInit)
	sent := time.Now()
	init.ClientTimeUnixMs = sent.UnixMilli()
	payload, err := proto.Marshal(init)
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
	var resp crhv1.HandshakeResponse
	if err := proto.Unmarshal(respPayload, &resp); err != nil {
		return nil, &HandshakeError{fmt.Errorf("decode response: %w", err)}
	}
	// Assume the server stamped its time halfway through the round trip.
	mid := sent.Add(received.Sub(sent) / 2)
	offset := mid.Sub(time.UnixMilli(resp.ServerTimeUnixMs))
	return &Conn{ws: ws, session: session, Response: &resp, ClockOffset: offset}, nil
}

func readBinary(ctx context.Context, ws *websocket.Conn) ([]byte, error) {
	typ, data, err := ws.Read(ctx)
	if err != nil {
		return nil, err
	}
	if typ != websocket.MessageBinary {
		return nil, errors.New("unexpected text message")
	}
	return data, nil
}

func (c *Conn) Send(ctx context.Context, env *crhv1.Envelope) error {
	data, err := proto.Marshal(env)
	if err != nil {
		return err
	}
	if len(data) > MaxEnvelopeLen {
		return fmt.Errorf("envelope of %d bytes exceeds %d", len(data), MaxEnvelopeLen)
	}
	c.sendMu.Lock()
	defer c.sendMu.Unlock()
	// Encrypt under the lock: the nonce order must match the wire order.
	ct, err := c.session.Encrypt(data)
	if err != nil {
		return err
	}
	return c.ws.Write(ctx, websocket.MessageBinary, ct)
}

func (c *Conn) Recv(ctx context.Context) (*crhv1.Envelope, error) {
	ct, err := readBinary(ctx, c.ws)
	if err != nil {
		return nil, err
	}
	data, err := c.session.Decrypt(ct)
	if err != nil {
		return nil, fmt.Errorf("decrypt: %w", err)
	}
	var env crhv1.Envelope
	if err := proto.Unmarshal(data, &env); err != nil {
		return nil, fmt.Errorf("decode envelope: %w", err)
	}
	return &env, nil
}

func (c *Conn) Close(reason string) error {
	return c.ws.Close(websocket.StatusNormalClosure, reason)
}
