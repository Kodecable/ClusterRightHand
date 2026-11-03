package daemon

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Kodecable/ClusterRightHand/client/internal/privileged/audit"
	"github.com/Kodecable/ClusterRightHand/client/internal/privileged/config"
	"github.com/Kodecable/ClusterRightHand/client/internal/privileged/localclient"
	"github.com/Kodecable/ClusterRightHand/client/internal/privileged/wire"
	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
)

func crhsOnlyEnv(t *testing.T, keys *testKeys) *testEnv {
	t.Helper()
	return newTestEnv(t, keys, func(p envPaths) string {
		return baseConfig(p, os.Getuid()) +
			sshTrust("crhs", "crhs", keys.crhsLine, `["execute", "cosign"]`, "")
	})
}

func expectRemoteCode(t *testing.T, err error, code string) *protocol.RemoteError {
	t.Helper()
	var remote *protocol.RemoteError
	if !errors.As(err, &remote) {
		t.Fatalf("got %v, want a remote error with code %s", err, code)
	}
	if remote.Code != code {
		t.Fatalf("error code %q, want %q (%s)", remote.Code, code, remote.Message)
	}
	return remote
}

func requestContext(t *testing.T) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	t.Cleanup(cancel)
	return ctx
}

func TestExactExecRuns(t *testing.T) {
	keys := newTestKeys(t)
	env := crhsOnlyEnv(t, keys)
	client := dialForward(t, env.paths.Socket)

	ts := execTask("exec-1", 1, "/bin/echo", "ok")
	payload := payloadFor("exec-1", 1, exactCommand(t, &ts.Spec), nil)
	ts.Authorizations = [][]byte{authorize(t, payload, keys.crhs)}
	if err := client.start(requestContext(t), ts); err != nil {
		t.Fatalf("task.start: %v", err)
	}
	exit := client.waitExit(15 * time.Second)
	if exit.TaskID != "exec-1" || exit.Outcome.Kind != protocol.OutcomeCode || exit.Outcome.Code != 0 {
		t.Fatalf("task.exit = %+v", exit)
	}
	if got := client.stdout(); got != "ok\n" {
		t.Fatalf("stdout = %q", got)
	}
	accepted := waitLogRecord(t, env.paths.Log, "task.accepted", "exec-1", 5*time.Second)
	if accepted["entry"] != "crhs" || accepted["authorization_id"] == "" || accepted["spec"] == nil {
		t.Fatalf("task.accepted record = %v", accepted)
	}
	finished := waitLogRecord(t, env.paths.Log, "task.finished", "exec-1", 5*time.Second)
	if finished["outcome"] != "exit 0" {
		t.Fatalf("task.finished record = %v", finished)
	}
}

func TestExactFileWriteRuns(t *testing.T) {
	keys := newTestKeys(t)
	env := crhsOnlyEnv(t, keys)
	client := dialForward(t, env.paths.Socket)

	path := filepath.Join(env.paths.Dir, "written")
	ts := fileWriteTask("write-1", 1, path)
	payload := payloadFor("write-1", 1, exactCommandFor(t, protocol.MethodFileWrite, &ts.Spec), nil)
	ts.Authorizations = [][]byte{authorize(t, payload, keys.crhs)}
	if err := client.start(requestContext(t), ts); err != nil {
		t.Fatalf("task.start: %v", err)
	}
	exit := client.waitExit(15 * time.Second)
	if exit.Outcome.Kind != protocol.OutcomeCode || exit.Outcome.Code != 0 {
		t.Fatalf("task.exit = %+v", exit)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("written file: %v", err)
	}
	if len(data) != 0 {
		t.Fatalf("written file has %q, want empty", data)
	}
}

func TestReplayRefused(t *testing.T) {
	keys := newTestKeys(t)
	env := crhsOnlyEnv(t, keys)
	client := dialForward(t, env.paths.Socket)

	ts := execTask("replay-1", 1, "/bin/echo", "once")
	payload := payloadFor("replay-1", 1, exactCommand(t, &ts.Spec), nil)
	ts.Authorizations = [][]byte{authorize(t, payload, keys.crhs)}
	ctx := requestContext(t)
	if err := client.start(ctx, ts); err != nil {
		t.Fatalf("first task.start: %v", err)
	}
	client.waitExit(15 * time.Second)
	if err := client.start(ctx, ts); err == nil {
		t.Fatal("replay was accepted")
	} else {
		expectRemoteCode(t, err, "already_accepted")
	}
}

func TestExpiredRefused(t *testing.T) {
	keys := newTestKeys(t)
	env := crhsOnlyEnv(t, keys)
	client := dialForward(t, env.paths.Socket)

	ts := execTask("expired-1", 1, "/bin/echo", "late")
	past := time.Now().Add(-time.Hour)
	payload := payloadFor("expired-1", 1, exactCommand(t, &ts.Spec), &past)
	ts.Authorizations = [][]byte{authorize(t, payload, keys.crhs)}
	err := client.start(requestContext(t), ts)
	remote := expectRemoteCode(t, err, "authorization_expired")
	if remote.Message == "" {
		t.Fatal("refusal has no message")
	}
	refused := waitLogRecord(t, env.paths.Log, "task.refused", "expired-1", 5*time.Second)
	if refused["code"] != "authorization_expired" || refused["step"] != float64(4) {
		t.Fatalf("task.refused record = %v", refused)
	}
}

func TestWrongAttemptRefused(t *testing.T) {
	keys := newTestKeys(t)
	env := crhsOnlyEnv(t, keys)
	client := dialForward(t, env.paths.Socket)

	ts := execTask("attempt-1", 1, "/bin/echo", "x")
	payload := payloadFor("attempt-1", 2, exactCommand(t, &ts.Spec), nil)
	ts.Authorizations = [][]byte{authorize(t, payload, keys.crhs)}
	expectRemoteCode(t, client.start(requestContext(t), ts), "authorization_invalid")
}

func TestUserOnlyTrust(t *testing.T) {
	keys := newTestKeys(t)
	env := newTestEnv(t, keys, func(p envPaths) string {
		return baseConfig(p, os.Getuid()) +
			sshTrust("alice", "user", keys.userLine, `["execute"]`, "")
	})
	client := dialForward(t, env.paths.Socket)
	ctx := requestContext(t)

	// A crhs signature on a node that does not trust crhs is ignored entirely.
	ts := execTask("user-1", 1, "/bin/echo", "crhs")
	payload := payloadFor("user-1", 1, exactCommand(t, &ts.Spec), nil)
	ts.Authorizations = [][]byte{authorize(t, payload, keys.crhs)}
	expectRemoteCode(t, client.start(ctx, ts), "authorization_invalid")

	// The user's own signature works.
	ts = execTask("user-2", 1, "/bin/echo", "user")
	payload = payloadFor("user-2", 1, exactCommand(t, &ts.Spec), nil)
	ts.Authorizations = [][]byte{authorize(t, payload, keys.user)}
	if err := client.start(ctx, ts); err != nil {
		t.Fatalf("user task.start: %v", err)
	}
	exit := client.waitExit(15 * time.Second)
	if exit.Outcome.Kind != protocol.OutcomeCode || exit.Outcome.Code != 0 {
		t.Fatalf("task.exit = %+v", exit)
	}
}

func TestRequireCosign(t *testing.T) {
	keys := newTestKeys(t)
	env := newTestEnv(t, keys, func(p envPaths) string {
		return baseConfig(p, os.Getuid()) +
			sshTrust("alice", "user", keys.userLine, `["execute", "require-cosign"]`, "") +
			sshTrust("crhs", "crhs", keys.crhsLine, `["cosign"]`, "")
	})
	client := dialForward(t, env.paths.Socket)
	ctx := requestContext(t)

	ts := execTask("cosign-1", 1, "/bin/echo", "no-cosign")
	payload := payloadFor("cosign-1", 1, exactCommand(t, &ts.Spec), nil)
	ts.Authorizations = [][]byte{authorize(t, payload, keys.user)}
	expectRemoteCode(t, client.start(ctx, ts), "authorization_rejected")

	ts = execTask("cosign-2", 1, "/bin/echo", "cosigned")
	payload = payloadFor("cosign-2", 1, exactCommand(t, &ts.Spec), nil)
	ts.Authorizations = [][]byte{authorize(t, payload, keys.user, keys.crhs)}
	if err := client.start(ctx, ts); err != nil {
		t.Fatalf("cosigned task.start: %v", err)
	}
	exit := client.waitExit(15 * time.Second)
	if exit.Outcome.Kind != protocol.OutcomeCode || exit.Outcome.Code != 0 {
		t.Fatalf("task.exit = %+v", exit)
	}
	if got := client.stdout(); got != "cosigned\n" {
		t.Fatalf("stdout = %q", got)
	}
}

// TestNoDeadlineRefused covers that every authorization must carry a deadline: the daemon
// refuses a payload without one at the authorization step, before it touches the used list.
func TestNoDeadlineRefused(t *testing.T) {
	keys := newTestKeys(t)
	env := crhsOnlyEnv(t, keys)
	client := dialForward(t, env.paths.Socket)

	ts := execTask("no-deadline-1", 1, "/bin/echo", "late")
	payload := payloadFor("no-deadline-1", 1, exactCommand(t, &ts.Spec), nil)
	payload.DeadlineMS = nil
	ts.Authorizations = [][]byte{authorize(t, payload, keys.crhs)}
	remote := expectRemoteCode(t, client.start(requestContext(t), ts), "authorization_expired")
	if !strings.Contains(remote.Message, "no deadline") {
		t.Fatalf("refusal = %q, want a missing-deadline explanation", remote.Message)
	}
	refused := waitLogRecord(t, env.paths.Log, "task.refused", "no-deadline-1", 5*time.Second)
	if refused["code"] != "authorization_expired" || refused["step"] != float64(4) {
		t.Fatalf("task.refused record = %v", refused)
	}
	if env.server.store.Executed("no-deadline-1") {
		t.Fatal("a refused authorization was written to the used list")
	}
}

// TestNoPersistUsed covers the in-memory-only switch at the daemon boundary: New logs the
// security warning and does not create the state directory.
func TestNoPersistUsed(t *testing.T) {
	keys := newTestKeys(t)
	dir := t.TempDir()
	paths := envPaths{
		Dir:      dir,
		Config:   filepath.Join(dir, "privileged.toml"),
		Socket:   filepath.Join(dir, "priv.sock"),
		StateDir: filepath.Join(dir, "state"),
		Log:      filepath.Join(dir, "privileged.jsonl"),
	}
	cfgText := baseConfig(paths, os.Getuid()) +
		sshTrust("crhs", "crhs", keys.crhsLine, `["execute"]`, "")
	if err := os.WriteFile(paths.Config, []byte(cfgText), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := config.Load(paths.Config)
	if err != nil {
		t.Fatalf("load config: %v", err)
	}
	log, err := audit.Open(paths.Log, audit.Options{Mirror: io.Discard})
	if err != nil {
		t.Fatal(err)
	}
	defer log.Close()
	var stderr bytes.Buffer
	server, err := New(cfg, Options{
		Version:       "test",
		Log:           log,
		Logger:        slog.New(slog.NewTextHandler(&stderr, nil)),
		NoPersistUsed: true,
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer server.store.Close()
	warning := stderr.String()
	for _, want := range []string{"in memory only", "can run again until its deadline"} {
		if !strings.Contains(warning, want) {
			t.Fatalf("startup warning = %q, want it to contain %q", warning, want)
		}
	}
	if _, err := os.Stat(paths.StateDir); !os.IsNotExist(err) {
		t.Fatalf("NoPersistUsed created the state directory: %v", err)
	}
}

func TestUsedPersistsAcrossRestart(t *testing.T) {
	keys := newTestKeys(t)
	env := crhsOnlyEnv(t, keys)
	client := dialForward(t, env.paths.Socket)
	ctx := requestContext(t)

	ts := execTask("used-1", 1, "/bin/echo", "used")
	payload := payloadFor("used-1", 1, exactCommand(t, &ts.Spec), nil)
	ts.Authorizations = [][]byte{authorize(t, payload, keys.crhs)}
	if err := client.start(ctx, ts); err != nil {
		t.Fatalf("task.start: %v", err)
	}
	client.waitExit(15 * time.Second)

	env.restart()
	client = dialForward(t, env.paths.Socket)
	expectRemoteCode(t, client.start(requestContext(t), ts), "already_accepted")
}

// TestRoleChecks covers SO_PEERCRED role selection: a forward hello is refused when the uid is
// not unprivileged_uid, while a local uid can still approve.
func TestRoleChecks(t *testing.T) {
	keys := newTestKeys(t)
	uid := os.Getuid()
	env := newTestEnv(t, keys, func(p envPaths) string {
		return baseConfig(p, uid+1000) +
			sshTrust("crhs", "crhs", keys.crhsLine, `["execute"]`, "") +
			localTrust("local-admins", []uint32{uint32(uid)}, "")
	})

	conn, err := net.Dial("unix", env.paths.Socket)
	if err != nil {
		t.Fatal(err)
	}
	_, _, err = wire.ClientHandshake(conn, conn, wire.ClientOptions{Role: wire.RoleForward, CRHAVersion: "test"})
	conn.Close()
	if err == nil {
		t.Fatal("forward handshake from a non-unprivileged uid succeeded")
	}

	// The same uid is a local approver, so the local role still connects.
	local, err := localclient.Dial(requestContext(t), env.paths.Socket, "test")
	if err != nil {
		t.Fatalf("local dial: %v", err)
	}
	defer local.Close()
	entries, err := local.Pending(requestContext(t))
	if err != nil || len(entries) != 0 {
		t.Fatalf("pending = %v, %v", entries, err)
	}
}

// TestRootIsNotImplicitlyLocal checks that a uid with no matching local trust entry cannot use
// the local role, even when it is not unprivileged_uid either.
func TestRootIsNotImplicitlyLocal(t *testing.T) {
	keys := newTestKeys(t)
	uid := os.Getuid()
	env := newTestEnv(t, keys, func(p envPaths) string {
		return baseConfig(p, uid+1000) +
			localTrust("local-admins", []uint32{uint32(uid + 1)}, "")
	})
	conn, err := net.Dial("unix", env.paths.Socket)
	if err != nil {
		t.Fatal(err)
	}
	_, _, err = wire.ClientHandshake(conn, conn, wire.ClientOptions{Role: wire.RoleLocal, CRHAVersion: "test"})
	conn.Close()
	if err == nil {
		t.Fatal("local handshake from an untrusted uid succeeded")
	}
	// A forward hello is refused too: unprivileged_uid is someone else.
	conn, err = net.Dial("unix", env.paths.Socket)
	if err != nil {
		t.Fatal(err)
	}
	_, _, err = wire.ClientHandshake(conn, conn, wire.ClientOptions{Role: wire.RoleForward, CRHAVersion: "test"})
	conn.Close()
	if err == nil {
		t.Fatal("forward handshake from an untrusted uid succeeded")
	}
}

// TestSocketMode covers the socket's 0660 mode; the group is the configured one when it
// exists, otherwise the running user's.
func TestSocketMode(t *testing.T) {
	keys := newTestKeys(t)
	env := crhsOnlyEnv(t, keys)
	info, err := os.Stat(env.paths.Socket)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode()&os.ModeSocket == 0 {
		t.Fatalf("%s is not a socket (%v)", env.paths.Socket, info.Mode())
	}
	if mode := info.Mode().Perm(); mode != 0o660 {
		t.Fatalf("socket mode = %04o, want 0660", mode)
	}
}

// TestTaskInput covers task.input forwarding: the daemon hands chunks to the shared task
// machinery and the process reads them as stdin.
func TestTaskInput(t *testing.T) {
	keys := newTestKeys(t)
	env := crhsOnlyEnv(t, keys)
	client := dialForward(t, env.paths.Socket)
	ctx := requestContext(t)

	data := []byte("hello privileged input")
	sum := sha256.Sum256(data)
	ts := execTask("input-1", 1, "/bin/cat")
	ts.Spec.Exec.Stdin = &protocol.InputRef{Size: protocol.Uint(len(data)), SHA256: protocol.Hash(sum)}
	payload := payloadFor("input-1", 1, exactCommand(t, &ts.Spec), nil)
	ts.Authorizations = [][]byte{authorize(t, payload, keys.crhs)}
	if err := client.start(ctx, ts); err != nil {
		t.Fatalf("task.start: %v", err)
	}
	var empty protocol.Empty
	for offset := 0; offset < len(data); offset += 5 {
		end := min(offset+5, len(data))
		if err := client.peer.Request(ctx, protocol.CmdTaskInput, protocol.TaskInput{
			TaskID: "input-1", Offset: protocol.Uint(offset), Data: data[offset:end],
		}, &empty); err != nil {
			t.Fatalf("task.input: %v", err)
		}
	}
	exit := client.waitExit(15 * time.Second)
	if exit.Outcome.Kind != protocol.OutcomeCode || exit.Outcome.Code != 0 {
		t.Fatalf("task.exit = %+v", exit)
	}
	if got := client.stdout(); got != string(data) {
		t.Fatalf("stdout = %q, want %q", got, data)
	}
}

// TestTaskCancel and TestTaskTimeout cover the task.cancel command and the timeout the
// daemon applies through the shared machinery.
func TestTaskCancel(t *testing.T) {
	keys := newTestKeys(t)
	env := crhsOnlyEnv(t, keys)
	client := dialForward(t, env.paths.Socket)
	ctx := requestContext(t)

	ts := execTask("cancel-1", 1, "/bin/sleep", "30")
	payload := payloadFor("cancel-1", 1, exactCommand(t, &ts.Spec), nil)
	ts.Authorizations = [][]byte{authorize(t, payload, keys.crhs)}
	if err := client.start(ctx, ts); err != nil {
		t.Fatalf("task.start: %v", err)
	}
	var empty protocol.Empty
	if err := client.peer.Request(ctx, protocol.CmdTaskCancel, protocol.TaskCancel{TaskID: "cancel-1"}, &empty); err != nil {
		t.Fatalf("task.cancel: %v", err)
	}
	exit := client.waitExit(15 * time.Second)
	if !exit.Cancelled || exit.Outcome.Kind != protocol.OutcomeSignal || exit.Outcome.Signal != "TERM" {
		t.Fatalf("task.exit = %+v", exit)
	}
}

func TestTaskTimeout(t *testing.T) {
	keys := newTestKeys(t)
	env := crhsOnlyEnv(t, keys)
	client := dialForward(t, env.paths.Socket)

	ts := execTask("timeout-1", 1, "/bin/sleep", "30")
	ts.TimeoutMS = 200
	payload := payloadFor("timeout-1", 1, exactCommand(t, &ts.Spec), nil)
	ts.Authorizations = [][]byte{authorize(t, payload, keys.crhs)}
	if err := client.start(requestContext(t), ts); err != nil {
		t.Fatalf("task.start: %v", err)
	}
	exit := client.waitExit(15 * time.Second)
	if !exit.TimedOut || exit.Outcome.Kind != protocol.OutcomeSignal {
		t.Fatalf("task.exit = %+v", exit)
	}
}

// onlyForwardConn returns the test daemon's single forward connection.
func onlyForwardConn(t *testing.T, s *Server) *conn {
	t.Helper()
	s.mu.Lock()
	defer s.mu.Unlock()
	for c := range s.forwards {
		return c
	}
	t.Fatal("no forward connection")
	return nil
}

// TestFinishedTasksLeaveConnection covers the connection's task table: a forward connection
// lives for days, so every task whose execution ended must be dropped instead of retaining its
// taskrun.Task. A late task.input for such an id is unknown_task.
func TestFinishedTasksLeaveConnection(t *testing.T) {
	keys := newTestKeys(t)
	env := crhsOnlyEnv(t, keys)
	client := dialForward(t, env.paths.Socket)
	ctx := requestContext(t)

	const tasks = 50
	var lastID string
	for i := range tasks {
		id := fmt.Sprintf("finished-%d", i)
		lastID = id
		ts := execTask(id, 1, "/bin/true")
		payload := payloadFor(id, 1, exactCommand(t, &ts.Spec), nil)
		ts.Authorizations = [][]byte{authorize(t, payload, keys.crhs)}
		if err := client.start(ctx, ts); err != nil {
			t.Fatalf("task.start %s: %v", id, err)
		}
		exit := client.waitExit(15 * time.Second)
		if exit.TaskID != id || exit.Outcome.Kind != protocol.OutcomeCode || exit.Outcome.Code != 0 {
			t.Fatalf("task.exit for %s = %+v", id, exit)
		}
	}

	c := onlyForwardConn(t, env.server)
	// task.exit goes out before the exit callback drops the entry, so wait for the drop.
	deadline := time.Now().Add(10 * time.Second)
	for {
		c.mu.Lock()
		left := len(c.tasks)
		c.mu.Unlock()
		if left == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("connection still retains %d finished task(s)", left)
		}
		time.Sleep(time.Millisecond)
	}

	var empty protocol.Empty
	err := client.peer.Request(ctx, protocol.CmdTaskInput, protocol.TaskInput{
		TaskID: lastID, Offset: 0, Data: []byte("late"),
	}, &empty)
	expectRemoteCode(t, err, "unknown_task")
}
