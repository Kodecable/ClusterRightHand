package pty

import (
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
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

// fakeShell writes a minimal executable shell script and returns its path.
func fakeShell(t *testing.T, dir, name string) string {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	return p
}

// terminalEnvironment is an environment whose login shell differs from the sh exec tasks use, so a
// test can tell which one a terminal adopted.
func terminalEnvironment(t *testing.T, loginShell string) *execenv.Environment {
	t.Helper()
	return &execenv.Environment{
		Shell:          "/bin/sh",
		Bash:           "/bin/bash",
		LoginShell:     loginShell,
		TerminalLocale: []string{"LANG=de_DE.UTF-8", "LC_TIME=fr_FR.UTF-8", "LANGUAGE=de"},
		Path:           "/usr/local/bin:/usr/bin:/bin",
		Home:           t.TempDir(),
		User:           "tester",
		Logname:        "tester",
	}
}

// envMap parses KEY=VALUE environment entries.
func envMap(t *testing.T, env []string) map[string]string {
	t.Helper()
	out := map[string]string{}
	for _, kv := range env {
		k, v, ok := strings.Cut(kv, "=")
		if !ok {
			t.Fatalf("environment entry %q has no =", kv)
		}
		if _, dup := out[k]; dup {
			t.Fatalf("environment has duplicate %s: %q", k, env)
		}
		out[k] = v
	}
	return out
}

// TestDefaultArgvUsesLoginShell checks that an empty argv runs the terminal's login shell with -l,
// not the discovered sh that exec tasks use.
func TestDefaultArgvUsesLoginShell(t *testing.T) {
	login := fakeShell(t, t.TempDir(), "login-shell")
	m := testManager(t, Options{Env: terminalEnvironment(t, login)})
	term := openTerm(t, m, "login")
	got := term.Argv()
	if len(got) != 2 || got[0] != login || got[1] != "-l" {
		t.Fatalf("argv = %q, want %q with -l", got, login)
	}
}

// TestTerminalSHELLAndEnvironment covers an explicit argv: SHELL is still the identity's login
// shell, the locale comes from the system default files without LC_ALL, and COLORTERM is set.
func TestTerminalSHELLAndEnvironment(t *testing.T) {
	login := fakeShell(t, t.TempDir(), "login-shell")
	m := testManager(t, Options{Env: terminalEnvironment(t, login)})
	term := openTerm(t, m, "shell-env", "/bin/sh", "-c",
		`printf '%s|%s|%s|%s|%s' "$SHELL" "$COLORTERM" "$LANG" "$LC_TIME" "${LC_ALL-unset}"`)
	waitOutput(t, term, login+"|truecolor|de_DE.UTF-8|fr_FR.UTF-8|unset")
}

// TestTerminalEnv checks the terminal environment directly: identity variables, SHELL, the locale
// without LC_ALL, and COLORTERM. LINES, COLUMNS and TERM are not set here (crosspty adds TERM).
func TestTerminalEnv(t *testing.T) {
	tests := []struct {
		name string
		env  *execenv.Environment
		want map[string]string
	}{
		{
			name: "resolved login shell and locale",
			env: &execenv.Environment{
				Shell:          "/bin/sh",
				Bash:           "/bin/bash",
				LoginShell:     "/bin/zsh",
				TerminalLocale: []string{"LANG=de_DE.UTF-8", "LC_TIME=fr_FR.UTF-8", "LANGUAGE=de"},
				Path:           "/usr/bin:/bin",
				Home:           "/home/alice",
				User:           "alice",
				Logname:        "alice",
			},
			want: map[string]string{
				"HOME": "/home/alice", "USER": "alice", "LOGNAME": "alice",
				"PATH": "/usr/bin:/bin", "SHELL": "/bin/zsh",
				"LANG": "de_DE.UTF-8", "LC_TIME": "fr_FR.UTF-8", "LANGUAGE": "de",
				"COLORTERM": "truecolor",
			},
		},
		{
			name: "bash fallback without a resolved login shell",
			env: &execenv.Environment{
				Shell: "/bin/sh", Bash: "/bin/bash",
				Path: "/bin", Home: "/root", User: "root", Logname: "root",
			},
			want: map[string]string{
				"HOME": "/root", "USER": "root", "LOGNAME": "root",
				"PATH": "/bin", "SHELL": "/bin/bash",
				"LANG": "C.UTF-8", "COLORTERM": "truecolor",
			},
		},
		{
			name: "sh fallback",
			env: &execenv.Environment{
				Shell: "/bin/sh", Path: "/bin", Home: "/", User: "nobody", Logname: "nobody",
			},
			want: map[string]string{
				"HOME": "/", "USER": "nobody", "LOGNAME": "nobody",
				"PATH": "/bin", "SHELL": "/bin/sh",
				"LANG": "C.UTF-8", "COLORTERM": "truecolor",
			},
		},
		{
			name: "manual locale cannot set LC_ALL or drop LANG",
			env: &execenv.Environment{
				Shell: "/bin/sh", Path: "/bin", Home: "/", User: "nobody", Logname: "nobody",
				TerminalLocale: []string{"LC_ALL=POSIX", "LC_TIME=fr_FR.UTF-8"},
			},
			want: map[string]string{
				"HOME": "/", "USER": "nobody", "LOGNAME": "nobody",
				"PATH": "/bin", "SHELL": "/bin/sh",
				"LANG": "C.UTF-8", "LC_TIME": "fr_FR.UTF-8", "COLORTERM": "truecolor",
			},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := envMap(t, terminalEnv(tc.env))
			for k, want := range tc.want {
				if got[k] != want {
					t.Errorf("%s = %q, want %q", k, got[k], want)
				}
			}
			for _, k := range []string{"LC_ALL", "LINES", "COLUMNS", "TERM"} {
				if _, ok := got[k]; ok {
					t.Errorf("terminal environment must not set %s: %q", k, got[k])
				}
			}
			if len(got) != len(tc.want) {
				t.Fatalf("environment has %d entries, want %d: %q", len(got), len(tc.want), terminalEnv(tc.env))
			}
		})
	}
}
