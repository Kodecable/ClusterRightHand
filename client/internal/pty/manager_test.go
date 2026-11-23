package pty

import (
	"errors"
	"io"
	"log/slog"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/Kodecable/ClusterRightHand/client/internal/execenv"
	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
)

func testManager(t *testing.T, opts Options) *Manager {
	t.Helper()
	if opts.Env == nil {
		opts.Env = &execenv.Environment{
			Shell:   "/bin/sh",
			Path:    "/usr/local/bin:/usr/bin:/bin",
			Home:    t.TempDir(),
			User:    "tester",
			Logname: "tester",
		}
	}
	if opts.Logger == nil {
		opts.Logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	m := NewManager(opts)
	t.Cleanup(m.Shutdown)
	return m
}

func openTerm(t *testing.T, m *Manager, id string, argv ...string) *Terminal {
	t.Helper()
	term, err := m.Open(OpenRequest{
		ID:              id,
		Argv:            argv,
		Rows:            24,
		Cols:            80,
		ScrollbackBytes: 1 << 20,
	})
	if err != nil {
		t.Fatalf("open %s: %v", id, err)
	}
	return term
}

func wantCode(t *testing.T, err error, code string) {
	t.Helper()
	var remote *protocol.RemoteError
	if !errors.As(err, &remote) {
		t.Fatalf("err = %v, want a remote error with code %q", err, code)
	}
	if remote.Code != code {
		t.Fatalf("code = %q, want %q (%s)", remote.Code, code, remote.Message)
	}
}

// waitOutput waits until the terminal's ring contains want.
func waitOutput(t *testing.T, term *Terminal, want string) string {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	var got string
	for time.Now().Before(deadline) {
		data, _ := term.Ring().Snapshot()
		got = string(data)
		if strings.Contains(got, want) {
			return got
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("terminal %s never printed %q; got %q", term.ID(), want, got)
	return ""
}

// waitExit waits for the process and its output to end, and returns the exit code.
func waitExit(t *testing.T, term *Terminal) int {
	t.Helper()
	select {
	case <-term.OutputDone():
	case <-time.After(10 * time.Second):
		t.Fatalf("terminal %s did not exit", term.ID())
	}
	exited, code := term.Exit()
	if !exited {
		t.Fatal("OutputDone closed before the process exited")
	}
	return code
}

func TestOpenShellInputAndExit(t *testing.T) {
	m := testManager(t, Options{})
	term := openTerm(t, m, "t1", "/bin/sh", "-c", "printf hello; read x; echo got:$x")
	waitOutput(t, term, "hello")

	if _, err := term.Write([]byte("world\n")); err != nil {
		t.Fatalf("write input: %v", err)
	}
	waitOutput(t, term, "got:world")
	if code := waitExit(t, term); code != 0 {
		t.Fatalf("exit code = %d, want 0", code)
	}
	status := term.Status()
	if !status.Exited || status.ExitCode != 0 {
		t.Fatalf("status = %+v, want exited with code 0", status)
	}
	if term.Argv()[0] != "/bin/sh" {
		t.Fatalf("argv = %q", term.Argv())
	}
	list := m.List()
	if len(list) != 1 || list[0].PTYID != "t1" || !list[0].Exited || list[0].ExitCode != 0 {
		t.Fatalf("list = %+v", list)
	}
	if !term.Ended() {
		t.Fatal("Ended is false after OutputDone closed")
	}
}

func TestExitCodeReported(t *testing.T) {
	m := testManager(t, Options{})
	term := openTerm(t, m, "exit7", "/bin/sh", "-c", "exit 7")
	if code := waitExit(t, term); code != 7 {
		t.Fatalf("exit code = %d, want 7", code)
	}
}

func TestResize(t *testing.T) {
	m := testManager(t, Options{})
	openTerm(t, m, "resize", "/bin/sh", "-c", "sleep 30")
	if err := m.Resize("resize", 40, 100); err != nil {
		t.Fatalf("resize: %v", err)
	}
	if err := m.Resize("resize", 0, 80); err == nil {
		t.Fatal("resize with zero rows succeeded")
	} else {
		wantCode(t, err, protocol.CodeInvalidSpec)
	}
	if err := m.Resize("resize", 1001, 80); err == nil {
		t.Fatal("resize above 1000 rows succeeded")
	} else {
		wantCode(t, err, protocol.CodeInvalidSpec)
	}
	if err := m.Resize("missing", 24, 80); err == nil {
		t.Fatal("resize of an unknown terminal succeeded")
	} else {
		wantCode(t, err, protocol.CodeNotFound)
	}
}

func TestOpenRefusals(t *testing.T) {
	m := testManager(t, Options{MaxTerminals: 2})
	if _, err := m.Open(OpenRequest{ID: "priv", Rows: 24, Cols: 80, Privileged: true}); err == nil {
		t.Fatal("privileged open succeeded")
	} else {
		wantCode(t, err, protocol.CodePrivilegedUnsupported)
	}
	if _, err := m.Open(OpenRequest{ID: "bad-size", Rows: 0, Cols: 80}); err == nil {
		t.Fatal("open with zero rows succeeded")
	} else {
		wantCode(t, err, protocol.CodeInvalidSpec)
	}
	if _, err := m.Open(OpenRequest{ID: "spawn", Argv: []string{"/nonexistent/definitely-not-a-shell"}, Rows: 24, Cols: 80}); err == nil {
		t.Fatal("open of a missing executable succeeded")
	} else {
		wantCode(t, err, protocol.CodeSpawnFailed)
	}

	openTerm(t, m, "one", "/bin/sh", "-c", "sleep 30")
	if _, err := m.Open(OpenRequest{ID: "one", Argv: []string{"/bin/sh"}, Rows: 24, Cols: 80}); err == nil {
		t.Fatal("duplicate open succeeded")
	} else {
		wantCode(t, err, protocol.CodeAlreadyAccepted)
	}
	openTerm(t, m, "two", "/bin/sh", "-c", "sleep 30")
	if _, err := m.Open(OpenRequest{ID: "three", Argv: []string{"/bin/sh"}, Rows: 24, Cols: 80}); err == nil {
		t.Fatal("open beyond the backstop succeeded")
	} else {
		wantCode(t, err, protocol.CodeBusy)
	}
}

func TestCloseUnknown(t *testing.T) {
	m := testManager(t, Options{})
	m.Close("unknown") // idempotent, no panic and no process
}

func TestDefaultArgvIsLoginShell(t *testing.T) {
	m := testManager(t, Options{})
	term, err := m.Open(OpenRequest{ID: "login", Rows: 24, Cols: 80, ScrollbackBytes: 1 << 20})
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	got := term.Argv()
	if len(got) != 2 || got[0] != "/bin/sh" || got[1] != "-l" {
		t.Fatalf("argv = %q, want the login shell with -l", got)
	}
	if m.Get("login") != term {
		t.Fatal("terminal is not in the manager")
	}
}

func TestCloseKillsProcessGroup(t *testing.T) {
	m := testManager(t, Options{})
	term := openTerm(t, m, "group", "/bin/sh", "-c", "sleep 100 & echo $!; wait")
	out := waitOutput(t, term, "\r\n")
	fields := strings.Fields(out)
	if len(fields) == 0 {
		t.Fatalf("no child pid in %q", out)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(fields[0]))
	if err != nil {
		t.Fatalf("child pid %q: %v", fields[0], err)
	}
	m.Close("group")
	if m.Get("group") != nil {
		t.Fatal("closed terminal is still held")
	}
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat("/proc/" + strconv.Itoa(pid)); errors.Is(err, os.ErrNotExist) {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("child process %d survived the terminal's close", pid)
}

func TestExitRetentionAndOnExit(t *testing.T) {
	exited := make(chan *Terminal, 1)
	m := testManager(t, Options{
		ExitRetention: 200 * time.Millisecond,
		OnExit:        func(t *Terminal) { exited <- t },
	})
	term := openTerm(t, m, "retained", "/bin/sh", "-c", "exit 3")
	if code := waitExit(t, term); code != 3 {
		t.Fatalf("exit code = %d, want 3", code)
	}
	select {
	case got := <-exited:
		if got != term {
			t.Fatalf("OnExit got %v, want %v", got, term)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("OnExit was not called")
	}
	// The exited entry stays until crhs closes it or the retention window passes.
	if m.Count() != 1 {
		t.Fatalf("held %d terminals right after exit, want 1", m.Count())
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if m.Count() == 0 {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("exited terminal was not dropped after the retention window")
}

func TestCloseBeforeExitReportsNothing(t *testing.T) {
	reported := make(chan struct{}, 1)
	m := testManager(t, Options{
		ExitRetention: time.Minute,
		OnExit:        func(*Terminal) { reported <- struct{}{} },
	})
	openTerm(t, m, "closing", "/bin/sh", "-c", "sleep 100")
	m.Close("closing")
	select {
	case <-reported:
		t.Fatal("OnExit was called for a terminal crhs closed")
	case <-time.After(500 * time.Millisecond):
	}
}
