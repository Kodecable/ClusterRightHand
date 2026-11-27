package executor

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
)

// sharedEditCase is one row of test/interop/file_edit_cases.json, shared with the SSH implementation's
// test so the two matching rules cannot drift.
type sharedEditCase struct {
	ID      string `json:"id"`
	Content string `json:"content"`
	Edits   []struct {
		OldText string `json:"oldText"`
		NewText string `json:"newText"`
	} `json:"edits"`
	Output *string `json:"output"`
	Error  string  `json:"error"`
}

func TestFileEditSharedCases(t *testing.T) {
	path := filepath.Join("..", "..", "..", "test", "interop", "file_edit_cases.json")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Cases []sharedEditCase `json:"cases"`
	}
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	for _, testCase := range fixture.Cases {
		t.Run(testCase.ID, func(t *testing.T) {
			edits := make([]protocol.Edit, 0, len(testCase.Edits))
			for _, edit := range testCase.Edits {
				edits = append(edits, protocol.Edit{OldText: edit.OldText, NewText: edit.NewText})
			}
			out, err := applyEdits(testCase.Content, edits, detectLineEnding(testCase.Content), "fixture")
			if testCase.Error != "" {
				wantCode(t, err, testCase.Error)
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if testCase.Output == nil || out != *testCase.Output {
				t.Fatalf("output = %q, want %q", out, deref(testCase.Output))
			}
		})
	}
}

func deref(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}
