package agent

import (
	"context"
	"errors"
	"fmt"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
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
	ptyID  string
	out    chan protocol.DataFrame
	input  chan protocol.DataFrame
	closed chan struct{}
	once   sync.Once
}

func newFakeTerminalConn(ptyID string) *fakeTerminalConn {
	return &fakeTerminalConn{
		ptyID:  ptyID,
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

// fakePTYDialer hands out one fresh in-memory data connection per dial. outputOffset supplies the
// output offset crhs would report in the handshake, and received records the input offset the
// terminal reported on each dial.
type fakePTYDialer struct {
	conns chan *fakeTerminalConn

	mu       sync.Mutex
	offset   func(ptyID string, inputReceived uint64) uint64
	received []uint64
}

func newFakePTYDialer() *fakePTYDialer {
	return &fakePTYDialer{conns: make(chan *fakeTerminalConn, 8)}
}

// setOutputOffset installs the output offset the next dials report.
func (d *fakePTYDialer) setOutputOffset(offset func(ptyID string, inputReceived uint64) uint64) {
	d.mu.Lock()
	d.offset = offset
	d.mu.Unlock()
}

// inputOffsets returns the input offsets reported so far, in dial order.
func (d *fakePTYDialer) inputOffsets() []uint64 {
	d.mu.Lock()
	defer d.mu.Unlock()
	return append([]uint64(nil), d.received...)
}

func (d *fakePTYDialer) dial(ctx context.Context, ptyID string, inputReceived uint64) (DataConn, uint64, error) {
	if err := ctx.Err(); err != nil {
		return nil, 0, err
	}
	d.mu.Lock()
	d.received = append(d.received, inputReceived)
	offset := d.offset
	d.mu.Unlock()
	output := uint64(0)
	if offset != nil {
		output = offset(ptyID, inputReceived)
	}
	c := newFakeTerminalConn(ptyID)
	select {
	case d.conns <- c:
		return c, output, nil
	case <-ctx.Done():
		return nil, 0, ctx.Err()
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

// ptyHarness is a fake crhs that offers the terminal names, an agent with an in-memory dialer and
// the events crhs consumes.
type ptyHarness struct {
	agent     *Agent
	dialer    *fakePTYDialer
	srv       *httptest.Server
	serverKey noise.Keypair
	listed    chan protocol.PTYList
	exited    chan protocol.PTYExited
}

func startPTYHarness(t *testing.T) *ptyHarness {
	t.Helper()
	serverKey, err := noise.GenerateKeypair()
	if err != nil {
		t.Fatal(err)
	}
	listed := make(chan protocol.PTYList, 8)
	exited := make(chan protocol.PTYExited, 8)
	srv := startFake(t, serverKey, fakeConfig{
		commands: protocol.OfferedNames(),
		setup: func(p *protocol.Peer) {
			ptyEvents(p, listed, exited)
		},
	})
	dialer := newFakePTYDialer()
	a := newTestAgent(t, Options{Env: testPTYEnv(t), PTYDial: dialer.dial})
	t.Cleanup(a.shutdownPTY)
	return &ptyHarness{agent: a, dialer: dialer, srv: srv, serverKey: serverKey, listed: listed, exited: exited}
}

// connect starts a control connection, waits for its pty.list and returns both.
func (h *ptyHarness) connect(t *testing.T) (protocol.PTYList, context.CancelFunc, <-chan struct{}) {
	t.Helper()
	stop, finished := startSession(t, h.agent, dialTo(t, h.srv, h.serverKey))
	return waitCh(t, h.listed, "pty.list"), stop, finished
}

// openTerminal opens a terminal in the manager, before any control connection.
func (h *ptyHarness) openTerminal(t *testing.T, id string, scrollback uint64, argv ...string) *pty.Terminal {
	t.Helper()
	term, err := h.agent.pty.mgr.Open(pty.OpenRequest{
		ID:              id,
		Argv:            argv,
		Rows:            24,
		Cols:            80,
		ScrollbackBytes: scrollback,
	})
	if err != nil {
		t.Fatalf("open %s: %v", id, err)
	}
	return term
}

// connFor waits for a data connection to the named terminal.
func (h *ptyHarness) connFor(t *testing.T, id string) *fakeTerminalConn {
	t.Helper()
	deadline := time.After(10 * time.Second)
	for {
		select {
		case conn := <-h.dialer.conns:
			if conn.ptyID == id {
				return conn
			}
		case <-deadline:
			t.Fatalf("no data connection for terminal %s", id)
		}
	}
}

// waitRing waits until the terminal's ring holds at least n bytes.
func waitRing(t *testing.T, term *pty.Terminal, n int) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if int(term.Ring().Total()) >= n {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("terminal %s produced %d bytes, want %d", term.ID(), term.Ring().Total(), n)
}

// collectBytes reads exactly n data bytes from conn, beyond any [end] or [abort] frames.
func collectBytes(t *testing.T, conn *fakeTerminalConn, n int) []byte {
	t.Helper()
	var out []byte
	deadline := time.After(10 * time.Second)
	for len(out) < n {
		select {
		case f := <-conn.out:
			if f.Kind == protocol.DataFrameData {
				out = append(out, f.Bytes...)
			}
		case <-deadline:
			t.Fatalf("connection delivered %d bytes, want %d", len(out), n)
		}
	}
	return out
}

// printfScript makes a shell command that writes exactly data and then stays alive, so the output
// stream is live rather than an exited terminal's.
func printfScript(data []byte) string {
	var b strings.Builder
	b.WriteString("printf '%b' '")
	for _, c := range data {
		fmt.Fprintf(&b, "\\%03o", c)
	}
	b.WriteString("'; sleep 30")
	return b.String()
}

// TestPTYListAfterHello covers doc/design/pty.md "Reconnect": pty.list names every held terminal and
// its exit state, and nothing else.
func TestPTYListAfterHello(t *testing.T) {
	h := startPTYHarness(t)
	exited := h.openTerminal(t, "exited", 1<<20, "/bin/sh", "-c", "exit 7")
	select {
	case <-exited.OutputDone():
	case <-time.After(10 * time.Second):
		t.Fatal("terminal did not exit")
	}
	h.openTerminal(t, "running", 1<<20, "/bin/sh", "-c", "sleep 30")

	list, _, _ := h.connect(t)
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
	live, ok := byID["running"]
	if !ok || live.Exited {
		t.Fatalf("running terminal = %+v, want running", live)
	}
}

// TestPTYOutputContinuesFromOffset covers doc/design/pty.md "Two continuous byte streams": a new
// data connection continues the output exactly where crhs says it stopped, with no repeat and no
// gap, even when the cut falls inside an escape sequence or a multi-byte UTF-8 character.
func TestPTYOutputContinuesFromOffset(t *testing.T) {
	cases := []struct {
		name string
		data []byte
		cut  int
	}{
		{name: "plain", data: []byte("hello"), cut: 2},
		{name: "escape sequence", data: []byte("\x1b[31mred\x1b[0m"), cut: 2},
		{name: "multi-byte utf-8", data: []byte("héllo 世界"), cut: 2},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := startPTYHarness(t)
			var offset atomic.Uint64
			h.dialer.setOutputOffset(func(string, uint64) uint64 { return offset.Load() })
			term := h.openTerminal(t, "cut", 1<<20, "/bin/sh", "-c", printfScript(tc.data))
			_, stop, done := h.connect(t)
			conn1 := h.connFor(t, "cut")
			waitRing(t, term, len(tc.data))

			// crhs received the first cut bytes; drop the connection and report exactly that offset.
			offset.Store(uint64(tc.cut))
			conn1.drop()
			conn2 := h.connFor(t, "cut")
			tail := collectBytes(t, conn2, len(tc.data)-tc.cut)
			if string(tail) != string(tc.data[tc.cut:]) {
				t.Fatalf("continuation = %q, want %q", tail, tc.data[tc.cut:])
			}
			stop()
			<-done
		})
	}
}

// TestPTYOutputLostAborts covers doc/design/pty.md "Two continuous byte streams": when the ring has
// overwritten bytes crhs never received, the stream cannot continue and crha answers stream_lost
// instead of replaying.
func TestPTYOutputLostAborts(t *testing.T) {
	h := startPTYHarness(t)
	const budget = 80000 // More than the 64 KiB minimum ring, which a zero asks for.
	h.dialer.setOutputOffset(func(string, uint64) uint64 { return 0 })
	term := h.openTerminal(t, "overflow", 0, "/bin/sh", "-c",
		"head -c 80000 /dev/zero | tr '\\0' a; sleep 30")
	_, stop, done := h.connect(t)
	conn1 := h.connFor(t, "overflow")
	waitRing(t, term, budget)
	start, _ := term.Ring().Range()
	if start == 0 {
		t.Fatalf("ring start = 0 after %d bytes; want overwritten output", budget)
	}

	conn1.drop()
	conn2 := h.connFor(t, "overflow")
	frame := waitDataKind(t, conn2, protocol.DataFrameAbort)
	if frame.Code != protocol.PTYStreamLost {
		t.Fatalf("abort code = %q, want %q", frame.Code, protocol.PTYStreamLost)
	}
	stop()
	<-done
}

// TestPTYOutputBeyondEndAborts covers doc/design/pty.md "Two continuous byte streams": crhs cannot
// have received more output than crha produced, so a handshake offset past the ring's end is as lost
// as one before its start. crha answers stream_lost and replays nothing.
func TestPTYOutputBeyondEndAborts(t *testing.T) {
	h := startPTYHarness(t)
	var offset atomic.Uint64
	h.dialer.setOutputOffset(func(string, uint64) uint64 { return offset.Load() })
	term := h.openTerminal(t, "ahead", 1<<20, "/bin/sh", "-c", printfScript([]byte("hello")))
	_, stop, done := h.connect(t)
	conn1 := h.connFor(t, "ahead")
	waitRing(t, term, 5)
	_, end := term.Ring().Range()

	// crhs claims output crha never produced: the next handshake lies beyond the ring's end.
	offset.Store(end + 100)
	conn1.drop()
	conn2 := h.connFor(t, "ahead")
	var frame protocol.DataFrame
	timeout := time.After(10 * time.Second)
	for frame.Kind != protocol.DataFrameAbort {
		select {
		case f := <-conn2.out:
			if f.Kind == protocol.DataFrameData {
				t.Fatalf("data frame %q arrived before the abort", f.Bytes)
			}
			frame = f
		case <-timeout:
			t.Fatal("data connection never delivered an abort frame")
		}
	}
	if frame.Code != protocol.PTYStreamLost {
		t.Fatalf("abort code = %q, want %q", frame.Code, protocol.PTYStreamLost)
	}
	stop()
	<-done
}

// TestPTYInputReceivedReported covers doc/design/pty.md "Two continuous byte streams": every data
// connection reports how many input bytes crha has written to the process, so crhs resends only the
// rest.
func TestPTYInputReceivedReported(t *testing.T) {
	h := startPTYHarness(t)
	term := h.openTerminal(t, "input", 1<<20, "/bin/sh", "-c", "cat")
	_, stop, done := h.connect(t)
	conn1 := h.connFor(t, "input")
	conn1.push(protocol.DataFrame{Kind: protocol.DataFrameData, Bytes: []byte("abc")})
	conn1.push(protocol.DataFrame{Kind: protocol.DataFrameData, Bytes: []byte("de")})
	deadline := time.Now().Add(10 * time.Second)
	for term.InputReceived() != 5 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if got := term.InputReceived(); got != 5 {
		t.Fatalf("input received = %d, want 5", got)
	}

	conn1.drop()
	conn2 := h.connFor(t, "input")
	if conn2.ptyID != term.ID() {
		t.Fatalf("connection for %s, want %s", conn2.ptyID, term.ID())
	}
	offsets := h.dialer.inputOffsets()
	if len(offsets) < 2 || offsets[len(offsets)-1] != 5 {
		t.Fatalf("handshake input offsets = %v, want the last one 5", offsets)
	}
	stop()
	<-done
}

// TestPTYExitedTerminalContinuesToEnd covers doc/design/pty.md "Reconnect": an exited terminal crhs
// has not closed keeps its worker and sends the output crhs is missing plus [end], once per
// connection.
func TestPTYExitedTerminalContinuesToEnd(t *testing.T) {
	h := startPTYHarness(t)
	var dials atomic.Uint64
	h.dialer.setOutputOffset(func(string, uint64) uint64 {
		if dials.Add(1) == 1 {
			return 1
		}
		return 3
	})
	term := h.openTerminal(t, "bye", 1<<20, "/bin/sh", "-c", "printf bye")
	_, stop, done := h.connect(t)
	conn1 := h.connFor(t, "bye")
	if got := string(collectBytes(t, conn1, 2)); got != "ye" {
		t.Fatalf("first connection delivered %q, want ye", got)
	}
	waitDataKind(t, conn1, protocol.DataFrameEnd)
	stop()
	<-done
	if !term.Ended() {
		t.Fatal("terminal did not end")
	}

	// The next control connection serves the exited terminal once more, from the new offset: only
	// [end] is left, and no data is replayed.
	_, _, _ = h.connect(t)
	conn2 := h.connFor(t, "bye")
	waitDataKind(t, conn2, protocol.DataFrameEnd)
	select {
	case conn := <-h.dialer.conns:
		t.Fatalf("exited terminal opened extra data connection %p", conn)
	case <-time.After(250 * time.Millisecond):
	}
}

// TestPTYReconnectWakesEveryTerminal covers doc/design/pty.md "Reconnect": a new control connection
// gives every held terminal a data connection again. The broadcast wake-up must not leave one worker
// waiting forever.
func TestPTYReconnectWakesEveryTerminal(t *testing.T) {
	oldMin := ptyMinBackoff
	ptyMinBackoff = 20 * time.Millisecond
	t.Cleanup(func() { ptyMinBackoff = oldMin })

	h := startPTYHarness(t)
	for _, id := range []string{"first", "second"} {
		h.openTerminal(t, id, 1<<20, "/bin/sh", "-c", "cat")
	}
	_, stop, done := h.connect(t)
	first := map[string]*fakeTerminalConn{}
	for range 2 {
		conn := <-h.dialer.conns
		first[conn.ptyID] = conn
	}
	if len(first) != 2 {
		t.Fatalf("first connection dialed %v, want both terminals", first)
	}
	stop()
	<-done

	_, _, _ = h.connect(t)
	second := map[string]*fakeTerminalConn{}
	for len(second) < 2 {
		conn := <-h.dialer.conns
		second[conn.ptyID] = conn
	}
	for _, id := range []string{"first", "second"} {
		conn := second[id]
		if conn == nil {
			t.Fatalf("terminal %s did not reconnect", id)
		}
		conn.push(protocol.DataFrame{Kind: protocol.DataFrameData, Bytes: []byte("again-" + id + "\n")})
		if got := collectUntil(t, conn, "again-"+id); !strings.Contains(got, "again-"+id) {
			t.Fatalf("terminal %s output = %q", id, got)
		}
	}
}
