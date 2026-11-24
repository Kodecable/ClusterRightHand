package daemon

import (
	"os"
	"strings"
	"testing"
	"time"

	"github.com/Kodecable/ClusterRightHand/client/internal/execenv"
	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
)

// testTerminalEnv is the environment a terminal test daemon runs with: the privileged fixed PATH,
// but a temporary home the test user can enter and a shell every Linux has.
func testTerminalEnv(t *testing.T) *execenv.Environment {
	t.Helper()
	return &execenv.Environment{
		Shell:   "/bin/sh",
		Path:    execenv.PrivilegedPath,
		Home:    t.TempDir(),
		User:    "tester",
		Logname: "tester",
	}
}

// ptySpec is the pty.create spec of a terminal's argv, as crhs signs it.
func ptySpec(argv []string) protocol.TaskSpec {
	return protocol.TaskSpec{Kind: protocol.TaskSpecPtyCreate, PtyCreate: &protocol.PtyCreateSpec{Argv: argv}}
}

// ptyOpen is a privileged pty.open for argv, sized 24x80, with the scrollback crhs sends and the
// privileged side ignores.
func ptyOpen(id string, argv []string) protocol.PTYOpen {
	return protocol.PTYOpen{
		PTYID:           id,
		Argv:            argv,
		Rows:            24,
		Cols:            80,
		Privileged:      true,
		ScrollbackBytes: 1 << 20,
		// Attempt 1 matches the one-shot authorization payload's attempt.
		Attempt: 1,
	}
}

// authorizedPTY signs req's pty.create spec with the crhs key and returns the request.
func authorizedPTY(t *testing.T, keys *testKeys, req protocol.PTYOpen) protocol.PTYOpen {
	t.Helper()
	spec := ptySpec(req.Argv)
	payload := payloadFor(req.PTYID, uint64(req.Attempt), specCommand(t, &spec), nil)
	req.Authorizations = [][]byte{authorize(t, payload, keys.crhs)}
	return req
}

// waitPTYLogRecord waits for a local-log line with the event and pty_id.
func waitPTYLogRecord(t *testing.T, path, event, id string, timeout time.Duration) map[string]any {
	t.Helper()
	deadline := time.Now().Add(timeout)
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

// countLogRecords counts the local-log lines with the event and pty_id.
func countLogRecords(t *testing.T, path, event, id string) int {
	t.Helper()
	count := 0
	for _, record := range logRecords(t, path) {
		if record["event"] == event && record["pty_id"] == id {
			count++
		}
	}
	return count
}

// waitTerminals waits until the daemon holds want terminals.
func waitTerminals(t *testing.T, env *testEnv, want int) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if env.server.terms.Count() == want {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("the daemon holds %d terminals, want %d", env.server.terms.Count(), want)
}

// TestPrivilegedPTYAcceptedRelaysAndLogs covers the accepted path: the crhs-signed one-shot
// authorization runs the process, output arrives as pty.output, input echoes, pty.exited carries
// the exit code, and the local log holds the acceptance and the exit (doc/design/pty.md "Privilege").
func TestPrivilegedPTYAcceptedRelaysAndLogs(t *testing.T) {
	keys := newTestKeys(t)
	env := newTestEnvWithEnv(t, keys, func(p envPaths) string {
		return baseConfig(p, os.Getuid()) +
			sshTrust("crhs", "crhs", keys.crhsLine, `["execute", "cosign"]`, "")
	}, testTerminalEnv(t))
	client := dialForward(t, env.paths.Socket)
	ctx := requestContext(t)

	req := authorizedPTY(t, keys, ptyOpen("term-1", []string{"/bin/sh", "-c", "printf ready; read line; echo got:$line"}))
	if err := client.openPTY(ctx, req); err != nil {
		t.Fatalf("pty.open: %v", err)
	}
	client.waitPTYOutput("ready", 10*time.Second)
	if err := client.ptyInput(ctx, "term-1", "hello\n"); err != nil {
		t.Fatalf("pty.input: %v", err)
	}
	client.waitPTYOutput("got:hello", 10*time.Second)
	exit := client.waitPTYExit(10 * time.Second)
	if exit.PTYID != "term-1" || exit.ExitCode != 0 {
		t.Fatalf("pty.exited = %+v, want term-1 with code 0", exit)
	}
	// The terminal stays held after its process exits, like an unprivileged one; resize still
	// reaches it until crhs closes it.
	if err := client.ptyResize(ctx, "term-1", 30, 100); err != nil {
		t.Fatalf("pty.resize: %v", err)
	}

	opened := waitPTYLogRecord(t, env.paths.Log, "terminal.opened", "term-1", 5*time.Second)
	if opened["entry"] != "crhs" || opened["authorization_id"] == "" || opened["spec"] == nil {
		t.Fatalf("terminal.opened record = %v", opened)
	}
	spec, _ := opened["spec"].(map[string]any)
	if spec == nil || spec["Kind"] != "pty.create" {
		t.Fatalf("terminal.opened spec = %v", opened["spec"])
	}
	exited := waitPTYLogRecord(t, env.paths.Log, "terminal.exited", "term-1", 5*time.Second)
	if exited["exit_code"] != float64(0) {
		t.Fatalf("terminal.exited record = %v", exited)
	}

	// The used record exists: replaying the same terminal id is refused.
	if err := client.openPTY(ctx, req); err == nil {
		t.Fatal("replay of an opened terminal succeeded")
	} else {
		expectRemoteCode(t, err, "already_accepted")
	}
	if n := countLogRecords(t, env.paths.Log, "terminal.opened", "term-1"); n != 1 {
		t.Fatalf("%d terminal.opened records after a replay, want 1", n)
	}

	if err := client.ptyClose(ctx, "term-1"); err != nil {
		t.Fatalf("pty.close: %v", err)
	}
	closed := waitPTYLogRecord(t, env.paths.Log, "terminal.closed", "term-1", 5*time.Second)
	if !strings.Contains(closed["detail"].(string), "closed by the unprivileged mode") {
		t.Fatalf("terminal.closed record = %v", closed)
	}
	waitTerminals(t, env, 0)
}

// TestPrivilegedPTYEnvironment covers how the process starts: the privileged identity's home, the
// fixed privileged environment, the identity's login shell as SHELL, the system locale without
// LC_ALL, COLORTERM and TERM=xterm-256color when the environment carries none.
func TestPrivilegedPTYEnvironment(t *testing.T) {
	keys := newTestKeys(t)
	termEnv := testTerminalEnv(t)
	// The privileged identity's login shell and locale, as execenv.Resolve supplies them. The
	// shell only has to be the value in SHELL, not the process's argv.
	termEnv.LoginShell = "/bin/bash"
	termEnv.TerminalLocale = []string{"LANG=de_DE.UTF-8", "LC_TIME=fr_FR.UTF-8"}
	env := newTestEnvWithEnv(t, keys, func(p envPaths) string {
		return baseConfig(p, os.Getuid()) +
			sshTrust("crhs", "crhs", keys.crhsLine, `["execute", "cosign"]`, "")
	}, termEnv)
	client := dialForward(t, env.paths.Socket)
	ctx := requestContext(t)

	req := authorizedPTY(t, keys, ptyOpen("term-env", []string{"/bin/sh", "-c",
		`printf '%s|%s|%s|%s|%s|%s|%s|%s' "$PWD" "$PATH" "$TERM" "$SHELL" "$COLORTERM" "$LANG" "$LC_TIME" "${LC_ALL-unset}"`}))
	if err := client.openPTY(ctx, req); err != nil {
		t.Fatalf("pty.open: %v", err)
	}
	out := client.waitPTYOutput("|", 10*time.Second)
	deadline := time.Now().Add(10 * time.Second)
	for !strings.Contains(out, "unset") && time.Now().Before(deadline) {
		select {
		case chunk := <-client.ptyOutput:
			out += string(chunk.Data)
		case <-time.After(10 * time.Millisecond):
		}
	}
	want := env.envHome() + "|" + execenv.PrivilegedPath + "|xterm-256color|/bin/bash|truecolor|de_DE.UTF-8|fr_FR.UTF-8|unset"
	if !strings.Contains(out, want) {
		t.Fatalf("terminal environment output %q does not contain %q", out, want)
	}
}

// envHome returns the home the test daemon's environment resolves.
func (e *testEnv) envHome() string {
	if e.env == nil {
		return ""
	}
	return e.env.Home
}

// TestPrivilegedPTYWrongSpecRefused covers step 6: an authorization for another spec is refused and
// nothing is started.
func TestPrivilegedPTYWrongSpecRefused(t *testing.T) {
	keys := newTestKeys(t)
	env := newTestEnvWithEnv(t, keys, func(p envPaths) string {
		return baseConfig(p, os.Getuid()) +
			sshTrust("crhs", "crhs", keys.crhsLine, `["execute", "cosign"]`, "")
	}, testTerminalEnv(t))
	client := dialForward(t, env.paths.Socket)
	ctx := requestContext(t)

	req := ptyOpen("term-wrong", []string{"/bin/sh", "-c", "sleep 30"})
	signed := ptySpec([]string{"/bin/echo", "another terminal"})
	payload := payloadFor(req.PTYID, 1, specCommand(t, &signed), nil)
	req.Authorizations = [][]byte{authorize(t, payload, keys.crhs)}
	err := client.openPTY(ctx, req)
	remote := expectRemoteCode(t, err, "authorization_rejected")
	if !strings.Contains(remote.Message, "step 6") {
		t.Fatalf("refusal = %q, want step 6", remote.Message)
	}
	if n := countLogRecords(t, env.paths.Log, "terminal.opened", req.PTYID); n != 0 {
		t.Fatalf("%d terminal.opened records, want none", n)
	}
	if rec := waitPTYLogRecord(t, env.paths.Log, "terminal.refused", req.PTYID, 5*time.Second); rec["step"] != float64(6) {
		t.Fatalf("terminal.refused record = %v", rec)
	}
	waitTerminals(t, env, 0)
}

// TestPrivilegedPTYGuardAllowsOnlyExecRefused covers the guard rules: an entry whose allow list
// names only exec refuses pty.create, like upgrade.
func TestPrivilegedPTYGuardAllowsOnlyExecRefused(t *testing.T) {
	keys := newTestKeys(t)
	env := newTestEnvWithEnv(t, keys, func(p envPaths) string {
		return baseConfig(p, os.Getuid()) +
			sshTrust("crhs", "crhs", keys.crhsLine, `["execute"]`, `allow = [{ method = "exec" }]`+"\n")
	}, testTerminalEnv(t))
	client := dialForward(t, env.paths.Socket)
	ctx := requestContext(t)

	req := authorizedPTY(t, keys, ptyOpen("term-guard", []string{"/bin/sh", "-c", "exit 0"}))
	err := client.openPTY(ctx, req)
	remote := expectRemoteCode(t, err, "authorization_rejected")
	if !strings.Contains(remote.Message, "step 7") {
		t.Fatalf("refusal = %q, want step 7", remote.Message)
	}
	if n := countLogRecords(t, env.paths.Log, "terminal.opened", req.PTYID); n != 0 {
		t.Fatalf("%d terminal.opened records, want none", n)
	}
	waitTerminals(t, env, 0)
}

// TestPrivilegedPTYThroughWindow covers the local approval window: a crhs signature accepted
// through it runs the terminal, and the acceptance record carries the opening uid.
func TestPrivilegedPTYThroughWindow(t *testing.T) {
	keys := newTestKeys(t)
	env := newTestEnvWithEnv(t, keys, func(p envPaths) string {
		return baseConfig(p, os.Getuid()) +
			sshTrust("crhs", "crhs", keys.crhsLine, `["execute"]`, `deny = [{ method = "exec" }]`+"\n") +
			localTrust("local-admins", []uint32{uint32(os.Getuid())}, "")
	}, testTerminalEnv(t))
	client := dialForward(t, env.paths.Socket)
	local := dialLocal(t, env.paths.Socket)
	ctx := requestContext(t)

	if _, err := local.Open(ctx, 5*time.Minute); err != nil {
		t.Fatalf("window.open: %v", err)
	}
	req := authorizedPTY(t, keys, ptyOpen("term-window", []string{"/bin/sh", "-c", "printf windowed"}))
	if err := client.openPTY(ctx, req); err != nil {
		t.Fatalf("pty.open through the window: %v", err)
	}
	client.waitPTYOutput("windowed", 10*time.Second)
	opened := waitPTYLogRecord(t, env.paths.Log, "terminal.opened", "term-window", 5*time.Second)
	if opened["uid"] != float64(os.Getuid()) {
		t.Fatalf("terminal.opened uid = %v, want %d", opened["uid"], os.Getuid())
	}
	detail, _ := opened["detail"].(string)
	if !strings.Contains(detail, "via local window opened by uid") {
		t.Fatalf("terminal.opened detail = %q", detail)
	}
	if err := client.ptyClose(ctx, "term-window"); err != nil {
		t.Fatalf("pty.close: %v", err)
	}
}

// TestPrivilegedPTYConnectionLossCloses covers the daemon side of a broken forward connection: its
// terminals are closed, their process groups killed, and each close is recorded.
func TestPrivilegedPTYConnectionLossCloses(t *testing.T) {
	keys := newTestKeys(t)
	env := newTestEnvWithEnv(t, keys, func(p envPaths) string {
		return baseConfig(p, os.Getuid()) +
			sshTrust("crhs", "crhs", keys.crhsLine, `["execute", "cosign"]`, "")
	}, testTerminalEnv(t))
	client := dialForward(t, env.paths.Socket)
	ctx := requestContext(t)

	req := authorizedPTY(t, keys, ptyOpen("term-lost", []string{"/bin/sh", "-c", "sleep 30"}))
	if err := client.openPTY(ctx, req); err != nil {
		t.Fatalf("pty.open: %v", err)
	}
	waitTerminals(t, env, 1)
	client.close()

	closed := waitPTYLogRecord(t, env.paths.Log, "terminal.closed", "term-lost", 10*time.Second)
	if !strings.Contains(closed["detail"].(string), "forward connection ended") {
		t.Fatalf("terminal.closed record = %v", closed)
	}
	waitTerminals(t, env, 0)
}
