package daemon

import (
	"errors"
	"net"
	"sync"
	"testing"

	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
)

// testPeer returns a peer that accepts one private event name, so a test can tell whether the
// peer was closed: Emit then fails with protocol.ErrClosed.
func testPeer() *protocol.Peer {
	return protocol.NewPeer(func([]byte) error { return nil }, protocol.NewSet("test.event"))
}

func assertPeerClosed(t *testing.T, peer *protocol.Peer) {
	t.Helper()
	if err := peer.Emit("test.event", protocol.Empty{}); !errors.Is(err, protocol.ErrClosed) {
		t.Fatalf("the peer is not closed: Emit = %v", err)
	}
}

// TestConnCloseClosesPeerSetDuringHandshake covers a connection closed while its handshake
// completes: the peer installed afterwards is closed at once, because close has already run and
// would never see it.
func TestConnCloseClosesPeerSetDuringHandshake(t *testing.T) {
	t.Run("set after close", func(t *testing.T) {
		nc, other := net.Pipe()
		defer other.Close()
		c := &conn{nc: nc}
		c.close()

		peer := testPeer()
		if c.setPeer(peer, nil) {
			t.Fatal("setPeer installed a peer on a closed connection")
		}
		assertPeerClosed(t, peer)
	})

	t.Run("concurrent", func(t *testing.T) {
		for range 50 {
			nc, other := net.Pipe()
			c := &conn{nc: nc}
			peer := testPeer()

			start := make(chan struct{})
			var wg sync.WaitGroup
			wg.Add(2)
			go func() {
				defer wg.Done()
				<-start
				c.close()
			}()
			go func() {
				defer wg.Done()
				<-start
				c.setPeer(peer, nil)
			}()
			close(start)
			wg.Wait()

			assertPeerClosed(t, peer)
			other.Close()
		}
	})
}
