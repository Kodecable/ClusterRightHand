// Package localclient is the crha CLI's client of the privileged mode's unix socket, in the
// crh-priv `local` role (doc/design/protocol.md "crh-priv", doc/design/privilege.md "Local approval window"). The privileged
// mode identifies the caller by SO_PEERCRED; the caller must be in a local trust entry. The
// client only manages the local approval window.
package localclient

import (
	"context"
	"errors"
	"fmt"
	"net"
	"sync"
	"time"

	"github.com/Kodecable/ClusterRightHand/client/internal/privileged/wire"
	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
)

// handshakeTimeout bounds the connect and handshake of one command.
const handshakeTimeout = 30 * time.Second

// Client is one local-role connection to the privileged mode.
type Client struct {
	conn   net.Conn
	stream *wire.Stream
	peer   *protocol.Peer

	runDone chan struct{}
	runErr  error
	once    sync.Once
}

// Dial connects to socket as the crh-priv local role. version is this build's crha version.
func Dial(ctx context.Context, socket, version string) (*Client, error) {
	if socket == "" {
		return nil, errors.New("local client: no socket path")
	}
	dialer := net.Dialer{Timeout: handshakeTimeout}
	conn, err := dialer.DialContext(ctx, "unix", socket)
	if err != nil {
		return nil, fmt.Errorf("connect %s: %w", socket, err)
	}
	_ = conn.SetDeadline(time.Now().Add(handshakeTimeout))
	_, negotiated, err := wire.ClientHandshake(conn, conn, wire.ClientOptions{
		Role:        wire.RoleLocal,
		CRHAVersion: version,
	})
	if err != nil {
		conn.Close()
		return nil, fmt.Errorf("crh-priv handshake: %w", err)
	}
	_ = conn.SetDeadline(time.Time{})
	client := &Client{
		conn:    conn,
		stream:  wire.NewStreamFor(conn, conn, negotiated, wire.RoleLocal),
		runDone: make(chan struct{}),
	}
	client.peer = client.stream.Peer()
	go func() {
		client.runErr = client.stream.Run()
		close(client.runDone)
	}()
	return client, nil
}

// Close closes the connection.
func (c *Client) Close() error {
	var err error
	c.once.Do(func() {
		err = c.conn.Close()
		c.peer.Close(errors.New("local client closed"))
		<-c.runDone
	})
	return err
}

// Window reports the current local approval window.
func (c *Client) Window(ctx context.Context) (protocol.WindowState, error) {
	var state protocol.WindowState
	if err := c.peer.Request(ctx, wire.CmdWindowStatus, protocol.Empty{}, &state); err != nil {
		return protocol.ClosedWindow(), err
	}
	return state, nil
}

// Open opens or replaces the local approval window for length and returns its state.
func (c *Client) Open(ctx context.Context, length time.Duration) (protocol.WindowState, error) {
	var state protocol.WindowState
	ms := uint64(length / time.Millisecond)
	if err := c.peer.Request(ctx, wire.CmdWindowOpen, protocol.WindowOpen{
		DurationMS: protocol.Uint(ms),
	}, &state); err != nil {
		return protocol.ClosedWindow(), err
	}
	return state, nil
}

// CloseWindow closes the local approval window early and returns its new state.
func (c *Client) CloseWindow(ctx context.Context) (protocol.WindowState, error) {
	var state protocol.WindowState
	if err := c.peer.Request(ctx, wire.CmdWindowClose, protocol.Empty{}, &state); err != nil {
		return protocol.ClosedWindow(), err
	}
	return state, nil
}
