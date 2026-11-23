package agent

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Kodecable/ClusterRightHand/client/internal/execenv"
	"github.com/Kodecable/ClusterRightHand/client/internal/noise"
	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
	"github.com/Kodecable/ClusterRightHand/client/internal/pty"
	"github.com/fxamacker/cbor/v2"
)

var errFakeDataClosed = errors.New("fake data connection closed")

// fakeTerminalConn is an in-memory DataConn: frames the agent sends arrive on out, and the test
// injects crhs frames with push.
type fakeTerminalConn struct {
	out    chan protocol.DataFrame
	input  chan protocol.DataFrame
	closed chan struct{}
	once   sync.Once
}

func newFakeTerminalConn() *fakeTerminalConn {
	return &fakeTerminalConn{
		out:    make(chan protocol.DataFrame, 256),
		input:  make(chan protocol.DataFrame, 16),
		closed: make(chan struct{}),
	}
}

func (c *fakeTerminalConn) Send(ctx context.Context, frame []byte) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	var f protocol.DataFrame
	if err := protocol.Unmarshal(frame, &f); err != nil {
		return err
	}
	select {
	case c.out <- f:
		return nil
	case <-c.closed:
		return errFakeDataClosed
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (c *fakeTerminalConn) Recv(ctx context.Context) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	select {
	case f := <-c.input:
		return protocol.Marshal(f)
	case <-c.closed:
		return nil, errFakeDataClosed
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (c *fakeTerminalConn) Close(string) error {
	c.once.Do(func() { close(c.closed) })
	return nil
}

// drop simulates the network losing the connection.
func (c *fakeTerminalConn) drop() { _ = c.Close("test drop") }

func (c *fakeTerminalConn) push(f protocol.DataFrame) { c.input <- f }

// fakePTYDialer hands out one fresh in-memory data connection per dial.
type fakePTYDialer struct {
	conns chan *fakeTerminalConn
}

func newFakePTYDialer() *fakePTYDialer {
	return &fakePTYDialer{conns: make(chan *fakeTerminalConn, 8)}
}

func (d *fakePTYDialer) dial(ctx context.Context, _ string) (DataConn, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	c := newFakeTerminalConn()
	select {
	case d.conns <- c:
		return c, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func testPTYEnv(t *testing.T) *execenv.Environment {
	t.Helper()
	return &execenv.Environment{
		Shell:   "/bin/sh",
		Path:    "/usr/local/bin:/usr/bin:/bin",
		Home:    t.TempDir(),
		User:    "tester",
		Logname: "tester",
	}
}

// ptyEvents registers the events a fake crhs that offers the terminal names must consume: the
// node's facts and the two terminal events.
func ptyEvents(p *protocol.Peer, list chan protocol.PTYList, exited chan protocol.PTYExited) {
	p.HandleEvent(protocol.EventFacts, func(body cbor.RawMessage) error {
		var f protocol.Facts
		return protocol.Unmarshal(body, &f)
	})
	p.HandleEvent(protocol.EventPTYList, func(body cbor.RawMessage) error {
		var l protocol.PTYList
		if err := protocol.Unmarshal(body, &l); err != nil {
			return err
		}
		list <- l
		return nil
	})
	p.HandleEvent(protocol.EventPTYExited, func(body cbor.RawMessage) error {
		var e protocol.PTYExited
		if err := protocol.Unmarshal(body, &e); err != nil {
			return err
		}
		exited <- e
		return nil
	})
}

// collectUntil reads data frames until their accumulated output contains want.
func collectUntil(t *testing.T, conn *fakeTerminalConn, want string) string {
	t.Helper()
	var b strings.Builder
	timeout := time.After(10 * time.Second)
	for {
		select {
		case f := <-conn.out:
			if f.Kind == protocol.DataFrameData {
				b.Write(f.Bytes)
			}
			if f.Kind == protocol.DataFrameData && strings.Contains(b.String(), want) {
				return b.String()
			}
		case <-timeout:
			t.Fatalf("data connection never delivered %q; got %q", want, b.String())
		}
	}
}

// collectPrefix reads data frames until at least n bytes arrived and returns them.
func collectPrefix(t *testing.T, conn *fakeTerminalConn, n int) string {
	t.Helper()
	var b strings.Builder
	timeout := time.After(10 * time.Second)
	for b.Len() < n {
		select {
		case f := <-conn.out:
			if f.Kind == protocol.DataFrameData {
				b.Write(f.Bytes)
			}
		case <-timeout:
			t.Fatalf("data connection delivered %d bytes, want %d", b.Len(), n)
		}
	}
	return b.String()
}

func waitDataKind(t *testing.T, conn *fakeTerminalConn, kind protocol.DataFrameKind) protocol.DataFrame {
	t.Helper()
	timeout := time.After(10 * time.Second)
	for {
		select {
		case f := <-conn.out:
			if f.Kind == kind {
				return f
			}
		case <-timeout:
			t.Fatalf("data connection never delivered a %q frame", kind)
		}
	}
}

// TestPTYListAfterHello covers doc/design/pty.md "Reconnect": every held terminal, running or
// exited, is reported in pty.list right after the handshake.
func TestPTYListAfterHello(t *testing.T) {
	serverKey, err := noise.GenerateKeypair()
	if err != nil {
		t.Fatal(err)
	}
	listCh := make(chan protocol.PTYList, 4)
	exitedCh := make(chan protocol.PTYExited, 4)
	srv := startFake(t, serverKey, fakeConfig{
		commands: protocol.OfferedNames(),
		setup: func(p *protocol.Peer) {
			ptyEvents(p, listCh, exitedCh)
		},
	})
	a := newTestAgent(t, Options{Env: testPTYEnv(t)})
	t.Cleanup(a.shutdownPTY)

	exited, err := a.pty.mgr.Open(pty.OpenRequest{
		ID: "exited", Argv: []string{"/bin/sh", "-c", "exit 7"}, Rows: 24, Cols: 80,
		ScrollbackBytes: 1 << 20, Meta: []byte("m1"),
	})
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-exited.OutputDone():
	case <-time.After(10 * time.Second):
		t.Fatal("terminal did not exit")
	}
	if _, err := a.pty.mgr.Open(pty.OpenRequest{
		ID: "running", Argv: []string{"/bin/sh", "-c", "sleep 30"}, Rows: 30, Cols: 100,
		ScrollbackBytes: 1 << 20,
	}); err != nil {
		t.Fatal(err)
	}

	startSession(t, a, dialTo(t, srv, serverKey))
	list := waitCh(t, listCh, "pty.list")
	if len(list.Terminals) != 2 {
		t.Fatalf("pty.list = %+v, want two terminals", list)
	}
	byID := map[string]protocol.PTYStatus{}
	for _, st := range list.Terminals {
		byID[st.PTYID] = st
	}
	gone, ok := byID["exited"]
	if !ok || !gone.Exited || gone.ExitCode != 7 {
		t.Fatalf("exited terminal = %+v, want exited with code 7", gone)
	}
	if string(gone.Meta) != "m1" {
		t.Fatalf("exited terminal meta = %q, want m1", gone.Meta)
	}
	live, ok := byID["running"]
	if !ok || live.Exited {
		t.Fatalf("running terminal = %+v, want running", live)
	}
	if live.Rows != 30 || live.Cols != 100 {
		t.Fatalf("running terminal size = %dx%d", live.Rows, live.Cols)
	}
}

// TestPTYDataReplayAndInput covers the data connection: output reaches crhs, input reaches the
// PTY, and a replacement connection starts with the whole ring buffer again.
func TestPTYDataReplayAndInput(t *testing.T) {
	oldMin := ptyMinBackoff
	ptyMinBackoff = 20 * time.Millisecond
	t.Cleanup(func() { ptyMinBackoff = oldMin })

	serverKey, err := noise.GenerateKeypair()
	if err != nil {
		t.Fatal(err)
	}
	dialer := newFakePTYDialer()
	listed := make(chan protocol.PTYList, 4)
	exitedCh := make(chan protocol.PTYExited, 4)
	srv := startFake(t, serverKey, fakeConfig{
		commands: protocol.OfferedNames(),
		setup: func(p *protocol.Peer) {
			ptyEvents(p, listed, exitedCh)
		},
		run: func(ctx context.Context, p *protocol.Peer) {
			waitCh(t, listed, "pty.list")
			var empty protocol.Empty
			err := p.Request(ctx, protocol.CmdPTYOpen, protocol.PTYOpen{
				PTYID:           "io",
				Argv:            []string{"/bin/sh", "-c", "printf hello; cat"},
				Rows:            24,
				Cols:            80,
				ScrollbackBytes: 1 << 20,
			}, &empty)
			if err != nil {
				t.Errorf("pty.open: %v", err)
			}
		},
	})
	a := newTestAgent(t, Options{Env: testPTYEnv(t), PTYDial: dialer.dial})
	t.Cleanup(a.shutdownPTY)
	startSession(t, a, dialTo(t, srv, serverKey))

	conn1 := waitCh(t, dialer.conns, "the first terminal data connection")
	collectUntil(t, conn1, "hello")
	conn1.push(protocol.DataFrame{Kind: protocol.DataFrameData, Bytes: []byte("world\n")})
	collectUntil(t, conn1, "world")

	// Drop the connection: the worker must redial, and the new connection replays the ring from
	// its oldest byte, not from where the first one stopped.
	conn1.drop()
	conn2 := waitCh(t, dialer.conns, "a replacement terminal data connection")
	replay := collectPrefix(t, conn2, len("helloworld\r\n"))
	if !strings.HasPrefix(replay, "hello") || !strings.Contains(replay, "world") {
		t.Fatalf("replacement connection starts with %q, want the ring replayed from hello", replay)
	}
	// Live input and output continue after the replay.
	conn2.push(protocol.DataFrame{Kind: protocol.DataFrameData, Bytes: []byte("again\n")})
	collectUntil(t, conn2, "again")
}

// collectMarker reads a fresh data connection's output until it starts with one of markers, and
// returns that marker. A new connection must begin with its terminal's ring buffer replay, so the
// marker is at the start rather than somewhere in live output.
func collectMarker(t *testing.T, conn *fakeTerminalConn, markers ...string) string {
	t.Helper()
	if marker := markerWithin(conn, markers, 10*time.Second); marker != "" {
		return marker
	}
	t.Fatalf("data connection delivered no replay of %v", markers)
	return ""
}

// markerWithin is collectMarker's non-fatal form. A connection that the old control connection
// raced with dials but carries no replay; it reports "" so the test can skip it.
func markerWithin(conn *fakeTerminalConn, markers []string, wait time.Duration) string {
	var b strings.Builder
	timeout := time.NewTimer(wait)
	defer timeout.Stop()
	for {
		select {
		case f := <-conn.out:
			if f.Kind != protocol.DataFrameData {
				continue
			}
			b.Write(f.Bytes)
			out := b.String()
			for _, marker := range markers {
				if strings.HasPrefix(out, marker) {
					return marker
				}
			}
		case <-timeout.C:
			return ""
		}
	}
}

// TestPTYReconnectWakesEveryTerminal covers doc/design/pty.md "Reconnect": after the control
// connection comes back, every running terminal gets its own data connection again, each beginning
// with its ring replay. A single shared wake-up must not leave the other worker waiting forever.
func TestPTYReconnectWakesEveryTerminal(t *testing.T) {
	oldMin := ptyMinBackoff
	ptyMinBackoff = 20 * time.Millisecond
	t.Cleanup(func() { ptyMinBackoff = oldMin })

	serverKey, err := noise.GenerateKeypair()
	if err != nil {
		t.Fatal(err)
	}
	listed := make(chan protocol.PTYList, 4)
	exitedCh := make(chan protocol.PTYExited, 4)
	srv := startFake(t, serverKey, fakeConfig{
		commands: protocol.OfferedNames(),
		setup: func(p *protocol.Peer) {
			ptyEvents(p, listed, exitedCh)
		},
	})
	dialer := newFakePTYDialer()
	a := newTestAgent(t, Options{Env: testPTYEnv(t), PTYDial: dialer.dial})
	t.Cleanup(a.shutdownPTY)

	terms := []struct{ id, marker string }{
		{id: "first", marker: "first-prompt"},
		{id: "second", marker: "second-prompt"},
	}
	for _, term := range terms {
		if _, err := a.pty.mgr.Open(pty.OpenRequest{
			ID:              term.id,
			Argv:            []string{"/bin/sh", "-c", "printf " + term.marker + "; cat"},
			Rows:            24,
			Cols:            80,
			ScrollbackBytes: 1 << 20,
		}); err != nil {
			t.Fatal(err)
		}
	}
	markers := []string{terms[0].marker, terms[1].marker}

	stop, done := startSession(t, a, dialTo(t, srv, serverKey))
	waitCh(t, listed, "pty.list")
	for range terms {
		conn := waitCh(t, dialer.conns, "a terminal data connection")
		collectMarker(t, conn, markers...)
	}
	stop()
	<-done

	// Reconnect: both terminals must dial again, not just the one worker that got the wake-up.
	// A dial that raced the old control connection's shutdown carries no replay and is skipped.
	startSession(t, a, dialTo(t, srv, serverKey))
	waitCh(t, listed, "pty.list")
	replayed := map[string]bool{}
	deadline := time.After(10 * time.Second)
	for len(replayed) < len(terms) {
		select {
		case conn := <-dialer.conns:
			if marker := markerWithin(conn, markers, 250*time.Millisecond); marker != "" {
				replayed[marker] = true
			}
		case <-deadline:
			t.Fatalf("data connections after the reconnect replayed %v, want both terminals", replayed)
		}
	}
}

// TestPTYReconnectReplaysExitedTerminalOnce covers doc/design/pty.md "Reconnect": an exited
// terminal crhs has not closed is replayed once on each new control connection, ending with
// [end], and is not dialed again while that connection lasts.
func TestPTYReconnectReplaysExitedTerminalOnce(t *testing.T) {
	oldMin := ptyMinBackoff
	ptyMinBackoff = 20 * time.Millisecond
	t.Cleanup(func() { ptyMinBackoff = oldMin })

	serverKey, err := noise.GenerateKeypair()
	if err != nil {
		t.Fatal(err)
	}
	listed := make(chan protocol.PTYList, 4)
	exitedCh := make(chan protocol.PTYExited, 4)
	srv := startFake(t, serverKey, fakeConfig{
		commands: protocol.OfferedNames(),
		setup: func(p *protocol.Peer) {
			ptyEvents(p, listed, exitedCh)
		},
	})
	dialer := newFakePTYDialer()
	a := newTestAgent(t, Options{Env: testPTYEnv(t), PTYDial: dialer.dial})
	t.Cleanup(a.shutdownPTY)

	// The terminal stays until crhs closes it, so on the next control connection it is still held
	// but exited: its last screen must still be replayable.
	if _, err := a.pty.mgr.Open(pty.OpenRequest{
		ID:              "bye",
		Argv:            []string{"/bin/sh", "-c", "printf bye; read line; exit 5"},
		Rows:            24,
		Cols:            80,
		ScrollbackBytes: 1 << 20,
	}); err != nil {
		t.Fatal(err)
	}

	stop, done := startSession(t, a, dialTo(t, srv, serverKey))
	waitCh(t, listed, "pty.list")
	conn1 := waitCh(t, dialer.conns, "the terminal data connection")
	collectUntil(t, conn1, "bye")
	conn1.push(protocol.DataFrame{Kind: protocol.DataFrameData, Bytes: []byte("leave\n")})
	waitDataKind(t, conn1, protocol.DataFrameEnd)
	stop()
	<-done

	startSession(t, a, dialTo(t, srv, serverKey))
	waitCh(t, listed, "pty.list")
	conn2 := waitCh(t, dialer.conns, "the exited terminal's replay connection")
	collectUntil(t, conn2, "bye")
	waitDataKind(t, conn2, protocol.DataFrameEnd)

	// Replaying is once per control connection. A worker that loops would dial again after the
	// backoff, so anything before the timeout is a failure.
	select {
	case conn := <-dialer.conns:
		t.Fatalf("exited terminal opened extra data connection %p", conn)
	case <-time.After(250 * time.Millisecond):
	}
}

// TestPTYExitedEventAndEnd covers doc/design/pty.md "crha": the data connection gets [end] after
// the last output and pty.exited carries the exit code.
func TestPTYExitedEventAndEnd(t *testing.T) {
	serverKey, err := noise.GenerateKeypair()
	if err != nil {
		t.Fatal(err)
	}
	dialer := newFakePTYDialer()
	listed := make(chan protocol.PTYList, 4)
	exitedCh := make(chan protocol.PTYExited, 4)
	srv := startFake(t, serverKey, fakeConfig{
		commands: protocol.OfferedNames(),
		setup: func(p *protocol.Peer) {
			ptyEvents(p, listed, exitedCh)
		},
		run: func(ctx context.Context, p *protocol.Peer) {
			waitCh(t, listed, "pty.list")
			var empty protocol.Empty
			err := p.Request(ctx, protocol.CmdPTYOpen, protocol.PTYOpen{
				PTYID:           "bye",
				Argv:            []string{"/bin/sh", "-c", "printf bye; exit 5"},
				Rows:            24,
				Cols:            80,
				ScrollbackBytes: 1 << 20,
			}, &empty)
			if err != nil {
				t.Errorf("pty.open: %v", err)
			}
		},
	})
	a := newTestAgent(t, Options{Env: testPTYEnv(t), PTYDial: dialer.dial})
	t.Cleanup(a.shutdownPTY)
	startSession(t, a, dialTo(t, srv, serverKey))

	conn := waitCh(t, dialer.conns, "the terminal data connection")
	collectUntil(t, conn, "bye")
	waitDataKind(t, conn, protocol.DataFrameEnd)
	event := waitCh(t, exitedCh, "pty.exited")
	if event.PTYID != "bye" || event.ExitCode != 5 {
		t.Fatalf("pty.exited = %+v, want bye with code 5", event)
	}
}
