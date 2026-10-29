package daemon

import (
	"errors"
	"os"
	"testing"
	"time"

	"github.com/Kodecable/ClusterRightHand/client/internal/privileged/authz"
	"github.com/Kodecable/ClusterRightHand/client/internal/privileged/localclient"
	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
)

func localEnv(t *testing.T, keys *testKeys) *testEnv {
	t.Helper()
	uid := uint32(os.Getuid())
	return newTestEnv(t, keys, func(p envPaths) string {
		return baseConfig(p, os.Getuid()) + localTrust("local-admins", []uint32{uid}, "")
	})
}

func TestLocalApprovalFlow(t *testing.T) {
	keys := newTestKeys(t)
	env := localEnv(t, keys)
	forward := dialForward(t, env.paths.Socket)
	ctx := requestContext(t)

	ts := execTask("local-1", 1, "/bin/echo", "approved")
	request := protocol.LocalRequest{TaskID: "local-1", Attempt: 1, Spec: ts.Spec, Note: "please run"}
	state, err := forward.localRequest(ctx, request)
	if err != nil {
		t.Fatalf("local.request: %v", err)
	}
	if state.Kind != protocol.LocalStatePending {
		t.Fatalf("local.request state = %+v", state)
	}
	// Repeating the same request is idempotent.
	if again, err := forward.localRequest(ctx, request); err != nil || again.Kind != protocol.LocalStatePending {
		t.Fatalf("second local.request = %+v, %v", again, err)
	}

	local, err := localclient.Dial(ctx, env.paths.Socket, "test")
	if err != nil {
		t.Fatalf("local dial: %v", err)
	}
	defer local.Close()
	entries, err := local.Pending(ctx)
	if err != nil {
		t.Fatalf("pending.list: %v", err)
	}
	if len(entries) != 1 || entries[0].TaskID != "local-1" || entries[0].Attempt != 1 {
		t.Fatalf("pending.list = %+v", entries)
	}
	if entries[0].Note != "please run" {
		t.Fatalf("note = %q", entries[0].Note)
	}
	method, target, err := authz.Target(&entries[0].Spec)
	if err != nil || method != "exec" || target != "/bin/echo approved" {
		t.Fatalf("pending target = %s %q, %v", method, target, err)
	}

	if err := local.Approve(ctx, "local-1", 1, ""); err != nil {
		t.Fatalf("local.approve: %v", err)
	}
	decision := forward.waitDecision(10 * time.Second)
	if decision.TaskID != "local-1" || decision.Attempt != 1 || decision.State.Kind != protocol.LocalStateApproved {
		t.Fatalf("local.decision = %+v", decision)
	}

	// task.start with no authorization; the approved record covers this exact spec.
	ts.Authorizations = nil
	if err := forward.start(ctx, ts); err != nil {
		t.Fatalf("task.start after approval: %v", err)
	}
	exit := forward.waitExit(15 * time.Second)
	if exit.Outcome.Kind != protocol.OutcomeCode || exit.Outcome.Code != 0 {
		t.Fatalf("task.exit = %+v", exit)
	}
	if got := forward.stdout(); got != "approved\n" {
		t.Fatalf("stdout = %q", got)
	}
	// The approval was consumed: nothing is pending any more.
	entries, err = local.Pending(ctx)
	if err != nil || len(entries) != 0 {
		t.Fatalf("pending after approval = %+v, %v", entries, err)
	}
	// A second task.start for the same task id is refused as already accepted.
	expectRemoteCode(t, forward.start(ctx, ts), "already_accepted")
}

func TestLocalApprovalSpecChangeRefused(t *testing.T) {
	keys := newTestKeys(t)
	env := localEnv(t, keys)
	forward := dialForward(t, env.paths.Socket)
	ctx := requestContext(t)

	ts := execTask("local-2", 1, "/bin/echo", "approved")
	request := protocol.LocalRequest{TaskID: "local-2", Attempt: 1, Spec: ts.Spec}
	if _, err := forward.localRequest(ctx, request); err != nil {
		t.Fatalf("local.request: %v", err)
	}
	local, err := localclient.Dial(ctx, env.paths.Socket, "test")
	if err != nil {
		t.Fatalf("local dial: %v", err)
	}
	defer local.Close()
	if err := local.Approve(ctx, "local-2", 1, ""); err != nil {
		t.Fatalf("local.approve: %v", err)
	}
	forward.waitDecision(10 * time.Second)

	// The same task id and attempt with a different spec is not what was approved.
	changed := execTask("local-2", 1, "/bin/echo", "something-else")
	remote := expectRemoteCode(t, forward.start(ctx, changed), "authorization_rejected")
	if remote.Message == "" {
		t.Fatal("spec change refusal has no message")
	}
	// The approval is still there for the exact approved spec.
	if err := forward.start(ctx, ts); err != nil {
		t.Fatalf("approved task.start after refusal: %v", err)
	}
	if exit := forward.waitExit(15 * time.Second); exit.Outcome.Code != 0 {
		t.Fatalf("task.exit = %+v", exit)
	}
}

func TestLocalDeny(t *testing.T) {
	keys := newTestKeys(t)
	env := localEnv(t, keys)
	forward := dialForward(t, env.paths.Socket)
	ctx := requestContext(t)

	ts := execTask("local-3", 1, "/bin/echo", "denied")
	if _, err := forward.localRequest(ctx, protocol.LocalRequest{
		TaskID: "local-3", Attempt: 1, Spec: ts.Spec, Note: "no",
	}); err != nil {
		t.Fatalf("local.request: %v", err)
	}
	local, err := localclient.Dial(ctx, env.paths.Socket, "test")
	if err != nil {
		t.Fatalf("local dial: %v", err)
	}
	defer local.Close()
	if err := local.Deny(ctx, "local-3", 1, "not now"); err != nil {
		t.Fatalf("local.deny: %v", err)
	}
	decision := forward.waitDecision(10 * time.Second)
	if decision.State.Kind != protocol.LocalStateDenied || decision.State.Message != "not now" {
		t.Fatalf("local.decision = %+v", decision)
	}
	expectRemoteCode(t, forward.start(ctx, ts), "authorization_required")

	// A second, conflicting decision is refused.
	var remote *protocol.RemoteError
	if err := local.Approve(ctx, "local-3", 1, ""); err == nil || !errors.As(err, &remote) || remote.Code != "already_decided" {
		t.Fatalf("approve after deny = %v", err)
	}
}

func TestLocalWithdraw(t *testing.T) {
	keys := newTestKeys(t)
	env := localEnv(t, keys)
	forward := dialForward(t, env.paths.Socket)
	ctx := requestContext(t)

	ts := execTask("local-4", 1, "/bin/echo", "withdrawn")
	if _, err := forward.localRequest(ctx, protocol.LocalRequest{
		TaskID: "local-4", Attempt: 1, Spec: ts.Spec,
	}); err != nil {
		t.Fatalf("local.request: %v", err)
	}
	local, err := localclient.Dial(ctx, env.paths.Socket, "test")
	if err != nil {
		t.Fatal(err)
	}
	defer local.Close()
	if entries, _ := local.Pending(ctx); len(entries) != 1 {
		t.Fatalf("pending before withdraw = %+v", entries)
	}
	if err := forward.withdrawLocal(ctx, "local-4", 1); err != nil {
		t.Fatalf("local.withdraw: %v", err)
	}
	if entries, _ := local.Pending(ctx); len(entries) != 0 {
		t.Fatalf("pending after withdraw = %+v", entries)
	}
	// Approving a withdrawn request is unknown.
	var remote *protocol.RemoteError
	if err := local.Approve(ctx, "local-4", 1, ""); err == nil || !errors.As(err, &remote) || remote.Code != "unknown_task" {
		t.Fatalf("approve after withdraw = %v", err)
	}
}

// TestLocalRequestWithoutLocalEntry covers local_not_trusted: crhs asks for local approval on
// a node that has no local trust entry.
func TestLocalRequestWithoutLocalEntry(t *testing.T) {
	keys := newTestKeys(t)
	env := crhsOnlyEnv(t, keys)
	forward := dialForward(t, env.paths.Socket)
	ts := execTask("local-5", 1, "/bin/echo", "no")
	_, err := forward.localRequest(requestContext(t), protocol.LocalRequest{
		TaskID: "local-5", Attempt: 1, Spec: ts.Spec,
	})
	expectRemoteCode(t, err, "local_not_trusted")
}

// TestLocalRevoke covers the local role's revocations.add, the path of `crha privileged
// revoke`.
func TestLocalRevoke(t *testing.T) {
	keys := newTestKeys(t)
	uid := uint32(os.Getuid())
	env := newTestEnv(t, keys, func(p envPaths) string {
		return baseConfig(p, os.Getuid()) +
			sshTrust("crhs", "crhs", keys.crhsLine, `["execute"]`, "") +
			localTrust("local-admins", []uint32{uid}, "")
	})
	forward := dialForward(t, env.paths.Socket)
	ctx := requestContext(t)

	ts := execTask("revoke-local-1", 1, "/bin/echo", "revoked")
	payload := payloadFor("revoke-local-1", 1, exactCommand(t, &ts.Spec), nil)
	ts.Authorizations = [][]byte{authorize(t, payload, keys.crhs)}

	local, err := localclient.Dial(ctx, env.paths.Socket, "test")
	if err != nil {
		t.Fatalf("local dial: %v", err)
	}
	defer local.Close()
	if err := local.Revoke(ctx, payloadID(t, payload)); err != nil {
		t.Fatalf("local revoke: %v", err)
	}
	expectRemoteCode(t, forward.start(ctx, ts), "authorization_rejected")
	records := logRecords(t, env.paths.Log)
	found := false
	for _, record := range records {
		if record["event"] == "revocations.added" {
			found = true
		}
	}
	if !found {
		t.Fatalf("no revocations.added record in %v", records)
	}
}
