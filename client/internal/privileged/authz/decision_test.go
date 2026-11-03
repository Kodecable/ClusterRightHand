package authz

import (
	"strings"
	"testing"
	"time"

	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
)

func execSpec() *protocol.TaskSpec {
	return &protocol.TaskSpec{Kind: protocol.TaskSpecExec, Exec: &protocol.ExecSpec{
		Command: protocol.Command{Kind: protocol.CommandArgv, Argv: []string{"echo", "hi"}},
		Env:     map[string]string{},
	}}
}

func fileSpec(kind protocol.TaskSpecKind, path string) *protocol.TaskSpec {
	switch kind {
	case protocol.TaskSpecFileStat:
		return &protocol.TaskSpec{Kind: kind, FileStat: &protocol.FileStatSpec{Path: path}}
	case protocol.TaskSpecFileRead:
		return &protocol.TaskSpec{Kind: kind, FileRead: &protocol.FileReadSpec{Path: path}}
	default:
		panic("unsupported test spec")
	}
}

func testNow() time.Time { return time.UnixMilli(1_793_016_000_000) }

func TestDecideNoAuthorizationAndNoApproval(t *testing.T) {
	decision := Decide(Input{
		Now:    testNow(),
		NodeID: "n",
		Task:   Task{ID: "t", Attempt: 1, Spec: execSpec()},
	})
	if decision.Result != ResultRequired || decision.Step != StepSignatures {
		t.Fatalf("got %s, want %s at step %d", decision, ResultRequired, StepSignatures)
	}
}

// Step 2 runs before step 3, so an invalid privileged path is reported even without an
// authorization.
func TestDecidePathCheckPrecedesAuthorization(t *testing.T) {
	decision := Decide(Input{
		Now:    testNow(),
		NodeID: "n",
		Task:   Task{ID: "t", Attempt: 1, Spec: fileSpec(protocol.TaskSpecFileStat, "etc/hosts")},
	})
	if decision.Result != ResultRejected || decision.Step != StepTaskCheck {
		t.Fatalf("got %s, want %s at step %d", decision, ResultRejected, StepTaskCheck)
	}
}

func TestDecideLocalApproval(t *testing.T) {
	spec := execSpec()
	hash, err := protocol.SpecSHA256(spec)
	if err != nil {
		t.Fatalf("SpecSHA256: %v", err)
	}
	ttl := 5 * time.Minute
	base := Input{
		Now:           testNow(),
		NodeID:        "n",
		Task:          Task{ID: "t", Attempt: 1, Spec: spec},
		LocalApproval: &LocalApproval{UID: 1000, SpecSHA256: hash},
		Trust: []Entry{{
			Name:     "local-admins",
			Role:     protocol.TrustRoleLocal,
			Kinds:    []protocol.TrustKind{protocol.TrustKindExecute},
			MaxTTL:   &ttl,
			EnvAllow: []string{},
			UIDs:     []uint32{1000},
		}},
	}

	t.Run("approved", func(t *testing.T) {
		decision := Decide(base)
		if decision.Result != ResultAccepted || decision.Entry != "local-admins" {
			t.Fatalf("got %s, want accepted by local-admins", decision)
		}
	})

	t.Run("uid not trusted", func(t *testing.T) {
		input := base
		input.LocalApproval = &LocalApproval{UID: 1001, SpecSHA256: hash}
		decision := Decide(input)
		if decision.Result != ResultRequired || decision.Step != StepSignatures {
			t.Fatalf("got %s, want %s at step %d", decision, ResultRequired, StepSignatures)
		}
	})

	t.Run("spec changed", func(t *testing.T) {
		input := base
		input.LocalApproval = &LocalApproval{UID: 1000, SpecSHA256: [32]byte{}}
		decision := Decide(input)
		if decision.Result != ResultRejected || decision.Step != StepCommand {
			t.Fatalf("got %s, want %s at step %d", decision, ResultRejected, StepCommand)
		}
	})

	t.Run("without execute", func(t *testing.T) {
		input := base
		input.Trust = []Entry{{
			Name: "local-admins", Role: protocol.TrustRoleLocal, UIDs: []uint32{1000},
		}}
		decision := Decide(input)
		if decision.Result != ResultRejected || decision.Step != StepTrust {
			t.Fatalf("got %s, want %s at step %d", decision, ResultRejected, StepTrust)
		}
	})

	t.Run("environment rejected", func(t *testing.T) {
		input := base
		input.Task.Spec = &protocol.TaskSpec{Kind: protocol.TaskSpecExec, Exec: &protocol.ExecSpec{
			Command: protocol.Command{Kind: protocol.CommandArgv, Argv: []string{"env"}},
			Env:     map[string]string{"LD_PRELOAD": "/tmp/x.so"},
		}}
		changed, err := protocol.SpecSHA256(input.Task.Spec)
		if err != nil {
			t.Fatalf("SpecSHA256: %v", err)
		}
		input.LocalApproval = &LocalApproval{UID: 1000, SpecSHA256: changed}
		decision := Decide(input)
		if decision.Result != ResultRejected || decision.Step != StepTrust {
			t.Fatalf("got %s, want %s at step %d", decision, ResultRejected, StepTrust)
		}
	})
}

func testAuthorization(t *testing.T, now time.Time, taskID string, attempt uint64) *Authorization {
	t.Helper()
	deadline := protocol.Int(now.Add(time.Minute).UnixMilli())
	taskIDs := []string{taskID}
	attemptValue := protocol.Uint(attempt)
	payload := &protocol.AuthorizationPayload{
		V:          protocol.AuthPayloadVersion,
		Nodes:      []string{"n"},
		IssuedAtMS: protocol.Int(now.UnixMilli()),
		DeadlineMS: &deadline,
		TaskIDs:    &taskIDs,
		Attempt:    &attemptValue,
		Note:       "",
	}
	payloadBytes, err := protocol.Marshal(payload)
	if err != nil {
		t.Fatalf("encode payload: %v", err)
	}
	return &Authorization{Payload: payloadBytes, Decoded: payload}
}

func TestDecideInvalidSignatureInvalidatesWholeAuthorization(t *testing.T) {
	now := testNow()
	valid := Entry{Name: "alice", Role: protocol.TrustRoleUser, Kinds: []protocol.TrustKind{protocol.TrustKindExecute}}
	broken := Entry{Name: "bob", Role: protocol.TrustRoleUser, Kinds: []protocol.TrustKind{protocol.TrustKindExecute}}
	auth := testAuthorization(t, now, "t", 1)

	for _, test := range []struct {
		name       string
		signatures []Signature
	}{
		{"invalid first", []Signature{{Entry: &broken, Valid: false}, {Entry: &valid, Valid: true}}},
		{"invalid second", []Signature{{Entry: &valid, Valid: true}, {Entry: &broken, Valid: false}}},
	} {
		t.Run(test.name, func(t *testing.T) {
			auth.Signatures = test.signatures
			decision := Decide(Input{
				Now:           now,
				NodeID:        "n",
				Trust:         []Entry{valid, broken},
				Task:          Task{ID: "t", Attempt: 1, Spec: execSpec()},
				Authorization: auth,
			})
			if decision.Result != ResultInvalid || decision.Step != StepSignatures {
				t.Fatalf("got %s, want %s at step %d", decision, ResultInvalid, StepSignatures)
			}
		})
	}
}

func TestDecideIgnoresUntrustedSignature(t *testing.T) {
	now := testNow()
	alice := Entry{Name: "alice", Role: protocol.TrustRoleUser, Kinds: []protocol.TrustKind{protocol.TrustKindExecute}}
	auth := testAuthorization(t, now, "t", 1)
	auth.Signatures = []Signature{{Entry: nil, Valid: false}, {Entry: &alice, Valid: true}}
	decision := Decide(Input{
		Now:           now,
		NodeID:        "n",
		Trust:         []Entry{alice},
		Task:          Task{ID: "t", Attempt: 1, Spec: execSpec()},
		Authorization: auth,
	})
	if decision.Result != ResultAccepted || decision.Entry != "alice" {
		t.Fatalf("got %s, want accepted by alice", decision)
	}
}

// A cosignature is a single confirmation: an authorization that requires one must be
// one-shot, even when every signature verifies.
func TestDecideCosignRequiresTaskIDs(t *testing.T) {
	now := testNow()
	user := Entry{
		Name:  "alice",
		Role:  protocol.TrustRoleUser,
		Kinds: []protocol.TrustKind{protocol.TrustKindExecute, protocol.TrustKindRequireCosign},
	}
	cosign := Entry{Name: "crhs", Role: protocol.TrustRoleCRHS, Kinds: []protocol.TrustKind{protocol.TrustKindCosign}}
	deadline := protocol.Int(now.Add(time.Hour).UnixMilli())
	payload := &protocol.AuthorizationPayload{
		V:          protocol.AuthPayloadVersion,
		Nodes:      []string{"n"},
		IssuedAtMS: protocol.Int(now.UnixMilli()),
		DeadlineMS: &deadline,
		Note:       "",
	}
	payloadBytes, err := protocol.Marshal(payload)
	if err != nil {
		t.Fatalf("encode payload: %v", err)
	}
	auth := &Authorization{
		Payload: payloadBytes,
		Decoded: payload,
		Signatures: []Signature{
			{Entry: &user, Valid: true},
			{Entry: &cosign, Valid: true},
		},
	}
	decision := Decide(Input{
		Now:           now,
		NodeID:        "n",
		Trust:         []Entry{user, cosign},
		Task:          Task{ID: "t", Attempt: 1, Spec: execSpec()},
		Authorization: auth,
	})
	if decision.Result != ResultRejected || decision.Step != StepOneShot {
		t.Fatalf("got %s, want %s at step %d", decision, ResultRejected, StepOneShot)
	}
}

func TestDecideRejectsInconsistentPayload(t *testing.T) {
	now := testNow()
	alice := Entry{Name: "alice", Role: protocol.TrustRoleUser, Kinds: []protocol.TrustKind{protocol.TrustKindExecute}}

	t.Run("malformed payload", func(t *testing.T) {
		auth := testAuthorization(t, now, "t", 1)
		auth.Payload = []byte{0x80}
		decision := Decide(Input{
			Now:           now,
			NodeID:        "n",
			Trust:         []Entry{alice},
			Task:          Task{ID: "t", Attempt: 1, Spec: execSpec()},
			Authorization: auth,
		})
		if decision.Result != ResultInvalid || decision.Step != StepSignatures {
			t.Fatalf("got %s, want %s at step %d", decision, ResultInvalid, StepSignatures)
		}
	})

	t.Run("decoded form differs", func(t *testing.T) {
		auth := testAuthorization(t, now, "t", 1)
		auth.Decoded.Nodes = []string{"other-node"}
		auth.Signatures = []Signature{{Entry: &alice, Valid: true}}
		decision := Decide(Input{
			Now:           now,
			NodeID:        "n",
			Trust:         []Entry{alice},
			Task:          Task{ID: "t", Attempt: 1, Spec: execSpec()},
			Authorization: auth,
		})
		if decision.Result != ResultInvalid || decision.Step != StepSignatures {
			t.Fatalf("got %s, want %s at step %d", decision, ResultInvalid, StepSignatures)
		}
	})
}

func TestDecideNoCandidate(t *testing.T) {
	now := testNow()
	local := Entry{Name: "local", Role: protocol.TrustRoleLocal, UIDs: []uint32{1000}}
	auth := testAuthorization(t, now, "t", 1)
	auth.Signatures = []Signature{{Entry: &local, Valid: true}}
	decision := Decide(Input{
		Now:           now,
		NodeID:        "n",
		Trust:         []Entry{local},
		Task:          Task{ID: "t", Attempt: 1, Spec: execSpec()},
		Authorization: auth,
	})
	if decision.Result != ResultInvalid || decision.Step != StepSignatures {
		t.Fatalf("got %s, want %s at step %d", decision, ResultInvalid, StepSignatures)
	}
}

// Every authorization must carry a deadline, for every trust role: without one, the
// privileged mode would have to trust the used record forever. Step 4 is the authorization
// body check, the same step and result the max_ttl path uses.
func TestDecideRequiresDeadline(t *testing.T) {
	now := testNow()
	for _, role := range []protocol.TrustRole{protocol.TrustRoleCRHS, protocol.TrustRoleUser} {
		t.Run(string(role), func(t *testing.T) {
			entry := Entry{Name: "signer", Role: role, Kinds: []protocol.TrustKind{protocol.TrustKindExecute}}
			payload := &protocol.AuthorizationPayload{
				V:          protocol.AuthPayloadVersion,
				Nodes:      []string{"n"},
				IssuedAtMS: protocol.Int(now.UnixMilli()),
			}
			raw, err := protocol.Marshal(payload)
			if err != nil {
				t.Fatalf("encode payload: %v", err)
			}
			auth := &Authorization{
				Payload:    raw,
				Decoded:    payload,
				Signatures: []Signature{{Entry: &entry, Valid: true}},
			}
			decision := Decide(Input{
				Now:           now,
				NodeID:        "n",
				Trust:         []Entry{entry},
				Task:          Task{ID: "t", Attempt: 1, Spec: execSpec()},
				Authorization: auth,
			})
			if decision.Result != ResultExpired || decision.Step != StepAuthorization {
				t.Fatalf("got %s, want %s at step %d", decision, ResultExpired, StepAuthorization)
			}
			if !strings.Contains(decision.Message, "no deadline") {
				t.Fatalf("message = %q, want a missing-deadline explanation", decision.Message)
			}
		})
	}
}

// The used-list watermark is checked next to the one-shot checks: an authorization issued at
// or before it may have lost its used pair and must be signed again.
func TestDecideRejectsWatermarkedAuthorization(t *testing.T) {
	now := testNow()
	alice := Entry{Name: "alice", Role: protocol.TrustRoleUser, Kinds: []protocol.TrustKind{protocol.TrustKindExecute}}
	auth := testAuthorization(t, now, "t", 1)
	auth.Signatures = []Signature{{Entry: &alice, Valid: true}}
	input := Input{
		Now:           now,
		NodeID:        "n",
		Trust:         []Entry{alice},
		Task:          Task{ID: "t", Attempt: 1, Spec: execSpec()},
		Authorization: auth,
		Watermarked:   func(issuedAtMS int64) bool { return issuedAtMS <= now.UnixMilli() },
	}
	decision := Decide(input)
	if decision.Result != ResultRejected || decision.Step != StepOneShot {
		t.Fatalf("got %s, want %s at step %d", decision, ResultRejected, StepOneShot)
	}
	if !strings.Contains(decision.Message, "watermark") {
		t.Fatalf("message = %q, want a watermark explanation", decision.Message)
	}

	// An authorization newer than the watermark still passes.
	input.Watermarked = func(issuedAtMS int64) bool {
		return issuedAtMS <= now.Add(-2*time.Minute).UnixMilli()
	}
	if decision := Decide(input); decision.Result != ResultAccepted || decision.Entry != "alice" {
		t.Fatalf("got %s, want accepted by alice", decision)
	}

	// The task id check keeps precedence: an already executed task is still already_accepted.
	input.Executed = func(string) bool { return true }
	if decision := Decide(input); decision.Result != ResultAlreadyAccepted {
		t.Fatalf("got %s, want %s", decision, ResultAlreadyAccepted)
	}
}

func TestMethodCovers(t *testing.T) {
	if !methodCovers("file.write", "file.read") {
		t.Fatal("file.write should cover file.read")
	}
	if methodCovers("file.read", "file.write") {
		t.Fatal("file.read must not cover file.write")
	}
	if !methodCovers("exec", "exec") {
		t.Fatal("exec should cover exec")
	}
	if methodCovers("exec", "file.read") {
		t.Fatal("exec must not cover file.read")
	}
}

func TestAddressedTo(t *testing.T) {
	node := "01JB0000000000000000000001"
	groups := []string{"web", "prod"}
	tests := []struct {
		nodes []string
		want  bool
	}{
		{[]string{node}, true},
		{[]string{"*"}, true},
		{[]string{"group:web"}, true},
		{[]string{"01JB0000000000000000000002"}, false},
		{[]string{"group:db"}, false},
		{[]string{"web"}, false},
		{nil, false},
	}
	for _, test := range tests {
		if got := addressedTo(test.nodes, node, groups); got != test.want {
			t.Errorf("addressedTo(%v) = %v, want %v", test.nodes, got, test.want)
		}
	}
}
