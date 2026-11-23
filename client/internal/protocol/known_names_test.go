package protocol

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"testing"
)

// The names crha knows for each open name and union are the ones crhs knows: both compare their lists
// with test/interop/known_names.json.
func TestKnownNamesAgreeWithCrhs(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "..", "test", "interop", "known_names.json"))
	if err != nil {
		t.Fatal(err)
	}
	var want struct {
		Methods      []string `json:"methods"`
		Matches      []string `json:"matches"`
		Roles        []string `json:"roles"`
		Capabilities []string `json:"capabilities"`
		TaskKinds    []string `json:"task_kinds"`
	}
	if err := json.Unmarshal(data, &want); err != nil {
		t.Fatal(err)
	}
	for name, c := range map[string]struct{ got, want []string }{
		"methods":      {names(methods.known), want.Methods},
		"matches":      {names(guardMatches.known), want.Matches},
		"roles":        {names(trustRoles.known), want.Roles},
		"capabilities": {names(trustKinds.known), want.Capabilities},
		"task_kinds":   {TaskSpecKinds(), want.TaskKinds},
	} {
		if !slices.Equal(c.got, c.want) {
			t.Errorf("%s: crha knows %q, the fixture lists %q", name, c.got, c.want)
		}
	}
}

func names[T ~string](known []T) []string {
	out := make([]string, len(known))
	for i, k := range known {
		out[i] = string(k)
	}
	return out
}

// TestHelloTaskKindsOmitsPtyCreate guards the difference between every kind the task spec union
// decodes and the kinds hello advertises: pty.create is decoded for a privileged terminal's
// authorization but is never a task (doc/design/pty.md "Privilege").
func TestHelloTaskKindsOmitsPtyCreate(t *testing.T) {
	decoded := TaskSpecKinds()
	hello := HelloTaskKinds()
	if !slices.Contains(decoded, string(TaskSpecPtyCreate)) {
		t.Fatalf("the task spec union does not decode %q", TaskSpecPtyCreate)
	}
	if slices.Contains(hello, string(TaskSpecPtyCreate)) {
		t.Fatalf("hello advertises %q", TaskSpecPtyCreate)
	}
	if len(hello) != len(decoded)-1 {
		t.Fatalf("hello lists %q, the union decodes %q", hello, decoded)
	}
}
