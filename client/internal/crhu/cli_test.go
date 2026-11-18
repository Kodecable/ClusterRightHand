package crhu

import (
	"bytes"
	"strings"
	"testing"
)

// TestCommandPaths covers the crhu command tree: signing, offline grants, registration and version.
func TestCommandPaths(t *testing.T) {
	root := NewRootCmd()
	for _, path := range [][]string{{"sign"}, {"grant"}, {"register"}, {"version"}} {
		cmd, _, err := root.Find(path)
		if err != nil || cmd == root || cmd.Name() != path[len(path)-1] {
			t.Errorf("command %v not found (got %v, err %v)", path, cmd.Name(), err)
		}
	}
	if cmd, _, _ := root.Find([]string{"grant-removed"}); cmd != root {
		t.Fatalf("unexpected command %q", cmd.Name())
	}
}

func TestVersionOutput(t *testing.T) {
	root := NewRootCmd()
	var out bytes.Buffer
	root.SetOut(&out)
	root.SetArgs([]string{"version"})
	if err := root.Execute(); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "crhu") {
		t.Errorf("unexpected output %q", out.String())
	}
}
