package cli

import (
	"bytes"
	"reflect"
	"strings"
	"testing"

	"github.com/Kodecable/ClusterRightHand/client/internal/config"
)

func TestCommandPaths(t *testing.T) {
	paths := [][]string{
		{"run"}, {"privileged"}, {"privileged", "run"}, {"privileged", "revoke"}, {"privileged", "stdio"},
		{"enroll"}, {"status"}, {"reload"}, {"rotate-key"}, {"upgrade"},
		{"grant"}, {"pending"}, {"approve"}, {"mcp"}, {"version"},
	}
	root := NewRootCmd()
	for _, p := range paths {
		cmd, _, err := root.Find(p)
		if err != nil || cmd == root || cmd.Name() != p[len(p)-1] {
			t.Errorf("command %v not found (got %v, err %v)", p, cmd.Name(), err)
		}
	}
}

func TestNotImplemented(t *testing.T) {
	root := NewRootCmd()
	root.SetArgs([]string{"pending"})
	if err := root.Execute(); err != errNotImplemented {
		t.Fatalf("got %v, want errNotImplemented", err)
	}
}

func TestNativeEscalation(t *testing.T) {
	for tool, want := range map[string][]string{
		config.NativeSudo: {"sudo", "-n"},
		config.NativeDoas: {"doas", "-n"},
		config.NativeRun0: {"run0", "--pipe", "--no-ask-password"},
	} {
		if got := nativeEscalation(tool); !reflect.DeepEqual(got, want) {
			t.Errorf("%s: got %v, want %v", tool, got, want)
		}
	}
}

func TestVersionOutput(t *testing.T) {
	root := NewRootCmd()
	var buf bytes.Buffer
	root.SetOut(&buf)
	root.SetArgs([]string{"version"})
	if err := root.Execute(); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(buf.String(), "crha") {
		t.Errorf("unexpected output %q", buf.String())
	}
}
