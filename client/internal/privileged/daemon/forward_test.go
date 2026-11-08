package daemon

import (
	"errors"
	"io"
	"net"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/Kodecable/ClusterRightHand/client/internal/privileged/wire"
	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
)

// TestForwardConnectionCap covers maxForwardConns: a ninth forward handshake is refused, and
// closing one connection frees its slot (doc/privilege.md 特权模式).
func TestForwardConnectionCap(t *testing.T) {
	keys := newTestKeys(t)
	env := crhsOnlyEnv(t, keys)

	clients := make([]*forwardClient, 0, maxForwardConns)
	for range maxForwardConns {
		clients = append(clients, dialForward(t, env.paths.Socket))
	}
	if got := len(env.server.forwardConns()); got != maxForwardConns {
		t.Fatalf("forward connections = %d, want %d", got, maxForwardConns)
	}

	conn, err := net.Dial("unix", env.paths.Socket)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	_, _, err = wire.ClientHandshake(conn, conn, wire.ClientOptions{Role: wire.RoleForward, CRHAVersion: "test"})
	_ = conn.Close()
	if err == nil {
		t.Fatal("handshake succeeded beyond the forward connection cap")
	}

	// The slot is released when the connection ends, so a new forward can connect again.
	clients[0].close()
	waitForwardCount(t, env.server, maxForwardConns-1)
	conn, err = net.Dial("unix", env.paths.Socket)
	if err != nil {
		t.Fatalf("dial after freeing a slot: %v", err)
	}
	if _, _, err := wire.ClientHandshake(conn, conn, wire.ClientOptions{Role: wire.RoleForward, CRHAVersion: "test"}); err != nil {
		_ = conn.Close()
		t.Fatalf("handshake after freeing a slot: %v", err)
	}
	_ = conn.Close()
}

func waitForwardCount(t *testing.T, s *Server, want int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if len(s.forwardConns()) == want {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("forward connections = %d, want %d", len(s.forwardConns()), want)
}

// TestSlowForwardDoesNotBlockDecision covers the broadcast path: pushLocalDecision enqueues for
// every forward connection and returns, while the connection that never reads is closed by its
// per-frame write deadline.
func TestSlowForwardDoesNotBlockDecision(t *testing.T) {
	keys := newTestKeys(t)
	env := localEnv(t, keys)
	env.writeTimeout = 150 * time.Millisecond
	env.restart()
	slow := dialForwardNoRead(t, env.paths.Socket)

	// Enough bytes to fill the unix socket buffers several times over: the drain goroutine blocks
	// in Write, hits the deadline and closes the connection.
	decision := protocol.LocalDecision{
		TaskID:  "slow-forward",
		Attempt: 1,
		State: protocol.LocalState{
			Kind:    protocol.LocalStateDenied,
			Message: strings.Repeat("x", 55<<10),
		},
	}
	pushed := make(chan struct{})
	go func() {
		for range forwardOutboxSize {
			env.server.pushLocalDecision(decision)
		}
		close(pushed)
	}()
	select {
	case <-pushed:
	case <-time.After(2 * time.Second):
		t.Fatal("pushLocalDecision blocked on a connection that does not read")
	}

	// Wait past the write deadline before reading: reading earlier would drain the socket and let
	// the blocked write succeed instead of timing out.
	time.Sleep(3 * env.writeTimeout)
	_ = slow.SetReadDeadline(time.Now().Add(5 * time.Second))
	buf := make([]byte, 32<<10)
	for {
		_, err := slow.Read(buf)
		if err == nil {
			continue
		}
		if errors.Is(err, os.ErrDeadlineExceeded) {
			t.Fatal("the slow forward connection was not closed by the write deadline")
		}
		return
	}
}

// TestReloadDoesNotBlockOnASlowForward covers the Run loop's reload broadcast with a peer whose
// send never returns: reload queues the trust summary and returns instead of waiting for it. The
// real socket path is exercised by TestSlowForwardDoesNotBlockDecision; this isolates the sender
// that reload must not call synchronously.
func TestReloadDoesNotBlockOnASlowForward(t *testing.T) {
	keys := newTestKeys(t)
	env := crhsOnlyEnv(t, keys)

	release := make(chan struct{})
	blocked := make(chan struct{}, 1)
	peer := protocol.NewPeer(func([]byte) error {
		select {
		case blocked <- struct{}{}:
		default:
		}
		<-release
		return io.ErrClosedPipe
	}, protocol.NewSet(protocol.EventTrustSummary, protocol.EventLocalDecision))
	nc, other := net.Pipe()
	c := &conn{s: env.server, nc: nc, outbox: make(chan outbound, forwardOutboxSize)}
	c.setPeer(peer, nil)
	if !env.server.addForward(c) {
		t.Fatal("could not register the test forward connection")
	}
	go c.drainOutbox()
	t.Cleanup(func() {
		close(release)
		_ = nc.Close()
		_ = other.Close()
		c.close()
	})

	// A changed digest makes reload push trust.summary to every forward connection.
	env.writeConfig(func(p envPaths) string {
		return baseConfig(p, os.Getuid()) +
			sshTrust("crhs", "crhs", keys.crhsLine, `["execute", "cosign"]`, "") +
			sshTrust("alice", "user", keys.userLine, `["execute"]`, "")
	})
	done := make(chan struct{})
	go func() {
		env.server.reload()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("reload blocked on a forward connection that does not read")
	}
	select {
	case <-blocked:
	case <-time.After(2 * time.Second):
		t.Fatal("the queued trust.summary was never written")
	}
}
