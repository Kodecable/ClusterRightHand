package authz

import (
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
)

// ---------------------------------------------------------------------------
// Fixture shapes (test/interop/m4_authz_cases.json)
// ---------------------------------------------------------------------------

type jsonInputRef struct {
	Size   uint64 `json:"size"`
	SHA256 string `json:"sha256"`
}

type jsonCommand struct {
	Argv  *[]string `json:"argv"`
	Shell *string   `json:"shell"`
}

type jsonEdit struct {
	OldText string `json:"oldText"`
	NewText string `json:"newText"`
}

type jsonSpec struct {
	Kind      string            `json:"kind"`
	Command   *jsonCommand      `json:"command"`
	Env       map[string]string `json:"env"`
	Cwd       string            `json:"cwd"`
	Stdin     *jsonInputRef     `json:"stdin"`
	Path      string            `json:"path"`
	Offset    uint64            `json:"offset"`
	Limit     uint64            `json:"limit"`
	Content   *jsonInputRef     `json:"content"`
	Overwrite bool              `json:"overwrite"`
	Mode      uint64            `json:"mode"`
	Owner     string            `json:"owner"`
	Group     string            `json:"group"`
	Edits     []jsonEdit        `json:"edits"`
}

type jsonRule struct {
	Method  string `json:"method"`
	Match   string `json:"match"`
	Pattern string `json:"pattern"`
}

type jsonEntry struct {
	Name         string     `json:"name"`
	Role         string     `json:"role"`
	Kinds        []string   `json:"kinds"`
	RequireExact bool       `json:"require_exact"`
	RequireTask  bool       `json:"require_task"`
	RequireUV    bool       `json:"require_uv"`
	MaxTTLMS     *int64     `json:"max_ttl_ms"`
	Allow        []jsonRule `json:"allow"`
	Deny         []jsonRule `json:"deny"`
	EnvAllow     []string   `json:"env_allow"`
	UIDs         []uint32   `json:"uids"`
}

type jsonAuthCommand struct {
	Method     string  `json:"method"`
	Exact      *string `json:"exact"`
	Prefix     *string `json:"prefix"`
	SpecSHA256 *string `json:"spec_sha256"`
}

type jsonPayload struct {
	Nodes      []string         `json:"nodes"`
	Command    *jsonAuthCommand `json:"command"`
	IssuedAtMS int64            `json:"issued_at_ms"`
	DeadlineMS *int64           `json:"deadline_ms"`
	TaskIDs    *[]string        `json:"task_ids"`
	Attempt    *uint64          `json:"attempt"`
}

type jsonSignature struct {
	Entry string `json:"entry"`
	Valid bool   `json:"valid"`
	UV    bool   `json:"uv"`
}

type jsonAuthorization struct {
	Payload    jsonPayload     `json:"payload"`
	Signatures []jsonSignature `json:"signatures"`
	Revoked    bool            `json:"revoked"`
}

type jsonLocalApproval struct {
	UID        uint32 `json:"uid"`
	SpecSHA256 string `json:"spec_sha256"`
}

type jsonCase struct {
	ID          string `json:"id"`
	Description string `json:"description"`
	NowMS       int64  `json:"now_ms"`
	ClockSkewMS int64  `json:"clock_skew_ms"`
	Node        struct {
		ID     string   `json:"id"`
		Groups []string `json:"groups"`
	} `json:"node"`
	Trust []jsonEntry `json:"trust"`
	Task  struct {
		TaskID  string   `json:"task_id"`
		Attempt uint64   `json:"attempt"`
		Spec    jsonSpec `json:"spec"`
	} `json:"task"`
	Authorization   *jsonAuthorization `json:"authorization"`
	LocalApproval   *jsonLocalApproval `json:"local_approval"`
	ExecutedTaskIDs []string           `json:"executed_task_ids"`
	UsedPairs       []string           `json:"used_pairs"`
	Expect          struct {
		Result string `json:"result"`
		Step   *int   `json:"step"`
	} `json:"expect"`
}

type authzFixture struct {
	Comment string `json:"comment"`
	Targets []struct {
		Spec   jsonSpec `json:"spec"`
		Method string   `json:"method"`
		Target string   `json:"target"`
	} `json:"targets"`
	Cases []jsonCase `json:"cases"`
}

func readAuthzFixture(t *testing.T) *authzFixture {
	t.Helper()
	path := filepath.Join("..", "..", "..", "..", "test", "interop", "m4_authz_cases.json")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	var fixture authzFixture
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatalf("parse %s: %v", path, err)
	}
	return &fixture
}

func mustHex32(t *testing.T, value string) protocol.Hash {
	t.Helper()
	raw, err := hex.DecodeString(value)
	if err != nil || len(raw) != 32 {
		t.Fatalf("not a 32-byte hex digest: %q (%v)", value, err)
	}
	var hash protocol.Hash
	copy(hash[:], raw)
	return hash
}

func inputRef(t *testing.T, ref *jsonInputRef) *protocol.InputRef {
	t.Helper()
	if ref == nil {
		return nil
	}
	return &protocol.InputRef{Size: protocol.Uint(ref.Size), SHA256: mustHex32(t, ref.SHA256)}
}

func taskSpecFromJSON(t *testing.T, spec jsonSpec) *protocol.TaskSpec {
	t.Helper()
	switch spec.Kind {
	case "exec":
		if spec.Command == nil {
			t.Fatalf("exec spec has no command")
		}
		var command protocol.Command
		switch {
		case spec.Command.Argv != nil && spec.Command.Shell == nil:
			command = protocol.Command{Kind: protocol.CommandArgv, Argv: *spec.Command.Argv}
		case spec.Command.Shell != nil && spec.Command.Argv == nil:
			command = protocol.Command{Kind: protocol.CommandShell, Shell: *spec.Command.Shell}
		default:
			t.Fatalf("exec spec needs exactly one of argv or shell")
		}
		env := spec.Env
		if env == nil {
			env = map[string]string{}
		}
		return &protocol.TaskSpec{Kind: protocol.TaskSpecExec, Exec: &protocol.ExecSpec{
			Command: command,
			Env:     env,
			Cwd:     spec.Cwd,
			Stdin:   inputRef(t, spec.Stdin),
		}}
	case "file.read":
		return &protocol.TaskSpec{Kind: protocol.TaskSpecFileRead, FileRead: &protocol.FileReadSpec{
			Path: spec.Path, Offset: protocol.Uint(spec.Offset), Limit: protocol.Uint(spec.Limit),
		}}
	case "file.write":
		if spec.Content == nil {
			t.Fatalf("file.write spec has no content")
		}
		return &protocol.TaskSpec{Kind: protocol.TaskSpecFileWrite, FileWrite: &protocol.FileWriteSpec{
			Path:      spec.Path,
			Content:   *inputRef(t, spec.Content),
			Overwrite: spec.Overwrite,
			Mode:      protocol.Uint(spec.Mode),
			Owner:     spec.Owner,
			Group:     spec.Group,
		}}
	case "file.edit":
		edits := make([]protocol.Edit, len(spec.Edits))
		for i, edit := range spec.Edits {
			edits[i] = protocol.Edit{OldText: edit.OldText, NewText: edit.NewText}
		}
		return &protocol.TaskSpec{Kind: protocol.TaskSpecFileEdit, FileEdit: &protocol.FileEditSpec{
			Path: spec.Path, Edits: edits,
		}}
	case "file.stat":
		return &protocol.TaskSpec{Kind: protocol.TaskSpecFileStat, FileStat: &protocol.FileStatSpec{Path: spec.Path}}
	case "file.list":
		return &protocol.TaskSpec{Kind: protocol.TaskSpecFileList, FileList: &protocol.FileListSpec{
			Path: spec.Path, Limit: protocol.Uint(spec.Limit),
		}}
	default:
		t.Fatalf("unknown task spec kind %q", spec.Kind)
		return nil
	}
}

func trustEntries(t *testing.T, raw []jsonEntry) []Entry {
	t.Helper()
	entries := make([]Entry, len(raw))
	for i, source := range raw {
		entry := Entry{
			Name:         source.Name,
			Role:         protocol.TrustRole(source.Role),
			RequireExact: source.RequireExact,
			RequireTask:  source.RequireTask,
			RequireUV:    source.RequireUV,
			EnvAllow:     source.EnvAllow,
			UIDs:         source.UIDs,
		}
		for _, kind := range source.Kinds {
			entry.Kinds = append(entry.Kinds, protocol.TrustKind(kind))
		}
		for _, rule := range source.Allow {
			entry.Allow = append(entry.Allow, protocol.GuardRule{
				Method: protocol.Method(rule.Method), Match: protocol.GuardMatch(rule.Match), Pattern: rule.Pattern,
			})
		}
		for _, rule := range source.Deny {
			entry.Deny = append(entry.Deny, protocol.GuardRule{
				Method: protocol.Method(rule.Method), Match: protocol.GuardMatch(rule.Match), Pattern: rule.Pattern,
			})
		}
		if source.MaxTTLMS != nil {
			ttl := time.Duration(*source.MaxTTLMS) * time.Millisecond
			entry.MaxTTL = &ttl
		}
		entries[i] = entry
	}
	return entries
}

func authCommand(t *testing.T, raw *jsonAuthCommand) *protocol.AuthCommand {
	t.Helper()
	if raw == nil {
		return nil
	}
	command := &protocol.AuthCommand{Method: protocol.Method(raw.Method)}
	switch {
	case raw.Exact != nil && raw.Prefix == nil:
		if raw.SpecSHA256 == nil {
			t.Fatalf("exact auth command has no spec_sha256")
		}
		command.Match = protocol.AuthMatch{Kind: protocol.AuthMatchExact, Exact: &protocol.AuthExact{
			Target: *raw.Exact, SpecSHA256: mustHex32(t, *raw.SpecSHA256),
		}}
	case raw.Prefix != nil && raw.Exact == nil:
		command.Match = protocol.AuthMatch{Kind: protocol.AuthMatchPrefix, Prefix: &protocol.AuthPrefix{
			Target: *raw.Prefix,
		}}
	default:
		t.Fatalf("auth command needs exactly one of exact or prefix")
	}
	return command
}

func authorizationPayload(t *testing.T, raw jsonPayload) *protocol.AuthorizationPayload {
	t.Helper()
	payload := &protocol.AuthorizationPayload{
		V:          protocol.AuthPayloadVersion,
		Nodes:      raw.Nodes,
		Command:    authCommand(t, raw.Command),
		IssuedAtMS: protocol.Int(raw.IssuedAtMS),
	}
	if raw.DeadlineMS != nil {
		deadline := protocol.Int(*raw.DeadlineMS)
		payload.DeadlineMS = &deadline
	}
	if raw.TaskIDs != nil {
		taskIDs := *raw.TaskIDs
		payload.TaskIDs = &taskIDs
	}
	if raw.Attempt != nil {
		attempt := protocol.Uint(*raw.Attempt)
		payload.Attempt = &attempt
	}
	return payload
}

// buildInput converts one fixture case into a Decide input.
func buildInput(t *testing.T, testCase *jsonCase) Input {
	t.Helper()
	trust := trustEntries(t, testCase.Trust)
	byName := make(map[string]*Entry, len(trust))
	for i := range trust {
		byName[trust[i].Name] = &trust[i]
	}
	input := Input{
		Now:        time.UnixMilli(testCase.NowMS),
		ClockSkew:  time.Duration(testCase.ClockSkewMS) * time.Millisecond,
		NodeID:     testCase.Node.ID,
		NodeGroups: testCase.Node.Groups,
		Trust:      trust,
		Task: Task{
			ID:      testCase.Task.TaskID,
			Attempt: testCase.Task.Attempt,
			Spec:    taskSpecFromJSON(t, testCase.Task.Spec),
		},
		Executed: func(taskID string) bool { return slices.Contains(testCase.ExecutedTaskIDs, taskID) },
		Used: func(_ [32]byte, taskID string) bool {
			return slices.Contains(testCase.UsedPairs, taskID)
		},
	}
	if testCase.Authorization != nil {
		payload := authorizationPayload(t, testCase.Authorization.Payload)
		payloadBytes, err := protocol.Marshal(payload)
		if err != nil {
			t.Fatalf("encode payload: %v", err)
		}
		authorization := &Authorization{Payload: payloadBytes, Decoded: payload}
		for _, signature := range testCase.Authorization.Signatures {
			authorization.Signatures = append(authorization.Signatures, Signature{
				Entry:        byName[signature.Entry],
				Valid:        signature.Valid,
				UserVerified: signature.UV,
			})
		}
		revoked := testCase.Authorization.Revoked
		input.Revoked = func([32]byte) bool { return revoked }
		input.Authorization = authorization
	}
	if testCase.LocalApproval != nil {
		input.LocalApproval = &LocalApproval{
			UID:        testCase.LocalApproval.UID,
			SpecSHA256: mustHex32(t, testCase.LocalApproval.SpecSHA256),
		}
	}
	return input
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

func TestAuthzCasesFixture(t *testing.T) {
	fixture := readAuthzFixture(t)
	if len(fixture.Cases) == 0 {
		t.Fatal("fixture has no cases")
	}
	for i := range fixture.Cases {
		testCase := &fixture.Cases[i]
		t.Run(testCase.ID, func(t *testing.T) {
			input := buildInput(t, testCase)
			decision := Decide(input)
			if got := string(decision.Result); got != testCase.Expect.Result {
				t.Fatalf("result = %q (%s), want %q; description: %s",
					got, decision, testCase.Expect.Result, testCase.Description)
			}
			if testCase.Expect.Step == nil {
				if decision.Step != 0 {
					t.Fatalf("step = %d, want none (accepted)", decision.Step)
				}
			} else if decision.Step != *testCase.Expect.Step {
				t.Fatalf("step = %d, want %d; description: %s", decision.Step, *testCase.Expect.Step, testCase.Description)
			}
			if decision.Result == ResultAccepted {
				if decision.Entry == "" {
					t.Fatal("accepted without an accepting trust entry")
				}
				if _, ok := lookupEntry(input.Trust, decision.Entry); !ok {
					t.Fatalf("accepting entry %q is not in the trust config", decision.Entry)
				}
			} else if decision.Entry != "" {
				t.Fatalf("rejected decision names entry %q", decision.Entry)
			}
		})
	}
}

func lookupEntry(trust []Entry, name string) (*Entry, bool) {
	for i := range trust {
		if trust[i].Name == name {
			return &trust[i], true
		}
	}
	return nil, false
}

func TestTargetsFixture(t *testing.T) {
	fixture := readAuthzFixture(t)
	if len(fixture.Targets) == 0 {
		t.Fatal("fixture has no targets")
	}
	for i := range fixture.Targets {
		vector := &fixture.Targets[i]
		spec := taskSpecFromJSON(t, vector.Spec)
		method, target, err := Target(spec)
		if err != nil {
			t.Fatalf("%s: %v", spec.Kind, err)
		}
		if method != vector.Method {
			t.Errorf("%s: method = %q, want %q", spec.Kind, method, vector.Method)
		}
		if target != vector.Target {
			t.Errorf("%s: target = %q, want %q", spec.Kind, target, vector.Target)
		}
	}
}

// TestCaseFixtureShape guards the fixture invariants the cases test relies on.
func TestCaseFixtureShape(t *testing.T) {
	fixture := readAuthzFixture(t)
	ids := make(map[string]bool, len(fixture.Cases))
	for _, testCase := range fixture.Cases {
		if ids[testCase.ID] {
			t.Fatalf("duplicate case id %q", testCase.ID)
		}
		ids[testCase.ID] = true
		if testCase.Expect.Result == "accepted" && testCase.Expect.Step != nil {
			t.Fatalf("%s: accepted case has a failure step", testCase.ID)
		}
		if testCase.Expect.Result != "accepted" && testCase.Expect.Step == nil {
			t.Fatalf("%s: rejected case has no failure step", testCase.ID)
		}
	}
}
