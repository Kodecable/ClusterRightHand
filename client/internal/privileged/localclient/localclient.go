// Package localclient is the crha CLI's client of the privileged mode's unix socket, in the
// crh-priv `local` role (doc/protocol.md crh-priv, doc/privilege.md 本地批准). The privileged
// mode identifies the caller by SO_PEERCRED; the caller must be in a local trust entry.
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

// Pending lists the tasks waiting for local approval.
func (c *Client) Pending(ctx context.Context) ([]protocol.PendingEntry, error) {
	var entries []protocol.PendingEntry
	if err := c.peer.Request(ctx, wire.CmdPendingList, protocol.Empty{}, &entries); err != nil {
		return nil, err
	}
	if entries == nil {
		entries = []protocol.PendingEntry{}
	}
	return entries, nil
}

// Approve approves one pending task.
func (c *Client) Approve(ctx context.Context, taskID string, attempt uint64, message string) error {
	return c.verdict(ctx, wire.CmdLocalApprove, taskID, attempt, message)
}

// Deny denies one pending task with an optional message.
func (c *Client) Deny(ctx context.Context, taskID string, attempt uint64, message string) error {
	return c.verdict(ctx, wire.CmdLocalDeny, taskID, attempt, message)
}

func (c *Client) verdict(ctx context.Context, cmd, taskID string, attempt uint64, message string) error {
	var empty protocol.Empty
	return c.peer.Request(ctx, cmd, protocol.LocalVerdict{
		TaskID:  taskID,
		Attempt: protocol.Uint(attempt),
		Message: message,
	}, &empty)
}

// Revoke adds one revocation without a deadline: the authorization stays revoked forever.
func (c *Client) Revoke(ctx context.Context, authorizationID [32]byte) error {
	var empty protocol.Empty
	return c.peer.Request(ctx, protocol.CmdRevocationsAdd, protocol.RevocationsAdd{
		Entries: []protocol.Revocation{{AuthorizationID: protocol.Hash(authorizationID)}},
	}, &empty)
}
