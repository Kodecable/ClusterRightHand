package agent

import (
	"context"
	"sync"
	"time"

	"github.com/Kodecable/ClusterRightHand/client/internal/privileged/wire"
	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
)

// nativePTYReapTimeout bounds how long crha waits for a native helper to leave after pty.close
// before killing it, as it does with a helper whose start failed.
const nativePTYReapTimeout = 5 * time.Second

// nativePTYChannel is the privileged channel of a native-mode terminal: one helper process started
// with launchNative, living exactly as long as the terminal (doc/design/pty.md "Privilege"). The
// helper serves the crh-priv native role and hosts the terminal itself, without authorization, as a
// native task. When its process exits or its stdio breaks before pty.exited, the relay ends the
// terminal helper_lost with code -1, exactly as a broken forward connection does.
type nativePTYChannel struct {
	h      *nativeHelper
	stream *wire.Stream
	// loopDone is closed when the stream read loop returns, which is how the relay learns that the
	// helper is gone.
	loopDone  chan struct{}
	closeOnce sync.Once
}

// launchNativePTY starts the helper of one privileged terminal and completes its crh-priv
// handshake. A helper from before privileged terminals answers without the terminal names: it is
// reaped and the pty.open is refused with privileged_unsupported, while its tasks keep working. A
// helper that cannot be started fails the same way a native task's helper does.
func (a *Agent) launchNativePTY() (*nativePTYChannel, error) {
	// The helper outlives the crhs request that started it, so it is not tied to that context.
	h, err := a.launchNative(context.Background())
	if err != nil {
		return nil, &protocol.RemoteError{Code: protocol.CodePrivilegedUnsupported, Message: err.Error()}
	}
	if !h.negotiated.Has(wire.CmdPTYOpen) {
		reapNativeHelper(h)
		return nil, &protocol.RemoteError{
			Code:    protocol.CodePrivilegedUnsupported,
			Message: "the native helper does not implement pty.open",
		}
	}
	c := &nativePTYChannel{h: h, loopDone: make(chan struct{})}
	c.stream = wire.NewStreamFor(h.stdout, h.stdin, h.negotiated, wire.RoleNative)
	peer := c.stream.Peer()
	peer.HandleEvent(wire.EventPTYOutput, a.handlePrivPTYOutput)
	peer.HandleEvent(wire.EventPTYExited, a.handlePrivPTYExited)
	go func() {
		err := c.stream.Run()
		// Fail requests waiting for a response; the read loop is the only receiver.
		c.stream.Close(err)
		close(c.loopDone)
	}()
	return c, nil
}

// Request sends one pty.* request to the helper.
func (c *nativePTYChannel) Request(ctx context.Context, cmd string, req, resp any) error {
	return c.stream.Peer().Request(ctx, cmd, req, resp)
}

// Done is closed when the helper's stream ended.
func (c *nativePTYChannel) Done() <-chan struct{} { return c.loopDone }

// Close reaps the helper after pty.close: it closes the helper's stdin, waits a bounded time for
// the process to leave, then kills it, and reaps the process either way. Waiting for the stream
// loop before Wait keeps Wait from closing the stdout pipe under a read.
func (c *nativePTYChannel) Close() {
	c.closeOnce.Do(func() {
		_ = c.h.stdin.Close()
		select {
		case <-c.loopDone:
		case <-time.After(nativePTYReapTimeout):
			if c.h.cmd.Process != nil {
				_ = c.h.cmd.Process.Kill()
			}
			<-c.loopDone
		}
		_ = c.h.cmd.Wait()
	})
}

// reapNativeHelper kills and reaps a helper that cannot serve terminals. It never accepted a task or
// terminal, so signalling it is fitting, as abort does for a failed native start.
func reapNativeHelper(h *nativeHelper) {
	_ = h.stdin.Close()
	if h.cmd.Process != nil {
		_ = h.cmd.Process.Kill()
	}
	_ = h.cmd.Wait()
}
