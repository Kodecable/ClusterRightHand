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
