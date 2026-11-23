package agent

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/Kodecable/ClusterRightHand/client/internal/config"
	"github.com/Kodecable/ClusterRightHand/client/internal/logging"
	"github.com/Kodecable/ClusterRightHand/client/internal/privileged/wire"
	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
)

// syncBuffer is a log sink the agent's goroutines write and the test reads.
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// waitLogLine waits until every want appears in the relaying log.
func waitLogLine(t *testing.T, buf *syncBuffer, want ...string) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		line := buf.String()
		ok := true
		for _, w := range want {
			if !strings.Contains(line, w) {
				ok = false
				break
			}
		}
		if ok {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("the relayed log lacks %v:\n%s", want, buf.String())
}

// nativePTYRequest is a privileged pty.open as crhs sends it. Native mode takes no authorization:
// the escalation tool already decided who may start the helper (doc/design/privilege.md "Native
// mode").
func nativePTYRequest(id string, argv ...string) protocol.PTYOpen {
	return protocol.PTYOpen{
		PTYID:           id,
		Argv:            argv,
		Rows:            24,
		Cols:            80,
		Privileged:      true,
		ScrollbackBytes: 1 << 20,
		Attempt:         1,
	}
}

// nativePTYAgent is an agent in native mode whose terminals are closed when the test ends.
func nativePTYAgent(t *testing.T, opts Options) *Agent {
	t.Helper()
	if opts.PrivilegedMode == "" {
		opts.PrivilegedMode = config.ModeNative
	}
	a := newTestAgent(t, opts)
	t.Cleanup(a.shutdownPTY)
	return a
}

// nativeChannel returns the native channel of a held relayed terminal.
func nativeChannel(t *testing.T, a *Agent, id string) *nativePTYChannel {
	t.Helper()
	relay := a.relayedPTY(id)
	if relay == nil {
		t.Fatalf("terminal %s is not relayed", id)
	}
	ch, ok := relay.ch.(*nativePTYChannel)
	if !ok {
		t.Fatalf("terminal %s runs on %T, want a native helper", id, relay.ch)
	}
	return ch
}

// waitReaped waits until the helper process is gone and has been waited for.
func waitReaped(t *testing.T, p *os.Process) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		err := p.Signal(syscall.Signal(0))
		if errors.Is(err, os.ErrProcessDone) {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("the native helper was not reaped: %v", err)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// TestNativePrivilegedPTYRelays covers the whole native relay: crha starts one helper for the
// terminal, its output reaches the terminal's data connection with a fresh replay after a drop,
// input reaches the process, and the process's exit ends the terminal like a local one. The
// helper's stderr records are relayed with the pty.create spec, and pty.close ends the helper.
func TestNativePrivilegedPTYRelays(t *testing.T) {
	oldMin := ptyMinBackoff
	ptyMinBackoff = 20 * time.Millisecond
	t.Cleanup(func() { ptyMinBackoff = oldMin })

	dialer := newFakePTYDialer()
	var logs syncBuffer
	a := nativePTYAgent(t, Options{PTYDial: dialer.dial, Logger: logging.NewPlain(&logs)})

	w := newCRHSWatch()
	replies := make(chan error, 1)
	var peer *protocol.Peer
	req := nativePTYRequest("native-1", "/bin/sh", "-c", "printf hello; read line; echo got:$line; exit 3")
	serveForwardWith(t, a, w, protocol.OfferedNames(), func(ctx context.Context, p *protocol.Peer) error {
		peer = p
		replies <- openPTY(ctx, p, req)
		return nil
	})
	if err := waitCh(t, replies, "pty.open response"); err != nil {
		t.Fatalf("pty.open: %v", err)
	}

	conn := waitCh(t, dialer.conns, "the terminal data connection")
	collectUntil(t, conn, "hello")

	// A dropped data connection is replaced by a fresh replay of the whole ring, not a resumption.
	conn.drop()
	replayConn := waitCh(t, dialer.conns, "a replacement terminal data connection")
	if replay := collectPrefix(t, replayConn, len("hello")); !strings.HasPrefix(replay, "hello") {
		t.Fatalf("replacement data connection starts with %q, want the ring replayed from hello", replay)
	}
	replayConn.push(protocol.DataFrame{Kind: protocol.DataFrameData, Bytes: []byte("world\n")})
	collectUntil(t, replayConn, "got:world")
	waitDataKind(t, replayConn, protocol.DataFrameEnd)

	exit := waitCh(t, w.ptyExits, "pty.exited")
	if exit.PTYID != "native-1" || exit.ExitCode != 3 || exit.Reason != protocol.PTYExitReasonExited {
		t.Fatalf("pty.exited = %+v, want native-1 code 3 reason exited", exit)
	}
	term := a.pty.mgr.Get("native-1")
	if term == nil {
		t.Fatal("the relayed terminal is not held")
	}
	if st := term.Status(); !st.Privileged || !st.Exited || st.ExitCode != 3 ||
		len(st.Argv) != 3 || st.Argv[0] != "/bin/sh" {
		t.Fatalf("relayed terminal status = %+v", st)
	}
	if term.Lost() {
		t.Fatal("a terminal whose process exited is marked lost")
	}

	// The native helper's stderr lines are the record: the terminal's spec must be relayed.
	waitLogLine(t, &logs, "native helper terminal.opened", "pty_id=native-1", "pty.create", "/bin/sh", "-c")
	waitLogLine(t, &logs, "native helper terminal.exited", "pty_id=native-1", "exit_code=3")

	// The helper lives as long as the terminal: it is still there while the exited terminal is held.
	ch := nativeChannel(t, a, "native-1")
	helper := ch.h.cmd.Process
	if err := helper.Signal(syscall.Signal(0)); err != nil {
		t.Fatalf("the helper left before its terminal was closed: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	var empty protocol.Empty
	if err := peer.Request(ctx, protocol.CmdPTYClose, protocol.PTYClose{PTYID: req.PTYID, Reason: "manual"}, &empty); err != nil {
		t.Fatalf("pty.close: %v", err)
	}
	waitReaped(t, helper)
	deadline := time.Now().Add(10 * time.Second)
	for a.pty.mgr.Get(req.PTYID) != nil {
		if time.Now().After(deadline) {
			t.Fatal("the closed terminal is still held")
		}
		time.Sleep(10 * time.Millisecond)
	}
	waitLogLine(t, &logs, "native helper terminal.closed", "pty_id=native-1", "closed by the unprivileged mode")
}

// TestNativePrivilegedPTYHelperLost kills the helper of a running terminal: its output ends, its
// data connection gets [end], and crhs is told helper_lost with code -1; the terminal stays held as
// exited, exactly as after a forward connection drop.
func TestNativePrivilegedPTYHelperLost(t *testing.T) {
	dialer := newFakePTYDialer()
	a := nativePTYAgent(t, Options{PTYDial: dialer.dial})

	w := newCRHSWatch()
	replies := make(chan error, 1)
	serveForwardWith(t, a, w, protocol.OfferedNames(), func(ctx context.Context, p *protocol.Peer) error {
		replies <- openPTY(ctx, p, nativePTYRequest("native-lost", "/bin/sh", "-c", "sleep 30"))
		return nil
	})
	if err := waitCh(t, replies, "pty.open response"); err != nil {
		t.Fatalf("pty.open: %v", err)
	}
	conn := waitCh(t, dialer.conns, "the terminal data connection")

	ch := nativeChannel(t, a, "native-lost")
	if err := ch.h.cmd.Process.Kill(); err != nil {
		t.Fatalf("kill the helper: %v", err)
	}

	exit := waitCh(t, w.ptyExits, "pty.exited")
	if exit.PTYID != "native-lost" || exit.ExitCode != -1 || exit.Reason != protocol.PTYExitReasonHelperLost {
		t.Fatalf("pty.exited = %+v, want native-lost code -1 reason helper_lost", exit)
	}
	waitDataKind(t, conn, protocol.DataFrameEnd)

	term := a.pty.mgr.Get("native-lost")
	if term == nil {
		t.Fatal("a helper_lost terminal must stay held as exited")
	}
	select {
	case <-term.OutputDone():
	case <-time.After(10 * time.Second):
		t.Fatal("the helper_lost terminal's output did not end")
	}
	if exited, code := term.Exit(); !exited || code != -1 {
		t.Fatalf("terminal exit = %v, %d; want exited with -1", exited, code)
	}
	if !term.Lost() {
		t.Fatal("the helper_lost terminal is not marked lost")
	}
}

// TestNativePrivilegedPTYClose covers pty.close during a running terminal: the process group is
// closed, the helper exits and is reaped, and the terminal leaves the agent's manager.
func TestNativePrivilegedPTYClose(t *testing.T) {
	dialer := newFakePTYDialer()
	var logs syncBuffer
	a := nativePTYAgent(t, Options{PTYDial: dialer.dial, Logger: logging.NewPlain(&logs)})

	w := newCRHSWatch()
	replies := make(chan error, 1)
	var peer *protocol.Peer
	req := nativePTYRequest("native-close", "/bin/sh", "-c", "sleep 30")
	serveForwardWith(t, a, w, protocol.OfferedNames(), func(ctx context.Context, p *protocol.Peer) error {
		peer = p
		replies <- openPTY(ctx, p, req)
		return nil
	})
	if err := waitCh(t, replies, "pty.open response"); err != nil {
		t.Fatalf("pty.open: %v", err)
	}
	waitCh(t, dialer.conns, "the terminal data connection")
	ch := nativeChannel(t, a, req.PTYID)
	helper := ch.h.cmd.Process

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	var empty protocol.Empty
	if err := peer.Request(ctx, protocol.CmdPTYClose, protocol.PTYClose{PTYID: req.PTYID, Reason: "manual"}, &empty); err != nil {
		t.Fatalf("pty.close: %v", err)
	}
	waitReaped(t, helper)
	deadline := time.Now().Add(10 * time.Second)
	for a.pty.mgr.Get(req.PTYID) != nil {
		if time.Now().After(deadline) {
			t.Fatal("the closed terminal is still held")
		}
		time.Sleep(10 * time.Millisecond)
	}
	waitLogLine(t, &logs, "native helper terminal.closed", "pty_id=native-close", "closed by the unprivileged mode")
}

// TestNativePrivilegedPTYOneTerminalPerHelper covers the helper's one-terminal rule: a second
// pty.open, and a task.start, on a helper that already hosts a terminal are refused, and the
// refusal of the terminal is recorded on stderr.
func TestNativePrivilegedPTYOneTerminalPerHelper(t *testing.T) {
	dialer := newFakePTYDialer()
	var logs syncBuffer
	a := nativePTYAgent(t, Options{PTYDial: dialer.dial, Logger: logging.NewPlain(&logs)})

	w := newCRHSWatch()
	replies := make(chan error, 1)
	serveForwardWith(t, a, w, protocol.OfferedNames(), func(ctx context.Context, p *protocol.Peer) error {
		replies <- openPTY(ctx, p, nativePTYRequest("native-first", "/bin/sh", "-c", "sleep 30"))
		return nil
	})
	if err := waitCh(t, replies, "pty.open response"); err != nil {
		t.Fatalf("pty.open: %v", err)
	}
	waitCh(t, dialer.conns, "the terminal data connection")
	ch := nativeChannel(t, a, "native-first")

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	var empty protocol.Empty
	err := ch.Request(ctx, wire.CmdPTYOpen, nativePTYRequest("native-second", "/bin/true"), &empty)
	expectRemoteCode(t, err, "already_accepted")
	if a.pty.mgr.Get("native-second") != nil {
		t.Fatal("a second terminal was accepted on the same helper")
	}
	waitLogLine(t, &logs, "native helper terminal.refused", "pty_id=native-second", "already_accepted")

	ts := privilegedTask("native-task", "true")
	err = ch.Request(ctx, protocol.CmdTaskStart, ts, &empty)
	expectRemoteCode(t, err, "already_accepted")
	a.mu.Lock()
	_, accepted := a.accepted["native-task"]
	a.mu.Unlock()
	if accepted {
		t.Fatal("a task was accepted on a helper that hosts a terminal")
	}
}

// TestNativePrivilegedPTYOldHelper covers a helper from before privileged terminals: its welcome
// lacks the terminal names, so crha refuses pty.open with privileged_unsupported while the node's
// tasks keep working.
func TestNativePrivilegedPTYOldHelper(t *testing.T) {
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	if exe, err = filepath.EvalSymlinks(exe); err != nil {
		t.Fatal(err)
	}
	a := nativePTYAgent(t, Options{NativePrefix: []string{exe, "fake-helper", "old-term"}})

	w := newCRHSWatch()
	replies := make(chan error, 1)
	serveForwardWith(t, a, w, protocol.OfferedNames(), func(ctx context.Context, p *protocol.Peer) error {
		replies <- openPTY(ctx, p, nativePTYRequest("native-old", "/bin/true"))
		return nil
	})
	remote := expectRemoteCode(t, waitCh(t, replies, "pty.open response"), "privileged_unsupported")
	if !strings.Contains(remote.Message, "pty.open") {
		t.Fatalf("message = %q, want it to name pty.open", remote.Message)
	}
	if n := a.pty.mgr.Count(); n != 0 {
		t.Fatalf("%d terminals held, want 0", n)
	}
}

// TestNativePrivilegedPTYLaunchFailure covers an escalation tool that refuses the helper: the
// pty.open is privileged_unsupported with the tool's stderr, as a native task's start answers, and
// no terminal is held.
func TestNativePrivilegedPTYLaunchFailure(t *testing.T) {
	dir := t.TempDir()
	tool := filepath.Join(dir, "fake-sudo")
	script := "#!/bin/sh\necho 'sudo: a password is required' >&2\nexit 1\n"
	if err := os.WriteFile(tool, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	a := nativePTYAgent(t, Options{NativePrefix: []string{tool}})

	w := newCRHSWatch()
	replies := make(chan error, 1)
	serveForwardWith(t, a, w, protocol.OfferedNames(), func(ctx context.Context, p *protocol.Peer) error {
		replies <- openPTY(ctx, p, nativePTYRequest("native-denied", "/bin/true"))
		return nil
	})
	remote := expectRemoteCode(t, waitCh(t, replies, "pty.open response"), "privileged_unsupported")
	if !strings.Contains(remote.Message, "a password is required") {
		t.Fatalf("message = %q, want the tool's stderr", remote.Message)
	}
	if n := a.pty.mgr.Count(); n != 0 {
		t.Fatalf("%d terminals held, want 0", n)
	}
}

// TestNativePrivilegedPTYInvalidSizeStartsNothing covers the order: the size is validated before a
// helper is launched, so an invalid pty.open fails with invalid_spec and never runs the escalation
// tool.
func TestNativePrivilegedPTYInvalidSizeStartsNothing(t *testing.T) {
	a := nativePTYAgent(t, Options{NativePrefix: []string{"/nonexistent/escalation-tool"}})

	w := newCRHSWatch()
	replies := make(chan error, 1)
	req := nativePTYRequest("native-bad-size", "/bin/true")
	req.Rows = 0
	serveForwardWith(t, a, w, protocol.OfferedNames(), func(ctx context.Context, p *protocol.Peer) error {
		replies <- openPTY(ctx, p, req)
		return nil
	})
	expectRemoteCode(t, waitCh(t, replies, "pty.open response"), "invalid_spec")
	if n := a.pty.mgr.Count(); n != 0 {
		t.Fatalf("%d terminals held, want 0", n)
	}
}
