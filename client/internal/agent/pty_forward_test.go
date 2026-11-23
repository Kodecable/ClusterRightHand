package agent

import (
	"context"
	"net"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/fxamacker/cbor/v2"

	"github.com/Kodecable/ClusterRightHand/client/internal/config"
	"github.com/Kodecable/ClusterRightHand/client/internal/privileged/wire"
	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
	"github.com/Kodecable/ClusterRightHand/client/internal/version"
)

// privilegedPTYRequest is a privileged pty.open bound to a crhs-signed one-shot pty.create spec.
func privilegedPTYRequest(t *testing.T, keys *privKeys, id string, argv ...string) protocol.PTYOpen {
	t.Helper()
	spec := protocol.TaskSpec{Kind: protocol.TaskSpecPtyCreate, PtyCreate: &protocol.PtyCreateSpec{Argv: argv}}
	payload := specPayload(t, keys.crhs, id, &spec)
	return protocol.PTYOpen{
		PTYID:           id,
		Argv:            argv,
		Rows:            24,
		Cols:            80,
		Privileged:      true,
		ScrollbackBytes: 1 << 20,
		Attempt:         1,
		Authorizations:  [][]byte{authorize(t, keys.crhs, payload)},
	}
}

// openPTY sends one pty.open over the fake crhs connection.
func openPTY(ctx context.Context, p *protocol.Peer, req protocol.PTYOpen) error {
	var empty protocol.Empty
	return p.Request(ctx, protocol.CmdPTYOpen, req, &empty)
}

// TestForwardPrivilegedPTYRelays covers the whole forward relay: the daemon runs the process, its
// output reaches the terminal's data connection with a fresh replay after a drop, input reaches the
// daemon, and the daemon's pty.exited ends the terminal like a local process exit.
func TestForwardPrivilegedPTYRelays(t *testing.T) {
	oldMin := ptyMinBackoff
	ptyMinBackoff = 20 * time.Millisecond
	t.Cleanup(func() { ptyMinBackoff = oldMin })

	keys := newPrivKeys(t)
	env := newPrivEnv(t, keys, func(e *privEnv) string { return e.crhsOnlyConfig() })
	env.start()
	dialer := newFakePTYDialer()
	a := forwardAgent(t, Options{PrivilegedSocket: env.socket, PTYDial: dialer.dial, Env: testPTYEnv(t)})
	waitForward(t, a)

	w := newCRHSWatch()
	replies := make(chan error, 1)
	req := privilegedPTYRequest(t, keys, "relay-1", "/bin/sh", "-c", "printf hello; read line; echo got:$line; exit 3")
	serveForwardWith(t, a, w, protocol.OfferedNames(), func(ctx context.Context, p *protocol.Peer) error {
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
	replay := collectPrefix(t, replayConn, len("hello"))
	if !strings.HasPrefix(replay, "hello") {
		t.Fatalf("replacement data connection starts with %q, want the ring replayed from hello", replay)
	}

	replayConn.push(protocol.DataFrame{Kind: protocol.DataFrameData, Bytes: []byte("world\n")})
	collectUntil(t, replayConn, "got:world")
	waitDataKind(t, replayConn, protocol.DataFrameEnd)

	exit := waitCh(t, w.ptyExits, "pty.exited")
	if exit.PTYID != "relay-1" || exit.ExitCode != 3 || exit.Reason != protocol.PTYExitReasonExited {
		t.Fatalf("pty.exited = %+v, want relay-1 code 3 reason exited", exit)
	}

	term := a.pty.mgr.Get("relay-1")
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

	// The daemon recorded the same terminal; the local log is the daemon's audit file.
	opened := waitPTYLogRecord(t, env.logPath, "terminal.opened", "relay-1")
	if opened["entry"] != "crhs" {
		t.Fatalf("terminal.opened record = %v", opened)
	}
	exited := waitPTYLogRecord(t, env.logPath, "terminal.exited", "relay-1")
	if exited["exit_code"] != float64(3) {
		t.Fatalf("terminal.exited record = %v", exited)
	}
}

// TestForwardPrivilegedPTYHelperLost breaks the daemon connection while a terminal runs: its output
// ends, its data connection gets [end], and crhs is told helper_lost with code -1; the terminal
// stays held as exited.
func TestForwardPrivilegedPTYHelperLost(t *testing.T) {
	oldMin := ptyMinBackoff
	ptyMinBackoff = 20 * time.Millisecond
	t.Cleanup(func() { ptyMinBackoff = oldMin })

	keys := newPrivKeys(t)
	env := newPrivEnv(t, keys, func(e *privEnv) string { return e.crhsOnlyConfig() })
	env.start()
	dialer := newFakePTYDialer()
	a := forwardAgent(t, Options{PrivilegedSocket: env.socket, PTYDial: dialer.dial, Env: testPTYEnv(t)})
	waitForward(t, a)

	w := newCRHSWatch()
	replies := make(chan error, 1)
	req := privilegedPTYRequest(t, keys, "relay-lost", "/bin/sh", "-c", "sleep 30")
	serveForwardWith(t, a, w, protocol.OfferedNames(), func(ctx context.Context, p *protocol.Peer) error {
		replies <- openPTY(ctx, p, req)
		return nil
	})
	if err := waitCh(t, replies, "pty.open response"); err != nil {
		t.Fatalf("pty.open: %v", err)
	}
	conn := waitCh(t, dialer.conns, "the terminal data connection")

	// Kill the privileged mode: the forward connection breaks while the terminal runs.
	env.stop()

	exit := waitCh(t, w.ptyExits, "pty.exited")
	if exit.PTYID != "relay-lost" || exit.ExitCode != -1 || exit.Reason != protocol.PTYExitReasonHelperLost {
		t.Fatalf("pty.exited = %+v, want relay-lost code -1 reason helper_lost", exit)
	}
	waitDataKind(t, conn, protocol.DataFrameEnd)

	term := a.pty.mgr.Get("relay-lost")
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
	if closed := waitPTYLogRecord(t, env.logPath, "terminal.closed", "relay-lost"); !strings.Contains(closed["detail"].(string), "forward connection ended") {
		t.Fatalf("the daemon did not close its terminal: %v", closed)
	}
}

// TestForwardPrivilegedPTYUnavailable covers the refusals: a mode without the relay refuses with
// privileged_unsupported, and forward mode without a reachable daemon with privileged_unavailable.
func TestForwardPrivilegedPTYUnavailable(t *testing.T) {
	t.Run("ignore", func(t *testing.T) {
		a := newTestAgent(t, Options{PrivilegedMode: config.ModeIgnore})
		w := newCRHSWatch()
		replies := make(chan error, 1)
		serveForwardWith(t, a, w, protocol.OfferedNames(), func(ctx context.Context, p *protocol.Peer) error {
			replies <- openPTY(ctx, p, protocol.PTYOpen{
				PTYID: "ignore-pty", Rows: 24, Cols: 80, Privileged: true,
				ScrollbackBytes: 1 << 20, Attempt: 1,
			})
			return nil
		})
		expectRemoteCode(t, waitCh(t, replies, "pty.open response"), "privileged_unsupported")
	})

	t.Run("reject", func(t *testing.T) {
		a := newTestAgent(t, Options{PrivilegedMode: config.ModeReject})
		w := newCRHSWatch()
		replies := make(chan error, 1)
		serveForwardWith(t, a, w, protocol.OfferedNames(), func(ctx context.Context, p *protocol.Peer) error {
			replies <- openPTY(ctx, p, protocol.PTYOpen{
				PTYID: "reject-pty", Rows: 24, Cols: 80, Privileged: true,
				ScrollbackBytes: 1 << 20, Attempt: 1,
			})
			return nil
		})
		expectRemoteCode(t, waitCh(t, replies, "pty.open response"), "privileged_unsupported")
	})

	t.Run("no daemon", func(t *testing.T) {
		socket := filepath.Join(t.TempDir(), "absent.sock")
		a := forwardAgent(t, Options{PrivilegedSocket: socket})
		w := newCRHSWatch()
		replies := make(chan error, 1)
		serveForwardWith(t, a, w, protocol.OfferedNames(), func(ctx context.Context, p *protocol.Peer) error {
			replies <- openPTY(ctx, p, protocol.PTYOpen{
				PTYID: "down-pty", Rows: 24, Cols: 80, Privileged: true,
				ScrollbackBytes: 1 << 20, Attempt: 1,
			})
			return nil
		})
		remote := expectRemoteCode(t, waitCh(t, replies, "pty.open response"), "privileged_unavailable")
		if !strings.Contains(remote.Message, "not reachable") {
			t.Fatalf("message = %q", remote.Message)
		}
	})

	t.Run("invalid size", func(t *testing.T) {
		a := forwardAgent(t, Options{PrivilegedSocket: filepath.Join(t.TempDir(), "absent.sock")})
		w := newCRHSWatch()
		replies := make(chan error, 1)
		serveForwardWith(t, a, w, protocol.OfferedNames(), func(ctx context.Context, p *protocol.Peer) error {
			replies <- openPTY(ctx, p, protocol.PTYOpen{
				PTYID: "bad-size", Rows: 0, Cols: 80, Privileged: true,
				ScrollbackBytes: 1 << 20, Attempt: 1,
			})
			return nil
		})
		expectRemoteCode(t, waitCh(t, replies, "pty.open response"), "invalid_spec")
	})
}

// TestForwardPrivilegedPTYRefusedByDaemon covers a daemon refusal reaching crhs unchanged: a
// pty.open without an authorization is refused with the daemon's code and nothing is held.
func TestForwardPrivilegedPTYRefusedByDaemon(t *testing.T) {
	keys := newPrivKeys(t)
	env := newPrivEnv(t, keys, func(e *privEnv) string { return e.crhsOnlyConfig() })
	env.start()
	a := forwardAgent(t, Options{PrivilegedSocket: env.socket, Env: testPTYEnv(t)})
	waitForward(t, a)

	w := newCRHSWatch()
	replies := make(chan error, 1)
	serveForwardWith(t, a, w, protocol.OfferedNames(), func(ctx context.Context, p *protocol.Peer) error {
		replies <- openPTY(ctx, p, protocol.PTYOpen{
			PTYID: "unauthorized", Argv: []string{"/bin/true"}, Rows: 24, Cols: 80,
			Privileged: true, ScrollbackBytes: 1 << 20, Attempt: 1,
		})
		return nil
	})
	expectRemoteCode(t, waitCh(t, replies, "pty.open response"), "authorization_required")
	if term := a.pty.mgr.Get("unauthorized"); term != nil {
		t.Fatalf("a refused terminal is held: %+v", term.Status())
	}
	if n := a.pty.mgr.Count(); n != 0 {
		t.Fatalf("%d terminals held after a refusal, want 0", n)
	}
}

// TestForwardPrivilegedPTYClose covers pty.close reaching the daemon: the process group is closed
// and the terminal leaves the agent's manager.
func TestForwardPrivilegedPTYClose(t *testing.T) {
	keys := newPrivKeys(t)
	env := newPrivEnv(t, keys, func(e *privEnv) string { return e.crhsOnlyConfig() })
	env.start()
	dialer := newFakePTYDialer()
	a := forwardAgent(t, Options{PrivilegedSocket: env.socket, PTYDial: dialer.dial, Env: testPTYEnv(t)})
	waitForward(t, a)

	w := newCRHSWatch()
	replies := make(chan error, 2)
	req := privilegedPTYRequest(t, keys, "relay-close", "/bin/sh", "-c", "sleep 30")
	serveForwardWith(t, a, w, protocol.OfferedNames(), func(ctx context.Context, p *protocol.Peer) error {
		if err := openPTY(ctx, p, req); err != nil {
			replies <- err
			return nil
		}
		replies <- nil
		replies <- p.Request(ctx, protocol.CmdPTYClose, protocol.PTYClose{PTYID: req.PTYID, Reason: "manual"}, &protocol.Empty{})
		return nil
	})
	if err := waitCh(t, replies, "pty.open response"); err != nil {
		t.Fatalf("pty.open: %v", err)
	}
	waitCh(t, dialer.conns, "the terminal data connection")
	if err := waitCh(t, replies, "pty.close response"); err != nil {
		t.Fatalf("pty.close: %v", err)
	}
	deadline := time.Now().Add(10 * time.Second)
	for a.pty.mgr.Get(req.PTYID) != nil {
		if time.Now().After(deadline) {
			t.Fatal("the closed terminal is still held")
		}
		time.Sleep(10 * time.Millisecond)
	}
	closed := waitPTYLogRecord(t, env.logPath, "terminal.closed", req.PTYID)
	if !strings.Contains(closed["detail"].(string), "closed by the unprivileged mode") {
		t.Fatalf("terminal.closed record = %v", closed)
	}
}

// TestForwardPrivilegedPTYInvalidSpecKeepsIDsUnused is a guard against burning the one-shot record
// on a request the daemon refuses before accepting: the same terminal id can be retried.
func TestForwardPrivilegedPTYRefusalKeepsIDUnused(t *testing.T) {
	keys := newPrivKeys(t)
	env := newPrivEnv(t, keys, func(e *privEnv) string { return e.crhsOnlyConfig() })
	env.start()
	a := forwardAgent(t, Options{PrivilegedSocket: env.socket, Env: testPTYEnv(t)})
	waitForward(t, a)

	w := newCRHSWatch()
	replies := make(chan error, 2)
	serveForwardWith(t, a, w, protocol.OfferedNames(), func(ctx context.Context, p *protocol.Peer) error {
		// First a wrong spec: refused, no side effect.
		bad := privilegedPTYRequest(t, keys, "retry-1", "/bin/true")
		signed := protocol.TaskSpec{Kind: protocol.TaskSpecPtyCreate, PtyCreate: &protocol.PtyCreateSpec{Argv: []string{"/bin/echo", "other"}}}
		payload := specPayload(t, keys.crhs, "retry-1", &signed)
		bad.Authorizations = [][]byte{authorize(t, keys.crhs, payload)}
		replies <- openPTY(ctx, p, bad)
		// Then the matching one, which must be accepted: the refusal did not burn the id.
		good := privilegedPTYRequest(t, keys, "retry-1", "/bin/true")
		replies <- openPTY(ctx, p, good)
		return nil
	})
	expectRemoteCode(t, waitCh(t, replies, "the wrong-spec pty.open"), "authorization_rejected")
	if err := waitCh(t, replies, "the matching pty.open"); err != nil {
		t.Fatalf("retry pty.open: %v", err)
	}
	exit := waitCh(t, w.ptyExits, "pty.exited")
	if exit.PTYID != "retry-1" || exit.ExitCode != 0 {
		t.Fatalf("pty.exited = %+v", exit)
	}
}

// waitPTYLogRecord waits for a daemon local-log line about a terminal, matched by pty_id.
func waitPTYLogRecord(t *testing.T, path, event, id string) map[string]any {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		for _, record := range logRecords(t, path) {
			if record["event"] == event && record["pty_id"] == id {
				return record
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("no %s record for terminal %s in %s", event, id, path)
	return nil
}

// noPTYDaemon serves a crh-priv forward connection whose welcome omits the terminal names, like a
// daemon from before privileged terminals: trust.query is answered so the agent treats it as
// connected, but a privileged pty.open must be refused with privileged_unsupported.
func noPTYDaemon(t *testing.T, socket string) {
	t.Helper()
	lis, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = lis.Close() })
	go func() {
		for {
			conn, err := lis.Accept()
			if err != nil {
				return
			}
			go func() {
				defer conn.Close()
				frame, err := wire.ReadFrame(conn)
				if err != nil {
					return
				}
				var hello wire.PrivHello
				if err := protocol.Unmarshal(frame, &hello); err != nil {
					return
				}
				advertised := append(wire.Names(), wire.CmdTrustQuery, protocol.EventTrustSummary)
				welcome := wire.PrivWelcome{
					PrivMajor:   wire.PrivMajor,
					PrivMinor:   wire.PrivMinor,
					Commands:    advertised,
					CRHAVersion: version.Version,
				}
				body, err := protocol.Marshal(welcome)
				if err != nil {
					return
				}
				if err := wire.WriteFrame(conn, body); err != nil {
					return
				}
				negotiated := protocol.NewSet(hello.Commands...).Intersect(protocol.NewSet(advertised...))
				stream := wire.NewStreamFor(conn, conn, negotiated, wire.RoleForward)
				defer stream.Close(nil)
				stream.Peer().HandleRequest(wire.CmdTrustQuery, func(context.Context, cbor.RawMessage) (any, error) {
					return protocol.TrustSummary{
						NodeID: "node-1",
						Identities: protocol.Identities{
							Unprivileged: protocol.Identity{UID: 1000, GID: 1000, User: "crha"},
							Privileged:   protocol.Identity{UID: 0, GID: 0, User: "root"},
						},
						LocalWindow: protocol.ClosedWindow(),
					}, nil
				})
				_ = stream.Run()
			}()
		}
	}()
}

// TestForwardPrivilegedPTYNotNegotiated covers the optional names: a daemon that does not offer the
// crh-priv terminal names makes a privileged pty.open fail with privileged_unsupported, and nothing
// is relayed.
func TestForwardPrivilegedPTYNotNegotiated(t *testing.T) {
	socket := filepath.Join(t.TempDir(), "priv.sock")
	noPTYDaemon(t, socket)
	a := forwardAgent(t, Options{PrivilegedSocket: socket})
	waitForward(t, a)

	w := newCRHSWatch()
	replies := make(chan error, 1)
	serveForwardWith(t, a, w, protocol.OfferedNames(), func(ctx context.Context, p *protocol.Peer) error {
		replies <- openPTY(ctx, p, protocol.PTYOpen{
			PTYID: "unnegotiated", Argv: []string{"/bin/true"}, Rows: 24, Cols: 80,
			Privileged: true, ScrollbackBytes: 1 << 20, Attempt: 1,
		})
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
