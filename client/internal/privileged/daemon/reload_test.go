package daemon

import (
	"os"
	"syscall"
	"testing"
	"time"

	"github.com/Kodecable/ClusterRightHand/client/internal/privileged/wire"
	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
)

func TestReloadPushesTrustSummary(t *testing.T) {
	keys := newTestKeys(t)
	env := crhsOnlyEnv(t, keys)
	forward := dialForward(t, env.paths.Socket)
	ctx := requestContext(t)

	var before protocol.TrustSummary
	if err := forward.peer.Request(ctx, wire.CmdTrustQuery, protocol.Empty{}, &before); err != nil {
		t.Fatalf("trust.query: %v", err)
	}
	if len(before.Trust) != 1 {
		t.Fatalf("initial trust = %+v", before.Trust)
	}
	beforeDigest, err := protocol.TrustDigest(&before)
	if err != nil {
		t.Fatal(err)
	}

	// The new configuration trusts a user as well, so the digest changes.
	env.writeConfig(func(p envPaths) string {
		return baseConfig(p, os.Getuid()) +
			sshTrust("crhs", "crhs", keys.crhsLine, `["execute", "cosign"]`, "") +
			sshTrust("alice", "user", keys.userLine, `["execute"]`, "")
	})
	if err := syscall.Kill(os.Getpid(), syscall.SIGHUP); err != nil {
		t.Fatalf("SIGHUP: %v", err)
	}
	report := forward.waitSummary(10 * time.Second)
	if report.Kind != protocol.TrustReportOK || report.Summary == nil {
		t.Fatalf("trust.summary = %+v", report)
	}
	if len(report.Summary.Trust) != 2 {
		t.Fatalf("reloaded trust = %+v", report.Summary.Trust)
	}
	digest, err := protocol.TrustDigest(report.Summary)
	if err != nil {
		t.Fatal(err)
	}
	if digest == beforeDigest {
		t.Fatal("trust.summary digest did not change")
	}
	// trust.query sees the new summary as well.
	var after protocol.TrustSummary
	if err := forward.peer.Request(ctx, wire.CmdTrustQuery, protocol.Empty{}, &after); err != nil {
		t.Fatalf("trust.query after reload: %v", err)
	}
	if got, err := protocol.TrustDigest(&after); err != nil || got != digest {
		t.Fatalf("trust.query digest = %x, %v; summary event %x", got, err, digest)
	}
	// The reload is in the local log.
	waitLogRecord(t, env.paths.Log, "config.reloaded", "", 5*time.Second)
}

func TestReloadFailureKeepsConfiguration(t *testing.T) {
	keys := newTestKeys(t)
	env := crhsOnlyEnv(t, keys)
	forward := dialForward(t, env.paths.Socket)
	ctx := requestContext(t)

	var before protocol.TrustSummary
	if err := forward.peer.Request(ctx, wire.CmdTrustQuery, protocol.Empty{}, &before); err != nil {
		t.Fatal(err)
	}
	env.writeConfig(func(p envPaths) string { return "node_id = \n" })
	if err := syscall.Kill(os.Getpid(), syscall.SIGHUP); err != nil {
		t.Fatalf("SIGHUP: %v", err)
	}
	waitLogRecord(t, env.paths.Log, "config.reload_failed", "", 5*time.Second)
	// No trust.summary event is pushed, and trust.query still returns the old summary.
	var after protocol.TrustSummary
	if err := forward.peer.Request(ctx, wire.CmdTrustQuery, protocol.Empty{}, &after); err != nil {
		t.Fatal(err)
	}
	if len(after.Trust) != len(before.Trust) {
		t.Fatalf("trust changed after a failed reload: %+v", after.Trust)
	}
	select {
	case report := <-forward.summaries:
		t.Fatalf("unexpected trust.summary after a failed reload: %+v", report)
	case <-time.After(200 * time.Millisecond):
	}
}

func TestDisconnectTaskFinishes(t *testing.T) {
	keys := newTestKeys(t)
	env := crhsOnlyEnv(t, keys)
	forward := dialForward(t, env.paths.Socket)

	ts := execTask("disconnect-1", 1, "/bin/sh", "-c", "sleep 0.2; printf done")
	payload := payloadFor("disconnect-1", 1, exactCommand(t, &ts.Spec), nil)
	ts.Authorizations = [][]byte{authorize(t, payload, keys.crhs)}
	if err := forward.start(requestContext(t), ts); err != nil {
		t.Fatalf("task.start: %v", err)
	}
	// The task was accepted; the connection disappears while it runs.
	forward.close()

	accepted := waitLogRecord(t, env.paths.Log, "task.accepted", "disconnect-1", 5*time.Second)
	if accepted["entry"] != "crhs" {
		t.Fatalf("task.accepted = %v", accepted)
	}
	finished := waitLogRecord(t, env.paths.Log, "task.finished", "disconnect-1", 15*time.Second)
	if finished["outcome"] != "exit 0" {
		t.Fatalf("task.finished = %v", finished)
	}
}

func TestForcedCwdUnlessExact(t *testing.T) {
	keys := newTestKeys(t)
	env := crhsOnlyEnv(t, keys)
	forward := dialForward(t, env.paths.Socket)
	ctx := requestContext(t)

	// A prefix authorization leaves cwd free in the spec, but privileged execution fixes it
	// to "/" (doc/design/privilege.md "Validation flow").
	ts := execTask("cwd-1", 1, "/bin/pwd")
	ts.Spec.Exec.Cwd = env.paths.Dir
	payload := payloadFor("cwd-1", 1, prefixCommand(protocol.MethodExec, "/bin/pwd"), nil)
	ts.Authorizations = [][]byte{authorize(t, payload, keys.crhs)}
	if err := forward.start(ctx, ts); err != nil {
		t.Fatalf("task.start: %v", err)
	}
	if exit := forward.waitExit(15 * time.Second); exit.Outcome.Code != 0 {
		t.Fatalf("task.exit = %+v", exit)
	}
	if got := forward.output(); got != "/\n" {
		t.Fatalf("prefix task cwd output = %q, want %q", got, "/\n")
	}

	// An exact authorization pins the whole spec, including cwd.
	ts = execTask("cwd-2", 1, "/bin/pwd")
	ts.Spec.Exec.Cwd = env.paths.Dir
	payload = payloadFor("cwd-2", 1, exactCommand(t, &ts.Spec), nil)
	ts.Authorizations = [][]byte{authorize(t, payload, keys.crhs)}
	if err := forward.start(ctx, ts); err != nil {
		t.Fatalf("exact task.start: %v", err)
	}
	if exit := forward.waitExit(15 * time.Second); exit.Outcome.Code != 0 {
		t.Fatalf("exact task.exit = %+v", exit)
	}
	if got := forward.output(); got != env.paths.Dir+"\n" {
		t.Fatalf("exact task cwd output = %q, want %q", got, env.paths.Dir+"\n")
	}
}

func TestEnvAllowRefused(t *testing.T) {
	keys := newTestKeys(t)
	env := newTestEnv(t, keys, func(p envPaths) string {
		return baseConfig(p, os.Getuid()) +
			sshTrust("crhs", "crhs", keys.crhsLine, `["execute"]`, `env_allow = ["FOO"]`)
	})
	forward := dialForward(t, env.paths.Socket)
	ctx := requestContext(t)

	ts := execTask("env-1", 1, "/bin/sh", "-c", "printf \"$BAR\"")
	ts.Spec.Exec.Env = map[string]string{"BAR": "secret"}
	payload := payloadFor("env-1", 1, prefixCommand(protocol.MethodExec, "/bin/sh -c"), nil)
	ts.Authorizations = [][]byte{authorize(t, payload, keys.crhs)}
	expectRemoteCode(t, forward.start(ctx, ts), "authorization_rejected")

	ts = execTask("env-2", 1, "/bin/sh", "-c", `printf "$FOO"`)
	ts.Spec.Exec.Env = map[string]string{"FOO": "visible"}
	payload = payloadFor("env-2", 1, exactCommand(t, &ts.Spec), nil)
	ts.Authorizations = [][]byte{authorize(t, payload, keys.crhs)}
	if err := forward.start(ctx, ts); err != nil {
		t.Fatalf("allowed env task.start: %v", err)
	}
	if exit := forward.waitExit(15 * time.Second); exit.Outcome.Code != 0 {
		t.Fatalf("task.exit = %+v", exit)
	}
	if got := forward.output(); got != "visible" {
		t.Fatalf("stdout = %q", got)
	}
}
