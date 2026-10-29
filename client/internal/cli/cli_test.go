package cli

import (
	"bytes"
	"reflect"
	"strings"
	"testing"

	"github.com/Kodecable/ClusterRightHand/client/internal/config"
	"github.com/Kodecable/ClusterRightHand/client/internal/protocol"
)

func TestCommandPaths(t *testing.T) {
	paths := [][]string{
		{"run"}, {"privileged"}, {"privileged", "run"}, {"privileged", "revoke"}, {"privileged", "stdio"},
		{"enroll"}, {"status"}, {"reload"}, {"rotate-key"}, {"upgrade"},
		{"grant"}, {"pending"}, {"approve"}, {"deny"}, {"mcp"}, {"version"},
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
	root.SetArgs([]string{"mcp"})
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

func TestChooseAttempt(t *testing.T) {
	entries := []protocol.PendingEntry{
		{TaskID: "a", Attempt: 1},
		{TaskID: "a", Attempt: 3},
		{TaskID: "b", Attempt: 2},
	}
	if got, ok := chooseAttempt(entries, "a", 0); !ok || got != 3 {
		t.Fatalf("highest attempt = %d, %v", got, ok)
	}
	if got, ok := chooseAttempt(entries, "a", 1); !ok || got != 1 {
		t.Fatalf("requested attempt = %d, %v", got, ok)
	}
	if _, ok := chooseAttempt(entries, "a", 2); ok {
		t.Fatal("non-pending attempt selected")
	}
	if _, ok := chooseAttempt(entries, "c", 0); ok {
		t.Fatal("unknown task selected")
	}
}

func TestParseAuthorizationID(t *testing.T) {
	id, err := parseAuthorizationID(strings.Repeat("ab", 32))
	if err != nil || id[0] != 0xab || id[31] != 0xab {
		t.Fatalf("parse = %x, %v", id, err)
	}
	for _, bad := range []string{"", "ab", strings.Repeat("zz", 32)} {
		if _, err := parseAuthorizationID(bad); err == nil {
			t.Fatalf("accepted %q", bad)
		}
	}
}
