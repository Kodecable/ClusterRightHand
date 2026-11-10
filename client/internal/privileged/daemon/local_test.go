package daemon

import (
	"errors"
	"fmt"
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
	request := protocol.LocalRequest{
		TaskID: "local-1", Attempt: 1, Spec: ts.Spec, Note: "please run",
		InputPreview: []byte("echo approved\n"),
	}
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
	if got := string(entries[0].InputPreview); got != "echo approved\n" {
		t.Fatalf("input preview = %q", got)
	}
	method, target, err := authz.Target(&entries[0].Spec)
	if err != nil || method != "exec" || target != "/bin/echo approved" {
		t.Fatalf("pending target = %s %q, %v", method, target, err)
	}

	if err := local.Approve(ctx, "local-1", 1, specHash(t, &ts.Spec), ""); err != nil {
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
	if got := forward.output(); got != "approved\n" {
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
	if err := local.Approve(ctx, "local-2", 1, specHash(t, &ts.Spec), ""); err != nil {
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
	if err := local.Deny(ctx, "local-3", 1, specHash(t, &ts.Spec), "not now"); err != nil {
		t.Fatalf("local.deny: %v", err)
	}
	decision := forward.waitDecision(10 * time.Second)
	if decision.State.Kind != protocol.LocalStateDenied || decision.State.Message != "not now" {
		t.Fatalf("local.decision = %+v", decision)
	}
	expectRemoteCode(t, forward.start(ctx, ts), "authorization_required")

	// A second, conflicting decision is refused.
	var remote *protocol.RemoteError
	if err := local.Approve(ctx, "local-3", 1, specHash(t, &ts.Spec), ""); err == nil || !errors.As(err, &remote) || remote.Code != "already_decided" {
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
	if err := local.Approve(ctx, "local-4", 1, specHash(t, &ts.Spec), ""); err == nil || !errors.As(err, &remote) || remote.Code != "unknown_task" {
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

// TestLocalApprovalSwappedSpecRefused covers the binding between a local verdict and the spec
// the approver saw: after crhs withdraws the request and asks again with a different spec, the
// approval that carries the old hash is refused (doc/design/privilege.md "Local approval").
func TestLocalApprovalSwappedSpecRefused(t *testing.T) {
	keys := newTestKeys(t)
	env := localEnv(t, keys)
	forward := dialForward(t, env.paths.Socket)
	ctx := requestContext(t)

	shown := execTask("local-swap", 1, "/bin/echo", "shown")
	if _, err := forward.localRequest(ctx, protocol.LocalRequest{
		TaskID: "local-swap", Attempt: 1, Spec: shown.Spec,
	}); err != nil {
		t.Fatalf("local.request: %v", err)
	}
	local, err := localclient.Dial(ctx, env.paths.Socket, "test")
	if err != nil {
		t.Fatalf("local dial: %v", err)
	}
	defer local.Close()
	entries, err := local.Pending(ctx)
	if err != nil || len(entries) != 1 {
		t.Fatalf("pending.list = %+v, %v", entries, err)
	}
	shownHash, err := protocol.SpecSHA256(&entries[0].Spec)
	if err != nil {
		t.Fatal(err)
	}

	// The task is re-planned: the request is withdrawn and the same key asks for another spec.
	if err := forward.withdrawLocal(ctx, "local-swap", 1); err != nil {
		t.Fatalf("local.withdraw: %v", err)
	}
	swapped := execTask("local-swap", 1, "/bin/echo", "swapped")
	if _, err := forward.localRequest(ctx, protocol.LocalRequest{
		TaskID: "local-swap", Attempt: 1, Spec: swapped.Spec,
	}); err != nil {
		t.Fatalf("second local.request: %v", err)
	}
	// The hash of the spec that was shown no longer matches the pending record.
	remote := expectRemoteCode(t, local.Approve(ctx, "local-swap", 1, shownHash, ""), "invalid_spec")
	if remote.Message == "" {
		t.Fatal("the refusal has no message")
	}
	// Nothing was approved: the task cannot run yet.
	expectRemoteCode(t, forward.start(ctx, swapped), "authorization_required")
	// The hash of the pending spec is accepted, and the approval covers exactly that spec.
	if err := local.Approve(ctx, "local-swap", 1, specHash(t, &swapped.Spec), ""); err != nil {
		t.Fatalf("local.approve with the current hash: %v", err)
	}
	decision := forward.waitDecision(10 * time.Second)
	if decision.State.Kind != protocol.LocalStateApproved {
		t.Fatalf("local.decision = %+v", decision)
	}
	expectRemoteCode(t, forward.start(ctx, shown), "authorization_rejected")
	if err := forward.start(ctx, swapped); err != nil {
		t.Fatalf("task.start of the approved spec: %v", err)
	}
	if exit := forward.waitExit(15 * time.Second); exit.Outcome.Kind != protocol.OutcomeCode || exit.Outcome.Code != 0 {
		t.Fatalf("task.exit = %+v", exit)
	}
}

// TestLocalDenySwappedSpecRefused covers the same binding on the deny path.
func TestLocalDenySwappedSpecRefused(t *testing.T) {
	keys := newTestKeys(t)
	env := localEnv(t, keys)
	forward := dialForward(t, env.paths.Socket)
	ctx := requestContext(t)

	shown := execTask("local-deny-swap", 1, "/bin/echo", "shown")
	if _, err := forward.localRequest(ctx, protocol.LocalRequest{
		TaskID: "local-deny-swap", Attempt: 1, Spec: shown.Spec,
	}); err != nil {
		t.Fatalf("local.request: %v", err)
	}
	local, err := localclient.Dial(ctx, env.paths.Socket, "test")
	if err != nil {
		t.Fatalf("local dial: %v", err)
	}
	defer local.Close()
	shownHash, err := protocol.SpecSHA256(&shown.Spec)
	if err != nil {
		t.Fatal(err)
	}
	if err := forward.withdrawLocal(ctx, "local-deny-swap", 1); err != nil {
		t.Fatalf("local.withdraw: %v", err)
	}
	swapped := execTask("local-deny-swap", 1, "/bin/echo", "swapped")
	if _, err := forward.localRequest(ctx, protocol.LocalRequest{
		TaskID: "local-deny-swap", Attempt: 1, Spec: swapped.Spec,
	}); err != nil {
		t.Fatalf("second local.request: %v", err)
	}
	expectRemoteCode(t, local.Deny(ctx, "local-deny-swap", 1, shownHash, "no"), "invalid_spec")
	if err := local.Deny(ctx, "local-deny-swap", 1, specHash(t, &swapped.Spec), "not today"); err != nil {
		t.Fatalf("local.deny with the current hash: %v", err)
	}
	decision := forward.waitDecision(10 * time.Second)
	if decision.State.Kind != protocol.LocalStateDenied || decision.State.Message != "not today" {
		t.Fatalf("local.decision = %+v", decision)
	}
	expectRemoteCode(t, forward.start(ctx, swapped), "authorization_required")
}

// TestLocalApprovalCap bounds the pending and approved requests a compromised crhs can make:
// beyond the cap a new local.request is refused, and a decided record frees a slot.
func TestLocalApprovalCap(t *testing.T) {
	keys := newTestKeys(t)
	env := localEnv(t, keys)
	server := env.server
	spec := execTask("over-cap", 1, "/bin/echo", "over").Spec
	hash, err := protocol.SpecSHA256(&spec)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	server.approvalMu.Lock()
	for i := 0; i < maxApprovals; i++ {
		key := approvalKey{taskID: fmt.Sprintf("fill-%d", i), attempt: 1}
		server.approvals[key] = &approval{
			localRequest: localRequest{taskID: key.taskID, attempt: 1, spec: spec, specHash: hash, receivedAt: now},
			state:        protocol.LocalState{Kind: protocol.LocalStatePending},
		}
	}
	server.approvalMu.Unlock()

	_, refusal := server.requestLocal(&protocol.LocalRequest{TaskID: "over-cap", Attempt: 1, Spec: spec})
	if refusal == nil || refusal.Code != "privileged_unavailable" {
		t.Fatalf("local.request at the cap = %+v, want privileged_unavailable", refusal)
	}
	// A repeated request for a key that is already pending stays idempotent.
	if _, refusal := server.requestLocal(&protocol.LocalRequest{TaskID: "fill-0", Attempt: 1, Spec: spec}); refusal != nil {
		t.Fatalf("repeated local.request at the cap = %+v", refusal)
	}
	// A denied record is no live approval; it must not keep the cap full.
	server.approvalMu.Lock()
	server.approvals[approvalKey{taskID: "fill-0", attempt: 1}].state = protocol.LocalState{Kind: protocol.LocalStateDenied}
	server.approvalMu.Unlock()
	state, refusal := server.requestLocal(&protocol.LocalRequest{TaskID: "over-cap", Attempt: 1, Spec: spec})
	if refusal != nil || state.Kind != protocol.LocalStatePending {
		t.Fatalf("local.request after a denial = %+v, %+v", state, refusal)
	}
}

// specHash computes the spec hash a local approval is bound to, exactly as the daemon does.
func specHash(t *testing.T, spec *protocol.TaskSpec) [32]byte {
	t.Helper()
	hash, err := protocol.SpecSHA256(spec)
	if err != nil {
		t.Fatalf("spec hash: %v", err)
	}
	return hash
}
